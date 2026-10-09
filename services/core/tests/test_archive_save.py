"""同期先に未完成のZIPを置かず、失敗時は元の本を守る。"""

import errno
import os
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, call, patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.archive_save import (  # noqa: E402
    create_archive_temp,
    refresh_folder,
    replace_archive,
)
from manga_core.file_organizer import FileOrganizer  # noqa: E402
from manga_core.file_times import capture_file_times, restore_file_times  # noqa: E402
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

    def test_metadata_is_finished_before_publication_on_either_drive(self):
        past = 1_600_000_000_000_000_000
        os.utime(self.destination, ns=(past, past))
        times = capture_file_times(self.destination)
        original_replace = os.replace
        for cross_volume in (False, True):
            with self.subTest(cross_volume=cross_volume):
                self.prepared.write_bytes(b"verified ZIP")
                events = []

                def replace(source, target, cross_volume=cross_volume, events=events):
                    if cross_volume and source == self.prepared:
                        raise OSError(errno.EXDEV, "different drives")
                    self.assertEqual(past, source.stat().st_mtime_ns)
                    self.assertEqual(
                        times.create_ns, capture_file_times(source).create_ns
                    )
                    events.append("publish")
                    return original_replace(source, target)

                def restore(path, original_times, events=events):
                    self.assertNotEqual(self.destination, path)
                    events.append("metadata")
                    return restore_file_times(path, original_times)

                def refresh(folder, events=events):
                    self.assertEqual(self.destination.parent, folder)
                    self.assertEqual(past, self.destination.stat().st_mtime_ns)
                    self.assertEqual(
                        times.create_ns, capture_file_times(self.destination).create_ns
                    )
                    self.assertEqual([self.destination], list(self.folder.iterdir()))
                    events.append("notify")

                with (
                    patch("manga_core.archive_save.os.replace", side_effect=replace),
                    patch(
                        "manga_core.archive_save.restore_file_times",
                        side_effect=restore,
                    ),
                    patch(
                        "manga_core.archive_save.refresh_folder", side_effect=refresh
                    ),
                ):
                    self.assertTrue(
                        replace_archive(self.prepared, self.destination, times=times)
                    )
                self.assertEqual(["publish", "notify"], events[-2:])

    def test_windows_refresh_invalidates_attributes_and_icons_of_all_ancestors(self):
        notify = MagicMock()
        with (
            patch("manga_core.archive_save.os.name", "nt"),
            patch("manga_core.archive_save.ctypes.WinDLL", create=True) as shell,
        ):
            shell.return_value.SHChangeNotify = notify
            refresh_folder(self.folder)
        self.assertEqual(
            [
                call(event, 0x1005, str(folder), None)
                for folder in (self.folder, *self.folder.parents)
                for event in (0x800, 0x2000, 0x1000)
            ],
            notify.call_args_list,
        )

    def test_notification_failure_does_not_turn_a_saved_book_into_a_failure(self):
        with (
            patch("manga_core.archive_save.os.name", "nt"),
            patch(
                "manga_core.archive_save.ctypes.WinDLL",
                create=True,
                side_effect=OSError(),
            ),
            self.assertLogs("manga_core.archive_save", level="WARNING"),
        ):
            replace_archive(self.prepared, self.destination)
        self.assertEqual(b"verified ZIP", self.destination.read_bytes())

    def test_timestamp_failure_is_reported_without_losing_the_saved_book(self):
        times = capture_file_times(self.destination)
        with patch("manga_core.archive_save.restore_file_times", return_value=False):
            self.assertFalse(
                replace_archive(self.prepared, self.destination, times=times)
            )
        self.assertEqual(b"verified ZIP", self.destination.read_bytes())
