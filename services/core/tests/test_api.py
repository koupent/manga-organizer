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

        # allowed_roots を渡さないと任意のファイルを読めてしまう。
        # シェルは必ず渡す前提なので、テストでも実際に制限を効かせる
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
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

    def test_serves_the_full_size_image(self):
        # Act - 原寸表示に使う
        response = self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "001.jpg"}),
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("image/jpeg", response.headers["content-type"])
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual((800, 1200), image.size)

    def test_rejects_a_full_size_request_for_an_unknown_page(self):
        # Act / Assert
        response = self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "../secret.jpg"}),
        )
        self.assertEqual(404, response.status_code)

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


class SeriesEstimateTest(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.library = self.work_dir / "library"
        self.library.mkdir()
        for name in ("作品A 第01巻.zip", "作品A 第02巻.zip", "作品B 第01巻.zip"):
            with zipfile.ZipFile(self.library / name, "w") as archive:
                archive.writestr("001.jpg", make_page())

    def test_estimates_groups_from_the_given_archives(self):
        # Act
        response = self.client.post(
            "/api/series/estimate",
            params=self.auth(),
            json={"archives": [str(p) for p in sorted(self.library.glob("*.zip"))]},
        )

        # Assert
        self.assertEqual(200, response.status_code)
        groups = response.json()["groups"]
        self.assertEqual(["作品A", "作品B"], [g["title"] for g in groups])
        self.assertEqual([1, 2], [v["volume"] for v in groups[0]["volumes"]])
        self.assertIn("confidence", groups[0])

    def test_requires_a_token(self):
        # Act / Assert
        response = self.client.post("/api/series/estimate", json={"archives": []})
        self.assertEqual(401, response.status_code)

    def test_rejects_an_archive_outside_the_allowed_roots(self):
        # Act / Assert
        response = self.client.post(
            "/api/series/estimate",
            params=self.auth(),
            json={"archives": ["/etc/passwd"]},
        )
        self.assertEqual(400, response.status_code)


class CoverEditTest(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.spread = self.work_dir / "spread.zip"
        canvas = Image.new("RGB", (1600, 1200), "red")
        canvas.paste(Image.new("RGB", (800, 1200), "blue"), (800, 0))
        buffer = io.BytesIO()
        canvas.save(buffer, "JPEG", quality=95)
        with zipfile.ZipFile(self.spread, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("001.jpg", buffer.getvalue())
            archive.writestr("002.jpg", make_page())

    def test_reports_that_the_cover_is_a_spread(self):
        # Act
        response = self.client.get(
            "/api/cover", params=self.auth({"archive": str(self.spread)})
        )

        # Assert
        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual("001.jpg", payload["name"])
        self.assertTrue(payload["is_spread"])
        self.assertEqual(1600, payload["width"])

    def test_splits_the_cover_through_a_job(self):
        # Act
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={"archive": str(self.spread), "name": "001.jpg", "split": "right"},
        )

        # Assert
        self.assertEqual(202, submitted.status_code)
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        with zipfile.ZipFile(self.spread) as archive:
            with Image.open(io.BytesIO(archive.read("001.jpg"))) as cover:
                self.assertEqual((800, 1200), cover.size)

    def test_reports_a_rejected_transform(self):
        # Act - 90 度単位でない回転
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={"archive": str(self.spread), "name": "001.jpg", "rotate": 45},
        )
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()

        # Assert
        self.assertEqual("failed", job["state"])
        self.assertIn("90", job["error"])


class LibraryTest(ApiTestBase):
    """タイトル・著者の辞書。現行 Tkinter アプリの DB 編集画面の置き換え"""

    def test_starts_empty_and_records_a_pair(self):
        # Act
        created = self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "ワンピース", "author": "尾田栄一郎"},
        )

        # Assert
        self.assertEqual(200, created.status_code)
        listed = self.client.get("/api/library/entries", params=self.auth()).json()
        self.assertEqual(1, len(listed["entries"]))
        self.assertEqual("尾田栄一郎", listed["entries"][0]["author"])

    def test_looks_up_a_known_author_by_title(self):
        # Arrange
        self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "ワンピース", "author": "尾田栄一郎"},
        )

        # Act
        found = self.client.get(
            "/api/library/entries", params=self.auth({"query": "ワン"})
        ).json()

        # Assert
        self.assertEqual("ワンピース", found["entries"][0]["title"])

    def test_removes_an_entry(self):
        # Arrange
        self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "消す作品", "author": "著者"},
        )

        # Act
        removed = self.client.request(
            "DELETE", "/api/library/entries", params=self.auth({"title": "消す作品"})
        )

        # Assert
        self.assertEqual(200, removed.status_code)
        listed = self.client.get("/api/library/entries", params=self.auth()).json()
        self.assertEqual([], listed["entries"])

    def test_requires_a_token(self):
        self.assertEqual(401, self.client.get("/api/library/entries").status_code)


