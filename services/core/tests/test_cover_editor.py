"""表紙加工を検証する。

suzume-viewer は表紙を縦長 2:3 の枠に BoxFit.cover（中央クロップ）で描く。
見開きが先頭にあると背表紙付近だけが拡大表示され、表紙が見えない。
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.cover_editor import (  # noqa: E402
    COVER_ASPECT_RATIO,
    CoverEditError,
    CoverTransform,
    apply_to_archive,
    is_spread,
    transform_image,
)


def image_bytes(size: tuple[int, int], fmt: str = "JPEG", color="navy") -> bytes:
    """テスト用の画像"""
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return buffer.getvalue()


def spread_bytes() -> bytes:
    """左右で色が違う見開き。分割位置を確かめられるようにする"""
    canvas = Image.new("RGB", (1600, 1200), "red")
    canvas.paste(Image.new("RGB", (800, 1200), "blue"), (800, 0))
    buffer = io.BytesIO()
    canvas.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


class IsSpreadTest(unittest.TestCase):
    def test_detects_a_wide_image_as_a_spread(self):
        self.assertTrue(is_spread(1600, 1200))

    def test_treats_a_normal_page_as_not_a_spread(self):
        self.assertFalse(is_spread(800, 1200))

    def test_treats_a_square_page_as_not_a_spread(self):
        self.assertFalse(is_spread(1000, 1000))


class TransformImageTest(unittest.TestCase):
    def test_splits_a_spread_and_keeps_the_right_half(self):
        # Arrange - 右綴じなので見開き表紙の右側が表
        transformed = transform_image(spread_bytes(), CoverTransform(split="right"))

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual((800, 1200), image.size)
            red, green, blue = image.convert("RGB").getpixel((400, 600))
            self.assertGreater(blue, red, "右半分（青）が残っていない")

    def test_can_keep_the_left_half_instead(self):
        # Act
        transformed = transform_image(spread_bytes(), CoverTransform(split="left"))

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual((800, 1200), image.size)
            red, green, blue = image.convert("RGB").getpixel((400, 600))
            self.assertGreater(red, blue, "左半分（赤）が残っていない")

    def test_crops_to_the_requested_box(self):
        # Act
        transformed = transform_image(
            image_bytes((1000, 1000)), CoverTransform(crop=(100, 200, 600, 800))
        )

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual((500, 600), image.size)

    def test_rotates_by_quarter_turns(self):
        # Act
        transformed = transform_image(
            image_bytes((800, 1200)), CoverTransform(rotate=90)
        )

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual((1200, 800), image.size)

    def test_applies_split_then_crop_then_rotate(self):
        # Act - 分割してから切り抜き、最後に回す
        transformed = transform_image(
            spread_bytes(),
            CoverTransform(split="right", crop=(0, 0, 400, 600), rotate=90),
        )

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual((600, 400), image.size)

    def test_rejects_a_rotation_that_is_not_a_quarter_turn(self):
        with self.assertRaises(CoverEditError):
            transform_image(image_bytes((800, 1200)), CoverTransform(rotate=45))

    def test_rejects_a_crop_outside_the_image(self):
        with self.assertRaises(CoverEditError):
            transform_image(
                image_bytes((800, 1200)), CoverTransform(crop=(0, 0, 900, 1300))
            )

    def test_rejects_an_empty_crop(self):
        with self.assertRaises(CoverEditError):
            transform_image(
                image_bytes((800, 1200)), CoverTransform(crop=(100, 100, 100, 200))
            )

    def test_keeps_the_original_format_for_jpeg(self):
        # Act
        transformed = transform_image(
            image_bytes((800, 1200), "JPEG"), CoverTransform(rotate=180)
        )

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual("JPEG", image.format)

    def test_converts_an_unsupported_format_to_png(self):
        # Act - viewer が読めない BMP は残さない
        transformed = transform_image(
            image_bytes((800, 1200), "BMP"), CoverTransform(rotate=180), name="001.bmp"
        )

        # Assert
        with Image.open(io.BytesIO(transformed)) as image:
            self.assertEqual("PNG", image.format)


class ApplyToArchiveTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive = self.work_dir / "volume.zip"
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("ComicInfo.xml", b"<ComicInfo/>")
            archive.writestr("001.jpg", spread_bytes())
            archive.writestr("002.jpg", image_bytes((800, 1200)))

    def test_replaces_the_cover_in_place(self):
        # Act
        result = apply_to_archive(
            self.archive, "001.jpg", CoverTransform(split="right")
        )

        # Assert
        self.assertEqual("001.jpg", result.name)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(
                ["ComicInfo.xml", "001.jpg", "002.jpg"], archive.namelist()
            )
            with Image.open(io.BytesIO(archive.read("001.jpg"))) as cover:
                self.assertEqual((800, 1200), cover.size)

    def test_leaves_other_pages_untouched(self):
        # Arrange
        with zipfile.ZipFile(self.archive) as archive:
            before = archive.read("002.jpg")

        # Act
        apply_to_archive(self.archive, "001.jpg", CoverTransform(split="right"))

        # Assert
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(before, archive.read("002.jpg"))

    def test_renames_when_the_format_changes(self):
        # Arrange - BMP は viewer が読めないので PNG になり、名前も変わる
        archive_path = self.work_dir / "bmp.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("001.bmp", image_bytes((800, 1200), "BMP"))

        # Act
        result = apply_to_archive(archive_path, "001.bmp", CoverTransform(rotate=180))

        # Assert
        self.assertEqual("001.png", result.name)
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(["001.png"], archive.namelist())

    def test_preserves_the_archive_timestamp(self):
        # Arrange
        import os

        past = 1_500_000_000
        os.utime(self.archive, (past, past))

        # Act
        apply_to_archive(self.archive, "001.jpg", CoverTransform(rotate=180))

        # Assert
        self.assertEqual(past, int(self.archive.stat().st_mtime))

    def test_rejects_a_page_that_is_not_in_the_archive(self):
        with self.assertRaises(CoverEditError):
            apply_to_archive(self.archive, "missing.jpg", CoverTransform(rotate=180))

    def test_leaves_the_archive_intact_when_the_transform_fails(self):
        # Arrange
        before = self.archive.read_bytes()

        # Act / Assert
        with self.assertRaises(CoverEditError):
            apply_to_archive(self.archive, "001.jpg", CoverTransform(rotate=45))
        self.assertEqual(before, self.archive.read_bytes())

    def test_cover_aspect_ratio_matches_the_viewer(self):
        # viewer は AspectRatio(2/3) で描く
        self.assertAlmostEqual(2 / 3, COVER_ASPECT_RATIO)


if __name__ == "__main__":
    unittest.main()
