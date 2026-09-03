"""表紙の加工。

suzume-viewer は表紙を縦長 2:3 の枠に中央クロップで描く（`manga_cover.dart`）。
見開きが先頭にあると背表紙付近だけが拡大表示され、表紙が見えない。先頭画像を
分割・切り抜き・回転して整える。

viewer は辞書順で先頭のページを表紙として描くため、途中の絵をサムネイルに
したい場合は先頭へ移すしかない。その並べ替えは page_reorder に任せる。

ZIP 内の実画像を差し替える破壊的操作なので、page_reorder と同じ安全機構
（排他生成した一時ファイル、書き込み検証、原子的置換、タイムスタンプ保持）
を通す。
"""

import io
import logging
import os
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from manga_core.file_times import capture_file_times, restore_file_times
from manga_core.page_reorder import PageEntry, PageReorderError, ZipPageEditor
from manga_core.viewer_contract import (
    VIEWER_IMAGE_EXTENSIONS,
    output_suffix,
    sequential_name,
)

logger = logging.getLogger(__name__)

# viewer が表紙を描く枠の縦横比（AspectRatio(2 / 3)）
COVER_ASPECT_RATIO = 2 / 3

# これより横長なら見開きとみなす。単ページは 2:3 前後なので余裕がある
SPREAD_RATIO_THRESHOLD = 1.2

QUARTER_TURNS = (0, 90, 180, 270)
TEMP_PREFIX = ".cover-"
TEMP_SUFFIX = ".tmp"


class CoverEditError(RuntimeError):
    """表紙を加工できない"""


@dataclass(frozen=True)
class CoverTransform:
    """表紙に加える操作。分割 → 切り抜き → 回転の順に適用する"""

    split: str | None = None
    crop: tuple[int, int, int, int] | None = None
    rotate: int = 0


@dataclass(frozen=True)
class CoverResult:
    """加工の結果"""

    name: str
    width: int
    height: int
    renamed: bool


def is_spread(width: int, height: int) -> bool:
    """見開き（横長）かどうか"""
    if height <= 0:
        return False
    return width / height >= SPREAD_RATIO_THRESHOLD


def _split_half(image: Image.Image, side: str) -> Image.Image:
    """見開きを左右に割る。右綴じなので既定は右側が表"""
    if side not in ("left", "right"):
        raise CoverEditError(f"分割の指定が不正です: {side}")
    middle = image.width // 2
    box = (
        (0, 0, middle, image.height)
        if side == "left"
        else (middle, 0, image.width, image.height)
    )
    return image.crop(box)


def _crop(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    """指定範囲を切り出す"""
    left, upper, right, lower = box
    if right <= left or lower <= upper:
        raise CoverEditError(f"切り抜き範囲が空です: {box}")
    if left < 0 or upper < 0 or right > image.width or lower > image.height:
        raise CoverEditError(
            f"切り抜き範囲が画像の外です: {box} (画像は {image.width}x{image.height})"
        )
    return image.crop(box)


def _rotate(image: Image.Image, degrees: int) -> Image.Image:
    """90 度単位で回す。任意角度は余白が出るため受け付けない"""
    if degrees % 360 not in QUARTER_TURNS:
        raise CoverEditError(f"回転は 90 度単位のみです: {degrees}")
    if degrees % 360 == 0:
        return image
    return image.rotate(-(degrees % 360), expand=True)


def _output_format(name: str) -> tuple[str, str]:
    """書き出す形式と拡張子。viewer が読めない形式は PNG へ移す"""
    suffix = output_suffix(Path(name).suffix)
    if suffix not in VIEWER_IMAGE_EXTENSIONS:
        suffix = ".png"
    formats = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}
    return formats.get(suffix, "PNG"), suffix


def transform_image(
    data: bytes, transform: CoverTransform, name: str = "cover.jpg"
) -> bytes:
    """1 枚の画像に加工を適用する"""
    try:
        with Image.open(io.BytesIO(data)) as opened:
            image = opened.convert("RGB")
    except OSError as error:
        raise CoverEditError(f"画像を読めません: {error}") from error

    if transform.split:
        image = _split_half(image, transform.split)
    if transform.crop:
        image = _crop(image, transform.crop)
    image = _rotate(image, transform.rotate)

    fmt, _ = _output_format(name)
    buffer = io.BytesIO()
    if fmt == "JPEG":
        image.save(buffer, fmt, quality=92, optimize=True)
    else:
        image.save(buffer, fmt, optimize=True)
    return buffer.getvalue()


def apply_to_archive(
    archive_path: Path,
    name: str,
    transform: CoverTransform,
    make_first: bool = False,
) -> CoverResult:
    """アーカイブ内の 1 枚を加工して差し替える。

    make_first を立てると、加工した 1 枚をサムネイル（先頭ページ）へ移す。
    どちらの経路でも、元を捨てる前に書き上げた ZIP を読み直して確かめ、
    原子的に置き換える。
    """
    archive_path = Path(archive_path)
    if make_first:
        return _move_to_front(archive_path, name, transform)
    return _replace_in_place(archive_path, name, transform)


