"""削除したページを本文から除き、再オープン後も元の画像を復元できる。"""

import zipfile
from dataclasses import replace

from test_page_splitter import SplitFixture, build_archive, page_names, tall_bytes

from manga_core.page_reorder import ZipPageEditor
from manga_core.page_splitter import SplitIntent, apply_rows, scan_rows


class RecoverableDeletionTest(SplitFixture):
    def build_pages(self):
        self.images = [
            tall_bytes(colour) for colour in ("#112233", "#445566", "#778899")
        ]
        build_archive(
            self.archive_path,
            {f"{i + 1:03d}.png": data for i, data in enumerate(self.images)},
        )

    def contents(self):
        with zipfile.ZipFile(self.archive_path) as archive:
            return [archive.read(name) for name in page_names(self.archive_path)]

    def test_delete_reopen_restore_preserves_bytes_and_position(self):
        self.build_pages()
        rows = scan_rows(self.archive_path)
        result = apply_rows(
            self.archive_path,
            [replace(row, deleted=i == 1) for i, row in enumerate(rows)],
        )
        self.assertTrue(result.changed)
        self.assertEqual(result.page_count, 2)
        self.assertEqual(self.contents(), [self.images[0], self.images[2]])
        rows = scan_rows(self.archive_path)
        self.assertEqual([row.deleted for row in rows], [False, True, False])
        self.assertFalse(apply_rows(self.archive_path, rows).changed)
        result = apply_rows(
            self.archive_path, [replace(row, deleted=False) for row in rows]
        )
        self.assertEqual(result.page_count, 3)
        self.assertEqual(self.contents(), self.images)

    def test_all_pages_can_be_deleted_and_restored(self):
        self.build_pages()
        result = apply_rows(
            self.archive_path,
            [replace(row, deleted=True) for row in scan_rows(self.archive_path)],
        )
        self.assertEqual(result.page_count, 0)
        self.assertEqual(page_names(self.archive_path), [])
        rows = scan_rows(self.archive_path)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row.deleted for row in rows))
        apply_rows(self.archive_path, [replace(row, deleted=False) for row in rows])
        self.assertEqual(self.contents(), self.images)

    def test_other_edits_keep_deleted_bytes(self):
        self.build_pages()
        apply_rows(
            self.archive_path,
            [
                replace(row, deleted=i == 1)
                for i, row in enumerate(scan_rows(self.archive_path))
            ],
        )
        with zipfile.ZipFile(self.archive_path) as archive:
            hidden = next(
                name
                for name in archive.namelist()
                if name.startswith(".manga-organizer/deleted/")
            )
            before = archive.read(hidden)
        editor = ZipPageEditor(self.archive_path)
        try:
            editor.apply_order([page.name for page in reversed(editor.pages)])
        finally:
            editor.close()
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(archive.read(hidden), before)
        apply_rows(
            self.archive_path,
            [replace(row, deleted=False) for row in scan_rows(self.archive_path)],
        )
        self.assertEqual(
            self.contents(), [self.images[2], self.images[1], self.images[0]]
        )

    def test_deleting_one_split_half_does_not_fold_it_into_visible_half(self):
        self.build_spread_and_page()
        self.split_row(self.archive_path, 0, 490)
        editor = ZipPageEditor(self.archive_path)
        try:
            original = [editor.read_entry(page.name) for page in editor.pages]
            names = [page.name for page in editor.pages]
        finally:
            editor.close()

        apply_rows(
            self.archive_path,
            [
                SplitIntent((name,), None, deleted=i == 0)
                for i, name in enumerate(names)
            ],
        )
        rows = scan_rows(self.archive_path)
        self.assertEqual([len(row.names) for row in rows], [1, 1, 1])
        self.assertEqual([row.deleted for row in rows], [True, False, False])
        self.assertEqual(self.contents(), original[1:])
        apply_rows(self.archive_path, [replace(row, deleted=False) for row in rows])
        self.assertEqual(self.contents(), original)
        self.assertEqual(
            [len(row.names) for row in scan_rows(self.archive_path)], [2, 1]
        )
