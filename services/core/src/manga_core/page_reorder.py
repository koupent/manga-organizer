"""ZIP アーカイブ内のページ順を手動で修正するためのコア処理。

漫画ビューアは ZIP の格納順ではなくファイル名順でページを表示するため、
「並び替え」は実質的に「エントリのリネーム」になる。ここでは全ページを
展開せずに ZIP を書き直し、各エントリの日時・圧縮方式と、ZIP ファイル
自身のタイムスタンプを保ったまま連番を振り直す。
"""

import io
import logging
import os
import struct
import tempfile
import threading
import time
import zipfile
import zlib
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from PIL import Image

from manga_core.file_times import capture_file_times, restore_file_times
from manga_core.naming import natural_sort_key
from manga_core.viewer_contract import (
    is_page_source,
    needs_conversion,
    sequential_name,
)

logger = logging.getLogger(__name__)

EDITABLE_SUFFIXES = {".zip", ".cbz"}
# 画像は既に圧縮済みなので、高い圧縮レベルは時間を使うだけで容量は減らない
DEFLATE_LEVEL = 1
TEMP_PREFIX = ".reorder-"
TEMP_SUFFIX = ".tmp"
# Zip64 拡張情報はオフセットを含み、書き直した ZIP では無効になる
_ZIP64_EXTRA_ID = 0x0001
_EXTRA_HEADER_STRUCT = struct.Struct("<HH")

# 進捗の受け手。ページを 1 枚書き終えるたびに (いま何枚目, 全部で何枚) で呼ぶ。
# 別名にしておくのは、同じ形の引数が並び替え・分割・サイドカー API に散って
# いるため。片方だけ形を変えても気づけない
ProgressCallback = Callable[[int, int], None]


class PageReorderError(RuntimeError):
    """並び替えの前提条件が満たされない場合に送出する"""


@dataclass(frozen=True)
class PageEntry:
    """ZIP 内の 1 ページ分のメタ情報"""

    name: str
    size: int
    modified: str


@dataclass(frozen=True)
class OutputPage:
    """書き直した後のアーカイブに並ぶページ 1 枚分（#58）。

    source は「いま存在するページ名」で、そのエントリの日時や圧縮方式を
    引き継ぐ相手を指す。content を渡すとその中身で書き、渡さなければ
    source のバイト列をそのまま運ぶ。

    見開きの分割は 1 枚の source から 2 枚を出す。名前で「このページはこの
    中身」と指す形では書き分けられないので、位置で持つ。
    """

    source: str
    content: bytes | None = None


@dataclass(frozen=True)
class ReorderResult:
    """並び替えの実行結果"""

    changed: bool
    page_count: int
    renamed_count: int
    times_restored: bool


def is_image_name(name: str) -> bool:
    """ページとして扱うエントリかどうかを判定する。

    suzume-viewer が読み飛ばすもの（`__MACOSX/`、ドット始まり、ディレクトリ）は
    ページに含めない。含めてしまうと連番に組み込まれ、リネーム後は viewer 側で
    壊れたページとして表示されてしまう。
    """
    return is_page_source(name)


def is_editable_archive(path: Path) -> bool:
    """ページ順を編集できるアーカイブ形式かどうかを判定する"""
    return path.suffix.lower() in EDITABLE_SUFFIXES


def _format_modified(date_time: tuple[int, int, int, int, int, int]) -> str:
    """ZipInfo.date_time を表示用の文字列に整形する"""
    try:
        return datetime(*date_time).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return "-"


def _portable_extra(extra: bytes) -> bytes:
    """書き直しても有効な extra フィールドだけを残す。

    Info-ZIP の UT や NTFS 時刻など高精度タイムスタンプは引き継ぎたいが、
    Zip64 拡張情報は元アーカイブ内のオフセットを含むため持ち込めない。
    """
    kept = bytearray()
    offset = 0
    while offset + _EXTRA_HEADER_STRUCT.size <= len(extra):
        header_id, size = _EXTRA_HEADER_STRUCT.unpack_from(extra, offset)
        chunk_end = offset + _EXTRA_HEADER_STRUCT.size + size
        if chunk_end > len(extra):
            break  # 壊れた extra はそこで打ち切る
        if header_id != _ZIP64_EXTRA_ID:
            kept += extra[offset:chunk_end]
        offset = chunk_end
    return bytes(kept)


