"""サイドカー API を検証する。

127.0.0.1 でのみ待ち受け、起動ごとの使い捨てトークンを必須にする
（#16 の page_editor_server の設計を踏襲）。
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402


def make_page(color: str = "navy") -> bytes:
    """テスト用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", (800, 1200), color).save(buffer, "JPEG")
    return buffer.getvalue()


class ApiTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive = self.work_dir / "volume.zip"
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("002.jpg", "001.jpg", "003.jpg"):
                archive.writestr(name, make_page())

        self.app = create_app(state_dir=self.work_dir / "state", run_jobs_inline=True)
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self, params: dict | None = None) -> dict:
        """トークン付きのクエリを組み立てる"""
        return {"token": self.token, **(params or {})}


class AuthorizationTest(ApiTestBase):
    def test_every_route_rejects_a_missing_token(self):
        # Arrange
        routes = [
            ("GET", "/api/health"),
            ("GET", "/api/pages"),
            ("GET", "/api/thumb"),
            ("GET", "/api/jobs"),
            ("POST", "/api/jobs/organize"),
        ]

        # Act / Assert
        for method, path in routes:
            with self.subTest(route=f"{method} {path}"):
                response = self.client.request(method, path, json={})
                self.assertEqual(401, response.status_code)

    def test_rejects_a_wrong_token(self):
        # Act / Assert
        response = self.client.get("/api/health", params={"token": "wrong"})
        self.assertEqual(401, response.status_code)

    def test_accepts_the_issued_token(self):
        # Act
        response = self.client.get("/api/health", params=self.auth())

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("ok", response.json()["status"])


class OpenApiTest(ApiTestBase):
    def test_publishes_a_schema_for_type_generation(self):
        # Act - フロントの型生成に使うため認証なしで取得できる
        response = self.client.get("/openapi.json")

        # Assert
        self.assertEqual(200, response.status_code)
        schema = response.json()
        self.assertIn("/api/jobs/organize", schema["paths"])
        self.assertIn("/api/pages", schema["paths"])


class PagesTest(ApiTestBase):
    def test_lists_pages_in_lexicographic_order(self):
        # Act - viewer と同じ並び
        response = self.client.get(
            "/api/pages", params=self.auth({"archive": str(self.archive)})
        )

        # Assert
        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual(
            ["001.jpg", "002.jpg", "003.jpg"], [p["name"] for p in payload["pages"]]
        )

    def test_serves_a_thumbnail(self):
        # Act
        response = self.client.get(
            "/api/thumb",
            params=self.auth(
                {"archive": str(self.archive), "name": "001.jpg", "width": 160}
            ),
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("image/jpeg", response.headers["content-type"])
        with Image.open(io.BytesIO(response.content)) as thumbnail:
            self.assertEqual(160, thumbnail.width)

    def test_rejects_an_archive_outside_the_allowed_roots(self):
        # Act / Assert - 任意のファイルを読ませない
        response = self.client.get(
            "/api/pages", params=self.auth({"archive": "/etc/passwd"})
        )
        self.assertEqual(400, response.status_code)

    def test_rejects_a_page_that_is_not_in_the_archive(self):
        # Act / Assert
        response = self.client.get(
            "/api/thumb",
            params=self.auth({"archive": str(self.archive), "name": "../secret.jpg"}),
        )
        self.assertEqual(404, response.status_code)


class JobTest(ApiTestBase):
    def test_submits_a_reorder_job_and_reports_completion(self):
        # Act
        submitted = self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={
                "archive": str(self.archive),
                "order": ["003.jpg", "001.jpg", "002.jpg"],
            },
        )

        # Assert
        self.assertEqual(202, submitted.status_code)
        job_id = submitted.json()["id"]

        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], archive.namelist())

    def test_reports_a_failed_job_without_crashing(self):
        # Act - ページ数が合わない並び順
        submitted = self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={"archive": str(self.archive), "order": ["001.jpg"]},
        )
        job_id = submitted.json()["id"]

        # Assert
        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("failed", job["state"])
        self.assertIsNotNone(job["error"])

    def test_lists_submitted_jobs(self):
        # Arrange
        self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={
                "archive": str(self.archive),
                "order": ["001.jpg", "002.jpg", "003.jpg"],
            },
        )

        # Act
        listed = self.client.get("/api/jobs", params=self.auth()).json()

        # Assert
        self.assertEqual(1, len(listed["jobs"]))
        self.assertEqual("reorder", listed["jobs"][0]["kind"])

    def test_reports_an_unknown_job(self):
        # Act / Assert
        response = self.client.get("/api/jobs/missing", params=self.auth())
        self.assertEqual(404, response.status_code)


if __name__ == "__main__":
    unittest.main()
