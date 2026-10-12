"""画像生成と編集保存が重なったときのキャッシュ更新を検証する。"""

import io
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from manga_api.app import create_app
from manga_api.thumbnails import ThumbnailCache, render


class ThumbnailGenerationTest(unittest.TestCase):
    def test_discard_during_generation_does_not_repopulate_old_image(self):
        cache = ThumbnailCache()
        started = threading.Event()
        resume = threading.Event()
        key = ("book.zip", "001.png", 240)

        def generate():
            started.set()
            self.assertTrue(resume.wait(10))
            return b"old"

        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(cache.get_or_create, key, generate)
            try:
                self.assertTrue(started.wait(10))
                cache.discard("book.zip")
            finally:
                resume.set()
            self.assertEqual(b"old", pending.result(timeout=10))
        self.assertEqual(b"new", cache.get_or_create(key, lambda: b"new"))


class ThumbnailRefreshApiTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.archive = self.root / "book.zip"
        self.images = []
        for color in ("red", "blue"):
            buffer = io.BytesIO()
            Image.new("RGB", (300, 450), color).save(buffer, "PNG")
            self.images.append(buffer.getvalue())
        with zipfile.ZipFile(self.archive, "w") as archive:
            for number, data in enumerate(self.images, 1):
                archive.writestr(f"{number:03}.png", data)
        self.app = create_app(
            state_dir=self.root / "state",
            token="thumbnail-refresh",
            allowed_roots=[self.root],
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def thumb(self, width=240, headers=None):
        return self.client.get(
            "/api/thumb",
            params={
                "token": self.app.state.token,
                "archive": str(self.archive),
                "name": "001.png",
                "width": width,
            },
            headers=headers,
        )

    def test_save_during_render_succeeds_and_next_request_has_new_picture(self):
        started = threading.Event()
        resume = threading.Event()

        def delayed_render(data, width):
            started.set()
            self.assertTrue(resume.wait(10))
            return render(data, width)

        with (
            patch("manga_api.thumbnails.render", side_effect=delayed_render),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            pending = executor.submit(self.thumb)
            try:
                self.assertTrue(started.wait(10))
                response = self.client.post(
                    "/api/jobs/reorder",
                    params={"token": self.app.state.token},
                    json={
                        "archive": str(self.archive),
                        "order": ["002.png", "001.png"],
                    },
                )
                self.assertEqual(202, response.status_code, response.text)
                job = self.client.get(
                    f"/api/jobs/{response.json()['id']}",
                    params={"token": self.app.state.token},
                ).json()
                self.assertEqual("succeeded", job["state"], job)
            finally:
                resume.set()
            before = pending.result(timeout=10)

        self.assertEqual(200, before.status_code)
        self.assertEqual(render(self.images[0], 240), before.content)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(self.images[1], archive.read("001.png"))
        for width in (160, 240):
            after = self.thumb(width, {"If-None-Match": before.headers["etag"]})
            self.assertEqual(200, after.status_code)
            self.assertEqual(render(self.images[1], width), after.content)

    def test_unchanged_images_keep_size_cache_and_conditional_response(self):
        for width in (160, 240):
            with self.subTest(width=width):
                first = self.thumb(width)
                self.assertEqual(200, first.status_code)
                with Image.open(io.BytesIO(first.content)) as image:
                    self.assertEqual((width, width * 3 // 2), image.size)
                with patch("manga_api.thumbnails.render") as generate:
                    repeated = self.thumb(
                        width, {"If-None-Match": first.headers["etag"]}
                    )
                    self.assertEqual(304, repeated.status_code)
                    self.assertEqual(b"", repeated.content)
                    generate.assert_not_called()
