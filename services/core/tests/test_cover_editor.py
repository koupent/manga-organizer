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
    edge_colors,
    is_spread,
    transform_image,
)
from manga_core.viewer_contract import is_viewer_page, sequential_name  # noqa: E402


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


# サムネイル移動の検証用。ページごとに違う色を塗り、移動後も中身を見分けられる。
# 連番になっていない名前にして、振り直しが起きたかどうかを見えるようにする
PAGE_COLORS = (
    ("page-1.jpg", "red"),
    ("page-2.jpg", "lime"),
    ("page-3.jpg", "blue"),
    ("page-4.jpg", "yellow"),
)
PAGE_COUNT = len(PAGE_COLORS)

_COLOR_SAMPLES = {
    "red": (255, 0, 0),
    "lime": (0, 255, 0),
    "blue": (0, 0, 255),
    "yellow": (255, 255, 0),
}


def closest_color_name(pixel: tuple[int, int, int]) -> str:
    """画素に最も近い色名を返す。JPEG の劣化があっても見分けられるようにする"""

    def squared_distance(name: str) -> int:
        sample = _COLOR_SAMPLES[name]
        return sum((pixel[index] - sample[index]) ** 2 for index in range(3))

    return min(_COLOR_SAMPLES, key=squared_distance)


def center_pixel(data: bytes) -> tuple[int, int, int]:
    """画像の中心の画素。切り抜き後でも塗った色が残る位置を見る"""
    with Image.open(io.BytesIO(data)) as opened:
        image = opened.convert("RGB")
        return image.getpixel((image.width // 2, image.height // 2))


def archive_page_names(archive_path: Path) -> list[str]:
    """viewer がページとして読むエントリ名を、viewer と同じ辞書順で返す"""
    with zipfile.ZipFile(archive_path) as archive:
        return sorted(name for name in archive.namelist() if is_viewer_page(name))


def archive_page_colors(archive_path: Path) -> list[str]:
    """ページの色名を viewer の並び順で返す。どの絵が何ページ目かを見る"""
    with zipfile.ZipFile(archive_path) as archive:
        return [
            closest_color_name(center_pixel(archive.read(name)))
            for name in archive_page_names(archive_path)
        ]


def archive_snapshot(archive_path: Path) -> list[tuple[str, bytes]]:
    """エントリ名と中身の対を格納順に並べて返す。壊れていないか比べる用"""
    with zipfile.ZipFile(archive_path) as archive:
        return [(name, archive.read(name)) for name in archive.namelist()]


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


def banded_png(size: tuple[int, int], bands: dict[str, str]) -> bytes:
    """4 辺に色の帯を引いた画像。帯の太さは辺の 1 割、真ん中は灰色。

    PNG にするのは、JPEG だと境目の色がにじんで、塗った色の比較が当てに
    ならないため。
    """
    width, height = size
    canvas = Image.new("RGB", size, "gray")
    band_y, band_x = height // 10, width // 10
    canvas.paste(bands["top"], (0, 0, width, band_y))
    canvas.paste(bands["bottom"], (0, height - band_y, width, height))
    canvas.paste(bands["left"], (0, band_y, band_x, height - band_y))
    canvas.paste(bands["right"], (width - band_x, band_y, width, height - band_y))
    buffer = io.BytesIO()
    canvas.save(buffer, "PNG")
    return buffer.getvalue()


BANDS = {"top": "red", "bottom": "blue", "left": "lime", "right": "yellow"}


class PaddedCropTest(unittest.TestCase):
    """2:3 に収まらない画像を、枠を外へ広げて切らずに表紙にする（#130）"""

    def crop(self, size, box) -> Image.Image:
        produced = transform_image(
            banded_png(size, BANDS), CoverTransform(crop=box), name="001.png"
        )
        return Image.open(io.BytesIO(produced)).convert("RGB")

    def test_pads_above_and_below_with_each_edge_colour(self):
        # Act - 750x1000 は 2:3 より横に広い。幅いっぱいの 2:3 は高さ 1125
        image = self.crop((750, 1000), (0, -62, 750, 1063))

        # Assert - 足した余白はそれぞれの辺の色、元の絵は真ん中にそのまま
        self.assertEqual((750, 1125), image.size)
        self.assertEqual(_COLOR_SAMPLES["red"], image.getpixel((375, 10)))
        self.assertEqual(_COLOR_SAMPLES["blue"], image.getpixel((375, 1115)))
        self.assertEqual((128, 128, 128), image.getpixel((375, 562)))

    def test_pads_left_and_right_with_each_edge_colour(self):
        # Act - 500x1000 は 2:3 より縦に長い。高さいっぱいの 2:3 は幅 667
        image = self.crop((500, 1000), (-83, 0, 584, 1000))

        # Assert
        self.assertEqual((667, 1000), image.size)
        self.assertEqual(_COLOR_SAMPLES["lime"], image.getpixel((10, 500)))
        self.assertEqual(_COLOR_SAMPLES["yellow"], image.getpixel((660, 500)))

    def test_refuses_a_box_that_cuts_one_side_and_pads_the_other(self):
        # Assert - はみ出すなら、その軸では画像を丸ごと含むこと
        with self.assertRaises(CoverEditError):
            self.crop((750, 1000), (0, -62, 750, 900))

    def test_refuses_a_box_far_larger_than_the_image(self):
        # Assert - 桁違いの範囲 1 つで画素を確保させない
        with self.assertRaises(CoverEditError):
            self.crop((750, 1000), (0, -5000, 750, 6000))

    def test_edge_colours_ignore_a_thin_line_at_the_very_edge(self):
        # Arrange - 赤い地の外周に 1px の黒い線
        canvas = Image.new("RGB", (600, 900), "red")
        for box in ((0, 0, 600, 1), (0, 899, 600, 900)):
            canvas.paste("black", box)

        # Assert - 線 1 本では色が変わらない
        colours = edge_colors(canvas)
        self.assertEqual(_COLOR_SAMPLES["red"], colours.top)
        self.assertEqual(_COLOR_SAMPLES["red"], colours.bottom)


class ApplyToArchiveTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
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
            names = archive.namelist()
            # ページの集合と並びは変わらない。加工前の画像と manifest（#66）は
            # ページ以外のエントリとして増えるので、ページだけで数える
            self.assertEqual(
                ["001.jpg", "002.jpg"], [name for name in names if is_viewer_page(name)]
            )
            self.assertIn("ComicInfo.xml", names, "ページ以外のエントリが消えている")
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
            names = archive.namelist()
            # 加工前の BMP は元画像として残る（#66）。ページとしては
            # PNG の 1 枚だけになり、古い名前は消えている
            self.assertEqual(
                ["001.png"], [name for name in names if is_viewer_page(name)]
            )
            self.assertNotIn("001.bmp", names, "古い名前のページが残っている")

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


class ApplyToArchiveMakeFirstTest(unittest.TestCase):
    """選んだ画像を先頭ページへ移してサムネイルにする振る舞い。

    viewer は先頭ページを表紙として描くため、選んだ画像を先頭へ動かす以外に
    サムネイルを差し替える方法がない。本文側に同じ絵は残さず、ページ数は変えない。
    """

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        self.archive = self.work_dir / "volume.zip"
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("ComicInfo.xml", b"<ComicInfo/>")
            for name, color in PAGE_COLORS:
                archive.writestr(name, image_bytes((800, 1200), color=color))

    def test_moves_the_chosen_page_to_the_front(self):
        # Arrange - 真ん中の page-3.jpg（青）をサムネイルにする
        chosen_color = dict(PAGE_COLORS)["page-3.jpg"]

        # Act
        result = apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(), make_first=True
        )

        # Assert
        colors = archive_page_colors(self.archive)
        self.assertEqual(chosen_color, colors[0], "選んだ絵が先頭ページになっていない")
        self.assertEqual(
            sequential_name(1, PAGE_COUNT, ".jpg"),
            result.name,
            "戻り値が先頭ページの名前を指していない",
        )

    def test_renumbers_every_page_sequentially(self):
        # Arrange
        expected = [
            sequential_name(position, PAGE_COUNT, ".jpg")
            for position in range(1, PAGE_COUNT + 1)
        ]

        # Act
        apply_to_archive(self.archive, "page-3.jpg", CoverTransform(), make_first=True)

        # Assert
        self.assertEqual(expected, archive_page_names(self.archive))
        colors = archive_page_colors(self.archive)
        self.assertEqual(PAGE_COUNT, len(colors), "ページ数が変わっている")
        self.assertEqual(
            PAGE_COUNT, len(set(colors)), "選んだ絵が本文側にも残って重複している"
        )

    def test_keeps_the_relative_order_of_the_other_pages(self):
        # Arrange - page-2 を先頭にしたら、残りは元の順のまま続く
        colors = dict(PAGE_COLORS)
        expected = [
            colors["page-2.jpg"],
            colors["page-1.jpg"],
            colors["page-3.jpg"],
            colors["page-4.jpg"],
        ]

        # Act
        apply_to_archive(self.archive, "page-2.jpg", CoverTransform(), make_first=True)

        # Assert
        self.assertEqual(expected, archive_page_colors(self.archive))

    def test_keeps_the_order_when_the_chosen_page_is_already_first(self):
        # Arrange
        expected_colors = [color for _, color in PAGE_COLORS]
        expected_names = [
            sequential_name(position, PAGE_COUNT, ".jpg")
            for position in range(1, PAGE_COUNT + 1)
        ]

        # Act - 既に先頭の page-1.jpg を指定する
        apply_to_archive(self.archive, "page-1.jpg", CoverTransform(), make_first=True)

        # Assert
        self.assertEqual(expected_colors, archive_page_colors(self.archive))
        self.assertEqual(expected_names, archive_page_names(self.archive))

    def test_applies_the_transform_to_the_page_it_moves(self):
        # Arrange - 加工（切り抜き）と先頭移動が両方効くこと
        chosen_color = dict(PAGE_COLORS)["page-3.jpg"]

        # Act
        result = apply_to_archive(
            self.archive,
            "page-3.jpg",
            CoverTransform(crop=(100, 150, 500, 750)),
            make_first=True,
        )

        # Assert
        self.assertEqual((400, 600), (result.width, result.height))
        with zipfile.ZipFile(self.archive) as archive:
            first = archive.read(archive_page_names(self.archive)[0])
        with Image.open(io.BytesIO(first)) as cover:
            self.assertEqual((400, 600), cover.size, "先頭が切り抜き後の寸法でない")
        self.assertEqual(chosen_color, closest_color_name(center_pixel(first)))

    def test_leaves_the_archive_intact_when_the_page_is_missing(self):
        # Arrange
        before = archive_snapshot(self.archive)

        # Act / Assert
        with self.assertRaises(CoverEditError):
            apply_to_archive(
                self.archive, "missing.jpg", CoverTransform(), make_first=True
            )
        self.assertEqual(before, archive_snapshot(self.archive))

    def test_leaves_the_archive_intact_when_the_crop_is_invalid(self):
        # Arrange
        before = archive_snapshot(self.archive)

        # Act / Assert - 画像の外を指す切り抜きは通らない
        with self.assertRaises(CoverEditError):
            apply_to_archive(
                self.archive,
                "page-3.jpg",
                CoverTransform(crop=(0, 0, 900, 1300)),
                make_first=True,
            )
        self.assertEqual(before, archive_snapshot(self.archive))

    def test_preserves_the_archive_timestamp(self):
        # Arrange
        import os

        past = 1_500_000_000
        os.utime(self.archive, (past, past))

        # Act
        apply_to_archive(self.archive, "page-3.jpg", CoverTransform(), make_first=True)

        # Assert
        self.assertEqual(past, int(self.archive.stat().st_mtime))


if __name__ == "__main__":
    unittest.main()
