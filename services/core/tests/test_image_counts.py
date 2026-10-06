import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from manga_api.analysis_job import _book_view
from manga_core.toc_analyzer import analyze_inputs


class ImageCountTest(unittest.TestCase):
    def test_folder_counts_pages_recursively_and_excludes_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "第1巻"
            for name in [
                "001.jpg",
                "002.BMP",
                "子/003.png",
                ".cache/a.jpg",
                "__MACOSX/a.jpg",
                "note.txt",
            ]:
                path = folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
            book = analyze_inputs([folder], "著者", "作品")[0]
            self.assertEqual(3, book.image_count)
            self.assertEqual(3, _book_view(book)["image_count"])

    def test_archive_counts_each_book_including_nested_images(self):
        with tempfile.TemporaryDirectory() as temp:
            nested = io.BytesIO()
            with zipfile.ZipFile(nested, "w") as archive:
                archive.writestr("001.jpg", b"fixture")
                archive.writestr("002.png", b"fixture")
            path = Path(temp) / "本.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("第1巻/001.jpg", b"fixture")
                archive.writestr("第1巻/子/002.BMP", b"fixture")
                archive.writestr("第1巻/.cache/a.jpg", b"fixture")
                archive.writestr("第1巻/内.zip", nested.getvalue())
                archive.writestr("第2巻/001.png", b"fixture")
            books = analyze_inputs([path], "著者", "作品")
            self.assertEqual(
                {"第1巻": 4, "第1巻/内.zip": 2, "第1巻/子": 1, "第2巻": 1},
                {book.entry: book.image_count for book in books},
            )
