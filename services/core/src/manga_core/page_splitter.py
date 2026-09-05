"""見開き 1 枚を 2 ページへ割る（#58）。

漫画の ZIP には、見開きを横長の画像 1 枚として持つものがある。viewer は
それを 1 ページとして描くので、単ページの間に横長が挟まって読みづらい。
右綴じなので、先に読むのは右半分になる。

割った後も利用者に「元画像」と「2 枚の半分」の区別は見せない。開き直せば
また 1 行の見開きとして現れ、割る位置を動かしたり、割る前へ戻したりできる。
そのために、割る前の画像は #66 の仕組みで同じ ZIP に残す。

割る幾何（どちらが先か、どこで切るか）と、開き直したときに対を 1 行へ畳む
規則は、すべてこのモジュールに閉じる。散らすと、割る側と畳む側の食い違いで
半分が迷子になる。

`is_spread` を cover_editor から借りているのは、見開き判定が今そこにあるため。
移すのは別途の整理に回す。
"""

import io
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from manga_core.cover_editor import is_spread
from manga_core.original_store import (
    Derivation,
    Operation,
    OriginalRef,
    OriginalStoreError,
    content_hash,
    find_original,
    plan_manifest,
    read_original,
)
from manga_core.page_reorder import (
    OutputPage,
    PageReorderError,
    ZipPageEditor,
)
from manga_core.viewer_contract import VIEWER_IMAGE_EXTENSIONS, output_suffix

# 割った半分を書き戻す形式。cover_editor と同じ選び方にしないと、同じ本を
# 割る経路によって拡張子が変わる
_SAVE_FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}
_JPEG_QUALITY = 92

# 行の画素の出どころ。画面はこの区別を出さないが、割る位置をどの座標で
# 解釈するかがこれで決まる
SOURCE_PAGE = "page"
SOURCE_ORIGINAL = "original"

_SPLIT_KIND = "split"
_SIDE_EARLIER = "right"
_SIDE_LATER = "left"


class PageSplitError(RuntimeError):
    """見開きを割れない"""


@dataclass(frozen=True)
class SplitPosition:
    """割る位置。行の width / height と同じ座標系で持つ"""

    x: int


@dataclass(frozen=True)
class SplitRow:
    """画面に 1 行として出る単位。

    names は、この行が占める「いま存在するページ名」。割る前は 1 つ、割った
    後の対は 2 つ（先に読む方、後に読む方の順）。

    width / height は source の画像の寸法で、split.x はこの座標で読む。
    """

    names: tuple[str, ...]
    source: str
    width: int
    height: int
    is_spread: bool
    split: SplitPosition | None


def split_halves(image: Image.Image, x: int) -> tuple[Image.Image, Image.Image]:
    """x で縦に割り、(先に読む方, 後に読む方) を返す。

    右綴じなので先に読むのは右半分。ここを取り違えると、割った本のページが
    見開きごとに前後する。

    見開きらしいかどうかは問わない。判定は画面の既定のチェックを決めるだけで、
    断ると、実際には見開きなのに閾値に届かない本を利用者が直せなくなる。
    """
    if not 0 < x < image.width:
        raise PageSplitError(f"割る位置が画像の外です: {x} (幅 {image.width})")
    return (
        image.crop((x, 0, image.width, image.height)),
        image.crop((0, 0, x, image.height)),
    )


def scan_rows(archive_path: Path, progress=None) -> tuple[SplitRow, ...]:
    """ページ順に行を組み立てる。割った対は 1 行へ畳む"""
    path = Path(archive_path)
    try:
        editor = ZipPageEditor(path)
    except PageReorderError as error:
        raise PageSplitError(str(error)) from error
    try:
        facts = _scan_pages(editor, path, progress)
    finally:
        editor.close()
    return _fold_pairs(path, facts)


def apply_rows(archive_path: Path, rows: Sequence[SplitRow], progress=None) -> None:
    """行ぜんぶを受け取り、split の変化を 1 回の書き直しで適用する。

    変わった行だけではなく全部を受け取るのは、書き直しがページの並びそのものを
    作り直すため。一部だけ渡されると、渡されなかったページを消したいのか
    書き忘れたのか区別が付かない。
    """
    path = Path(archive_path)
    try:
        editor = ZipPageEditor(path)
    except PageReorderError as error:
        raise PageSplitError(str(error)) from error
    try:
        outputs: list[OutputPage] = []
        dropped: list[str] = []
        extras: dict[str, bytes] = {}
        for row in rows:
            planned = _apply_row(editor, path, row, extras)
            outputs.extend(planned.outputs)
            dropped.extend(planned.dropped)
            extras = planned.extras
        editor.apply_pages(
            outputs,
            progress=progress,
            extra_entries=extras,
            dropped=tuple(dropped),
        )
    except PageReorderError as error:
        raise PageSplitError(str(error)) from error
    finally:
        editor.close()


