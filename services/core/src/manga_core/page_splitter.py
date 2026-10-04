"""見開き 1 枚を 2 ページへ割る（#58）。

漫画の ZIP には、見開きを横長の画像 1 枚として持つものがある。viewer は
それを 1 ページとして描くので、単ページの間に横長が挟まって読みづらい。
右綴じなので、先に読むのは右半分になる。

割った後も利用者に「元画像」と「2 枚の半分」の区別は見せない。開き直せば
また 1 行の見開きとして現れ、割る位置を動かしたり、割る前へ戻したりできる。
そのために、割る前の画像は #66 の仕組みで同じ ZIP に残す。

対は中身のハッシュで記録から引くので、並びに頼らずに見つかる。ページ並べ替えで
左右を入れ替えた対も、離れた位置へ動かした対も、同じ 1 行へ畳む（#133）。

割る幾何（どちらが先か、どこで切るか）と、開き直したときに対を 1 行へ畳む
規則は、すべてこのモジュールに閉じる。散らすと、割る側と畳む側の食い違いで
半分が迷子になる。

`is_spread` を cover_editor から借りているのは、見開き判定が今そこにあるため。
移すのは別途の整理に回す。
"""

import io
from collections import Counter
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
    ProgressCallback,
    ZipPageEditor,
)
from manga_core.viewer_contract import VIEWER_IMAGE_EXTENSIONS, output_suffix

# 割った半分を書き戻す形式。鍵は viewer が読める拡張子の全部で、値は Pillow が
# その拡張子に対して名乗る形式名。ここに無い拡張子は PNG へ移すので、抜けが
# あると中身が PNG のまま名前だけ .gif のページができ、拡張子で復号器を選ぶ
# 読み手（別のビューアやサムネイル生成）が開けなくなる
_SAVE_FORMATS = {
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
    ".webp": "WEBP",
    ".gif": "GIF",
    ".avif": "AVIF",
}
_JPEG_QUALITY = 92

# 行の画素の出どころ。画面はこの区別を出さないが、割る位置をどの座標で
# 解釈するかがこれで決まる
SOURCE_PAGE = "page"
SOURCE_ORIGINAL = "original"

_SPLIT_KIND = "split"
_SIDE_EARLIER = "right"
_SIDE_LATER = "left"

# 1 行に起きたこと。3 つに分けて数えるので、行ごとにどれだったかを持ち回る
_CHANGE_NONE = "none"
_CHANGE_SPLIT = "split"
_CHANGE_RESTORED = "restored"
_CHANGE_ADJUSTED = "adjusted"
_CHANGE_JOINED = "joined"


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
    後の対は 2 つで、本の中で先に出てくる方から並ぶ。ふつうは右半分・左半分の
    順だが、並べ替えで入れ替えられていれば左半分が先になる。

    width / height は source の画像の寸法で、split.x はこの座標で読む。

    displaced は、対の 2 枚がいま隣り合っていないこと。行は先に出てくる方の
    位置に置かれ、確定するとそこで 2 枚が隣り合う（#133）。
    """

    names: tuple[str, ...]
    source: str
    width: int
    height: int
    is_spread: bool
    split: SplitPosition | None
    displaced: bool = False


@dataclass(frozen=True)
class SplitIntent:
    """画面が送り返してくる「こうしたい」だけの行（#58 段階 2）。

    名前と割る位置の 2 つきり。寸法・出どころ・見開きの印は走査が ZIP と
    同梱の記録から読んだ事実であって、画面はそれを送り返さない。送り返させ
    ると、画面が抱えている古い寸法で切られる余地が残る。

    ``apply_rows`` がこの型も受けるのは、**受け口が知らない欄を埋めずに
    済ませるため**。いまの ``_apply_row`` は names と split しか見ないので、
    寸法に 0 を詰めた ``SplitRow`` を組んでも同じ結果になる。だが詰めた 0 は
    「幅 0 の見開き」として黙って通り、のちにコアがその欄を読み始めた日に
    初めて牙をむく。埋める値はコアだけが決める。
    """

    names: tuple[str, ...]
    split: SplitPosition | None


@dataclass(frozen=True)
class SplitResult:
    """行ぜんぶを適用した結果（#58）。

    数え方を 3 つに分けるのは、画面が「割った」「戻した」「位置を動かした」を
    言い分けるため。1 つにまとめると、ページが 1 枚増えたことは分かっても、
    自分のどの操作が効いたのかを利用者に言えない。
    """

    changed: bool
    page_count: int
    split_count: int
    restored_count: int
    adjusted_count: int
    # 離れていた対を、位置は変えずに隣り合わせへ戻した数（#133）
    joined_count: int = 0


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


def scan_rows(
    archive_path: Path, progress: ProgressCallback | None = None
) -> tuple[SplitRow, ...]:
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


def apply_rows(
    archive_path: Path,
    rows: Sequence[SplitRow | SplitIntent],
    progress: ProgressCallback | None = None,
) -> SplitResult:
    """行ぜんぶを受け取り、split の変化を 1 回の書き直しで適用する。

    変わった行だけではなく全部を受け取るのは、書き直しがページの並びそのものを
    作り直すため。一部だけ渡されると、渡されなかったページを消したいのか
    書き忘れたのか区別が付かない。

    名前を 2 つ持つ行は、書き直す前に畳み込みと同じ規則で確かめ直す。行は
    画面から戻ってくるので、走査と確定の間にアーカイブが変われば古い名前を
    指しうる。

    数えるのはここでしかできない。「位置を動かした」かどうかは、いま記録
    されている位置と見比べて初めて決まる。受け口が行の形だけで数えると、
    変えていない対を送り返しただけで「動かした」と報告する。
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
        changes: Counter[str] = Counter()
        for row in rows:
            planned = _apply_row(editor, path, row, extras)
            outputs.extend(planned.outputs)
            dropped.extend(planned.dropped)
            extras = planned.extras
            changes[planned.change] += 1
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
    return _tally(len(outputs), changes)