def _replace_in_place(
    archive_path: Path, name: str, transform: CoverTransform
) -> CoverResult:
    """加工した 1 枚を、同じ位置のまま差し替える"""
    with zipfile.ZipFile(archive_path, "r") as source:
        try:
            info = source.getinfo(name)
        except KeyError as error:
            raise CoverEditError(f"アーカイブに存在しません: {name}") from error
        original = source.read(info)

    # 加工に失敗したらここで止まる。元のアーカイブには触れていない
    produced = transform_image(original, transform, name)
    _, suffix = _output_format(name)
    new_name = str(Path(name).with_suffix(suffix))

    times = capture_file_times(archive_path)
    handle, temp_name = tempfile.mkstemp(
        dir=archive_path.parent,
        prefix=archive_path.name + TEMP_PREFIX,
        suffix=TEMP_SUFFIX,
    )
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        _write_replacement(archive_path, temp_path, name, new_name, produced)
        _verify(temp_path, new_name, len(produced))
        os.replace(temp_path, archive_path)
    finally:
        temp_path.unlink(missing_ok=True)

    restore_file_times(archive_path, times)
    with Image.open(io.BytesIO(produced)) as written:
        size = written.size
    return CoverResult(
        name=new_name, width=size[0], height=size[1], renamed=new_name != name
    )


def _front_first_order(name: str, pages: tuple[PageEntry, ...]) -> tuple[str, ...]:
    """選んだページを先頭に、残りは元の並びのまま続く順序を組み立てる。

    元の並びは page_reorder が示すページ一覧の順をそのまま使う。ここで独自に
    並べ替えると、利用者がページ修正画面で見ている順と食い違う。
    """
    return (name,) + tuple(page.name for page in pages if page.name != name)


def _move_to_front(
    archive_path: Path, name: str, transform: CoverTransform
) -> CoverResult:
    """加工した 1 枚を先頭ページへ移し、画像エントリの連番を振り直す。

    加工と並べ替えを page_reorder の 1 回の書き直しに委ねる。別々に適用すると、
    加工だけ済んで並べ替えに失敗した中途半端なアーカイブが残る。連番の付け方や
    ページとみなす条件も page_reorder と一致させないと、viewer 側で順序が崩れる。
    """
    try:
        editor = ZipPageEditor(archive_path)
    except PageReorderError as error:
        raise CoverEditError(str(error)) from error

    try:
        original = editor.read_entry(name)
        # 加工に失敗したらここで止まる。元のアーカイブには触れていない
        produced = transform_image(original, transform, name)
        ordered = _front_first_order(name, editor.pages)
        editor.apply_order(ordered, replacements={name: produced})
    except PageReorderError as error:
        raise CoverEditError(str(error)) from error
    finally:
        editor.close()

    _, suffix = _output_format(name)
    new_name = sequential_name(1, len(ordered), suffix)
    with Image.open(io.BytesIO(produced)) as written:
        size = written.size
    return CoverResult(
        name=new_name, width=size[0], height=size[1], renamed=new_name != name
    )


def _write_replacement(
    archive_path: Path, temp_path: Path, old_name: str, new_name: str, produced: bytes
) -> None:
    """対象の 1 枚だけ差し替えた ZIP を書き出す。他はバイト列を変えない"""
    with (
        zipfile.ZipFile(archive_path, "r") as source,
        zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as destination,
    ):
        destination.comment = source.comment
        for info in source.infolist():
            if info.is_dir():
                continue
            if info.filename == old_name:
                replaced = zipfile.ZipInfo(new_name, date_time=info.date_time)
                replaced.compress_type = zipfile.ZIP_DEFLATED
                replaced.external_attr = info.external_attr
                destination.writestr(replaced, produced)
                continue
            copied = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            copied.compress_type = info.compress_type
            copied.external_attr = info.external_attr
            copied.comment = info.comment
            destination.writestr(copied, source.read(info))


def _verify(temp_path: Path, new_name: str, expected_size: int) -> None:
    """置き換える前に、書き上げた ZIP を読み直して確かめる"""
    try:
        with zipfile.ZipFile(temp_path, "r") as written:
            if new_name not in written.namelist():
                raise CoverEditError(f"書き出した ZIP に {new_name} がありません")
            if written.getinfo(new_name).file_size != expected_size:
                raise CoverEditError("書き出した表紙のサイズが一致しません")
            damaged = written.testzip()
    except (OSError, zipfile.BadZipFile) as error:
        raise CoverEditError(
            f"書き出した ZIP を検証できませんでした: {error}"
        ) from error
    if damaged is not None:
        raise CoverEditError(f"書き出した ZIP の内容が壊れています: {damaged}")

    with open(temp_path, "rb") as stream:
        os.fsync(stream.fileno())
