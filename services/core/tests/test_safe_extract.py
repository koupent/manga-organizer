"""展開の安全弁を検証する。

雑に梱包されたアーカイブを丸ごと投入する使い方なので、悪意のない壊れた
アーカイブでもディスクを埋め尽くさないこと、展開先の外へ書き出さないことを
保証する必要がある。
"""

import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.safe_extract import (  # noqa: E402
    DEFAULT_LIMITS,
    ExtractionBudget,
    ExtractionLimitExceeded,
    ExtractionLimits,
    UnsafeEntryName,
    declared_size,
    safe_destination,
)


class SafeDestinationTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name).resolve()

    def test_resolves_a_normal_entry_under_the_destination(self):
        # Act
        resolved = safe_destination("pages/001.jpg", self.root)

        # Assert
        self.assertEqual(self.root / "pages" / "001.jpg", resolved)

    def test_rejects_parent_traversal(self):
        for name in ("../escape.jpg", "pages/../../escape.jpg", "a/../../b.jpg"):
            with self.subTest(name=name), self.assertRaises(UnsafeEntryName):
                safe_destination(name, self.root)

    def test_rejects_absolute_paths(self):
        for name in ("/etc/passwd", "//server/share/x.jpg"):
            with self.subTest(name=name), self.assertRaises(UnsafeEntryName):
                safe_destination(name, self.root)

    def test_rejects_windows_style_absolute_and_traversal(self):
        # 7z や unrar は Windows 形式の区切りをそのまま渡してくることがある
        for name in (r"C:\Windows\system32\x.jpg", r"..\..\escape.jpg"):
            with self.subTest(name=name), self.assertRaises(UnsafeEntryName):
                safe_destination(name, self.root)

    def test_allows_a_harmless_dot_segment(self):
        # Act / Assert - 展開先の内側に収まるので許す
        self.assertEqual(
            self.root / "pages" / "001.jpg",
            safe_destination("pages/./001.jpg", self.root),
        )


class ExtractionBudgetTest(unittest.TestCase):
    def test_consumes_until_the_byte_limit_is_reached(self):
        # Arrange
        budget = ExtractionBudget(ExtractionLimits(max_total_bytes=100, max_entries=10))

        # Act
        budget.consume_bytes(60)
        budget.consume_bytes(40)

        # Assert
        with self.assertRaises(ExtractionLimitExceeded):
            budget.consume_bytes(1)

    def test_counts_entries_across_nested_archives(self):
        # Arrange - 入れ子の合計で数える
        budget = ExtractionBudget(
            ExtractionLimits(max_total_bytes=10**9, max_entries=3)
        )

        # Act / Assert
        for _ in range(3):
            budget.consume_entry()
        with self.assertRaises(ExtractionLimitExceeded):
            budget.consume_entry()

    def test_reports_how_much_is_left(self):
        # Arrange
        budget = ExtractionBudget(ExtractionLimits(max_total_bytes=100, max_entries=5))

        # Act
        budget.consume_bytes(30)

        # Assert
        self.assertEqual(70, budget.remaining_bytes)

    def test_depth_is_limited(self):
        # Arrange
        budget = ExtractionBudget(ExtractionLimits(max_depth=2))

        # Act / Assert
        self.assertTrue(budget.may_descend(0))
        self.assertTrue(budget.may_descend(1))
        self.assertFalse(budget.may_descend(2))

    def test_default_limits_are_generous_enough_for_real_volumes(self):
        # Arrange - 200ページ 200MB の巻を 20 巻でも通る余裕
        budget = ExtractionBudget(DEFAULT_LIMITS)

        # Act / Assert
        budget.consume_bytes(4 * 1024**3)
        for _ in range(4000):
            budget.consume_entry()


class DeclaredSizeTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name).resolve()

    def test_reads_the_uncompressed_size_from_the_central_directory(self):
        # Arrange - 展開前に膨張を見抜けるようにする
        archive = self.root / "bomb.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("big.bin", b"\0" * 5_000_000)

        # Act
        total, entries = declared_size(archive)

        # Assert
        self.assertEqual(5_000_000, total)
        self.assertEqual(1, entries)

    def test_returns_none_for_formats_it_cannot_inspect(self):
        # Arrange
        archive = self.root / "unknown.7z"
        archive.write_bytes(b"not really a 7z")

        # Act / Assert
        self.assertIsNone(declared_size(archive))


if __name__ == "__main__":
    unittest.main()
