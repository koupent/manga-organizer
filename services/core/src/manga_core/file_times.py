"""ファイルのタイムスタンプを退避・復元する。

ZIP を書き換えるとファイル自身の更新日時・作成日時が現在時刻に変わってしまう。
ページ順の修正は中身の並びだけを変える操作なので、書き換え前に採取した値を
書き換え後に戻し、ユーザーから見えるメタ情報を保つ。
"""

import ctypes
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Windows の FILETIME は 1601-01-01 起点の 100 ナノ秒刻み
_WINDOWS_EPOCH_OFFSET_NS = 11_644_473_600 * 10**9
_FILETIME_TICK_NS = 100

_GENERIC_WRITE = 0x4000_0000
_FILE_SHARE_ALL = 0x0000_0007
_OPEN_EXISTING = 3
_FILE_ATTRIBUTE_NORMAL = 0x0000_0080
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


@dataclass(frozen=True)
class FileTimes:
    """1 つのファイルから採取したタイムスタンプ一式"""

    access_ns: int
    modify_ns: int
    create_ns: int | None = None


class _FileTime(ctypes.Structure):
    """Windows API の FILETIME 構造体"""

    _fields_ = [
        ("low_date_time", ctypes.c_uint32),
        ("high_date_time", ctypes.c_uint32),
    ]


def capture_file_times(path: Path) -> FileTimes:
    """書き換え前のタイムスタンプを採取する"""
    stat_result = path.stat()
    create_ns = None
    if sys.platform == "win32":
        # Windows では st_ctime が作成日時。3.12 以降は st_birthtime_ns が使える
        create_ns = (
            getattr(stat_result, "st_birthtime_ns", None) or stat_result.st_ctime_ns
        )
    return FileTimes(
        access_ns=stat_result.st_atime_ns,
        modify_ns=stat_result.st_mtime_ns,
        create_ns=create_ns,
    )


def restore_file_times(path: Path, times: FileTimes) -> bool:
    """採取済みのタイムスタンプを書き戻す。完全に復元できたかを返す"""
    restored = True
    try:
        os.utime(path, ns=(times.access_ns, times.modify_ns))
    except OSError as error:
        logger.warning("更新日時の復元に失敗しました: %s", error)
        restored = False

    if sys.platform == "win32" and times.create_ns is not None:
        restored = _set_windows_creation_time(path, times.create_ns) and restored
    return restored


def _to_filetime(timestamp_ns: int) -> _FileTime:
    """UNIX エポックのナノ秒を Windows FILETIME に変換する"""
    ticks = (timestamp_ns + _WINDOWS_EPOCH_OFFSET_NS) // _FILETIME_TICK_NS
    return _FileTime(
        low_date_time=ticks & 0xFFFF_FFFF,
        high_date_time=(ticks >> 32) & 0xFFFF_FFFF,
    )


def _set_windows_creation_time(path: Path, create_ns: int) -> bool:
    """Windows の作成日時を SetFileTime で書き戻す"""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    except (AttributeError, OSError) as error:  # pragma: no cover - Windows 専用
        logger.warning("kernel32 を読み込めませんでした: %s", error)
        return False

    # wintypes は Windows でしか import できないため、ここで読み込む
    from ctypes import wintypes

    file_time_pointer = ctypes.POINTER(_FileTime)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.SetFileTime.argtypes = [
        wintypes.HANDLE,
        file_time_pointer,
        file_time_pointer,
        file_time_pointer,
    ]
    kernel32.SetFileTime.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.CreateFileW(
        str(path),
        _GENERIC_WRITE,
        _FILE_SHARE_ALL,
        None,
        _OPEN_EXISTING,
        _FILE_ATTRIBUTE_NORMAL,
        None,
    )
    if not handle or handle == _INVALID_HANDLE_VALUE:
        logger.warning(
            "作成日時の復元用にファイルを開けませんでした (%s): error=%s",
            path,
            ctypes.get_last_error(),
        )
        return False

    try:
        created = _to_filetime(create_ns)
        succeeded = kernel32.SetFileTime(handle, ctypes.byref(created), None, None)
        if not succeeded:
            logger.warning(
                "SetFileTime に失敗しました (%s): error=%s",
                path,
                ctypes.get_last_error(),
            )
        return bool(succeeded)
    finally:
        if not kernel32.CloseHandle(handle):
            logger.warning(
                "ハンドルを閉じられませんでした (%s): error=%s",
                path,
                ctypes.get_last_error(),
            )