@dataclass(frozen=True)
class _PageFacts:
    """1 ページを行に組む前に集めた事実"""

    name: str
    width: int
    height: int
    ref: OriginalRef | None
    side: str | None
    x: int | None


def _scan_pages(
    editor: ZipPageEditor, path: Path, progress=None
) -> tuple[_PageFacts, ...]:
    """ページを 1 枚ずつ読み、割った跡の記録まで含めて事実を集める"""
    pages = editor.pages
    facts: list[_PageFacts] = []
    for position, page in enumerate(pages, 1):
        data = editor.read_entry(page.name)
        width, height = _image_size(data)
        ref = find_original(path, data)
        side, x = _split_marks(ref)
        facts.append(
            _PageFacts(
                name=page.name, width=width, height=height, ref=ref, side=side, x=x
            )
        )
        if progress is not None:
            progress(position, len(pages))
    return tuple(facts)


def _split_marks(ref: OriginalRef | None) -> tuple[str | None, int | None]:
    """「割っただけの半分」なら、その向きと位置を返す。

    加工が分割 1 つきりのときに限るのが要点。切り抜きや回転が乗った画像まで
    半分とみなすと、無関係な 2 枚が対にされ、割り直しで片方が消える。
    """
    if ref is None or len(ref.operations) != 1:
        return None, None
    operation = ref.operations[0]
    if operation.kind != _SPLIT_KIND:
        return None, None
    side = operation.params.get("side")
    x = operation.params.get("x")
    if side not in (_SIDE_EARLIER, _SIDE_LATER):
        return None, None
    return side, x if isinstance(x, int) and not isinstance(x, bool) else None


def _fold_pairs(path: Path, facts: Sequence[_PageFacts]) -> tuple[SplitRow, ...]:
    """割った対だけを 1 行へ畳む。

    前から順に見て、対になったら 2 枚まとめて進める。これで「どちらも
    まだ他の行に取られていない」が自然に守られる。
    """
    rows: list[SplitRow] = []
    index = 0
    while index < len(facts):
        pair = (
            _folded_row(path, facts[index], facts[index + 1])
            if index + 1 < len(facts)
            else None
        )
        if pair is not None:
            rows.append(pair)
            index += 2
            continue
        rows.append(_plain_row(facts[index]))
        index += 1
    return tuple(rows)


def _folded_row(path: Path, earlier: _PageFacts, later: _PageFacts) -> SplitRow | None:
    """隣り合う 2 枚が同じ元から割られた対なら、1 行に畳んで返す。

    条件を 1 つでも緩めると、たまたま同じ元から出た無関係な 2 枚が 1 行に
    まとめられ、片方を割り直したつもりでもう片方が消える。離れた 2 枚や
    右左が逆の 2 枚を畳まないのは、利用者が意図して動かした並びを、次の
    書き込みで黙って戻さないため。
    """
    if earlier.ref is None or later.ref is None:
        return None
    if earlier.ref.hash != later.ref.hash:
        return None
    if earlier.side != _SIDE_EARLIER or later.side != _SIDE_LATER:
        return None
    if earlier.x is None or earlier.x != later.x:
        return None
    try:
        original = read_original(path, earlier.ref)
    except OriginalStoreError:
        # 割る前の画像を引けないなら、位置を動かすことも戻すこともできない
        return None
    width, height = _image_size(original)
    if not 0 < earlier.x < width:
        return None
    return SplitRow(
        names=(earlier.name, later.name),
        source=SOURCE_ORIGINAL,
        width=width,
        height=height,
        is_spread=is_spread(width, height),
        split=SplitPosition(x=earlier.x),
    )


def _plain_row(fact: _PageFacts) -> SplitRow:
    """まだ割られていない 1 ページぶんの行"""
    return SplitRow(
        names=(fact.name,),
        source=SOURCE_PAGE,
        width=fact.width,
        height=fact.height,
        is_spread=is_spread(fact.width, fact.height),
        split=None,
    )


@dataclass(frozen=True)
class _RowPlan:
    """1 行を書き直すと決まること"""

    outputs: tuple[OutputPage, ...]
    dropped: tuple[str, ...]
    # ここまでに積み上がった書き足しエントリ（元画像と manifest）
    extras: dict[str, bytes]


def _apply_row(
    editor: ZipPageEditor, path: Path, row: SplitRow, extras: dict[str, bytes]
) -> _RowPlan:
    """1 行ぶんの出力ページと記録を組み立てる"""
    if len(row.names) == 1:
        if row.split is None:
            return _RowPlan((OutputPage(row.names[0]),), (), extras)
        return _split_page(editor, path, row, extras)
    if len(row.names) == 2:
        return _rewrite_pair(editor, path, row, extras)
    raise PageSplitError(f"行が持てるページは 1 枚か 2 枚です: {row.names}")