def _tally(page_count: int, changes: Counter[str]) -> SplitResult:
    """行ごとに起きたことを、画面へ返す数え方へまとめる"""
    split = changes[_CHANGE_SPLIT]
    restored = changes[_CHANGE_RESTORED]
    adjusted = changes[_CHANGE_ADJUSTED]
    joined = changes[_CHANGE_JOINED]
    return SplitResult(
        # 1 行も動いていない確定もありうる（画面が走査の結果をそのまま
        # 送り返したとき）。書き直したかどうかではなく、利用者の意図が
        # 何か効いたかどうかを返す
        changed=bool(split or restored or adjusted or joined),
        page_count=page_count,
        split_count=split,
        restored_count=restored,
        adjusted_count=adjusted,
        joined_count=joined,
    )


@dataclass(frozen=True)
class _PageFacts:
    """1 ページを行に組む前に集めた事実。

    digest は中身そのもののハッシュ。記録の鍵と同じ値なので、「この 2 枚は
    同じ 1 件の記録に行き着く」かどうかをここで判じられる。走査のときに
    一度読んだバイト列から取っておかないと、畳む側が ZIP を開き直すことに
    なる。
    """

    name: str
    width: int
    height: int
    digest: str
    ref: OriginalRef | None
    side: str | None
    x: int | None


def _page_facts(path: Path, name: str, data: bytes) -> _PageFacts:
    """1 ページ分の事実を集める。

    走査と、書き直す前の確かめ直しで共有する。別々に組み立てると、畳む規則と
    確かめ直す規則が食い違い、畳めた対が書き直しで断られる（あるいはその逆）。
    """
    width, height = _image_size(data)
    ref = find_original(path, data)
    side, x = _split_marks(ref)
    return _PageFacts(
        name=name,
        width=width,
        height=height,
        digest=content_hash(data),
        ref=ref,
        side=side,
        x=x,
    )


def _scan_pages(
    editor: ZipPageEditor, path: Path, progress: ProgressCallback | None = None
) -> tuple[_PageFacts, ...]:
    """ページを 1 枚ずつ読み、割った跡の記録まで含めて事実を集める"""
    pages = editor.pages
    facts: list[_PageFacts] = []
    for position, page in enumerate(pages, 1):
        facts.append(_page_facts(path, page.name, editor.read_entry(page.name)))
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
    """割った対を 1 行へ畳む。行は対のうち先に出てくる方の位置に置く。

    並びには頼らない（#133）。ページ並べ替えで左右を入れ替えた対や、離れた
    位置へ動かした対を畳まずにおくと、どちらもただのページとして並び、ZIP に
    元画像が残っているのに戻す手立てが無くなる。
    """
    folded: dict[int, tuple[int, SplitRow]] = {}
    for first, second in _matched_halves(facts):
        row = _folded_row(
            path, facts[first], facts[second], displaced=second != first + 1
        )
        if row is not None:
            folded[first] = (second, row)
    consumed = {second for second, _ in folded.values()}

    rows: list[SplitRow] = []
    for index, fact in enumerate(facts):
        if index in consumed:
            continue
        if index in folded:
            rows.append(folded[index][1])
            continue
        rows.append(_plain_row(fact))
    return tuple(rows)