def _convert_to_png(data: bytes) -> bytes:
    """viewer が読めない画像を PNG へ変換する。

    BMP は無圧縮なだけで、PNG は可逆圧縮なので画質は落ちない。
    """
    with Image.open(io.BytesIO(data)) as image:
        loaded = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        buffer = io.BytesIO()
        loaded.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def _copy_entry(
    source: zipfile.ZipFile,
    destination: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    arcname: str,
    convert: bool = False,
    replacement: bytes | None = None,
) -> None:
    """エントリを新しい名前でコピーする。

    viewer が読めない形式のときだけ変換し、それ以外はバイト列を変えない。
    replacement を渡すとその中身で差し替える。差し替える側は呼び出し元が
    viewer の読める形式に整えて渡すので、ここでは変換しない。
    """
    rewritten = replacement is not None
    data = replacement if rewritten else source.read(info)
    if not rewritten and convert and needs_conversion(info.filename):
        data = _convert_to_png(data)
        rewritten = True
    copied = zipfile.ZipInfo(arcname, date_time=info.date_time)
    copied.compress_type = info.compress_type
    copied.external_attr = info.external_attr
    copied.internal_attr = info.internal_attr
    copied.create_system = info.create_system
    copied.comment = info.comment
    copied.extra = _portable_extra(info.extra)
    if rewritten:
        # 元の圧縮方式は書き換えた後のバイト列に対しては意味を持たない
        copied.compress_type = zipfile.ZIP_DEFLATED
    level = DEFLATE_LEVEL if copied.compress_type == zipfile.ZIP_DEFLATED else None
    destination.writestr(copied, data, compresslevel=level)


def new_entry_info(name: str) -> zipfile.ZipInfo:
    """アーカイブへ新しく書き足すエントリのメタ情報を作る。

    コピー元の ZipInfo が無いエントリ（#66 の元画像や manifest）用。
    zipfile の既定の日時は 1980-01-01 になるため、書き足した時刻を入れる。
    """
    info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def mismatched_entries(
    archive: zipfile.ZipFile, expected: Mapping[str, bytes]
) -> list[str]:
    """期待した中身で書けていないエントリ名を返す。

    名前と CRC の検証だけでは、書いたつもりで元の中身が残っていても気づけない。
    元のアーカイブを捨てる前に大きさまで突き合わせるために使う。
    """
    names = set(archive.namelist())
    return sorted(
        name
        for name, data in expected.items()
        if name not in names or archive.getinfo(name).file_size != len(data)
    )


def _output_names(outputs: Sequence[OutputPage]) -> tuple[str, ...]:
    """出力ページに振る連番名を、位置の順に組み立てる。

    名前ではなく位置で作るのが要点。名前を鍵にした写像で作ると、同じ source を
    2 回使う分割で後の 1 つしか残らず、片方の半分がどこにも書かれないまま
    エラーも出ずに消える。
    """
    total = len(outputs)
    return tuple(
        sequential_name(position, total, Path(output.source).suffix)
        for position, output in enumerate(outputs, 1)
    )


def _content_for(output: OutputPage, replacements: Mapping[str, bytes]) -> bytes | None:
    """このページに書く中身。そのまま運ぶなら None。

    位置で持つ content が先で、名前で指す replacements は content を持たない
    ページにだけ効く。分割は同じ source から違う中身を 2 枚出すので、
    名前で指す形では書き分けられない。
    """
    if output.content is not None:
        return output.content
    return replacements.get(output.source)


def _written_content(
    outputs: Sequence[OutputPage],
    names: Sequence[str],
    replacements: Mapping[str, bytes],
) -> dict[str, bytes]:
    """「書き上がった ZIP のこの名前は、この中身のはず」の対応表を作る"""
    written: dict[str, bytes] = {}
    for output, name in zip(outputs, names, strict=True):
        content = _content_for(output, replacements)
        if content is not None:
            written[name] = content
    return written


