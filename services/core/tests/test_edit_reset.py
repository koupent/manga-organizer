import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from manga_core.cover_editor import CoverTransform, apply_to_archive, record_review
from manga_core.edit_reset import BACKUP_ENTRY, reset_edits
from manga_core.original_store import MANIFEST_ENTRY, recorded_edits
from manga_core.page_margins import trim_pages
from manga_core.page_reorder import OutputPage, ZipPageEditor
from manga_core.page_splitter import (
    MergeIntent,
    SplitIntent,
    SplitPosition,
    apply_rows,
    scan_rows,
)


class EditResetTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "book.zip"
        with zipfile.ZipFile(self.path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.comment = b"original comment"
            for index in range(3):
                buffer = io.BytesIO()
                Image.new("RGB", (400, 300), (index * 80, 20, 30)).save(buffer, "PNG")
                archive.writestr(f"{index + 1:03}.png", buffer.getvalue())
        self.before = self.path.read_bytes()
        self.modified = self.path.stat().st_mtime_ns

    def test_restores_exact_archive_after_multiple_saved_edits(self):
        trim_pages(self.path, ["001.png"], (5, 0, 5, 0))
        apply_to_archive(
            self.path, "002.png", CoverTransform(rotate=90), make_first=True
        )
        rows = scan_rows(self.path)
        apply_rows(
            self.path,
            [
                SplitIntent(
                    names=row.names,
                    split=SplitPosition(x=200) if row.names == ("003.png",) else None,
                )
                for row in rows
            ],
        )
        editor = ZipPageEditor(self.path, include_deleted=True)
        try:
            editor.apply_pages(
                [
                    OutputPage(p.name, deleted=i == 0)
                    for i, p in enumerate(reversed(editor.pages))
                ]
            )
        finally:
            editor.close()
        record_review(self.path)
        self.assertNotEqual(self.before, self.path.read_bytes())
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(self.before, archive.read(BACKUP_ENTRY))
            self.assertEqual(1, archive.namelist().count(BACKUP_ENTRY))
        reset_edits(self.path)
        self.assertEqual(self.before, self.path.read_bytes())
        self.assertEqual(self.modified, self.path.stat().st_mtime_ns)
        self.assertEqual((), recorded_edits(self.path))

    def test_review_only_can_be_reset_and_edited_again(self):
        for _ in range(2):
            record_review(self.path)
            self.assertEqual(("review",), recorded_edits(self.path))
            reset_edits(self.path)
            self.assertEqual(self.before, self.path.read_bytes())

    def test_saved_merge_is_reset_to_separate_original_pages(self):
        apply_rows(
            self.path,
            [
                MergeIntent(names=("001.png", "002.png")),
                SplitIntent(names=("003.png",), split=None),
            ],
            allow_reorder=True,
        )
        reset_edits(self.path)
        self.assertEqual(self.before, self.path.read_bytes())

    def test_legacy_edits_are_never_claimed_to_be_original(self):
        with zipfile.ZipFile(self.path, "a") as archive:
            archive.writestr(
                MANIFEST_ENTRY, json.dumps({"version": 1, "edits": ["reorder"]})
            )
        record_review(self.path)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "旧版"):
            reset_edits(self.path)
        self.assertEqual(before, self.path.read_bytes())

    def test_bad_backup_leaves_book_unchanged(self):
        with zipfile.ZipFile(self.path, "a") as archive:
            archive.writestr(BACKUP_ENTRY, b"not a zip")
        before = self.path.read_bytes()
        with self.assertRaises(zipfile.BadZipFile):
            reset_edits(self.path)
        self.assertEqual(before, self.path.read_bytes())

    def test_failed_backup_does_not_save_edit(self):
        with patch(
            "manga_core.edit_reset.zipfile.ZipFile.write",
            side_effect=OSError("disk full"),
        ):
            with self.assertRaises(OSError):
                record_review(self.path)
        self.assertEqual(self.before, self.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