def _matched_halves(facts: Sequence[_PageFacts]) -> list[tuple[int, int]]:
    """同じ元を同じ位置で割った 2 枚の組を、本の中で先に出てくる順に拾う。

    1 枚目は相手が来るまで待たせておき、相手が来たら組にする。どの 2 枚が
    組になるかは記録（元画像と割った位置）で決まり、並びでは決まらない。
    """
    waiting: dict[tuple[str, int], int] = {}
    pairs: list[tuple[int, int]] = []
    for index, fact in enumerate(facts):
        if fact.ref is None or fact.side is None or fact.x is None:
            continue
        key = (fact.ref.hash, fact.x)
        earlier = waiting.get(key)
        if earlier is None:
            waiting[key] = index
        elif _split_pair(facts[earlier], fact) is not None:
            pairs.append((earlier, index))
            del waiting[key]
    return pairs


def _folded_row(
    path: Path, first: _PageFacts, second: _PageFacts, displaced: bool
) -> SplitRow | None:
    """2 枚が同じ元から割られた対なら、1 行に畳んで返す。

    条件を 1 つでも緩めると、たまたま同じ元から出た無関係な 2 枚が 1 行に
    まとめられ、片方を割り直したつもりでもう片方が消える。
    """
    pair = _split_pair(first, second)
    if pair is None:
        return None
    try:
        original = read_original(path, pair.ref)
    except OriginalStoreError:
        # 割る前の画像を引けないなら、位置を動かすことも戻すこともできない
        return None
    width, height = _image_size(original)
    if not 0 < pair.x < width:
        return None
    return SplitRow(
        names=(first.name, second.name),
        source=SOURCE_ORIGINAL,
        width=width,
        height=height,
        is_spread=is_spread(width, height),
        split=SplitPosition(x=pair.x),
        displaced=displaced,
    )


@dataclass(frozen=True)
class _SplitPair:
    """同じ元を同じ位置で割った対だと確かめられた 2 枚。

    確かめた結果そのもの（どの元画像を、どこで割ったか、どちらが先に並んで
    いるか）を持つ。呼び出し側が改めて片方から引き直すと、確かめた対象と
    ずれる余地が残る。
    """

    ref: OriginalRef
    x: int
    # 先に並んでいる方が右半分か。並べ替えで入れ替えられていれば False
    right_first: bool


def _split_pair(first: _PageFacts, second: _PageFacts) -> _SplitPair | None:
    """2 枚が同じ元を同じ位置で割った右半分と左半分なら、その元と位置を返す。

    条件を 1 つでも緩めると、たまたま同じ元から出た無関係な 2 枚が 1 行に
    まとめられ、片方を割り直したつもりでもう片方が消える。

    並び順は問わない（#133）。どちらが先かは返す値に持たせ、割り直すときも
    その並びを保つ。利用者が意図して入れ替えた並びを、次の書き込みで黙って
    戻さないため。

    ただ 1 つだけ緩める。左右がまったく同じバイト列になった対（一色の章扉や
    左右対称の見返しを中央で割った場合）は、記録の鍵が中身のハッシュである
    以上 1 件しか持てず、後から書いた側が前を上書きする。両方が同じ side を
    指すので、右と左の 1 枚ずつという条件は原理的に満たせない。そこで、2 枚の
    中身が同じで、同じ元から出た同じ 1 件の split の記録に行き着くときに限り、
    その記録の x で対とみなす。塞いだままにすると、真っ白な見開きだけが
    二度と割り位置を直せなくなる。ページは残るので、壊れたようには見えない
    ぶん気づけない。

    記録の形は変えない。derived を 1 つのハッシュに複数件持てる形へ広げると、
    #66 と共有している manifest の形式が変わる。
    """
    if first.ref is None or second.ref is None:
        return None
    if first.ref.hash != second.ref.hash:
        return None
    if first.x is None or first.x != second.x:
        return None
    if first.side is None or second.side is None:
        return None
    if first.digest == second.digest:
        # 中身が同じ 2 枚は同じ 1 件の記録に行き着くので、side はどちらも同じ
        # 値になる。どちらが先かは見分けられず、見分ける意味も無い
        return _SplitPair(ref=first.ref, x=first.x, right_first=True)
    if {first.side, second.side} != {_SIDE_EARLIER, _SIDE_LATER}:
        return None
    return _SplitPair(ref=first.ref, x=first.x, right_first=first.side == _SIDE_EARLIER)


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
    # この行に何が起きたか（_CHANGE_*）。数えるのは行を組むこの場所でしか
    # できない。位置を動かしたかどうかは、記録された位置と見比べて決まる
    change: str


