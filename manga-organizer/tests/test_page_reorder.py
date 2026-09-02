"""ZIP のページ並び替えが中身とメタ情報を壊さないことを検証する"""

import os
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core.page_reorder import (  # noqa: E402
    PageReorderError,
    ZipPageEditor,
)

PAGE_DATE_TIME = (2019, 5, 4, 12, 30, 0)
COMIC_INFO = b"<ComicInfo><Series>Test</Series></ComicInfo>"


def build_archive(path: Path, names, extra_entries=None) -> dict[str, bytes]:
    """テスト用 ZIP を作り、エントリ名から中身への対応表を返す"""
    payloads = {name: f"payload-{name}".encode() for name in names}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in payloads.items():
            info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
        for name, data in (extra_entries or {}).items():
            archive.writestr(zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME), data)
    return payloads


class ZipPageEditorTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"

    def test_lists_pages_in_natural_order(self):
        # Arrange
        build_archive(self.archive_path, ["p10.jpg", "p2.jpg", "p1.jpg"])

        # Act
        pages = ZipPageEditor(self.archive_path).pages

        # Assert
        self.assertEqual(["p1.jpg", "p2.jpg", "p10.jpg"], [p.name for p in pages])

    def test_applies_new_order_as_sequential_names(self):
        # Arrange
        payloads = build_archive(self.archive_path, ["a.jpg", "b.png", "c.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        result = editor.apply_order(["c.jpg", "a.jpg", "b.png"])

        # Assert
        self.assertTrue(result.changed)
        self.assertEqual(3, result.page_count)
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.png"], archive.namelist())
            self.assertEqual(payloads["c.jpg"], archive.read("001.jpg"))
            self.assertEqual(payloads["a.jpg"], archive.read("002.jpg"))
            self.assertEqual(payloads["b.png"], archive.read("003.png"))

    def test_preserves_entry_timestamps_and_compression(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            for info in archive.infolist():
                self.assertEqual(PAGE_DATE_TIME, info.date_time)
                self.assertEqual(zipfile.ZIP_DEFLATED, info.compress_type)

    def test_preserves_archive_file_modification_time(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        past = 1_000_000_000
        os.utime(self.archive_path, (past, past))
        editor = ZipPageEditor(self.archive_path)

        # Act
        result = editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        self.assertTrue(result.times_restored)
        self.assertEqual(past, int(self.archive_path.stat().st_mtime))

    def test_keeps_non_image_entries(self):
        # Arrange
        build_archive(
            self.archive_path,
            ["a.jpg", "b.jpg"],
            extra_entries={"ComicInfo.xml": COMIC_INFO},
        )
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(COMIC_INFO, archive.read("ComicInfo.xml"))
            self.assertEqual(
                ["ComicInfo.xml", "001.jpg", "002.jpg"], archive.namelist()
            )
            self.assertEqual(PAGE_DATE_TIME, archive.getinfo("ComicInfo.xml").date_time)

    def test_flattens_pages_stored_in_subdirectories(self):
        # Arrange
        payloads = build_archive(self.archive_path, ["vol/02.jpg", "vol/01.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["vol/02.jpg", "vol/01.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg"], archive.namelist())
            self.assertEqual(payloads["vol/02.jpg"], archive.read("001.jpg"))

    def test_uses_four_digits_when_page_count_exceeds_999(self):
        # Arrange
        names = [f"p{index}.jpg" for index in range(1, 1001)]
        build_archive(self.archive_path, names)
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order([page.name for page in editor.pages])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual("0001.jpg", archive.namelist()[0])
            self.assertEqual("1000.jpg", archive.namelist()[-1])

    def test_reports_no_change_when_order_already_sequential(self):
        # Arrange
        build_archive(self.archive_path, ["001.jpg", "002.jpg"])
        editor = ZipPageEditor(self.archive_path)
        before = self.archive_path.read_bytes()

        # Act
        result = editor.apply_order(["001.jpg", "002.jpg"])

        # Assert
        self.assertFalse(result.changed)
        self.assertEqual(before, self.archive_path.read_bytes())

    def test_rejects_order_that_does_not_match_page_list(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act / Assert
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg"])
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg", "a.jpg"])
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg", "zzz.jpg"])

    def test_rejects_collision_with_non_image_entry(self):
        # Arrange
        build_archive(
            self.archive_path, ["a.jpg", "b.jpg"], extra_entries={"001.jpg.txt": b"x"}
        )
        build_archive(
            self.archive_path, ["a.jpg", "b.jpg"], extra_entries={"001.txt": b"x"}
        )
        editor = ZipPageEditor(self.archive_path)
        renamed = self.work_dir / "collide.zip"
        with zipfile.ZipFile(self.archive_path) as source:
            with zipfile.ZipFile(renamed, "w") as destination:
                for info in source.infolist():
                    name = "001.jpg" if info.filename == "001.txt" else info.filename
                    destination.writestr(name, source.read(info))
        editor = ZipPageEditor(renamed)

        # Act / Assert
        with self.assertRaises(PageReorderError):
            editor.apply_order(["b.jpg", "a.jpg"])

    def test_leaves_archive_untouched_when_write_fails(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)
        before = self.archive_path.read_bytes()

        def explode(current, total):
            raise OSError("disk full")

        # Act / Assert
        with self.assertRaises(OSError):
            editor.apply_order(["b.jpg", "a.jpg"], progress=explode)
        self.assertEqual(before, self.archive_path.read_bytes())
        self.assertEqual([], list(self.work_dir.glob("*.reorder-tmp")))

    def test_rejects_unsupported_archive_format(self):
        # Arrange
        rar_path = self.work_dir / "volume.rar"
        rar_path.write_bytes(b"not a zip")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(rar_path)

    def test_rejects_archive_without_images(self):
        # Arrange
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("readme.txt", b"hello")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(self.archive_path)


class ArchiveIntegrityTest(unittest.TestCase):
    """壊れたら戻らないデータを守るための検証"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"

    def test_rejects_archive_with_duplicate_image_names(self):
        # Arrange - ZIP 形式は同名エントリを許すが、
        # 名前でページを指す API では区別できない
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("a.jpg", b"first")
            archive.writestr("a.jpg", b"second")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(self.archive_path)

    def test_preserves_extra_fields_of_entries(self):
        # Arrange - Info-ZIP の UT フィールド（高精度タイムスタンプ）
        unix_time_extra = b"\x55\x54\x05\x00\x01\x40\xe2\x01\x00"
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            for name in ("b.jpg", "a.jpg"):
                info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
                info.extra = unix_time_extra
                archive.writestr(info, b"payload")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            for info in archive.infolist():
                self.assertIn(b"\x55\x54", info.extra)

    def test_keeps_directory_entries_used_by_retained_files(self):
        # Arrange
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("meta/", b"")
            archive.writestr("meta/ComicInfo.xml", COMIC_INFO)
            archive.writestr("pages/", b"")
            archive.writestr("pages/b.jpg", b"second")
            archive.writestr("pages/a.jpg", b"first")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["pages/b.jpg", "pages/a.jpg"])

        # Assert - 非画像が残る meta/ は保持、画像が抜けた pages/ は残さない
        with zipfile.ZipFile(self.archive_path) as archive:
            names = archive.namelist()
        self.assertIn("meta/", names)
        self.assertIn("meta/ComicInfo.xml", names)
        self.assertNotIn("pages/", names)
        images = [n for n in names if n.endswith(".jpg")]
        self.assertEqual(["001.jpg", "002.jpg"], images)

    def test_does_not_leave_temporary_files_behind(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        leftovers = [p.name for p in self.work_dir.iterdir() if p.name != "volume.zip"]
        self.assertEqual([], leftovers)

    def test_does_not_truncate_a_pre_existing_file_at_the_temp_path(self):
        # Arrange - 固定名の一時ファイルを使うと既存ファイルを壊しうる
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        squatter = self.work_dir / "volume.zip.reorder-tmp"
        squatter.write_bytes(b"important")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        self.assertEqual(b"important", squatter.read_bytes())


if __name__ == "__main__":
    unittest.main()
