"""同期対象のフォルダで作成途中のZIPを公開せず、安全に置き換える。"""

import errno
import os
import shutil
import tempfile
from pathlib import Path


def create_archive_temp() -> Path:
    """ZIPの作成・検証用ファイルをOSの一時領域に排他生成する。"""
    handle, name = tempfile.mkstemp(prefix="manga-organizer-", suffix=".zip")
    os.close(handle)
    return Path(name)


def replace_archive(prepared: Path, destination: Path) -> None:
    """検証済みZIPを保存する。別ドライブでも元を直接上書きしない。"""
    try:
        os.replace(prepared, destination)
        return
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
        os.replace(pending, destination)
    finally:
        pending.unlink(missing_ok=True)
