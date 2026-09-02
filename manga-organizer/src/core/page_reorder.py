"""ZIP アーカイブ内のページ順を手動で修正するためのコア処理。

漫画ビューアは ZIP の格納順ではなくファイル名順でページを表示するため、
「並び替え」は実質的に「エントリのリネーム」になる。ここでは全ページを
展開せずに ZIP を書き直し、各エントリの日時・圧縮方式と、ZIP ファイル
自身のタイムスタンプを保ったまま連番を振り直す。
"""

import logging
import os
import struct
import tempfile
import threading
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from utils.file_times import capture_file_times, restore_file_times
from utils.naming import natural_sort_key

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".avif"}
EDITABLE_SUFFIXES = {".zip", ".cbz"}
MIN_NAME_DIGITS = 3
# 画像は既に圧縮済みなので、高い圧縮レベルは時間を使うだけで容量は減らない
DEFLATE_LEVEL = 1
TEMP_PREFIX = ".reorder-"
TEMP_SUFFIX = ".tmp"
# Zip64 拡張情報はオフセットを含み、書き直した ZIP では無効になる
_ZIP64_EXTRA_ID = 0x0001
_EXTRA_HEADER_STRUCT = struct.Struct("<HH")


class PageReorderError(RuntimeError):
    """並び替えの前提条件が満たされない場合に送出する"""


@dataclass(frozen=True)
class PageEntry:
    """ZIP 内の 1 ページ分のメタ情報"""

    name: str
    size: int
    modified: str


@dataclass(frozen=True)
class ReorderResult:
    """並び替えの実行結果"""

    changed: bool
    page_count: int
    renamed_count: int
    times_restored: bool


def is_image_name(name: str) -> bool:
    """アーカイブ内のエントリ名が画像かどうかを判定する"""
    return Path(name).suffix.lower() in IMAGE_EXTENSIONS


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


def _copy_entry(
    source: zipfile.ZipFile,
    destination: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    arcname: str,
) -> None:
    """エントリを新しい名前でコピーする(中身のバイト列は変えない)"""
    data = source.read(info)
    copied = zipfile.ZipInfo(arcname, date_time=info.date_time)
    copied.compress_type = info.compress_type
    copied.external_attr = info.external_attr
    copied.internal_attr = info.internal_attr
    copied.create_system = info.create_system
    copied.comment = info.comment
    copied.extra = _portable_extra(info.extra)
    level = DEFLATE_LEVEL if info.compress_type == zipfile.ZIP_DEFLATED else None
    destination.writestr(copied, data, compresslevel=level)


def _required_directories(source: zipfile.ZipFile, renames: dict[str, str]) -> set[str]:
    """書き直した後も中身が残るディレクトリエントリの名前を集める"""
    required: set[str] = set()
    for info in source.infolist():
        if info.is_dir() or info.filename in renames:
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

    def apply_order(self, ordered_names, progress=None) -> ReorderResult:
        """指定された順序で連番を振り直し、ZIP をその場で置き換える"""
        with self._lock:
            ordered = tuple(ordered_names)
            self._validate_order(ordered)
            renames = self._build_renames(ordered)

            current = tuple(page.name for page in self._pages)
            renamed_nothing = all(old == new for old, new in renames.items())
            if renamed_nothing and ordered == current:
                return ReorderResult(
                    changed=False,
                    page_count=len(ordered),
                    renamed_count=0,
                    times_restored=True,
                )

            self.close()
            original_times = capture_file_times(self.zip_path)
            temp_path = self._create_temp_file()
            try:
                self._write_reordered(temp_path, ordered, renames, progress)
                self._verify_written(temp_path, ordered, renames)
                os.replace(temp_path, self.zip_path)
            finally:
                # 置き換えに成功していれば既に消えている
                temp_path.unlink(missing_ok=True)

            times_restored = restore_file_times(self.zip_path, original_times)
            self._pages = self._load_pages()
            return ReorderResult(
                changed=True,
                page_count=len(ordered),
                renamed_count=sum(1 for old, new in renames.items() if old != new),
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
        self, temp_path: Path, ordered: tuple[str, ...], renames: dict[str, str]
    ) -> None:
        """置き換える前に、書き上げた ZIP を読み直して中身を確かめる。

        元のアーカイブを捨ててから壊れていたと分かっても取り返しがつかない。
        """
        try:
            with zipfile.ZipFile(temp_path, "r") as written:
                written_names = written.namelist()
        except (OSError, zipfile.BadZipFile) as error:
            raise PageReorderError(
                f"書き出した ZIP を読み直せませんでした: {error}"
            ) from error

        expected = {renames[name] for name in ordered}
        missing = sorted(expected - set(written_names))
        if missing:
            raise PageReorderError(f"書き出した ZIP にページが足りません: {missing}")
        if len(written_names) != len(set(written_names)):
            raise PageReorderError("書き出した ZIP に同名エントリが含まれています")

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

    def _build_renames(self, ordered: tuple[str, ...]) -> dict[str, str]:
        """旧エントリ名から新しい連番名への対応表を作る"""
        digits = max(MIN_NAME_DIGITS, len(str(len(ordered))))
        renames = {
            name: f"{position:0{digits}d}{Path(name).suffix.lower()}"
            for position, name in enumerate(ordered, 1)
        }
        self._reject_name_collisions(renames)
        return renames

    def _reject_name_collisions(self, renames: dict[str, str]) -> None:
        """連番名が画像以外のエントリと衝突していないか確認する"""
        with zipfile.ZipFile(self.zip_path, "r") as archive:
            others = {
                info.filename
                for info in archive.infolist()
                if not info.is_dir() and not is_image_name(info.filename)
            }
        conflicts = sorted(others & set(renames.values()))
        if conflicts:
            raise PageReorderError(
                f"連番名が画像以外のエントリと衝突します: {conflicts}"
            )

    def _write_reordered(
        self,
        temp_path: Path,
        ordered: tuple[str, ...],
        renames: dict[str, str],
        progress=None,
    ) -> None:
        """新しい並び順の ZIP を一時ファイルとして書き出す"""
        with (
            zipfile.ZipFile(self.zip_path, "r") as source,
            zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as destination,
        ):
            destination.comment = source.comment
            retained_dirs = _required_directories(source, renames)
            for info in source.infolist():
                if info.filename in renames:
                    continue
                if info.is_dir() and info.filename not in retained_dirs:
                    # 画像が抜けて空になるフォルダは残さない
                    continue
                _copy_entry(source, destination, info, info.filename)

            total = len(ordered)
            for position, name in enumerate(ordered, 1):
                _copy_entry(source, destination, source.getinfo(name), renames[name])
                if progress is not None:
                    progress(position, total)
