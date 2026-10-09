"""同期対象のフォルダで作成途中のZIPを公開せず、安全に置き換える。"""

import ctypes
import errno
import logging
import os
import shutil
import tempfile
from pathlib import Path

from manga_core.file_times import FileTimes, restore_file_times

logger = logging.getLogger(__name__)

_SHCNE_ATTRIBUTES = 0x800
_SHCNE_UPDATEDIR = 0x1000
_SHCNE_UPDATEITEM = 0x2000
_SHCNF_PATHW = 0x5
_SHCNF_FLUSH = 0x1000


def create_archive_temp() -> Path:
    """ZIPの作成・検証用ファイルをOSの一時領域に排他生成する。"""
    handle, name = tempfile.mkstemp(prefix="manga-organizer-", suffix=".zip")
    os.close(handle)
    return Path(name)


def replace_archive(
    prepared: Path, destination: Path, *, times: FileTimes | None = None
) -> bool:
    """日時まで整えたZIPを公開し、表示を更新する。日時の復元結果を返す。"""
    times_restored = True
    try:
        if times is not None:
            times_restored = restore_file_times(prepared, times)
        os.replace(prepared, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise

        # 別ドライブからはrenameできない。完成したZIPだけを同じフォルダへ
        # 転送し、最後に原子的に置き換える。圧縮・検証中の一時ZIPは同期しない。
        handle, name = tempfile.mkstemp(
            dir=destination.parent, prefix=".manga-organizer-save-", suffix=".tmp"
        )
        pending = Path(name)
        try:
            with os.fdopen(handle, "wb") as output, prepared.open("rb") as source:
                shutil.copyfileobj(source, output, length=1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            # コピー先の日時も公開前に確定する。公開後に書き換えると、同期側が
            # 置き換えと日時変更を別々の更新として扱い、表示通知も早すぎる。
            if times is not None:
                times_restored = restore_file_times(pending, times)
            os.replace(pending, destination)
        finally:
            pending.unlink(missing_ok=True)

    refresh_folder(destination.parent)
    return times_restored


def refresh_folder(folder: Path) -> None:
    """保存済みフォルダの古い同期アイコンをExplorerに読み直させる。"""
    if os.name != "nt":
        return
    try:
        notify = ctypes.WinDLL("shell32").SHChangeNotify
        notify.argtypes = [
            ctypes.c_long,
            ctypes.c_uint,
            ctypes.c_wchar_p,
            ctypes.c_void_p,
        ]
        notify.restype = None
        # 属性・アイコンと一覧の更新はそれぞれ通知する。SHCNF_PATHW |
        # SHCNF_FLUSH で配信完了まで待ち、直後のアプリ終了でも通知を落とさない。
        folder = folder.absolute()
        for changed in (folder, *folder.parents):
            for event in (_SHCNE_ATTRIBUTES, _SHCNE_UPDATEITEM, _SHCNE_UPDATEDIR):
                notify(event, _SHCNF_PATHW | _SHCNF_FLUSH, str(changed), None)
    except (AttributeError, OSError):
        # データの保存は完了している。表示だけの失敗で保存失敗とはしない。
        logger.warning("フォルダ表示の更新通知に失敗しました: %s", folder)
