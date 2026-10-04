"""本に施した編集の種類を、本の中の記録に残す（#143）。

整理の画面は、サムネイル作成・ページ並べ替え・ページ分割結合をした本に印を
出す。並べ替えは中身から見分けられないので、編集したこと自体を
``.manga-organizer/manifest.json`` の ``edits`` に残す。

- サムネイル・並べ替え・分割結合のそれぞれ、書き込みが通ったときに足す
- 何も変わらない保存・確定では足さない
- 元画像の記録（originals / derived）を書き換える加工でも、印は消えない
- ``POST /api/edits`` が本ごとの種類をまとめて返す
"""

import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_core.cover_editor import CoverTransform, apply_to_archive  # noqa: E402
from manga_core.original_store import (  # noqa: E402
    MANIFEST_ENTRY,
    plan_edit,
    recorded_edits,
)
from manga_core.page_splitter import (  # noqa: E402
    SplitIntent,
    SplitPosition,
    apply_rows,
    scan_rows,
)


def png(width: int, height: int, colour: str) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()


def build_book(path: Path) -> Path:
    """縦長 3 枚と見開き 1 枚の本"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("001.png", png(600, 900, "#101010"))
        archive.writestr("002.png", png(600, 900, "#202020"))
        archive.writestr("003.png", png(1200, 900, "#303030"))
        archive.writestr("004.png", png(600, 900, "#404040"))
    return path


def write_manifest(path: Path, document: dict) -> None:
    """記録だけを書き足す。読み手が知らない欄の扱いを確かめるため"""
    with zipfile.ZipFile(path, "a") as archive:
        archive.writestr(MANIFEST_ENTRY, json.dumps(document))


class EditMarkFixture(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        self.archive = build_book(self.work_dir / "volume.zip")


class RecordedEditsTest(EditMarkFixture):
    def test_a_book_without_a_record_has_no_edits(self):
        self.assertEqual((), recorded_edits(self.archive))

    def test_unknown_kinds_in_the_record_are_ignored(self):
        # Arrange - 本を配る側が書いた知らない種類が混ざっている
        write_manifest(
            self.archive,
            {"version": 1, "originals": {}, "derived": {}, "edits": ["split", "x"]},
        )

        # Assert
        self.assertEqual(("split",), recorded_edits(self.archive))

    def test_refuses_an_unknown_kind(self):
        with self.assertRaises(ValueError):
            plan_edit(self.archive, "crop")


class WritersMarkTheirEditTest(EditMarkFixture):
    def test_making_a_thumbnail_marks_thumbnail(self):
        # Act
        apply_to_archive(self.archive, "001.png", CoverTransform(rotate=90))

        # Assert
        self.assertEqual(("thumbnail",), recorded_edits(self.archive))

    def test_splitting_marks_split_and_keeps_the_thumbnail_mark(self):
        # Arrange - 先にサムネイルを作っておく。分割は元画像の記録を書き換えるので、
        # そこで印まで書き落とさないこと
        apply_to_archive(self.archive, "001.png", CoverTransform(rotate=90))
        rows = scan_rows(self.archive)

        # Act - 見開きを割る
        apply_rows(
            self.archive,
            [
                SplitIntent(
                    names=row.names,
                    split=SplitPosition(x=600) if row.is_spread else None,
                )
                for row in rows
            ],
        )

        # Assert
        self.assertEqual(("split", "thumbnail"), recorded_edits(self.archive))

    def test_a_confirm_that_changes_nothing_leaves_no_mark(self):
        # Act - 走査の結果をそのまま送り返す
        rows = scan_rows(self.archive)
        apply_rows(
            self.archive,
            [SplitIntent(names=row.names, split=None) for row in rows],
        )

        # Assert
        self.assertEqual((), recorded_edits(self.archive))


class ApiTest(EditMarkFixture):
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

    def reorder(self, order: list[str]) -> None:
        submitted = self.client.post(
            "/api/jobs/reorder",
            params=self.params,
            json={"archive": str(self.archive), "order": order},
        )
        self.assertEqual(202, submitted.status_code, submitted.text)
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.params
        ).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))

    def edits_of(self, *paths: str) -> dict:
        response = self.client.post(
            "/api/edits", params=self.params, json={"paths": list(paths)}
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()["edits"]

    def test_reordering_marks_reorder_and_the_api_reports_it(self):
        # Arrange - 並べ替えていない本も一緒に問い合わせる
        untouched = build_book(self.work_dir / "untouched.zip")

        # Act
        self.reorder(["002.png", "001.png", "003.png", "004.png"])

        # Assert
        self.assertEqual(
            {str(self.archive): ["reorder"], str(untouched): []},
            self.edits_of(str(self.archive), str(untouched)),
        )

    def test_saving_the_same_order_leaves_no_mark(self):
        # Act
        self.reorder(["001.png", "002.png", "003.png", "004.png"])

        # Assert
        self.assertEqual({str(self.archive): []}, self.edits_of(str(self.archive)))

    def test_a_missing_file_has_no_edits(self):
        missing = str(self.work_dir / "missing.zip")
        self.assertEqual({missing: []}, self.edits_of(missing))

    def test_refuses_a_path_outside_the_allowed_roots(self):
        response = self.client.post(
            "/api/edits",
            params=self.params,
            json={"paths": [str(Path(self._temp.name).parent / "elsewhere.zip")]},
        )
        self.assertEqual(400, response.status_code, response.text)


if __name__ == "__main__":
    unittest.main()
