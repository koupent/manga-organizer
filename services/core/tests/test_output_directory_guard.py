"""書き出す側（出力先）の守りを検証する。

読む側は最初から許可された場所に閉じている（/api/browse と、各経路が受け取る
archive）。ところが /api/jobs/organize の output_directory だけが
refuse_outside を通っておらず、トークンを持つ呼び出しは 1 回の要求で任意の
場所へファイルを書き出せる。

塞ぎ方に「出力先をホーム以下へ縛る」は採らない。蔵書は 2 台目のドライブや
NAS に置かれることが多く、出力先の入力欄は自由入力なので（DirectoryPicker）、
いま D:\\manga へ整理できている利用者を丸ごと締め出してしまう。代わりに、
利用者が選んだ出力先をその時点でサイドカーへ覚えさせ、覚えのある場所へだけ
書き出す。境界は「ホームの中だけ」ではなく「利用者が選んだ場所だけ」になる。

ここでいう「選んだ」とは、`POST /api/output-roots` でその場所を名指しして
登録したことを指す。登録の約束は次の 4 つ。

- 起動しているサイドカーの一生ぶんだけ覚える（次の起動には持ち越さない）
- 書き出す側にだけ効く。読む側の許可は 1 ミリも広がらない
- 積み重なる。次を選んでも前に選んだ場所は消えない
- 覚えの無い出力先は、ジョブを作る前に 400 で断る

このファイルの一式は、経路 `POST /api/output-roots` がまだ無いので落ちる。
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

# 出力先を「利用者が選んだ」と伝える経路。まだ無い
CHOOSE_OUTPUT = "/api/output-roots"


def make_page(color: str = "navy") -> bytes:
    """テスト用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", (800, 1200), color).save(buffer, "JPEG")
    return buffer.getvalue()


class OutputDirectoryTestBase(unittest.TestCase):
    """許可された場所（work_dir）と、その外（outside）を用意する。

    実機のシェルはホームだけを許可して起動する（lib.rs の `&[home]`）ので、
    別ドライブや NAS は必ず「許可の外」になる。outside はその立場を演じる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.state_dir = self.work_dir / "state"
        self.archive = self.make_archive(self.work_dir / "volume_01.zip")

        outside_temp = TemporaryDirectory()
        self.addCleanup(outside_temp.cleanup)
        self.outside = Path(outside_temp.name)

        self.app = create_app(
            state_dir=self.state_dir,
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def make_archive(self, path: Path) -> Path:
        """整理できる中身を持つ ZIP を作る"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("001.jpg", "002.jpg"):
                archive.writestr(name, make_page())
        return path

    def auth(self, params: dict | None = None) -> dict:
        """トークン付きのクエリを組み立てる"""
        return {"token": self.token, **(params or {})}

    def choose(self, directory: Path | str):
        """利用者が出力先として選んだ、とサイドカーへ伝える"""
        return self.client.post(
            CHOOSE_OUTPUT, params=self.auth(), json={"directory": str(directory)}
        )

    def organize(self, output: Path, archives: list[Path] | None = None):
        """整理を投入する。断られるかどうかはこの応答で決まる"""
        return self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(a) for a in (archives or [self.archive])],
                "output_directory": str(output),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )

    def job_of(self, accepted) -> dict:
        """受け付けられたジョブの結果を読む。ジョブは同期実行される"""
        return self.client.get(
            f"/api/jobs/{accepted.json()['id']}", params=self.auth()
        ).json()

    def zips_under(self, root: Path) -> list[str]:
        """その場所に実際に出来上がったファイル。202 だけでは分からない"""
        if not root.exists():
            return []
        return sorted(str(path) for path in root.rglob("*.zip"))

    def organize_jobs(self) -> list[dict]:
        """記録に残っている整理ジョブ"""
        listed = self.client.get("/api/jobs", params=self.auth()).json()["jobs"]
        return [job for job in listed if job["kind"] == "organize"]


