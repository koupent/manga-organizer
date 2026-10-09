import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from manga_core.cover_editor import CoverTransform, apply_to_archive
from manga_core.edit_reset import BACKUP_ENTRY
from manga_core.edit_restore import restore_preview, restore_saved
from manga_core.merge_store import MERGES_ENTRY, plan_merge
from manga_core.page_margins import trim_pages
from manga_core.page_reorder import ZipPageEditor
from manga_core.page_splitter import MergeIntent, SplitIntent, SplitPosition, apply_rows


class EditRestoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "book.zip"
        with zipfile.ZipFile(self.path, "w") as archive:
            for index, size in enumerate(((600, 400), (250, 400), (300, 400)), 1):
                stream = io.BytesIO()
                Image.new("RGB", size, (index * 60, 40, 70)).save(stream, "PNG")
                archive.writestr(f"{index:03}.png", stream.getvalue())
        self.original = self.pixels()

    def pixels(self):
        editor = ZipPageEditor(self.path, include_deleted=True)
        try:
            return [editor.read_entry(page.name) for page in editor.pages]
        finally:
            editor.close()

    def legacy(self):
        staged = self.path.with_suffix(".tmp")
        with zipfile.ZipFile(self.path) as source, zipfile.ZipFile(staged, "w") as dest:
            for info in source.infolist():
                if info.filename != BACKUP_ENTRY:
                    dest.writestr(info, source.read(info))
        staged.replace(self.path)

    def test_legacy_margin_restores_original_without_full_snapshot(self):
        trim_pages(self.path, ["001.png", "002.png"], (5, 0, 5, 0))
        self.legacy()
        self.assertEqual(2, restore_preview(self.path)["counts"]["trim"])
        result = restore_saved(self.path)
        self.assertFalse(result["complete"])
        self.assertEqual(self.original, self.pixels())

    def test_margin_mode_does_not_restore_cover(self):
        trim_pages(self.path, ["001.png"], (5, 0, 5, 0))
        apply_to_archive(self.path, "002.png", CoverTransform(rotate=90))
        cover = self.pixels()[1]
        restore_saved(self.path, "trim")
        self.assertEqual(self.original[0], self.pixels()[0])
        self.assertEqual(cover, self.pixels()[1])

    def test_thumbnail_padding_only_can_be_restored(self):
        apply_to_archive(self.path, "002.png", CoverTransform())
        self.legacy()
        self.assertEqual(
            1, restore_preview(self.path, "thumbnail")["counts"]["thumbnail"]
        )
        restore_saved(self.path, "thumbnail")
        self.assertEqual(self.original, self.pixels())

    def test_saved_merge_restores_both_exact_originals(self):
        apply_rows(
            self.path,
            [SplitIntent(("001.png",), None), MergeIntent(("002.png", "003.png"))],
        )
        self.legacy()
        self.assertEqual(1, restore_preview(self.path, "merge")["counts"]["merge"])
        restore_saved(self.path, "merge")
        self.assertEqual(self.original, self.pixels())

    def test_merge_restore_preserves_mixed_image_formats_without_recompression(self):
        stream = io.BytesIO()
        Image.new("RGB", (250, 400), "red").save(stream, "JPEG")
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("001.jpg", stream.getvalue())
            archive.writestr("002.png", self.original[2])
        original = self.pixels()
        apply_rows(self.path, [MergeIntent(("001.jpg", "002.png"))])
        self.legacy()
        restore_saved(self.path, "merge")
        self.assertEqual(original, self.pixels())
        with zipfile.ZipFile(self.path) as archive:
            self.assertIn("001.jpg", archive.namelist())
            self.assertIn("002.png", archive.namelist())

    def test_split_restore_and_full_restore_share_saved_originals(self):
        apply_rows(
            self.path,
            [
                SplitIntent(("001.png",), SplitPosition(300)),
                SplitIntent(("002.png",), None),
                SplitIntent(("003.png",), None),
            ],
        )
        self.legacy()
        restore_saved(self.path, "split")
        self.assertEqual(self.original, self.pixels())

    def test_combined_restore_unwraps_merge_then_margin(self):
        trim_pages(self.path, ["002.png", "003.png"], (5, 0, 5, 0))
        apply_rows(
            self.path,
            [SplitIntent(("001.png",), None), MergeIntent(("002.png", "003.png"))],
        )
        self.legacy()
        result = restore_saved(self.path)
        self.assertEqual(1, result["counts"]["merge"])
        self.assertEqual(2, result["counts"]["trim"])
        self.assertEqual(self.original, self.pixels())

    def test_combined_restore_preserves_deleted_pages(self):
        from manga_core.page_reorder import OutputPage

        trim_pages(self.path, ["002.png"], (5, 0, 5, 0))
        editor = ZipPageEditor(self.path, include_deleted=True)
        try:
            editor.apply_pages(
                [
                    OutputPage(page.name, deleted=index == 1)
                    for index, page in enumerate(editor.pages)
                ]
            )
        finally:
            editor.close()
        self.legacy()
        restore_saved(self.path)
        self.assertEqual(self.original, self.pixels())
        editor = ZipPageEditor(self.path, include_deleted=True)
        try:
            self.assertEqual(
                [False, True, False], [page.deleted for page in editor.pages]
            )
        finally:
            editor.close()

    def test_failure_in_combined_restore_leaves_archive_untouched(self):
        trim_pages(self.path, ["001.png"], (5, 0, 5, 0))
        self.legacy()
        before = self.path.read_bytes()
        with patch(
            "manga_core.edit_restore._split_restore",
            side_effect=[0, RuntimeError("failed")],
        ):
            with self.assertRaises(RuntimeError):
                restore_saved(self.path)
        self.assertEqual(before, self.path.read_bytes())

    def test_cyclic_merge_history_cannot_expand_the_archive_indefinitely(self):
        extras = plan_merge(
            self.path,
            self.original[0],
            [("001.png", self.original[0]), ("002.png", self.original[1])],
            {},
        )
        with zipfile.ZipFile(self.path, "a") as archive:
            for name, data in extras.items():
                archive.writestr(name, data)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "循環"):
            restore_saved(self.path)
        self.assertEqual(before, self.path.read_bytes())

    def test_invalid_merge_record_cannot_restore_arbitrary_members(self):
        with zipfile.ZipFile(self.path, "a") as archive:
            import json

            from manga_core.original_store import content_hash

            archive.writestr(
                MERGES_ENTRY,
                json.dumps(
                    {
                        content_hash(self.original[0]): [
                            ["x", "001.png"],
                            ["x", "002.png"],
                        ]
                    }
                ),
            )
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            restore_saved(self.path, "merge")
        self.assertEqual(before, self.path.read_bytes())