def _stamp(info: zipfile.ZipInfo) -> tuple[int, int]:
    """中身を読み直さずに引ける、そのエントリの指紋（大きさと CRC-32）"""
    return (info.file_size, info.CRC)


def _required_directories(
    source: zipfile.ZipFile, consumed: frozenset[str]
) -> set[str]:
    """書き直した後も中身が残るディレクトリエントリの名前を集める"""
    required: set[str] = set()
    for info in source.infolist():
        if info.is_dir() or info.filename in consumed:
            continue
        parent = PurePosixPath(info.filename).parent
        while str(parent) not in (".", "/"):
            required.add(f"{parent}/")
            parent = parent.parent
    return required


class ZipPageEditor:
    """1 つの ZIP に対するページ一覧の取得と並び順の適用を担当する"""

    def __init__(self, zip_path: Path):
        self.zip_path = Path(zip_path)
        if not self.zip_path.is_file():
            raise PageReorderError(f"ファイルが見つかりません: {self.zip_path}")
        if not is_editable_archive(self.zip_path):
            raise PageReorderError(
                f"ページ順を編集できるのは .zip / .cbz のみです: {self.zip_path.suffix}"
            )

        # 保存中に読み出しが ZIP を開き直すと Windows で os.replace が失敗する。
        # 読み出しと書き換えを同じロックで直列化する。
        self._lock = threading.RLock()
        self._handle: zipfile.ZipFile | None = None
        self._pages: tuple[PageEntry, ...] = self._load_pages()

    @property
    def pages(self) -> tuple[PageEntry, ...]:
        """ファイル名の自然順に並べたページ一覧"""
        return self._pages

    def read_entry(self, name: str) -> bytes:
        """ページ 1 枚分の生バイト列を読み出す"""
        if name not in {page.name for page in self._pages}:
            raise PageReorderError(f"アーカイブに存在しないページです: {name}")
        with self._lock:
            if self._handle is None:
                self._handle = zipfile.ZipFile(self.zip_path, "r")
            return self._handle.read(name)

    def close(self) -> None:
        """読み出し用に開いているハンドルを解放する"""
        with self._lock:
            if self._handle is not None:
                self._handle.close()
                self._handle = None

    def apply_order(
        self,
        ordered_names,
        progress: ProgressCallback | None = None,
        replacements: Mapping[str, bytes] | None = None,
        extra_entries: Mapping[str, bytes] | None = None,
    ) -> ReorderResult:
        """指定された順序で連番を振り直し、ZIP をその場で置き換える。

        replacements を渡すと、そのページだけ中身を差し替えたうえで並べ替える。
        並べ替えと差し替えを 1 回の書き直しで済ませることで、片方だけ適用された
        中途半端なアーカイブが残らない。

        extra_entries はページ以外として書き足すエントリ（#66 の元画像と
        manifest）。同名が既にあれば置き換える。これも同じ 1 回の書き直しに
        含める。後から追記に分けると、ZIP 自身のタイムスタンプ保持が 2 回目の
        書き込みで壊れるうえ、元画像だけ書けて本体が古いままのアーカイブが残る。

        書き直しそのものは apply_pages に任せるが、先に _validate_order を
        通すのが要点（#58）。あちらはページを増やす・減らすことも許す入口なので、
        こちらを素通しにすると、ページ修正画面から来たただの並べ替えでも
        名前を 1 つ書き間違えただけでページが消える。
        """
        with self._lock:
            ordered = tuple(ordered_names)
            self._validate_order(ordered)
            return self.apply_pages(
                [OutputPage(name) for name in ordered],
                progress=progress,
                extra_entries=extra_entries,
                replacements=replacements,
            )

    def apply_pages(
        self,
        outputs: Iterable[OutputPage],
        progress: ProgressCallback | None = None,
        extra_entries: Mapping[str, bytes] | None = None,
        dropped: Sequence[str] = (),
        replacements: Mapping[str, bytes] | None = None,
    ) -> ReorderResult:
        """出力ページの列そのものを受け取って ZIP を書き直す（#58）。

        並べ替えはページの集合を変えないが、見開きの分割は 1 枚から 2 枚を出し、
        割る前へ戻すと 2 枚が 1 枚に減る。数も集合も変わるので、apply_order を
        緩めるのではなく別の入口を置く。

        dropped は「書き直した後には残さない」と名指しするページ。出力に現れない
        ページを黙って落とすと、行を 1 つ組み立て損ねただけでページが失われる。

        replacements は名前で指す差し替え（並べ替えと同時の表紙加工）。中身を
        位置で持てる呼び出し側は OutputPage.content を使う。
        """
        with self._lock:
            pages = tuple(outputs)
            removed = tuple(dropped)
            replaced = dict(replacements or {})
            extras = dict(extra_entries or {})
            sources = tuple(page.source for page in pages)
            self._validate_outputs(pages, removed)
            self._validate_replacements(sources, replaced)
            self._validate_extra_entries(extras)
            names = _output_names(pages)
            self._reject_name_collisions(names)
            written = _written_content(pages, names, replaced)

            current = tuple(page.name for page in self._pages)
            # 差し替えや書き足しがあるなら、名前と順序が同じでも
            # 書き直さないと中身が変わらない
            renamed_nothing = sources == names
            if (
                not written
                and not extras
                and not removed
                and renamed_nothing
                and sources == current
            ):
                return ReorderResult(
                    changed=False,
                    page_count=len(pages),
                    renamed_count=0,
                    times_restored=True,
                )

            self.close()
            original_times = capture_file_times(self.zip_path)
            temp_path = self._create_temp_file()
            try:
                self._write_reordered(
                    temp_path, pages, names, progress, replaced, extras
                )
                self._verify_written(temp_path, names, removed)
                self._verify_carried_content(temp_path, pages, names, replaced)
                self._verify_replacements(temp_path, written)
                self._verify_extra_entries(temp_path, extras)
                os.replace(temp_path, self.zip_path)
            finally:
                # 置き換えに成功していれば既に消えている
                temp_path.unlink(missing_ok=True)

            times_restored = restore_file_times(self.zip_path, original_times)
            self._pages = self._load_pages()
            return ReorderResult(
                changed=True,
                page_count=len(pages),
                renamed_count=sum(
                    1
                    for source, name in zip(sources, names, strict=True)
                    if source != name
                ),
                times_restored=times_restored,
            )

    def _create_temp_file(self) -> Path:
        """同じディレクトリに、排他生成した一時ファイルを用意する。

        固定名だと既存ファイルやシンボリックリンクを切り詰めうるうえ、
        同時実行で衝突する。os.replace のために配置先と同じ場所に作る。
        """
        handle, name = tempfile.mkstemp(
            dir=self.zip_path.parent,
            prefix=self.zip_path.name + TEMP_PREFIX,
            suffix=TEMP_SUFFIX,
        )
        os.close(handle)
        return Path(name)

    def _verify_written(
        self, temp_path: Path, names: tuple[str, ...], dropped: tuple[str, ...]
    ) -> None:
        """置き換える前に、書き上げた ZIP を読み直して中身を確かめる。

        元のアーカイブを捨ててから壊れていたと分かっても取り返しがつかない。

        足りないものだけでなく、余っているページも見る（#58）。落とすと
        約束したページが運ばれてしまうと、利用者には同じ絵が 2 枚並ぶ。
        連番を振り直した後は古い名前で探せないので、ページの集合そのものを
        突き合わせる。
        """
        try:
            with zipfile.ZipFile(temp_path, "r") as written:
                written_names = written.namelist()
        except (OSError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP を読み直せませんでした: {error}"
            ) from error

        pages = {name for name in written_names if is_image_name(name)}
        missing = sorted(set(names) - pages)
        if missing:
            raise PageReorderError(f"書き出した ZIP にページが足りません: {missing}")
        if len(written_names) != len(set(written_names)):
            raise PageReorderError("書き出した ZIP に同名エントリが含まれています")
        left_over = sorted(pages - set(names))
        if left_over:
            raise PageReorderError(
                f"書き出した ZIP に余分なページが残っています: {left_over} "
                f"(落とすはずだったページ: {sorted(dropped)})"
            )

        # 名前が揃っていても中身が壊れていることはある。元を捨てる前に
        # 全メンバーを読み、CRC まで突き合わせる
        try:
            with zipfile.ZipFile(temp_path, "r") as written:
                damaged = written.testzip()
        except (OSError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP を検証できませんでした: {error}"
            ) from error
        if damaged is not None:
            raise PageReorderError(f"書き出した ZIP の内容が壊れています: {damaged}")

        # OS のキャッシュ上だけで完了したことにしない
        with open(temp_path, "rb") as stream:
            os.fsync(stream.fileno())

    def _load_pages(self) -> tuple[PageEntry, ...]:
        """ZIP から画像エントリを読み出し、自然順に並べて返す"""
        try:
            with zipfile.ZipFile(self.zip_path, "r") as archive:
                infos = [
                    info
                    for info in archive.infolist()
                    if not info.is_dir() and is_image_name(info.filename)
                ]
        except zipfile.BadZipFile as error:
            raise PageReorderError(f"ZIP を読み込めません: {error}") from error

        if not infos:
            raise PageReorderError("アーカイブに画像が含まれていません")

        # ZIP は同名エントリを許すが、名前でページを指す以上は区別できない。
        # そのまま進めると片方が欠落するので、ここで断る。
        duplicated = sorted(
            name
            for name, count in Counter(info.filename for info in infos).items()
            if count > 1
        )
        if duplicated:
            raise PageReorderError(
                f"同名の画像エントリが含まれており編集できません: {duplicated}"
            )

        infos.sort(key=lambda info: natural_sort_key(info.filename))
        return tuple(
            PageEntry(
                name=info.filename,
                size=info.file_size,
                modified=_format_modified(info.date_time),
            )
            for info in infos
        )

    def _validate_order(self, ordered: tuple[str, ...]) -> None:
        """受け取った並び順が現在のページ集合と一致するか検証する"""
        current = {page.name for page in self._pages}
        received = set(ordered)
        if len(ordered) != len(received):
            raise PageReorderError("並び順に重複したページが含まれています")
        if len(ordered) != len(self._pages):
            raise PageReorderError(
                "ページ数が一致しません "
                f"(要求 {len(ordered)} / 実際 {len(self._pages)})"
            )
        if received != current:
            missing = sorted(current - received)
            unknown = sorted(received - current)
            raise PageReorderError(
                f"並び順がページ一覧と一致しません (不足: {missing}, 不明: {unknown})"
            )

    def _validate_outputs(
        self, outputs: tuple[OutputPage, ...], dropped: tuple[str, ...]
    ) -> None:
        """出力ページの列が、いまのページを過不足なく使い切るか検証する（#58）。

        _validate_order を緩めたものではなく、別の規則。ページの数も集合も
        変えてよい代わりに、増えた自由の分だけここで塞ぐ。
        """
        if not outputs:
            raise PageReorderError("出力するページがありません")

        current = {page.name for page in self._pages}
        counts = Counter(output.source for output in outputs)
        removed = set(dropped)

        unknown = sorted(set(counts) - current)
        if unknown:
            # 黙って読み飛ばすと、名前を書き間違えただけでページが本から消える
            raise PageReorderError(f"出力元がページ一覧にありません: {unknown}")

        unknown_dropped = sorted(removed - current)
        if unknown_dropped:
            raise PageReorderError(
                f"落とす指定がページ一覧にありません: {unknown_dropped}"
            )

        both = sorted(removed & set(counts))
        if both:
            # どちらかを黙って優先すると、消えるはずのページが残るか、
            # 残るはずのページが消える
            raise PageReorderError(f"落とすページを出力にも使っています: {both}")

        lost = sorted(current - set(counts) - removed)
        if lost:
            # 消したいのか書き忘れたのか区別が付かない
            raise PageReorderError(f"出力にも落とす指定にも現れないページです: {lost}")

        # 1 枚から 2 枚が出るのは分割だけで、どちらの出力も切った後の中身を持つ。
        # 中身の無い出力が混ざるのは、同じ絵を本の中へ二重に並べる形
        copied = sorted(
            {
                output.source
                for output in outputs
                if counts[output.source] > 1 and output.content is None
            }
        )
        if copied:
            raise PageReorderError(
                f"同じページを中身なしで複数回出力しています: {copied}"
            )

        empty = sorted({output.source for output in outputs if output.content == b""})
        if empty:
            raise PageReorderError(f"出力する中身が空です: {empty}")

    def _validate_replacements(
        self, sources: tuple[str, ...], replacements: dict[str, bytes]
    ) -> None:
        """名前で指した差し替えが、書き出すページを指しているか検証する"""
        unknown = sorted(set(replacements) - set(sources))
        if unknown:
            raise PageReorderError(f"差し替え対象がページ一覧にありません: {unknown}")
        empty = sorted(name for name, data in replacements.items() if not data)
        if empty:
            raise PageReorderError(f"差し替える中身が空です: {empty}")

    def _validate_extra_entries(self, extras: dict[str, bytes]) -> None:
        """書き足すエントリがページと衝突しないか検証する。

        ページとみなされる名前を書き足すと連番の振り直しに巻き込まれ、隠して
        おいたはずの元画像が改名されて本文へ紛れる。置き場を変えたときに
        気づけるよう、書き込む前で止める。
        """
        pages = sorted(name for name in extras if is_image_name(name))
        if pages:
            raise PageReorderError(f"書き足すエントリがページと衝突します: {pages}")
        empty = sorted(name for name, data in extras.items() if not data)
        if empty:
            raise PageReorderError(f"書き足す中身が空です: {empty}")

    def _verify_carried_content(
        self,
        temp_path: Path,
        outputs: tuple[OutputPage, ...],
        names: tuple[str, ...],
        replacements: Mapping[str, bytes],
    ) -> None:
        """中身を指定せず運ぶだけのページが、その出どころの中身で書けているか
        確かめる（#58）。

        _verify_written が見るのは書き上がった ZIP のページ名の集合と、ZIP
        としての整合だけで、「どの名前にどのページの中身が入ったか」は見て
        いない。_verify_replacements は中身を指定した出力にしか効かない。
        落として連番を振り直す書き直しで、落とすはずのページの中身が残る
        ページの名前に入っても、名前・整合・差し替え・余りの検査は全部通り、
        続く os.replace で元のアーカイブは消える。利用者から見ると、消した
        はずのページが別の番号で残り、残るはずのページが消える。ページ数も
        名前も期待どおりなので、開いて眺めるまで気づけない。

        突き合わせるのは名前ではなく位置。分割は 1 つの出どころから 2 枚を
        出すので、名前を鍵にすると片方しか見られない。大きさと CRC-32 は
        どちらも中央ディレクトリに入っていて、中身を読み直さずに引ける。
        長さが同じで中身の違うページは大きさだけの照合をすり抜けるため、
        CRC まで見る。
        """
        carried = [
            (name, output.source)
            for output, name in zip(outputs, names, strict=True)
            # 中身を指定した出力は _verify_replacements の担当。変換が要る
            # ページ（BMP -> PNG）は、運んだ時点でバイト列が変わるのが正しい
            if _content_for(output, replacements) is None
            and not needs_conversion(output.source)
        ]
        if not carried:
            return
        try:
            with (
                zipfile.ZipFile(self.zip_path, "r") as source,
                zipfile.ZipFile(temp_path, "r") as written,
            ):
                mismatched = sorted(
                    f"{name} <- {origin}"
                    for name, origin in carried
                    if _stamp(written.getinfo(name)) != _stamp(source.getinfo(origin))
                )
        except (OSError, KeyError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP のページの中身を確認できませんでした: {error}"
            ) from error
        if mismatched:
            raise PageReorderError(
                f"運んだページの中身が出どころと一致しません: {mismatched}"
            )

    def _verify_replacements(self, temp_path: Path, expected: dict[str, bytes]) -> None:
        """中身を指定して書いたページが、その中身のまま書けているか確かめる。

        名前と CRC の検証（_verify_written）だけでは、差し替えたつもりで元の
        中身が残っていても気づけない。元を捨てる前に突き合わせる。

        突き合わせるのは大きさではなく CRC-32。長さが同じで中身が違う絵は
        大きさの照合をすり抜ける。差し替えは元の画素を捨てる操作なので、
        通った時点で利用者は「加工した」つもりのまま別の絵を掴み、元は戻らない。
        CRC-32 は ZIP の中央ディレクトリに既に入っていて、中身を読み直さずに
        引ける。

        _verify_written に混ぜていないのは、あちらが書き直しなら常に必要な検証で、
        こちらは中身を指定したときだけ意味を持つため。
        """
        if not expected:
            return
        try:
            with zipfile.ZipFile(temp_path, "r") as written:
                infos = [written.getinfo(name) for name in expected]
            stamps = {info.filename: _stamp(info) for info in infos}
        except (OSError, KeyError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP の差し替えを確認できませんでした: {error}"
            ) from error
        mismatched = sorted(
            name
            for name, stamp in stamps.items()
            if stamp != (len(expected[name]), zlib.crc32(expected[name]))
        )
        if mismatched:
            raise PageReorderError(
                f"差し替えたページの中身が一致しません: {mismatched}"
            )

    def _verify_extra_entries(self, temp_path: Path, extras: dict[str, bytes]) -> None:
        """書き足したエントリが渡した中身のまま書けているか確かめる。

        元画像は元のアーカイブを捨てた後では作り直せない。捨てる前に確かめる。
        """
        if not extras:
            return
        try:
            with zipfile.ZipFile(temp_path, "r") as written:
                mismatched = mismatched_entries(written, extras)
        except (OSError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP の書き足しを確認できませんでした: {error}"
            ) from error
        if mismatched:
            raise PageReorderError(
                f"書き足したエントリの大きさが一致しません: {mismatched}"
            )

    def _reject_name_collisions(self, names: tuple[str, ...]) -> None:
        """連番名が画像以外のエントリと衝突していないか確認する"""
        with zipfile.ZipFile(self.zip_path, "r") as archive:
            others = {
                info.filename
                for info in archive.infolist()
                if not info.is_dir() and not is_image_name(info.filename)
            }
        conflicts = sorted(others & set(names))
        if conflicts:
            raise PageReorderError(
                f"連番名が画像以外のエントリと衝突します: {conflicts}"
            )

    def _write_reordered(
        self,
        temp_path: Path,
        outputs: tuple[OutputPage, ...],
        names: tuple[str, ...],
        progress: ProgressCallback | None = None,
        replacements: dict[str, bytes] | None = None,
        extras: dict[str, bytes] | None = None,
    ) -> None:
        """書き直したページ列の ZIP を一時ファイルとして書き出す。

        outputs と names は位置で対応する。同じ source から 2 枚出す分割では
        名前を鍵にできないので、名前で引かず位置で回す。
        """
        replaced = replacements or {}
        added = extras or {}
        # いまのページは、出力に使うか落とすかが呼び出し前に決まっている。
        # ここで元の名前のまま運ぶと、書き直した連番と同名のエントリになる
        consumed = frozenset(page.name for page in self._pages)
        with (
            zipfile.ZipFile(self.zip_path, "r") as source,
            zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as destination,
        ):
            destination.comment = source.comment
            retained_dirs = _required_directories(source, consumed)
            for info in source.infolist():
                if info.filename in consumed:
                    continue
                if info.filename in added:
                    # 書き足す側で同じ名前を作る。両方入れると同名エントリになる
                    continue
                if info.is_dir() and info.filename not in retained_dirs:
                    # 画像が抜けて空になるフォルダは残さない
                    continue
                _copy_entry(source, destination, info, info.filename)

            for name, data in sorted(added.items()):
                destination.writestr(
                    new_entry_info(name), data, compresslevel=DEFLATE_LEVEL
                )

            total = len(outputs)
            for position, (output, name) in enumerate(
                zip(outputs, names, strict=True), 1
            ):
                _copy_entry(
                    source,
                    destination,
                    source.getinfo(output.source),
                    name,
                    convert=True,
                    replacement=_content_for(output, replaced),
                )
                if progress is not None:
                    progress(position, total)