def _apply_row(
    editor: ZipPageEditor,
    path: Path,
    row: SplitRow | SplitIntent,
    extras: dict[str, bytes],
) -> _RowPlan:
    """1 行ぶんの出力ページと記録を組み立てる"""
    if len(row.names) == 1:
        if row.split is None:
            return _RowPlan((OutputPage(row.names[0]),), (), extras, _CHANGE_NONE)
        return _split_page(editor, path, row.names[0], row.split, extras)
    if len(row.names) == 2:
        return _rewrite_pair(editor, path, row, extras)
    raise PageSplitError(f"行が持てるページは 1 枚か 2 枚です: {row.names}")


def _split_page(
    editor: ZipPageEditor,
    path: Path,
    name: str,
    split: SplitPosition,
    extras: dict[str, bytes],
) -> _RowPlan:
    """まだ割られていない 1 ページを割る。

    割る相手は同梱された元画像ではなく、そのページ自身のバイト列。行が映して
    いたのはそのページなので、切るのもそれでなければならない。別の所を切り
    抜いた跡があるページを、利用者が一度も見ていない見開きから切ると、
    選んだ位置と切れる場所が食い違う。
    """
    stored = editor.read_entry(name)
    earlier, later = _halves_of(stored, name, split.x)
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
        change=_CHANGE_SPLIT,
    )


def _rewrite_pair(
    editor: ZipPageEditor,
    path: Path,
    row: SplitRow | SplitIntent,
    extras: dict[str, bytes],
) -> _RowPlan:
    """割った対を、位置を変えて割り直すか、割る前へ戻す。

    どちらも相手は同梱された元画像。保存済みの半分を相手にすると、動かす
    たびに前回捨てた画素が戻らず、JPEG なら劣化も積み上がる。

    書き出すのはこの行の位置。離れていた対は、ここで 2 枚が隣り合う（#133）。
    """
    first_name, second_name = row.names
    facts, displaced = _revalidated_pair(editor, path, row.names)
    pair = _split_pair(*facts)
    if pair is None:
        raise PageSplitError(
            f"同じ見開きを同じ位置で割った対ではありません: {row.names}"
        )
    try:
        original = read_original(path, pair.ref)
    except OriginalStoreError as error:
        raise PageSplitError(str(error)) from error
    # 置き換わって消える 2 枚。落とさないと、位置を動かすたびに記録が
    # 2 件ずつ増え、開き直すたびに前回の位置で畳まれて動かせなくなる
    superseded = tuple(fact.digest for fact in facts)

    if row.split is None:
        # 割る前のバイト列をそのまま戻す。作り直した絵では、貼り合わせた
        # ものと見分けが付かない。元画像そのものは残す（#66）。消すと、
        # 戻した直後にもう一度割ったとき、元の画素をもう引けない。ただし
        # 元画像の形式が書き戻し先の拡張子と食い違うとき（viewer が読めない
        # BMP の元画像は、戻り先の名前が .png になる）だけは書き直す
        restored = _bytes_matching_suffix(original, first_name)
        return _RowPlan(
            outputs=(OutputPage(first_name, restored),),
            dropped=(second_name,),
            extras=plan_manifest(
                path,
                source=original,
                source_name=pair.ref.entry,
                derivations=(),
                superseded=superseded,
                planned=extras,
            ),
            change=_CHANGE_RESTORED,
        )

    right, left = _halves_of(original, first_name, row.split.x)
    # いまの並び（どちらが先か）を保つ。入れ替えた並びを黙って右・左へ戻さない
    ahead, behind = (right, left) if pair.right_first else (left, right)
    if row.split.x != pair.x:
        change = _CHANGE_ADJUSTED
    elif displaced:
        change = _CHANGE_JOINED
    else:
        # 同じ位置で送り返された対は、画面が走査の結果をそのまま返しただけ。
        # 動かしたと数えると、1 か所を割っただけの確定が「10 か所動かした」と
        # 報告される
        change = _CHANGE_NONE
    return _RowPlan(
        outputs=(
            OutputPage(first_name, ahead.data),
            OutputPage(second_name, behind.data),
        ),
        dropped=(),
        extras=plan_manifest(
            path,
            source=original,
            source_name=pair.ref.entry,
            derivations=(right.derivation, left.derivation),
            superseded=superseded,
            planned=extras,
        ),
        change=change,
    )