class ChosenOutputDirectoryTest(OutputDirectoryTestBase):
    """選んだ場所へは書ける／選んでいない場所へは書けない、を対で見る"""

    def test_refuses_an_output_directory_that_was_never_chosen(self):
        """利用者が一度も選んでいない場所へは書き出さない。

        いまはトークンさえあれば、1 回の POST で許可の外へ ZIP を置ける。
        置ける場所には自動起動のフォルダも含まれるので、書き出しの穴は
        そのまま居座り続ける仕掛けの置き場になる。
        """
        # Arrange - 許可の外。選んだと伝えたことは一度も無い
        never_chosen = self.outside / "整理後"

        # Act
        refused = self.organize(never_chosen)

        # Assert - 断りはこの応答で返る。ジョブにして後から失敗させると、
        # 画面は投入できたと思ったまま結果だけが変わる（#58 と同じ理由）
        self.assertEqual(
            400,
            refused.status_code,
            f"選んでいない場所への書き出しが通っている: {refused.text}",
        )

        # Assert - ジョブそのものが作られていない
        self.assertEqual([], self.organize_jobs(), "断ったのにジョブが残っている")

        # Assert - 1 バイトも書かれていない。状態番号だけでは、書いた後に
        # 400 を返す実装と見分けられない
        self.assertEqual(
            [], sorted(str(path) for path in self.outside.rglob("*")), "外に書かれた"
        )

    def test_organizes_into_a_chosen_directory_outside_the_allowed_roots(self):
        """利用者が選んだ場所なら、許可の外でも今までどおり整理できる。

        守りを足したときに最初に壊れるのがこの道。ここが通らないと、蔵書を
        別ドライブや NAS に置いている利用者は整理そのものができなくなる。
        「外は断る」だけのテストは何でも断る実装でも通るので、必ずこの受け入れ
        側と対にする。
        """
        # Arrange - 利用者が選んだ
        chosen = self.outside / "整理後"
        chosen.mkdir()
        chose = self.choose(chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act
        accepted = self.organize(chosen)

        # Assert - 受け付けたことは「どこへ書いたか」を何も語らない。
        # 選んだ場所に実物が出来ていることまで見る
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job_of(accepted)
        self.assertEqual("succeeded", job["state"], job.get("error"))
        produced = job["result"]["produced"]
        self.assertNotEqual([], produced, f"1 冊も出来ていない: {job}")
        self.assertNotEqual([], self.zips_under(chosen), "選んだ場所に実ファイルが無い")
        for path in produced:
            self.assertTrue(
                Path(path).resolve().is_relative_to(chosen.resolve()),
                f"選んだ場所の外に出来ている: {path}",
            )

    def test_remembers_a_directory_that_does_not_exist_yet(self):
        """まだ無いフォルダ名を打ち込んで整理する、を保つ。

        出力先は整理のときに作られる（FileOrganizer が mkdir する）。登録の
        条件に「すでに存在すること」を足すと、これから作るフォルダ名を打ち込む
        今までのやり方が断られるようになる。
        """
        # Arrange
        chosen = self.outside / "まだ無い"
        self.assertFalse(chosen.exists(), "前提が崩れている")
        chose = self.choose(chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act
        accepted = self.organize(chosen)

        # Assert
        self.assertEqual(202, accepted.status_code, accepted.text)
        self.assertNotEqual([], self.zips_under(chosen), "選んだ場所に実ファイルが無い")

    def test_reports_the_directory_it_remembered(self):
        """覚えた場所を、辿り直した形で返す。

        自由入力なので `.../整理後/../整理後` のような書き方も届く。覚える形と
        照合する形がずれていると、選んだ直後の出力先が断られる。返すのは、
        画面が「どこを覚えたか」を確かめられるようにするため。
        """
        # Arrange
        chosen = self.outside / "整理後"
        chosen.mkdir()

        # Act - 遠回りな書き方で選ぶ
        chose = self.choose(chosen / ".." / chosen.name)

        # Assert
        self.assertEqual(200, chose.status_code, chose.text)
        self.assertEqual(str(chosen.resolve()), chose.json()["directory"])

        # Assert - 素直な書き方で投入しても、同じ場所として通る
        accepted = self.organize(chosen)
        self.assertEqual(202, accepted.status_code, accepted.text)
        self.assertNotEqual([], self.zips_under(chosen))

    def test_keeps_the_earlier_choice_when_another_one_is_chosen(self):
        """選び直しても、前に選んだ場所は消えない。

        1 か所しか覚えない実装だと、2 か所へ交互に整理する利用者は戻るたびに
        断られる。覚えは積み重なる。
        """
        # Arrange
        first = self.outside / "一つ目"
        second = self.outside / "二つ目"
        for directory in (first, second):
            directory.mkdir()
            chose = self.choose(directory)
            self.assertEqual(200, chose.status_code, chose.text)

        # Act - 先に選んだほうへ戻る
        accepted = self.organize(first)

        # Assert
        self.assertEqual(202, accepted.status_code, accepted.text)
        self.assertNotEqual([], self.zips_under(first), "前に選んだ場所が消えている")

    def test_accepts_a_directory_below_the_chosen_one(self):
        """選んだ場所の下は、同じ 1 回の選択で足りる。

        許可された場所の判定（within_allowed）と同じ「配下かどうか」で揃える。
        「中」の意味を 2 通り持つと、片方だけ直したときに気づけない。
        """
        # Arrange
        chosen = self.outside / "manga"
        chosen.mkdir()
        chose = self.choose(chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act
        accepted = self.organize(chosen / "新刊")

        # Assert
        self.assertEqual(202, accepted.status_code, accepted.text)
        self.assertNotEqual([], self.zips_under(chosen / "新刊"))

    def test_refuses_a_sibling_that_only_shares_the_beginning_of_the_name(self):
        """名前の先頭が同じだけの別フォルダは、選んだことにならない。

        文字列の前方一致で照合すると、`/mnt/manga` を選んだだけで
        `/mnt/manga-秘密` へも書けてしまう。配下かどうかは区切りで見る。
        """
        # Arrange
        chosen = self.outside / "manga"
        sibling = self.outside / "manga-秘密"
        chosen.mkdir()
        sibling.mkdir()
        chose = self.choose(chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act
        refused = self.organize(sibling)

        # Assert
        self.assertEqual(
            400,
            refused.status_code,
            f"選んだ場所と名前が似ているだけの所へ書けている: {refused.text}",
        )
        self.assertEqual([], self.zips_under(sibling), "隣のフォルダに書かれた")

    def test_a_choice_does_not_survive_a_restart(self):
        """覚えは、起動しているサイドカーの一生ぶんだけ。

        選んだ場所をディスクへ残すと、次の起動でも許可されたままになる。
        トークンを起動ごとに捨てている意味が薄れるので、覚えも同じ寿命にする。
        """
        # Arrange - 前の起動で選んだ
        chosen = self.outside / "前回の出力先"
        chosen.mkdir()
        chose = self.choose(chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act - 同じ状態ディレクトリのまま起動し直す
        restarted = create_app(
            state_dir=self.state_dir,
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        client = TestClient(restarted)
        self.addCleanup(client.close)
        refused = client.post(
            "/api/jobs/organize",
            params={"token": restarted.state.token},
            json={
                "archives": [str(self.archive)],
                "output_directory": str(chosen),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )

        # Assert
        self.assertEqual(
            400,
            refused.status_code,
            f"前の起動で選んだ場所が残っている: {refused.text}",
        )
        self.assertEqual([], self.zips_under(chosen))

    def test_choosing_requires_the_token(self):
        """出力先の登録もトークンを要る側に置く。

        ここが素通しだと、トークンを持たない呼び出しでも書き出し先を先に
        仕込めてしまい、覚えの意味が無くなる。
        """
        # Act
        response = self.client.post(
            CHOOSE_OUTPUT, json={"directory": str(self.outside)}
        )

        # Assert
        self.assertEqual(401, response.status_code, response.text)


class ReadSideUnchangedTest(OutputDirectoryTestBase):
    """出力先を選んでも、読む側の許可は広がらないことを見る"""

    def setUp(self):
        super().setUp()
        self.outside_archive = self.make_archive(self.outside / "外_01.zip")
        self.chosen = self.outside / "整理後"
        self.chosen.mkdir()

    def test_choosing_an_output_directory_does_not_open_it_for_reading(self):
        """選んだのは「書き出す先」であって「読んでよい場所」ではない。

        登録が読む側まで広げると、書き出しの穴を塞ぐ代わりに、どこでも読める
        入口を新しく開くことになる。辿ることも、中のアーカイブを開くことも、
        選ぶ前と同じに断る。
        """
        # Arrange
        chose = self.choose(self.chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act / Assert - 選んだ場所も、その隣のアーカイブも読めない
        browsed = self.client.get(
            "/api/browse", params=self.auth({"path": str(self.chosen)})
        )
        self.assertEqual(400, browsed.status_code, "選んだ場所を辿れてしまう")
        listed = self.client.get(
            "/api/pages", params=self.auth({"archive": str(self.outside_archive)})
        )
        self.assertEqual(400, listed.status_code, "許可の外のアーカイブを開けてしまう")

        # Assert - 「何を渡しても断る」実装で通らないよう、中は通ることも見る
        self.assertEqual(
            200,
            self.client.get(
                "/api/browse", params=self.auth({"path": str(self.work_dir)})
            ).status_code,
        )
        self.assertEqual(
            200,
            self.client.get(
                "/api/pages", params=self.auth({"archive": str(self.archive)})
            ).status_code,
        )

    def test_still_refuses_source_archives_outside_the_allowed_roots(self):
        """出力先を選んでも、整理する対象の許可は広がらない。

        出力先の登録を allowed_roots そのものへ足すと、その下のアーカイブを
        読む道が一緒に開く。断るのは投入の時点で、ジョブは作らない。
        """
        # Arrange
        chose = self.choose(self.chosen)
        self.assertEqual(200, chose.status_code, chose.text)

        # Act - 対象だけが許可の外
        refused = self.organize(self.chosen, archives=[self.outside_archive])

        # Assert
        self.assertEqual(
            400,
            refused.status_code,
            f"許可の外のアーカイブを整理しようとしている: {refused.text}",
        )
        self.assertEqual([], self.organize_jobs(), "断ったのにジョブが残っている")
        self.assertEqual([], self.zips_under(self.chosen))


if __name__ == "__main__":
    unittest.main()
