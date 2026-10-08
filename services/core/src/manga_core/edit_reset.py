"""最初のファイル編集前のZIPを同梱し、全編集を一括で戻す。"""

import shutil
import zipfile
from pathlib import Path

from manga_core.archive_save import create_archive_temp, replace_archive
from manga_core.file_times import capture_file_times, restore_file_times
from manga_core.original_store import recorded_edits

# 整理時の入れ子アーカイブ展開へ巻き込まれない拡張子にする。
BACKUP_ENTRY = ".manga-organizer/before-edit.bin"


def preserve_before_edit(prepared: Path, source: Path) -> None:
    """検証済みの保存内容へ、一度だけ編集前の本を追加する。

    ZIPは既に圧縮されているので再圧縮しない。旧版で編集済みの本を
    編集前と偽って保存しない。以降の保存では既存の同梱物として引き継ぐ。
    """
    if not recorded_edits(prepared):
        return
    with zipfile.ZipFile(source) as archive:
        if BACKUP_ENTRY in archive.namelist() or recorded_edits(source):
            return
    with zipfile.ZipFile(prepared, "a") as archive:
        archive.write(source, BACKUP_ENTRY, compress_type=zipfile.ZIP_STORED)
    # 元ファイルを置き換える前に、同梱したバイト列のCRCを検証する。
    with zipfile.ZipFile(prepared) as archive, archive.open(BACKUP_ENTRY) as backup:
        while backup.read(1024 * 1024):
            pass


def reset_edits(path: Path) -> None:
    """編集前のZIPを検証して原子的に戻す。名前と保存場所は変更しない。"""
    times = capture_file_times(path)
    temp = create_archive_temp()
    try:
        with zipfile.ZipFile(path) as archive:
            if BACKUP_ENTRY not in archive.namelist():
                raise ValueError(
                    "編集前の本が保存されていないため、すべての編集を戻せません。"
                    "旧版で編集した本は、元のファイルから復元してください。"
                )
            info = archive.getinfo(BACKUP_ENTRY)
            if info.compress_type != zipfile.ZIP_STORED:
                raise ValueError("編集前の本の記録が不正です")
            with archive.open(info) as source, temp.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
        with zipfile.ZipFile(temp) as archive:
            if archive.testzip() is not None or BACKUP_ENTRY in archive.namelist():
                raise ValueError("編集前の本が壊れているため復元できません")
        if recorded_edits(temp):
            raise ValueError("編集前の本の記録が不正です")
        replace_archive(temp, path)
        restore_file_times(path, times)
    finally:
        temp.unlink(missing_ok=True)
