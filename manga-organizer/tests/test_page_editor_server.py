"""ページ修正サーバーの API とアクセス制御を検証する"""

import io
import json
import sys
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from gui.page_editor_server import (  # noqa: E402
    STATE_EDITING,
    STATE_SAVED,
    PageEditorServer,
)

PAGE_NAMES = ("cover.jpg", "p2.jpg", "p10.jpg")


def encode_page(color: str) -> bytes:
    """テスト用の JPEG を 1 枚作る"""
    buffer = io.BytesIO()
    Image.new("RGB", (600, 900), color).save(buffer, "JPEG")
    return buffer.getvalue()


class PageEditorServerTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.archive_path = Path(self._temp.name) / "volume.zip"
        with zipfile.ZipFile(self.archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            colors = ("red", "green", "blue")
            for name, color in zip(PAGE_NAMES, colors, strict=True):
                archive.writestr(name, encode_page(color))

        self.server = PageEditorServer(self.archive_path)
        self.addCleanup(self.server.shutdown)
        self.base_url = self.server.start().split("/?")[0]
        self.token = self.server.token

    def request(self, path, params=None, method="GET", payload=None):
        """テスト対象のサーバーへ 1 リクエスト送る"""
        query = {"token": self.token, **(params or {})}
        encoded = "&".join(f"{key}={value}" for key, value in query.items())
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}?{encoded}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body else {},
        )
        with urllib.request.urlopen(request) as response:
            return response.status, response.read(), response.headers

    def test_serves_index_with_token_substituted(self):
        # Act
        status, body, headers = self.request("/")

        # Assert
        self.assertEqual(200, status)
        page = body.decode("utf-8")
        self.assertIn(f'"{self.token}"', page)
        self.assertNotIn("__TOKEN__", page)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))

    def test_does_not_embed_the_archive_name_in_the_html(self):
        # Arrange - ファイル名由来のマークアップが
        # トークン付きオリジンで実行されるのを防ぐ
        # Act
        _, body, _ = self.request("/")
        _, pages, _ = self.request("/api/pages")

        # Assert - HTML には現れず、JSON 経由でのみ渡す
        self.assertNotIn("volume.zip", body.decode("utf-8"))
        self.assertEqual("volume.zip", json.loads(pages)["archive"])

    def test_lists_pages_in_natural_order(self):
        # Act
        _, body, _ = self.request("/api/pages")

        # Assert
        payload = json.loads(body)
        self.assertEqual(
            ["cover.jpg", "p2.jpg", "p10.jpg"],
            [page["name"] for page in payload["pages"]],
        )
        self.assertEqual("volume.zip", payload["archive"])

    def test_returns_jpeg_thumbnail_at_requested_width(self):
        # Act
        status, body, headers = self.request(
            "/api/thumb", {"name": "p2.jpg", "width": "160"}
        )

        # Assert
        self.assertEqual(200, status)
        self.assertEqual("image/jpeg", headers["Content-Type"])
        with Image.open(io.BytesIO(body)) as thumbnail:
            self.assertEqual(160, thumbnail.width)

    def test_rejects_requests_without_valid_token(self):
        # Act / Assert
        with self.assertRaises(urllib.error.HTTPError) as caught:
            request = urllib.request.Request(f"{self.base_url}/api/pages?token=wrong")
            urllib.request.urlopen(request)
        self.assertEqual(403, caught.exception.code)

    def test_rejects_unknown_page_name(self):
        # Act / Assert
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/image", {"name": "..%2Fescape.jpg"})
        self.assertEqual(404, caught.exception.code)

    def test_saves_new_order_and_marks_session_finished(self):
        # Arrange
        original = self.server.editor.read_entry("cover.jpg")
        self.assertEqual(STATE_EDITING, self.server.session.snapshot()[0])

        # Act
        status, body, _ = self.request(
            "/api/save",
            method="POST",
            payload={"order": ["cover.jpg", "p10.jpg", "p2.jpg"]},
        )

        # Assert
        self.assertEqual(200, status)
        self.assertTrue(json.loads(body)["changed"])
        self.assertEqual(STATE_SAVED, self.server.session.snapshot()[0])
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], archive.namelist())
            self.assertEqual(original, archive.read("001.jpg"))

    def test_rejects_malformed_save_payload(self):
        # Act / Assert
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/save", method="POST", payload={"order": "not-a-list"})
        self.assertEqual(400, caught.exception.code)

    def test_rejects_incomplete_save_payload(self):
        # Act / Assert
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/save", method="POST", payload={"order": ["p2.jpg"]})
        self.assertEqual(400, caught.exception.code)


if __name__ == "__main__":
    unittest.main()
