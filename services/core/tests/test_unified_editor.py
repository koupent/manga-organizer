import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from manga_api.app import create_app
from manga_core.original_store import recorded_edits


def image(color: str, size: tuple[int, int] = (60, 90)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "PNG")
    return buffer.getvalue()


class UnifiedEditorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "book.zip"
        self.pages = {
            "a.png": image("red"),
            "b.png": image("green"),
            "c.png": image("blue"),
        }
        with zipfile.ZipFile(self.path, "w") as archive:
            for name, data in self.pages.items():
                archive.writestr(name, data)
            archive.writestr("note.txt", b"keep me")
        self.app = create_app(
            token="test",
            state_dir=self.root / "state",
            allowed_roots=[self.root],
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.client.params = {"token": "test"}

    def tearDown(self):
        self.client.close()
        self.app.state.jobs.close()
        self.temp.cleanup()

    def job(self, route, body):
        response = self.client.post(route, json=body)
        self.assertEqual(response.status_code, 202, response.text)
        return self.client.get("/api/jobs/" + response.json()["id"]).json()

    def request(self):
        scan = self.job("/api/jobs/split-scan", {"archive": str(self.path)})["result"]
        return {
            "archive": str(self.path),
            "token": scan["token"],
            "rows": [
                {"names": row["names"], "split": row["split"]} for row in scan["rows"]
            ],
            "allow_reorder": True,
            "reviewed": True,
        }

    def test_review_keeps_page_names_bytes_and_timestamp(self):
        with zipfile.ZipFile(self.path, "a") as archive:
            archive.writestr("empty/", b"")
            archive.comment = b"keep comment"
        before = self.path.stat().st_mtime_ns
        result = self.job("/api/jobs/split", self.request())
        self.assertEqual(result["state"], "succeeded", result)
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(
                {name: archive.read(name) for name in self.pages}, self.pages
            )
            self.assertEqual(archive.read("note.txt"), b"keep me")
            self.assertIn("empty/", archive.namelist())
            self.assertEqual(archive.comment, b"keep comment")
        self.assertEqual(self.path.stat().st_mtime_ns, before)
        self.assertIn("review", recorded_edits(self.path))

    def test_reorder_and_cover_adjustment_commit_together(self):
        request = self.request()
        request["rows"] = [request["rows"][2], request["rows"][0], request["rows"][1]]
        request["cover"] = {
            "archive": str(self.path),
            "name": "c.png",
            "crop": [0, 0, 30, 90],
        }
        result = self.job("/api/jobs/split", request)
        self.assertEqual(result["state"], "succeeded", result)
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("002.png"), self.pages["a.png"])
            self.assertEqual(archive.read("003.png"), self.pages["b.png"])
            with Image.open(io.BytesIO(archive.read("001.png"))) as cover:
                self.assertEqual(cover.size, (60, 90))
                self.assertEqual(cover.getpixel((30, 45)), (0, 0, 255))
        self.assertEqual(
            set(recorded_edits(self.path)), {"review", "reorder", "thumbnail"}
        )

    def test_reordered_merge_uses_new_adjacency(self):
        request = self.request()
        request["rows"] = [
            {"names": ["c.png", "a.png"], "split": None, "merge": True},
            {"names": ["b.png"], "split": None},
        ]
        result = self.job("/api/jobs/split", request)
        self.assertEqual(result["state"], "succeeded", result)
        with zipfile.ZipFile(self.path) as archive:
            with Image.open(io.BytesIO(archive.read("001.png"))) as spread:
                self.assertEqual(spread.getpixel((30, 45)), (255, 0, 0))
                self.assertEqual(spread.getpixel((90, 45)), (0, 0, 255))

    def test_missing_or_duplicate_pages_rejected_without_changes(self):
        before = self.path.read_bytes()
        for rows in (
            [{"names": ["a.png", "b.png"], "split": None}],
            [{"names": ["a.png"], "split": None}] * 3,
        ):
            request = self.request()
            request["rows"] = rows
            response = self.client.post("/api/jobs/split", json=request)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_cover_does_not_partially_reorder(self):
        before = self.path.read_bytes()
        request = self.request()
        request["rows"].reverse()
        request["cover"] = {
            "archive": str(self.path),
            "name": "c.png",
            "crop": [0, 0, 999, 90],
        }
        result = self.job("/api/jobs/split", request)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.path.read_bytes(), before)

    def test_manual_filename_is_written_and_cannot_escape_output(self):
        output = self.root / "out"
        output.mkdir()
        body = {
            "archives": [str(self.path)],
            "output_directory": str(output),
            "title": "作品",
            "author": "著者",
            "books": [{"source": str(self.path), "filename": "[著者] 作品 特典.zip"}],
        }
        result = self.job("/api/jobs/organize", body)
        self.assertEqual(result["state"], "succeeded", result)
        self.assertEqual(
            result["result"]["produced"],
            [str(output / "[著者] 作品" / "[著者] 作品 特典.zip")],
        )
        for name in (
            "../outside.zip",
            "C:\\outside.zip",
            "CON.zip",
            "bad?.zip",
            "empty.zip/next.zip",
        ):
            body["books"][0]["filename"] = name
            self.assertEqual(
                self.client.post("/api/jobs/organize", json=body).status_code, 422
            )
