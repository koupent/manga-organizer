"""フォルダを丸ごと投入できることを検証する（#70 第 1 段階）。

利用者の指摘は「処理対象の ZIP ファイルを一個一個選択するなんてことはしなくて、
このフォルダに入れているそのファイルを丸っと入れて」。実測でフォルダ 1 つ分を
集めるのに 13 回のクリックが要った。

いまの整理ジョブは受け取ったパスを 1 つずつ resolve_archive() に通し、そこで
`path.is_file()` がディレクトリを弾く。collect_archives() は既に rglob で
再帰できるが、ジョブはそれを呼んでいない。

ここで見るのは次の 4 つだけで、目次を読む解析・3 階層の一覧・チェックボックス
（第 2 段階以降）は範囲外とする。

1. フォルダを渡すと、その下のアーカイブが再帰的に処理される
2. ZIP に入っていない裸の画像フォルダも 1 冊として扱う
3. フォルダとファイルを混ぜて渡せる
4. allowed_roots の検証がフォルダにも効く
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
    """テスト用のページ画像。実際に開ける JPEG でないと展開側が弾く"""
    buffer = io.BytesIO()
    Image.new("RGB", (800, 1200), color).save(buffer, "JPEG")
    return buffer.getvalue()


class FolderInputTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

        # 許可された場所を実際に絞る。絞らないと第 4 の検証が意味を持たない
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.token, **(params or {})}

    def write_archive(self, path: Path, pages: int = 2) -> Path:
        """指定の場所に ZIP を作る。途中のディレクトリも掘る"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for index in range(1, pages + 1):
                archive.writestr(f"{index:03d}.jpg", make_page())
        return path

    def write_image_folder(self, path: Path, pages: int = 2) -> Path:
        """ZIP に入っていない、画像が直接置かれたフォルダを作る"""
        path.mkdir(parents=True, exist_ok=True)
        for index in range(1, pages + 1):
            (path / f"{index:03d}.jpg").write_bytes(make_page())
        return path

    def submit(self, targets: list[Path], output_directory: Path):
        """整理ジョブを投入する。受け付けたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "output_directory": str(output_directory),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )

    def organize(self, targets: list[Path], output_directory: Path) -> dict:
        """整理ジョブを投入し、終わったジョブの詳細を返す"""
        accepted = self.submit(targets, output_directory)
        self.assertEqual(
            202,
            accepted.status_code,
            f"フォルダを含む投入が受け付けられていない: {accepted.text}",
        )
        job_id = accepted.json()["id"]
        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job

    def produced_names(self, job: dict) -> list[str]:
        """出来たファイルの名前。実在と中身も併せて確かめる。

        パスだけ返して実物を作らない実装で通らないようにする。
        """
        produced = job["result"]["produced"]
        names = []
        for raw in produced:
            path = Path(raw)
            self.assertTrue(path.is_file(), f"出来たはずのファイルが無い: {raw}")
            with zipfile.ZipFile(path) as archive:
                self.assertTrue(archive.namelist(), f"中身が空: {raw}")
            names.append(path.name)
        return sorted(names)


class FolderRecursionTest(FolderInputTestBase):
    def test_organizes_every_archive_under_a_submitted_folder(self):
        # Arrange - 直下と、その下と、さらにその下。1 階層だけ辿る実装では
        # 取り残しが出る深さにする
        folder = self.work_dir / "取り込み"
        self.write_archive(folder / "raw_01.zip")
        self.write_archive(folder / "サブ" / "raw_02.zip")
        self.write_archive(folder / "サブ" / "さらに深く" / "raw_03.zip")
        output = self.work_dir / "out-recursive"

        # Act - フォルダのパスだけを投入する。中の 3 冊は名指ししない
        job = self.organize([folder], output)

        # Assert - 3 冊とも整理された。深さの違いで落ちない
        names = self.produced_names(job)
        self.assertEqual(
            [
                "[著者] 作品 第001巻.zip",
                "[著者] 作品 第002巻.zip",
                "[著者] 作品 第003巻.zip",
            ],
            names,
            f"フォルダの下の 3 冊が揃っていない: {names}",
        )

        # Assert - 失敗の内訳は空。「作れた」と「落ちなかった」を取り違えない
        self.assertEqual([], job["result"]["failed"], job["result"])

    def test_treats_a_bare_image_folder_as_one_volume(self):
        # Arrange - ZIP に入っていない、画像が直接置かれたフォルダを 2 つ。
        # 1 つだと「投入したフォルダ全体を 1 冊にまとめた」実装でも数が合う
        folder = self.work_dir / "裸を含む"
        self.write_image_folder(folder / "裸フォルダ_05")
        self.write_image_folder(folder / "裸フォルダ_06")
        output = self.work_dir / "out-bare"

        # Act
        job = self.organize([folder], output)

        # Assert - 画像が入っている階層まで降り、それぞれを 1 冊として扱う。
        # 巻数はフォルダ名から取れるので Unknown にはならない
        names = self.produced_names(job)
        self.assertEqual(
            ["[著者] 作品 第005巻.zip", "[著者] 作品 第006巻.zip"],
            names,
            f"裸の画像フォルダが 1 冊ずつになっていない: {names}",
        )

        # Assert - 中身のページも入っている。空の ZIP を 2 つ作って
        # 数だけ合わせる実装で通らないようにする
        for raw in job["result"]["produced"]:
            with zipfile.ZipFile(Path(raw)) as archive:
                self.assertEqual(
                    2, len(archive.namelist()), f"ページが 2 枚入っていない: {raw}"
                )

    def test_accepts_folders_and_files_in_the_same_submission(self):
        # Arrange - フォルダ 1 つと、単体のアーカイブ 1 つ
        folder = self.work_dir / "混在フォルダ"
        self.write_archive(folder / "サブ" / "raw_02.zip")
        loose = self.write_archive(self.work_dir / "raw_01.zip")
        output = self.work_dir / "out-mixed"

        # Act - 両方を同時に渡す
        job = self.organize([folder, loose], output)

        # Assert - フォルダの中身と単体のファイルが、どちらも整理される
        names = self.produced_names(job)
        self.assertEqual(
            ["[著者] 作品 第001巻.zip", "[著者] 作品 第002巻.zip"],
            names,
            f"フォルダと単体ファイルの片方しか処理されていない: {names}",
        )


class FolderAllowedRootsTest(FolderInputTestBase):
    """フォルダを受け取れるようにしても、許可された場所の外は読ませない。

    「拒む」だけなら、いまも全ディレクトリを拒んでいるので通ってしまう。
    許可の中のフォルダは受け付けることまで併せて見る。
    """

    def test_rejects_a_folder_outside_the_allowed_roots(self):
        # Arrange - 許可の外にも、中と同じ形のフォルダを用意する
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = Path(outside_temp.name).resolve() / "許可の外"
        self.write_archive(outside / "サブ" / "raw_01.zip")

        inside = self.work_dir / "許可の中"
        self.write_archive(inside / "サブ" / "raw_01.zip")
        output = self.work_dir / "out-roots"

        # Act - 外のフォルダを渡す
        refused = self.submit([outside], output)

        # Assert - 400 で弾かれ、理由も「許可の外」であること。
        # 「ファイルが見つかりません」で弾かれているなら、それは
        # ディレクトリを一律に拒んでいるだけで、根の検証が効いた証拠にならない
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertIn(
            "対象外",
            refused.json().get("detail", ""),
            f"許可の外だから拒んだ、とは読めない: {refused.text}",
        )

        # Assert - ジョブごと作られていない。走らせてから気付くのでは遅い
        listed = self.client.get("/api/jobs", params=self.auth()).json()
        self.assertEqual(
            [], [job for job in listed["jobs"] if job["kind"] == "organize"], listed
        )

        # Act / Assert - 同じ形でも許可の中なら受け付ける。
        # これが無いと「フォルダを全部拒む」実装でも上の検証を通せる
        accepted = self.submit([inside], output)
        self.assertEqual(
            202,
            accepted.status_code,
            f"許可の中のフォルダまで拒んでいる: {accepted.text}",
        )


if __name__ == "__main__":
    unittest.main()
