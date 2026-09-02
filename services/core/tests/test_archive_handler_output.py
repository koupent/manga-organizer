"""整理機能の出力が suzume-viewer の解釈と一致することを検証する"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.archive_handler import ArchiveHandler  # noqa: E402


def write_image(path: Path, fmt: str = "JPEG") -> None:
    """テスト用の画像を1枚書き出す"""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (40, 60), "navy").save(path, fmt)


class CreateArchiveTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.source = self.work_dir / "src"
        self.source.mkdir()
        self.output = self.work_dir / "out.zip"
        self.handler = ArchiveHandler()

    def test_widens_digits_beyond_999_so_lexicographic_order_holds(self):
        # Arrange - 3桁固定だと辞書順で 1000 が 100 の直後に割り込む
        for index in range(1, 1002):
            write_image(self.source / f"p{index:05d}.jpg")

        # Act
        self.assertTrue(self.handler.create_archive(self.source, self.output))

        # Assert
        with zipfile.ZipFile(self.output) as archive:
            names = archive.namelist()
        self.assertEqual(names, sorted(names))
        self.assertEqual("0001.jpg", names[0])
        self.assertEqual("1001.jpg", names[-1])

    def test_keeps_three_digits_for_ordinary_volumes(self):
        # Arrange
        for index in range(1, 11):
            write_image(self.source / f"p{index:03d}.jpg")

        # Act
        self.handler.create_archive(self.source, self.output)

        # Assert
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual("001.jpg", archive.namelist()[0])

    def test_converts_bmp_pages_to_png(self):
        # Arrange
        write_image(self.source / "001.jpg", "JPEG")
        write_image(self.source / "002.bmp", "BMP")

        # Act
        self.handler.create_archive(self.source, self.output)

        # Assert - viewer の対応形式だけになる
        with zipfile.ZipFile(self.output) as archive:
            names = archive.namelist()
            self.assertEqual(["001.jpg", "002.png"], names)
            with Image.open(io.BytesIO(archive.read("002.png"))) as converted:
                self.assertEqual("PNG", converted.format)

    def test_skips_macos_metadata_and_dotfiles(self):
        # Arrange
        write_image(self.source / "001.jpg")
        (self.source / "__MACOSX").mkdir()
        (self.source / "__MACOSX" / "._001.jpg").write_bytes(b"\x00\x05\x16\x07")
        (self.source / ".DS_Store").write_bytes(b"junk")

        # Act
        self.handler.create_archive(self.source, self.output)

        # Assert - ページは1枚だけ
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(["001.jpg"], archive.namelist())

    def test_excludes_valid_images_inside_macos_metadata_directory(self):
        # Arrange - ドット始まりでない正当な画像でも __MACOSX/ 配下は除外する
        write_image(self.source / "001.jpg")
        write_image(self.source / "__MACOSX" / "001.jpg")

        # Act
        self.handler.create_archive(self.source, self.output)

        # Assert
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(["001.jpg"], archive.namelist())

    def test_converts_extension_even_without_renaming(self):
        # Arrange - rename_images=False でも中身が PNG なら名前も PNG にする
        write_image(self.source / "cover.bmp", "BMP")

        # Act
        self.handler.create_archive(self.source, self.output, rename_images=False)

        # Assert
        with zipfile.ZipFile(self.output) as archive:
            names = archive.namelist()
            self.assertEqual(["cover.png"], names)
            with Image.open(io.BytesIO(archive.read("cover.png"))) as converted:
                self.assertEqual("PNG", converted.format)

    def test_rejects_conversion_that_would_collide_without_renaming(self):
        # Arrange - cover.bmp と cover.png が両方あると同名になる
        write_image(self.source / "cover.bmp", "BMP")
        write_image(self.source / "cover.png", "PNG")

        # Act
        created = self.handler.create_archive(
            self.source, self.output, rename_images=False
        )

        # Assert - 黙って上書きせず失敗させる
        self.assertFalse(created)


class ImageDirectoryDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)
        self.handler = ArchiveHandler()

    def test_does_not_treat_macos_metadata_as_an_image_directory(self):
        # Arrange - AppleDouble しか入っていないディレクトリを巻として数えない
        write_image(self.root / "pages" / "001.jpg")
        macos = self.root / "__MACOSX"
        macos.mkdir()
        (macos / "._001.jpg").write_bytes(b"\x00\x05\x16\x07")

        # Act
        found = self.handler.find_all_image_directories(self.root)

        # Assert
        self.assertEqual([self.root / "pages"], found)


if __name__ == "__main__":
    unittest.main()