def _revalidated_pair(
    editor: ZipPageEditor, path: Path, names: tuple[str, ...]
) -> tuple[tuple[_PageFacts, _PageFacts], bool]:
    """名前を 2 つ持つ行が、いまも割った対の 2 枚を指しているか確かめ直す。

    行は画面から戻ってくるもので、走査した時点のアーカイブしか映していない。
    確定までに別のタブが同じ本を書き換えれば、行は古い名前を指したまま届く。
    名前だけを見て書くと、2 枚目に指名された無関係なページが「割る前へ戻す」の
    巻き添えで落とされる。apply_pages は名指しされた落としを通すので、
    止められるのはここだけ。2 枚の中身を読み、同じ元を割った対であることを
    呼び出し側（``_split_pair``）が確かめる。書き直しの計画を組む前に断る
    ことで、アーカイブは 1 バイトも変わらない。

    2 枚がいま隣り合っているかも返す。隣り合っていない対は、この行の位置で
    隣り合わせへ戻る（#133）。
    """
    order = {page.name: position for position, page in enumerate(editor.pages)}
    missing = [name for name in names if name not in order]
    if missing:
        raise PageSplitError(f"アーカイブに存在しないページです: {missing}")
    first_name, second_name = names
    facts = (
        _page_facts(path, first_name, editor.read_entry(first_name)),
        _page_facts(path, second_name, editor.read_entry(second_name)),
    )
    return facts, order[second_name] != order[first_name] + 1


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
    data = _encoded(image, _destination_suffix(name))
    operation = Operation(_SPLIT_KIND, {"side": side, "x": x, "width": width})
    return _Half(
        data=data, derivation=Derivation(produced=data, operations=(operation,))
    )


def _destination_suffix(name: str) -> str:
    """このページを書き戻すときの拡張子。viewer が読めない拡張子は PNG へ移す。

    連番を振り直す側（viewer_contract.sequential_name）と同じ規則で決める。
    食い違うと、中身が PNG なのに名前が .gif のページができ、拡張子で復号器を
    選ぶ読み手（別のビューアやサムネイル生成）が開けなくなる。
    """
    suffix = output_suffix(Path(name).suffix)
    if suffix not in VIEWER_IMAGE_EXTENSIONS:
        return ".png"
    return suffix


def _bytes_matching_suffix(data: bytes, name: str) -> bytes:
    """バイト列を、そのページの拡張子が名乗る形式へ揃える。

    既に合っていればバイト列をそのまま返すのが要点。割る前へ戻すときは同梱の
    元画像をそのまま書き戻したい。無条件に書き直すと、「割る前のものをそのまま
    戻した」ことの唯一の証拠であるバイト列の一致が失われ、貼り合わせた絵と
    見分けが付かなくなる。一方で viewer が読めない BMP の元画像は戻り先の
    名前が .png になるので、そのまま書くと名前と中身が食い違う。
    """
    suffix = _destination_suffix(name)
    try:
        with Image.open(io.BytesIO(data)) as opened:
            if opened.format == _SAVE_FORMATS[suffix]:
                return data
            image = opened.convert("RGB")
    except OSError as error:
        raise PageSplitError(f"画像を読めません: {error}") from error
    return _encoded(image, suffix)


def _encoded(image: Image.Image, suffix: str) -> bytes:
    """拡張子どおりの形式で書き出す"""
    fmt = _SAVE_FORMATS[suffix]
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