class BrowseTest(ApiTestBase):
    """ファイル選択。ブラウザは実パスを扱えないのでサーバー側で辿る"""

    def setUp(self):
        super().setUp()
        self.folder = self.work_dir / "shelf"
        (self.folder / "sub").mkdir(parents=True)
        for name in ("b.zip", "a.cbz", "memo.txt"):
            (self.folder / name).write_bytes(b"x")

    def test_lists_directories_and_archives(self):
        # Act
        listed = self.client.get(
            "/api/browse", params=self.auth({"path": str(self.folder)})
        ).json()

        # Assert - ディレクトリが先、アーカイブ以外は出さない
        self.assertEqual(str(self.folder), listed["path"])
        self.assertEqual(
            [("sub", True), ("a.cbz", False), ("b.zip", False)],
            [(e["name"], e["is_directory"]) for e in listed["entries"]],
        )

    def test_reports_the_parent_so_the_ui_can_go_up(self):
        # Act
        listed = self.client.get(
            "/api/browse", params=self.auth({"path": str(self.folder)})
        ).json()

        # Assert
        self.assertEqual(str(self.work_dir), listed["parent"])

    def test_defaults_to_the_allowed_root(self):
        # Act - path を省くと起点を返す
        listed = self.client.get("/api/browse", params=self.auth()).json()

        # Assert
        self.assertEqual(str(self.work_dir), listed["path"])
        self.assertIsNone(listed["parent"])

    def test_refuses_to_escape_the_allowed_roots(self):
        # Act / Assert
        response = self.client.get("/api/browse", params=self.auth({"path": "/etc"}))
        self.assertEqual(400, response.status_code)

    def test_requires_a_token(self):
        self.assertEqual(401, self.client.get("/api/browse").status_code)


class ResolveTest(ApiTestBase):
    """ドロップされたファイルを実パスに結びつける。

    ブラウザは実パスを渡さないが、名前とサイズは分かる。許可された場所の
    中から同じものを探せば、ドロップからでも対象を特定できる。
    """

    def setUp(self):
        super().setUp()
        self.shelf = self.work_dir / "shelf"
        (self.shelf / "深い場所").mkdir(parents=True)
        self.unique = self.shelf / "唯一.zip"
        self.unique.write_bytes(b"a" * 100)
        self.nested = self.shelf / "深い場所" / "奥.zip"
        self.nested.write_bytes(b"b" * 200)

    def test_resolves_by_name(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 100}]},
        ).json()

        # Assert
        self.assertEqual([str(self.unique)], found["resolved"])
        self.assertEqual([], found["unresolved"])

    def test_searches_subdirectories(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "奥.zip", "size": 200}]},
        ).json()

        # Assert
        self.assertEqual([str(self.nested)], found["resolved"])

    def test_reports_what_it_could_not_find(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "ない.zip", "size": 1}]},
        ).json()

        # Assert
        self.assertEqual([], found["resolved"])
        self.assertEqual(["ない.zip"], found["unresolved"])

    def test_uses_size_to_disambiguate_same_names(self):
        # Arrange - 同名が複数ある場合はサイズで絞る
        other = self.shelf / "深い場所" / "唯一.zip"
        other.write_bytes(b"c" * 999)

        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 999}]},
        ).json()

        # Assert
        self.assertEqual([str(other)], found["resolved"])

    def test_reports_ambiguous_matches_instead_of_guessing(self):
        # Arrange - 名前もサイズも同じものが 2 つ
        twin = self.shelf / "深い場所" / "唯一.zip"
        twin.write_bytes(b"a" * 100)

        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 100}]},
        ).json()

        # Assert - 勝手に選ばず、判断を返す
        self.assertEqual([], found["resolved"])
        self.assertEqual(["唯一.zip"], found["ambiguous"])

    def test_requires_a_token(self):
        self.assertEqual(
            401, self.client.post("/api/resolve", json={"files": []}).status_code
        )


class FixedTokenTest(unittest.TestCase):
    """開発中はトークンを固定できるようにする。

    再起動のたびに変わると、控えた URL がすぐ使えなくなる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def test_uses_the_given_token(self):
        # Arrange
        app = create_app(state_dir=self.work_dir / "state", token="固定トークン")

        # Act / Assert
        self.assertEqual("固定トークン", app.state.token)
        client = TestClient(app)
        self.addCleanup(client.close)
        self.assertEqual(
            200, client.get("/api/health", params={"token": "固定トークン"}).status_code
        )

    def test_generates_one_when_not_given(self):
        # Arrange
        first = create_app(state_dir=self.work_dir / "a").state.token
        second = create_app(state_dir=self.work_dir / "b").state.token

        # Assert - 既定では毎回異なる
        self.assertNotEqual(first, second)
        self.assertGreater(len(first), 20)


if __name__ == "__main__":
    unittest.main()
