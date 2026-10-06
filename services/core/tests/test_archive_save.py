"""同期先に未完成のZIPを置かず、失敗時は元の本を守る。"""

import errno
import os
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.archive_save import (  # noqa: E402
    create_archive_temp,
    replace_archive,
)
from manga_core.file_organizer import FileOrganizer  # noqa: E402
from manga_core.page_reorder import ZipPageEditor  # noqa: E402


class ArchiveSaveTest(unittest.TestCase):
    def setUp(self):
        self.root = TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.folder = Path(self.root.name)
        self.destination = self.folder / "book.zip"
        self.destination.write_bytes(b"original")
        self.prepared = create_archive_temp()
        self.addCleanup(self.prepared.unlink, missing_ok=True)
        self.prepared.write_bytes(b"verified ZIP")

    def test_reorder_does_not_write_work_in_progress_in_the_book_folder(self):
        with zipfile.ZipFile(self.destination, "w") as archive:
            archive.writestr("a.jpg", b"first")
            archive.writestr("b.jpg", b"second")
        before = self.destination.read_bytes()
        observations = []

        def progress(current, total):
            observations.append(current)
            self.assertEqual([self.destination], list(self.folder.iterdir()))
            self.assertEqual(before, self.destination.read_bytes())

        editor = ZipPageEditor(self.destination)
        self.addCleanup(editor.close)
        editor.apply_order(["b.jpg", "a.jpg"], progress=progress)
        self.assertTrue(observations)
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(b"second", archive.read("001.jpg"))

    def test_new_book_only_appears_after_zip_creation_finishes(self):
        self.destination.unlink()
        images = self.folder / "images"
        images.mkdir()
        Image.new("RGB", (20, 30), "red").save(images / "page.png")
        observations = []

        def progress(message):
            observations.append(message)
            self.assertFalse(self.destination.exists())
            self.assertEqual([images], list(self.folder.iterdir()))

        organizer = FileOrganizer(self.folder, log_callback=progress)
        self.assertIsNone(organizer._build_volume_archive(images, self.destination, 1))
        self.assertTrue(observations)
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(["001.png"], archive.namelist())

    def cross_volume(self):
        original_replace = os.replace

        def replace(source, destination):
            if source == self.prepared:
                raise OSError(errno.EXDEV, "different drives")
            return original_replace(source, destination)

        return patch("manga_core.archive_save.os.replace", side_effect=replace)

    def test_cross_volume_transfer_only_commits_the_complete_file(self):
        with self.cross_volume():
            replace_archive(self.prepared, self.destination)
        self.assertEqual(b"verified ZIP", self.destination.read_bytes())
        self.assertEqual([self.destination], list(self.folder.iterdir()))

    def test_failed_transfer_keeps_original_and_removes_partial_file(self):
        def incomplete(source, output, **kwargs):
            output.write(b"partial")
            raise OSError(errno.ENOSPC, "disk full")

        with (
            self.cross_volume(),
            patch("manga_core.archive_save.shutil.copyfileobj", side_effect=incomplete),
        ):
            with self.assertRaises(OSError):
                replace_archive(self.prepared, self.destination)
        self.assertEqual(b"original", self.destination.read_bytes())
        self.assertEqual([self.destination], list(self.folder.iterdir()))

    def test_permission_error_does_not_copy_or_overwrite_the_original(self):
        with (
            patch("manga_core.archive_save.os.replace", side_effect=PermissionError()),
            patch("manga_core.archive_save.shutil.copyfileobj") as copy,
        ):
            with self.assertRaises(PermissionError):
                replace_archive(self.prepared, self.destination)
        copy.assert_not_called()
        self.assertEqual(b"original", self.destination.read_bytes())

    def test_failed_final_replace_keeps_original_and_removes_pending_file(self):
        with patch(
            "manga_core.archive_save.os.replace",
            side_effect=[OSError(errno.EXDEV, "different drives"), PermissionError()],
        ):
            with self.assertRaises(PermissionError):
                replace_archive(self.prepared, self.destination)
        self.assertEqual(b"original", self.destination.read_bytes())
        self.assertEqual([self.destination], list(self.folder.iterdir()))
