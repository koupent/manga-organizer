"""出力先に既にある本と、番号の詰め直し（#178）"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
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
                },
                {
                    "path": str(self.series / f"{SERIES} 第001巻_1.zip"),
                    "volume": 1,
                    "size": 5,
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


if __name__ == "__main__":
    unittest.main()
