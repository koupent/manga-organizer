import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from manga_api.app import create_app
from manga_core.original_store import find_original, read_original
from manga_core.page_margins import common_margins, trim_pages, white_margins
from manga_core.page_splitter import SplitIntent, SplitPosition, apply_rows, scan_rows


def bordered(size=(400, 600), box=(40, 30, 360, 570)):
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).rectangle(box, fill="black")
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


class MarginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / "book.zip"
        self.original = bordered()
        with zipfile.ZipFile(self.path, "w") as archive:
            for name in ("001.png", "002.png", "003.png"):
                archive.writestr(name, self.original)
            archive.writestr("note.txt", "keep")

    def tearDown(self):
        self.temp.cleanup()

    def test_detect_common_white_borders_and_ignore_blank(self):
        margins = white_margins(self.original)
        self.assertAlmostEqual(margins[0], 10, delta=0.5)
        self.assertAlmostEqual(margins[1], 5, delta=0.5)
        self.assertEqual(
            common_margins([margins] * 8 + [(0, 0, 0, 0)] * 2), list(margins)
        )
        self.assertEqual(common_margins([margins, (0, 0, 0, 0)]), [0] * 4)
        blank = io.BytesIO()
        Image.new("RGB", (100, 100), "white").save(blank, "PNG")
        self.assertEqual(white_margins(blank.getvalue()), (0, 0, 0, 0))

    def test_selection_preserves_other_pages_and_originals_and_timestamp(self):
        before = self.path.stat().st_mtime_ns
        self.assertEqual(trim_pages(self.path, ["002.png"], [10, 5, 10, 5]), 1)
        with zipfile.ZipFile(self.path) as archive:
            data = archive.read("002.png")
            with Image.open(io.BytesIO(data)) as image:
                self.assertEqual(image.size, (320, 540))
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(archive.read("001.png"), self.original)
            self.assertEqual(archive.read("003.png"), self.original)
            self.assertEqual(archive.read("note.txt"), b"keep")
        self.assertEqual(
            read_original(self.path, find_original(self.path, data)), self.original
        )
        self.assertEqual(self.path.stat().st_mtime_ns, before)

    def test_invalid_target_or_crop_changes_nothing(self):
        before = self.path.read_bytes()
        for names, margins in (
            (["missing.png"], [10, 0, 0, 0]),
            (["001.png"], [90, 0, 0, 0]),
            (["001.png"], [0] * 4),
        ):
            with self.assertRaises(ValueError):
                trim_pages(self.path, names, margins)
            self.assertEqual(self.path.read_bytes(), before)

    def test_cancel_during_preparation_keeps_archive(self):
        before = self.path.read_bytes()

        def stop(current, total):
            raise RuntimeError("cancelled")

        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            trim_pages(self.path, ["001.png", "002.png"], [10, 0, 10, 0], stop)
        self.assertEqual(self.path.read_bytes(), before)

    def test_trim_split_pages_keeps_them_as_individual_pages(self):
        apply_rows(
            self.path,
            [
                SplitIntent(("001.png",), SplitPosition(200)),
                SplitIntent(("002.png",), None),
                SplitIntent(("003.png",), None),
            ],
        )
        trim_pages(self.path, ["001.png", "002.png"], [5, 0, 5, 0])
        rows = scan_rows(self.path)
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(len(row.names) == 1 for row in rows))
        self.assertEqual(
            [(row.width, row.height) for row in rows[:2]], [(180, 600)] * 2
        )

    def test_scan_save_and_stale_token_api(self):
        app = create_app(
            token="test",
            state_dir=self.root / "state",
            allowed_roots=[self.root],
            run_jobs_inline=True,
        )
        with TestClient(app) as client:
            client.params = {"token": "test"}
            response = client.post(
                "/api/jobs/margin-scan", json={"archive": str(self.path)}
            )
            self.assertEqual(response.status_code, 202)
            scan = client.get("/api/jobs/" + response.json()["id"]).json()["result"]
            self.assertEqual(len(scan["pages"]), 3)
            request = {
                "archive": str(self.path),
                "token": scan["token"],
                "names": ["001.png", "003.png"],
                "margins": [10, 5, 10, 5],
            }
            response = client.post("/api/jobs/margins", json=request)
            self.assertEqual(response.status_code, 202)
            job = client.get("/api/jobs/" + response.json()["id"]).json()
            self.assertEqual(job["state"], "succeeded", job)
            self.assertEqual(job["result"]["trimmed_count"], 2)
            before = self.path.read_bytes()
            self.assertEqual(
                client.post("/api/jobs/margins", json=request).status_code, 400
            )
            self.assertEqual(self.path.read_bytes(), before)
        app.state.jobs.close()
