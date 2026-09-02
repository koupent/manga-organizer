"""入れ子アーカイブの再帰展開を検証する"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.archive_handler import ArchiveHandler  # noqa: E402
from manga_core.safe_extract import (  # noqa: E402
    ExtractionBudget,
    ExtractionLimitExceeded,
    ExtractionLimits,
)


def page() -> bytes:
    """テスト用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def zip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の ZIP を作る"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


class NestedExtractionTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.handler = ArchiveHandler()
        self.addCleanup(self.handler.cleanup)

    def build_nested(self, levels: int) -> Path:
        """levels 段の入れ子アーカイブを作る。最深部にページが入る"""
        inner = zip_with(
            self.work_dir / "innermost.zip",
            {f"{i:03d}.jpg": page() for i in range(1, 4)},
        )
        current = inner
        for level in range(levels):
            wrapper = self.work_dir / f"level{level}.zip"
            wrapper_entries = {current.name: current.read_bytes()}
            zip_with(wrapper, wrapper_entries)
            current = wrapper
        return current

    def test_finds_pages_inside_multiply_nested_archives(self):
        # Arrange - ZIP の中に ZIP がさらに入っている
        outer = self.build_nested(levels=3)

        # Act
        image_dirs, _ = self.handler.process_archive(outer)

        # Assert
        self.assertEqual(1, len(image_dirs))
        found = sorted(p.name for p in image_dirs[0].iterdir() if p.suffix == ".jpg")
        self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], found)

    def test_stops_when_nesting_is_deeper_than_allowed(self):
        # Arrange
        outer = self.build_nested(levels=4)
        handler = ArchiveHandler(limits=ExtractionLimits(max_depth=2))
        self.addCleanup(handler.cleanup)

        # Act - 上限で打ち切られ、最深部までは届かない
        image_dirs, _ = handler.process_archive(outer)

        # Assert
        self.assertEqual([], image_dirs)

    def test_refuses_an_archive_that_declares_too_much_content(self):
        # Arrange - 展開前に申告サイズで見抜く
        bomb = zip_with(self.work_dir / "bomb.zip", {"big.bin": b"\0" * 2_000_000})
        handler = ArchiveHandler(limits=ExtractionLimits(max_total_bytes=1_000_000))
        self.addCleanup(handler.cleanup)

        # Act / Assert
        with self.assertRaises(ExtractionLimitExceeded):
            handler.process_archive(bomb)

    def test_counts_nested_archives_against_one_shared_budget(self):
        # Arrange - どちらの階層も単独では上限に収まるが、合計では超える。
        # 1段ごとの上限では多段の展開爆弾を止められないことの検証。
        inner = zip_with(self.work_dir / "inner.zip", {"a.bin": b"\0" * 1_000_000})
        outer = zip_with(
            self.work_dir / "outer.zip",
            {"inner.zip": inner.read_bytes(), "b.bin": b"\0" * 1_000_000},
        )
        handler = ArchiveHandler(
            budget=ExtractionBudget(ExtractionLimits(max_total_bytes=1_500_000))
        )
        self.addCleanup(handler.cleanup)

        # Act / Assert
        with self.assertRaises(ExtractionLimitExceeded):
            handler.process_archive(outer)

    def test_rejects_entries_that_escape_the_destination(self):
        # Arrange - zipfile は正規化するが、明示的に拒否して記録を残す
        escaping = self.work_dir / "escape.zip"
        with zipfile.ZipFile(escaping, "w") as archive:
            archive.writestr("../../escaped.jpg", page())
            archive.writestr("001.jpg", page())
        messages: list[str] = []
        handler = ArchiveHandler(log_callback=messages.append)
        self.addCleanup(handler.cleanup)

        # Act
        image_dirs, _ = handler.process_archive(escaping)

        # Assert - 展開先の外にファイルが作られていない
        self.assertFalse((self.work_dir.parent / "escaped.jpg").exists())
        self.assertTrue(any("危険なエントリ" in m for m in messages), messages)
        self.assertEqual(1, len(image_dirs))


if __name__ == "__main__":
    unittest.main()
