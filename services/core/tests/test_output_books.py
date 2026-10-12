"""出力先に既にある本と、番号の詰め直し（#178）"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_api.thumbnails import render  # noqa: E402
from manga_core.output_books import list_output_books, rename_files  # noqa: E402

SERIES = "[著者] 作品"


class OutputBooksTestBase(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp.cleanup)
        self.work_dir = Path(temp.name).resolve()
        self.output = self.work_dir / "出力"
        self.series = self.output / SERIES
        self.series.mkdir(parents=True)

    def write(self, name: str, body: bytes = b"zip") -> Path:
        path = self.series / name
        path.write_bytes(body)
        return path

    def names(self) -> list[str]:
        return sorted(path.name for path in self.series.iterdir())


class ListOutputBooksTest(OutputBooksTestBase):
    def test_lists_only_names_that_follow_the_rule(self):
        """整理が作りうる名前だけを拾い、名前の順に並べる"""
        # Arrange
        self.write(f"{SERIES} 第003巻_1.zip")
        self.write(f"{SERIES} 第003巻.zip", b"longer")
        self.write(f"{SERIES} Unknown.zip")
        self.write(f"{SERIES} 第010巻.zip")
        self.write("手で置いた本.zip")
        self.write("[別の著者] 作品 第001巻.zip")
        self.write(f"{SERIES} 第004巻.txt")

        # Act
        books = list_output_books(self.output, "著者", "作品")

        # Assert
        self.assertEqual(
            [
                f"{SERIES} Unknown.zip",
                f"{SERIES} 第003巻.zip",
                f"{SERIES} 第003巻_1.zip",
                f"{SERIES} 第010巻.zip",
            ],
            [book.path.name for book in books],
        )
        self.assertEqual([None, 3, 3, 10], [book.volume for book in books])
        self.assertEqual(6, books[1].size)

    def test_counts_pages_without_including_hidden_edit_originals(self):
        path = self.series / f"{SERIES} 第001巻.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name in (
                "001.jpg",
                "002.png",
                "003.webp",
                ".manga-organizer/originals/page.jpg",
                ".manga-organizer/deleted/page.png",
                "__MACOSX/001.jpg",
                "notes.txt",
            ):
                archive.writestr(name, b"metadata-only fixture")
        books = list_output_books(self.output, "著者", "作品")
        self.assertEqual(3, books[0].image_count)
        # 同じパスを編集した後も、古い枚数を使わない。
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("001.jpg", b"updated")
        self.assertEqual(
            1, list_output_books(self.output, "著者", "作品")[0].image_count
        )

    def test_returns_nothing_when_the_folder_is_missing(self):
        # Act / Assert
        self.assertEqual([], list_output_books(self.output, "別人", "作品"))
        self.assertEqual([], list_output_books(self.output, "", "作品"))


class RenameFilesTest(OutputBooksTestBase):
    def test_shifts_numbers_down_even_when_targets_overlap_sources(self):
        """``_1`` → 番号なし、``_2`` → ``_1`` を 1 度に付け替える"""
        # Arrange - 番号なしを消した後の姿
        first = self.write(f"{SERIES} 第003巻_1.zip", b"first")
        second = self.write(f"{SERIES} 第003巻_2.zip", b"second")

        # Act
        rename_files(
            [
                (first, self.series / f"{SERIES} 第003巻.zip"),
                (second, self.series / f"{SERIES} 第003巻_1.zip"),
            ]
        )

        # Assert - 中身ごと名前が移っている
        self.assertEqual(
            [f"{SERIES} 第003巻.zip", f"{SERIES} 第003巻_1.zip"], self.names()
        )
        self.assertEqual(b"first", (self.series / f"{SERIES} 第003巻.zip").read_bytes())
        self.assertEqual(
            b"second", (self.series / f"{SERIES} 第003巻_1.zip").read_bytes()
        )

    def test_refuses_to_overwrite_a_file_that_is_not_renamed(self):
        """付け替えないファイルの名前へは移さない。何も動かさずに断る"""
        # Arrange
        source = self.write(f"{SERIES} 第003巻_1.zip")
        self.write(f"{SERIES} 第003巻.zip", b"keep")

        # Act / Assert
        with self.assertRaises(ValueError):
            rename_files([(source, self.series / f"{SERIES} 第003巻.zip")])
        self.assertEqual(b"keep", (self.series / f"{SERIES} 第003巻.zip").read_bytes())
        self.assertEqual(
            [f"{SERIES} 第003巻.zip", f"{SERIES} 第003巻_1.zip"], self.names()
        )

    def test_refuses_to_move_into_another_folder(self):
        # Arrange
        source = self.write(f"{SERIES} 第003巻_1.zip")

        # Act / Assert
        with self.assertRaises(ValueError):
            rename_files([(source, self.output / f"{SERIES} 第003巻.zip")])
        self.assertEqual([f"{SERIES} 第003巻_1.zip"], self.names())


class RenameRetryTest(OutputBooksTestBase):
    def test_retries_while_the_file_is_held(self):
        """作った直後のファイルが掴まれていても、待ってやり直して付け替える"""
        # Arrange - 最初の 2 回だけ断られる（同期中のフォルダが掴んでいる姿）
        source = self.write(f"{SERIES} 第025巻_1.zip", b"kept")
        target = self.series / f"{SERIES} 第025巻.zip"
        real_rename = Path.rename
        refusals = iter([True, True])

        def flaky_rename(path: Path, destination: Path):
            if next(refusals, False):
                raise PermissionError("使用中です")
            return real_rename(path, destination)

        # Act
        with (
            mock.patch.object(Path, "rename", flaky_rename),
            mock.patch("manga_core.output_books.RENAME_WAIT", 0),
        ):
            rename_files([(source, target)])

        # Assert
        self.assertEqual([f"{SERIES} 第025巻.zip"], self.names())
        self.assertEqual(b"kept", target.read_bytes())


class OutputBooksApiTest(OutputBooksTestBase):
    def setUp(self):
        super().setUp()
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.params = {"token": self.app.state.token}

    def test_lists_books_already_in_the_output(self):
        # Arrange
        self.write(f"{SERIES} 第001巻.zip")
        self.write(f"{SERIES} 第001巻_1.zip", b"12345")

        # Act
        response = self.client.post(
            "/api/output/books",
            params=self.params,
            json={
                "output_directory": str(self.output),
                "title": "作品",
                "author": "著者",
            },
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [
                {
                    "path": str(self.series / f"{SERIES} 第001巻.zip"),
                    "volume": 1,
                    "size": 3,
                    "image_count": None,
                },
                {
                    "path": str(self.series / f"{SERIES} 第001巻_1.zip"),
                    "volume": 1,
                    "size": 5,
                    "image_count": None,
                },
            ],
            response.json()["books"],
        )

    def test_renames_and_refuses_outside_the_allowed_roots(self):
        """付け替えは通り、許可の外を指せば何も動かさずに断る"""
        # Arrange
        source = self.write(f"{SERIES} 第002巻_1.zip")
        target = self.series / f"{SERIES} 第002巻.zip"
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = Path(outside_temp.name).resolve() / "外_1.zip"
        outside.write_bytes(b"outside")

        # Act
        refused = self.client.post(
            "/api/files/rename",
            params=self.params,
            json={
                "renames": [
                    {"source": str(outside), "target": str(outside.with_name("外.zip"))}
                ]
            },
        )
        accepted = self.client.post(
            "/api/files/rename",
            params=self.params,
            json={"renames": [{"source": str(source), "target": str(target)}]},
        )

        # Assert
        self.assertEqual(400, refused.status_code)
        self.assertTrue(outside.exists())
        self.assertEqual(200, accepted.status_code)
        self.assertEqual([f"{SERIES} 第002巻.zip"], self.names())

    def test_reports_a_refused_rename_as_bad_request(self):
        # Arrange
        source = self.write(f"{SERIES} 第002巻_1.zip")
        self.write(f"{SERIES} 第002巻.zip")

        # Act
        response = self.client.post(
            "/api/files/rename",
            params=self.params,
            json={
                "renames": [
                    {
                        "source": str(source),
                        "target": str(self.series / f"{SERIES} 第002巻.zip"),
                    }
                ]
            },
        )

        # Assert
        self.assertEqual(400, response.status_code)
        self.assertIn("既にあります", response.json()["detail"])


class FileMutationThumbnailsTest(OutputBooksTestBase):
    """番号の詰め直し・削除で同じ名前を再利用しても画像を取り違えない。"""

    def setUp(self):
        super().setUp()
        self.app = create_app(
            state_dir=self.work_dir / "state", allowed_roots=[self.work_dir]
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.params = {"token": self.app.state.token}

    def page(self, color: str) -> bytes:
        buffer = io.BytesIO()
        Image.new("RGB", (40, 60), color).save(buffer, "PNG")
        return buffer.getvalue()

    def archive(self, name: str, *pages: bytes) -> Path:
        path = self.series / name
        with zipfile.ZipFile(path, "w") as archive:
            for index, page in enumerate(pages, 1):
                archive.writestr(f"{index:03}.png", page)
        return path

    def thumbnail(self, path: Path, width=160, name="001.png", etag=None):
        return self.client.get(
            "/api/thumb",
            params={**self.params, "archive": str(path), "name": name, "width": width},
            headers={"If-None-Match": etag} if etag else {},
        )

    def rename(self, *pairs: tuple[Path, Path]):
        return self.client.post(
            "/api/files/rename",
            params=self.params,
            json={
                "renames": [
                    {"source": str(source), "target": str(target)}
                    for source, target in pairs
                ]
            },
        )

    def trash(self, path: Path):
        return self.client.post(
            "/api/files/trash", params=self.params, json={"path": str(path)}
        )

    def test_chain_rename_refreshes_multiple_widths_and_drops_removed_pages(self):
        red, green, blue = [self.page(color) for color in ("red", "green", "blue")]
        first = self.archive("book.zip", red, red)
        second = self.archive("book_1.zip", green)
        third = self.archive("book_2.zip", blue)
        unrelated = self.archive("other.zip", red)
        before = {
            (path, width): self.thumbnail(path, width)
            for path in (first, second, third, unrelated)
            for width in (160, 240)
        }
        self.assertEqual(200, self.thumbnail(first, name="002.png").status_code)
        first.unlink()

        self.assertEqual(200, self.rename((second, first), (third, second)).status_code)

        for path, page in ((first, green), (second, blue)):
            for width in (160, 240):
                with self.subTest(path=path.name, width=width):
                    response = self.thumbnail(
                        path, width, etag=before[path, width].headers["etag"]
                    )
                    self.assertEqual(200, response.status_code)
                    self.assertEqual(render(page, width), response.content)
        self.assertEqual(404, self.thumbnail(first, name="002.png").status_code)
        # 空いた移動元の名前を再利用しても、以前の本の画像は残さない。
        self.archive(third.name, red)
        self.assertEqual(render(red, 160), self.thumbnail(third).content)
        self.assertEqual(
            304,
            self.thumbnail(
                unrelated, etag=before[unrelated, 160].headers["etag"]
            ).status_code,
        )

    def test_trash_refreshes_reused_name(self):
        red, green = self.page("red"), self.page("green")
        path = self.archive("book.zip", red)
        before = self.thumbnail(path)
        with mock.patch("manga_api.app.send2trash", side_effect=lambda p: p.unlink()):
            self.assertEqual(200, self.trash(path).status_code)
        self.archive(path.name, green)
        response = self.thumbnail(path, etag=before.headers["etag"])
        self.assertEqual(200, response.status_code)
        self.assertEqual(render(green, 160), response.content)

    def test_refused_mutations_preserve_files_and_cache(self):
        red, green = self.page("red"), self.page("green")
        first = self.archive("book.zip", red)
        second = self.archive("book_1.zip", green)
        before = {
            path: (path.read_bytes(), self.thumbnail(path)) for path in (first, second)
        }
        with mock.patch.object(self.app.state.thumbnails, "discard") as discard:
            self.assertEqual(400, self.rename((second, first)).status_code)
            with mock.patch(
                "manga_api.app.send2trash", side_effect=PermissionError("held")
            ):
                self.assertEqual(409, self.trash(first).status_code)
            discard.assert_not_called()
        for path, (body, response) in before.items():
            self.assertEqual(body, path.read_bytes())
            self.assertEqual(
                304, self.thumbnail(path, etag=response.headers["etag"]).status_code
            )

    def test_failed_chain_rename_rolls_back_without_invalidating_cache(self):
        from manga_core import output_books

        first = self.archive("book.zip", self.page("red"))
        second = self.archive("book_1.zip", self.page("green"))
        targets = [self.series / "new.zip", self.series / "new_1.zip"]
        before = {
            path: (path.read_bytes(), self.thumbnail(path)) for path in (first, second)
        }
        real_rename = output_books._rename
        failed = False

        def fail_second(source, target):
            nonlocal failed
            if target == targets[1] and not failed:
                failed = True
                raise OSError("controlled failure")
            real_rename(source, target)

        with (
            mock.patch.object(output_books, "_rename", side_effect=fail_second),
            mock.patch.object(self.app.state.thumbnails, "discard") as discard,
        ):
            self.assertEqual(
                409, self.rename((first, targets[0]), (second, targets[1])).status_code
            )
            discard.assert_not_called()
        for path, (body, response) in before.items():
            self.assertEqual(body, path.read_bytes())
            self.assertEqual(
                304, self.thumbnail(path, etag=response.headers["etag"]).status_code
            )
        self.assertTrue(all(not path.exists() for path in targets))


if __name__ == "__main__":
    unittest.main()
