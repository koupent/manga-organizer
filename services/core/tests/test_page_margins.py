import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from manga_api.app import create_app
from manga_core.cover_editor import CoverTransform, prepare_cover
from manga_core.original_store import (
    Operation,
    OriginalStoreError,
    find_crop_source,
    find_original,
    plan_record,
    read_original,
)
from manga_core.page_margins import (
    common_margins,
    restore_margins,
    trim_pages,
    white_margins,
)
from manga_core.page_reorder import OutputPage, ZipPageEditor
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

    def test_restore_selected_pages_exactly_and_keep_timestamp_and_other_pages(self):
        before_time = self.path.stat().st_mtime_ns
        trim_pages(self.path, ["001.png", "003.png"], [10, 5, 10, 5])
        with zipfile.ZipFile(self.path) as archive:
            other = archive.read("003.png")
        self.assertEqual(restore_margins(self.path, ["001.png"]), 1)
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("001.png"), self.original)
            self.assertEqual(archive.read("002.png"), self.original)
            self.assertEqual(archive.read("003.png"), other)
            self.assertEqual(archive.read("note.txt"), b"keep")
        self.assertEqual(self.path.stat().st_mtime_ns, before_time)

    def test_restore_after_split_preserves_split_pages_and_exact_bytes(self):
        apply_rows(
            self.path,
            [
                SplitIntent(("001.png",), SplitPosition(200)),
                SplitIntent(("002.png",), None),
                SplitIntent(("003.png",), None),
            ],
        )
        with zipfile.ZipFile(self.path) as archive:
            before = [archive.read(f"{i:03d}.png") for i in range(1, 5)]
        trim_pages(self.path, ["001.png", "002.png"], [5, 0, 5, 0])
        restore_margins(self.path, ["001.png", "002.png"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(
                [archive.read(f"{i:03d}.png") for i in range(1, 5)], before
            )
        rows = scan_rows(self.path)
        self.assertEqual(rows[0].names, ("001.png", "002.png"))

    def test_repeated_cuts_restore_one_step_at_a_time(self):
        trim_pages(self.path, ["001.png"], [5, 0, 5, 0])
        with zipfile.ZipFile(self.path) as archive:
            first = archive.read("001.png")
        trim_pages(self.path, ["001.png"], [5, 0, 5, 0])
        restore_margins(self.path, ["001.png"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("001.png"), first)
        restore_margins(self.path, ["001.png"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("001.png"), self.original)

    def test_restore_keeps_previous_cover_adjustment(self):
        adjusted, extras = prepare_cover(
            self.path,
            "001.png",
            self.original,
            CoverTransform(crop=(20, 20, 380, 580)),
            False,
        )
        editor = ZipPageEditor(self.path)
        editor.apply_pages(
            [
                OutputPage(p.name, adjusted if p.name == "001.png" else None)
                for p in editor.pages
            ],
            extra_entries=extras,
        )
        self.assertIsNone(find_crop_source(self.path, adjusted))
        trim_pages(self.path, ["001.png"], [5, 0, 5, 0])
        restore_margins(self.path, ["001.png"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("001.png"), adjusted)
        self.assertIsNone(find_crop_source(self.path, adjusted))

    def test_legacy_crop_can_restore_when_immediate_source_is_retained(self):
        cropped = bordered(size=(320, 540), box=(0, 0, 320, 540))
        extras = plan_record(
            self.path,
            self.original,
            "001.png",
            cropped,
            [Operation("crop", {"box": [40, 30, 360, 570]})],
        )
        editor = ZipPageEditor(self.path)
        editor.apply_pages(
            [
                OutputPage(p.name, cropped if p.name == "001.png" else None)
                for p in editor.pages
            ],
            extra_entries=extras,
        )
        restore_margins(self.path, ["001.png"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertEqual(archive.read("001.png"), self.original)

    def test_restore_invalid_or_unretained_source_changes_nothing(self):
        trim_pages(self.path, ["001.png"], [5, 0, 5, 0])
        before = self.path.read_bytes()
        for names in (["missing.png"], ["001.png", "002.png"], ["001.png"] * 2, []):
            with self.assertRaises(ValueError):
                restore_margins(self.path, names)
            self.assertEqual(self.path.read_bytes(), before)

    def test_corrupt_restore_source_does_not_overwrite_pages(self):
        trim_pages(self.path, ["001.png"], [5, 0, 5, 0])
        with zipfile.ZipFile(self.path) as archive:
            ref = find_crop_source(self.path, archive.read("001.png"))
            members = [(info, archive.read(info)) for info in archive.infolist()]
        with zipfile.ZipFile(self.path, "w") as archive:
            for info, data in members:
                archive.writestr(
                    info, b"corrupt" if info.filename == ref.entry else data
                )
        before = self.path.read_bytes()
        with self.assertRaises(OriginalStoreError):
            restore_margins(self.path, ["001.png"])
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
            response = client.post(
                "/api/jobs/margin-scan", json={"archive": str(self.path)}
            )
            scan = client.get("/api/jobs/" + response.json()["id"]).json()["result"]
            self.assertEqual(
                [p["restorable"] for p in scan["pages"]], [True, False, True]
            )
            restore = {
                "archive": str(self.path),
                "token": scan["token"],
                "names": ["001.png"],
            }
            response = client.post("/api/jobs/margin-restore", json=restore)
            self.assertEqual(response.status_code, 202)
            job = client.get("/api/jobs/" + response.json()["id"]).json()
            self.assertEqual(job["state"], "succeeded", job)
            self.assertEqual(job["result"]["restored_count"], 1)
            before = self.path.read_bytes()
            self.assertEqual(
                client.post("/api/jobs/margin-restore", json=restore).status_code, 400
            )
            self.assertEqual(self.path.read_bytes(), before)
        app.state.jobs.close()