def _split_page(
    editor: ZipPageEditor, path: Path, row: SplitRow, extras: dict[str, bytes]
) -> _RowPlan:
    """まだ割られていない 1 ページを割る。

    割る相手は同梱された元画像ではなく、そのページ自身のバイト列。行が映して
    いたのはそのページなので、切るのもそれでなければならない。別の所を切り
    抜いた跡があるページを、利用者が一度も見ていない見開きから切ると、
    選んだ位置と切れる場所が食い違う。
    """
    name = row.names[0]
    stored = editor.read_entry(name)
    earlier, later = _halves_of(stored, name, row.split.x)
    return _RowPlan(
        outputs=(OutputPage(name, earlier.data), OutputPage(name, later.data)),
        dropped=(),
        extras=plan_manifest(
            path,
            source=stored,
            source_name=name,
            derivations=(earlier.derivation, later.derivation),
            # 割った後のページは本から消える。記録を残すと、半分から元を辿る道が
            # 二段になり、次に開いたとき対として畳めなくなる
            superseded=(content_hash(stored),),
            planned=extras,
        ),
    )


def _rewrite_pair(
    editor: ZipPageEditor, path: Path, row: SplitRow, extras: dict[str, bytes]
) -> _RowPlan:
    """割った対を、位置を変えて割り直すか、割る前へ戻す。

    どちらも相手は同梱された元画像。保存済みの半分を相手にすると、動かす
    たびに前回捨てた画素が戻らず、JPEG なら劣化も積み上がる。
    """
    earlier_name, later_name = row.names
    stored = [editor.read_entry(name) for name in row.names]
    ref = find_original(path, stored[0])
    if ref is None:
        raise PageSplitError(f"割る前の画像が同梱されていません: {earlier_name}")
    try:
        original = read_original(path, ref)
    except OriginalStoreError as error:
        raise PageSplitError(str(error)) from error
    # 置き換わって消える 2 枚。落とさないと、位置を動かすたびに記録が
    # 2 件ずつ増え、開き直すたびに前回の位置で畳まれて動かせなくなる
    superseded = tuple(content_hash(data) for data in stored)

    if row.split is None:
        # 割る前のバイト列をそのまま戻す。作り直した絵では、貼り合わせた
        # ものと見分けが付かない。元画像そのものは残す（#66）。消すと、
        # 戻した直後にもう一度割ったとき、元の画素をもう引けない
        return _RowPlan(
            outputs=(OutputPage(earlier_name, original),),
            dropped=(later_name,),
            extras=plan_manifest(
                path,
                source=original,
                source_name=ref.entry,
                derivations=(),
                superseded=superseded,
                planned=extras,
            ),
        )

    earlier, later = _halves_of(original, earlier_name, row.split.x)
    return _RowPlan(
        outputs=(
            OutputPage(earlier_name, earlier.data),
            OutputPage(later_name, later.data),
        ),
        dropped=(),
        extras=plan_manifest(
            path,
            source=original,
            source_name=ref.entry,
            derivations=(earlier.derivation, later.derivation),
            superseded=superseded,
            planned=extras,
        ),
    )


@dataclass(frozen=True)
class _Half:
    """割った半分 1 枚と、その記録"""

    data: bytes
    derivation: Derivation


def _halves_of(source: bytes, name: str, x: int) -> tuple[_Half, _Half]:
    """バイト列を x で割り、書き戻す形と記録まで揃えて返す"""
    try:
        with Image.open(io.BytesIO(source)) as opened:
            image = opened.convert("RGB")
    except OSError as error:
        raise PageSplitError(f"画像を読めません: {error}") from error

    earlier, later = split_halves(image, x)
    return (
        _half(earlier, name, _SIDE_EARLIER, x, image.width),
        _half(later, name, _SIDE_LATER, x, image.width),
    )


def _half(image: Image.Image, name: str, side: str, x: int, width: int) -> _Half:
    """半分 1 枚を書き戻す形へ落とし、割った位置まで記録に残す"""
    data = _encoded(image, name)
    operation = Operation(_SPLIT_KIND, {"side": side, "x": x, "width": width})
    return _Half(
        data=data, derivation=Derivation(produced=data, operations=(operation,))
    )


def _encoded(image: Image.Image, name: str) -> bytes:
    """viewer が読める形式へ書き出す。読めない拡張子は PNG へ移す"""
    suffix = output_suffix(Path(name).suffix)
    if suffix not in VIEWER_IMAGE_EXTENSIONS:
        suffix = ".png"
    fmt = _SAVE_FORMATS.get(suffix, "PNG")
    buffer = io.BytesIO()
    if fmt == "JPEG":
        image.save(buffer, fmt, quality=_JPEG_QUALITY, optimize=True)
    else:
        image.save(buffer, fmt, optimize=True)
    return buffer.getvalue()


def _image_size(data: bytes) -> tuple[int, int]:
    """画像の寸法。読めなければ断る"""
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.size
    except OSError as error:
        raise PageSplitError(f"画像を読めません: {error}") from error
