"""ページ修正モードの対象ファイル選別を検証する"""

import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from gui.page_editor_panel import collect_editable_archives  # noqa: E402


class CollectEditableArchivesTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def make(self, name: str) -> Path:
        """空の ZIP などのファイルを 1 つ作る"""
        path = self.work_dir / name
        if path.suffix.lower() in {".zip", ".cbz"}:
            with zipfile.ZipFile(path, "w"):
                pass
        else:
            path.write_bytes(b"x")
        return path

    def test_keeps_only_zip_and_cbz(self):
        # Arrange
        paths = [
            self.make("a.zip"),
            self.make("b.cbz"),
            self.make("c.rar"),
            self.make("d.7z"),
            self.make("e.txt"),
        ]

        # Act
        collected = collect_editable_archives(paths)

        # Assert
        self.assertEqual(["a.zip", "b.cbz"], [path.name for path in collected])

    def test_ignores_paths_that_do_not_exist(self):
        # Arrange
        paths = [self.make("a.zip"), self.work_dir / "missing.zip"]

        # Act / Assert
        self.assertEqual(["a.zip"], [p.name for p in collect_editable_archives(paths)])

    def test_ignores_directories(self):
        # Arrange
        directory = self.work_dir / "folder.zip"
        directory.mkdir()

        # Act / Assert
        self.assertEqual([], collect_editable_archives([directory]))

    def test_removes_duplicates(self):
        # Arrange
        archive = self.make("a.zip")

        # Act
        collected = collect_editable_archives([archive, archive, str(archive)])

        # Assert
        self.assertEqual(1, len(collected))

    def test_orders_naturally_including_mixed_names(self):
        # Arrange
        for name in ("10.zip", "2.zip", "cover.zip", "001.zip"):
            self.make(name)
        paths = list(self.work_dir.glob("*.zip"))

        # Act
        collected = collect_editable_archives(paths)

        # Assert
        self.assertEqual(
            ["001.zip", "2.zip", "10.zip", "cover.zip"],
            [path.name for path in collected],
        )

    def test_accepts_plain_strings(self):
        # Arrange
        archive = self.make("a.zip")

        # Act / Assert
        self.assertEqual([archive.resolve()], collect_editable_archives([str(archive)]))


if __name__ == "__main__":
    unittest.main()
