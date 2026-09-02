"""suzume-viewer が解釈できる出力の規約を検証する。

参照実装: koupent/suzume-viewer の lib/archive/manga_archive.dart
- filterImageEntries: ディレクトリ / __MACOSX/ / ドット始まり を除外し、
  jpg jpeg png webp avif gif のみ採用（サブフォルダ内は保持）
- 並び順: a.name.compareTo(b.name)（単純な辞書順）
- 表紙: 並べ替え後の先頭（page 0）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core.viewer_contract import (  # noqa: E402
    UNSUPPORTED_IMAGE_EXTENSIONS,
    VIEWER_IMAGE_EXTENSIONS,
    is_viewer_page,
    needs_conversion,
    sequence_digits,
    sequential_name,
)


class IsViewerPageTest(unittest.TestCase):
    def test_accepts_supported_image_extensions(self):
        supported = (
            "001.jpg",
            "002.JPEG",
            "003.png",
            "004.webp",
            "005.avif",
            "006.gif",
        )
        for name in supported:
            with self.subTest(name=name):
                self.assertTrue(is_viewer_page(name))

    def test_keeps_images_in_subfolders(self):
        # CBZ は同名フォルダで包むことがある
        self.assertTrue(is_viewer_page("volume01/001.jpg"))

    def test_rejects_directory_entries(self):
        self.assertFalse(is_viewer_page("pages/"))

    def test_rejects_macos_metadata(self):
        # AppleDouble。拡張子は .jpg だが画像ではない
        self.assertFalse(is_viewer_page("__MACOSX/._001.jpg"))

    def test_rejects_dotfiles(self):
        self.assertFalse(is_viewer_page(".DS_Store"))
        self.assertFalse(is_viewer_page("pages/._001.jpg"))

    def test_rejects_unsupported_extensions(self):
        # viewer が復号できない形式
        self.assertFalse(is_viewer_page("001.bmp"))
        self.assertFalse(is_viewer_page("readme.txt"))

    def test_rejects_empty_basename(self):
        self.assertFalse(is_viewer_page(""))


class ConversionTest(unittest.TestCase):
    def test_bmp_is_marked_for_conversion(self):
        self.assertTrue(needs_conversion("001.bmp"))
        self.assertTrue(needs_conversion("PAGES/002.BMP"))

    def test_supported_formats_are_not_converted(self):
        for name in ("001.jpg", "002.png", "003.webp"):
            with self.subTest(name=name):
                self.assertFalse(needs_conversion(name))

    def test_macos_metadata_is_not_marked_for_conversion(self):
        self.assertFalse(needs_conversion("__MACOSX/._001.bmp"))

    def test_extension_sets_do_not_overlap(self):
        self.assertEqual(set(), VIEWER_IMAGE_EXTENSIONS & UNSUPPORTED_IMAGE_EXTENSIONS)


class SequentialNameTest(unittest.TestCase):
    def test_uses_three_digits_up_to_999(self):
        self.assertEqual(3, sequence_digits(1))
        self.assertEqual(3, sequence_digits(999))
        self.assertEqual("001.jpg", sequential_name(1, 999, ".jpg"))
        self.assertEqual("999.jpg", sequential_name(999, 999, ".jpg"))

    def test_widens_beyond_999_so_lexicographic_order_stays_correct(self):
        # 3桁固定だと辞書順で 1000 が 100 の直後に割り込む
        self.assertEqual(4, sequence_digits(1000))
        self.assertEqual("0001.jpg", sequential_name(1, 1000, ".jpg"))
        self.assertEqual("1000.jpg", sequential_name(1000, 1000, ".jpg"))

    def test_lexicographic_order_matches_page_order(self):
        for total in (9, 10, 999, 1000, 1001, 10000):
            with self.subTest(total=total):
                names = [sequential_name(i, total, ".jpg") for i in range(1, total + 1)]
                self.assertEqual(names, sorted(names))

    def test_normalizes_the_extension(self):
        self.assertEqual("001.jpg", sequential_name(1, 10, ".JPG"))

    def test_bmp_becomes_png(self):
        self.assertEqual("001.png", sequential_name(1, 10, ".bmp"))


if __name__ == "__main__":
    unittest.main()
