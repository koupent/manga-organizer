"""展開の安全弁。

雑に梱包されたアーカイブを丸ごと投入する使い方なので、悪意のない壊れた
アーカイブでもディスクを埋め尽くさないこと、展開先の外へ書き出さないことを
保証する必要がある。入れ子は合計で数え、途中で打ち切れるようにする。
"""

import logging
import ntpath
import posixpath
import threading
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

logger = logging.getLogger(__name__)


class UnsafeEntryName(ValueError):
    """展開先の外を指すエントリ名"""


class ExtractionLimitExceeded(RuntimeError):
    """展開量が上限を超えた"""


@dataclass(frozen=True)
class ExtractionLimits:
    """1 回の投入で許す展開量。

    既定値は「200MB の巻を 20 冊」を余裕を持って通せる範囲にしてある。
    実運用で足りなくなるより、暴走を止められることを優先する。
    """

    max_total_bytes: int = 16 * 1024**3
    max_entries: int = 200_000
    max_depth: int = 10


DEFAULT_LIMITS = ExtractionLimits()


class ExtractionBudget:
    """入れ子をまたいで残量を数える。

    1 段ごとに上限を設けても、入れ子を重ねれば合計は青天井になる。合計で
    数えることで、多段の展開爆弾も止まる。
    """

    def __init__(self, limits: ExtractionLimits = DEFAULT_LIMITS):
        self.limits = limits
        self._lock = threading.Lock()
        self._bytes = 0
        self._entries = 0

    @property
    def used_bytes(self) -> int:
        """これまでに展開したバイト数"""
        with self._lock:
            return self._bytes

    @property
    def remaining_bytes(self) -> int:
        """残りバイト数"""
        with self._lock:
            return max(0, self.limits.max_total_bytes - self._bytes)

    def consume_bytes(self, amount: int) -> None:
        """展開したバイト数を計上する"""
        with self._lock:
            self._bytes += amount
            if self._bytes > self.limits.max_total_bytes:
                raise ExtractionLimitExceeded(
                    f"展開量が上限を超えました "
                    f"({self._bytes} > {self.limits.max_total_bytes} バイト)"
                )

    def consume_entry(self, count: int = 1) -> None:
        """展開したエントリ数を計上する"""
        with self._lock:
            self._entries += count
            if self._entries > self.limits.max_entries:
                raise ExtractionLimitExceeded(
                    f"エントリ数が上限を超えました "
                    f"({self._entries} > {self.limits.max_entries} 件)"
                )

    def may_descend(self, depth: int) -> bool:
        """この深さから、さらに入れ子を開いてよいか"""
        return depth < self.limits.max_depth


def safe_destination(name: str, destination: Path) -> Path:
    """エントリ名を展開先の中の絶対パスへ解決する。

    zipfile.extract は名前を正規化するが、7-Zip や unrar を経由する経路は
    こちらで検証しないと素通りする。Windows 形式の区切りとドライブ指定も
    弾く必要がある。
    """
    if not name or name in (".", ".."):
        raise UnsafeEntryName(name)
    if ntpath.splitdrive(name)[0]:
        raise UnsafeEntryName(name)

    normalized = name.replace("\\", "/")
    if posixpath.isabs(normalized):
        raise UnsafeEntryName(name)

    parts = [p for p in PurePosixPath(normalized).parts if p not in ("", ".")]
    if any(part == ".." for part in parts):
        raise UnsafeEntryName(name)
    if not parts:
        raise UnsafeEntryName(name)

    root = destination.resolve()
    resolved = (root / Path(*parts)).resolve()
    if not resolved.is_relative_to(root):
        raise UnsafeEntryName(name)
    return resolved


def declared_size(archive_path: Path) -> tuple[int, int] | None:
    """中央ディレクトリが申告する展開後サイズとエントリ数。

    展開する前に膨張を見抜けると、書き出しを始める前に断れる。読めない形式
    では None を返し、呼び出し側は実測に頼る。
    """
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            return sum(info.file_size for info in infos), len(infos)
    except (OSError, zipfile.BadZipFile):
        return None
