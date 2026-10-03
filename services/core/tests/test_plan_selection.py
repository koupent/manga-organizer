"""解析を画面へ渡し、選んだ本だけを作る（#70 第 3 段階）。

第 2 段階でコア層（``manga_core.toc_analyzer``）は出来上がったが、API にも画面にも
繋がっていない。第 3 段階は「解析結果を 3 階層のリストで見せ、チェックボックスで
選べるようにする」ため、次の 2 つが要る。

1. **解析を呼ぶ入口** …… 投入したパスと作品名・著者を渡すと、出来上がる本が返る
2. **本の単位での選択** …… 整理の投入で、外した本を作らない

2 が第 3 段階の核心になる。いまの ``POST /api/jobs/organize`` は「アーカイブの
一覧」しか受け取らないので、1 つのアーカイブから 2 冊出るときに片方だけを外す
手段が無い。チェックボックスは見た目の話ではなく、この入口が本の単位で選べる
かどうかで決まる。

ここで求める公開契約は次の形とする。

    POST /api/analyze
        {"archives": [...絶対パス], "title": "作品", "author": "著者"}
      → {"books": [{"source", "entry", "output_name", "volume", "issues"}, ...]}

    この入口は第 4 段階で ``POST /api/jobs/analyze`` に移り、投入は 202 を返して
    結果は後から取りに行く形になった（``test_analysis_progress.py``）。運び方だけの
    変更なので、以下で確かめる中身は 1 つも変えていない。運び方の差は
    ``PlanApiTestBase.analyze`` が吸収する。

    ``books`` の各項目は ``toc_analyzer.PlannedBook`` をそのまま写した形にする。
    ``source`` は元のアーカイブ（または裸の画像フォルダ）の絶対パス、``entry`` は
    アーカイブ内での位置でアーカイブ全体が 1 冊なら空文字。この 2 つの組が本の
    同一性になる。名前は作品名と著者で変わるので、名前を鍵にはしない。

    POST /api/jobs/organize
        {..., "books": [{"source": ..., "entry": ...}]}

    ``books`` を省いたときは従来どおり投入された全部を作る（第 1 段階までの
    投入を壊さないため）。与えたときは、その ``(source, entry)`` の本だけを作る。
    空の配列は「1 冊も作らない」であって「全部作る」ではない。

画面側（3 階層の一覧・三態のチェック）は ``apps/desktop/e2e/plan-list.spec.ts``。
途中経過（実行中に行が育つ / #68）と RAR・7z の目次読みは第 4・第 5 段階なので
ここでは扱わない。
"""

import io
import sys
import time
import unittest
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"

# 実行前に利用者へ見せる印。値は manga_core.toc_analyzer と揃える
VOLUME_UNKNOWN = "volume-unknown"

# 1 つの ZIP に 2 冊分が入っている状態。アーカイブ単位でしか選べない実装では
# この 2 冊を選り分けられない
COMPOUND_ENTRIES = (
    "第01巻/001.jpg",
    "第01巻/002.jpg",
    "第02巻/001.jpg",
    "第02巻/002.jpg",
)


def page() -> bytes:
    """テスト用のページ画像。実処理まで走らせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


@dataclass(frozen=True)
class AnalyzedResponse:
    """解析ジョブの結果を、第 3 段階の応答と同じ形で見せる包み。

    解析の入口は第 4 段階でジョブに移り、投入は 202 を返して結果は後から
    取りに行く形になった（``test_analysis_progress.py``）。この段階で確かめる
    のは「解析が何を返すか」なので、運び方の違いだけをここで吸収する。
    """

    status_code: int
    text: str
    books: list[dict]

    def json(self) -> dict:
        return {"books": self.books}


class PlanApiTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

        # 許可された場所を実際に絞る。絞らないと根の検証が意味を持たない
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

    def write_archive(self, path: Path, entries: tuple[str, ...] = ("001.jpg",)):
        """指定の中身の ZIP を作る。途中のディレクトリも掘る"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in entries:
                archive.writestr(name, page())
        return path

    def write_compound(self, path: Path) -> Path:
        """2 冊分が入った 1 つの ZIP"""
        return self.write_archive(path, COMPOUND_ENTRIES)

    def analyze(self, targets: list[Path], title: str = TITLE, author: str = AUTHOR):
        """解析の入口を叩く。受け付けたかどうかは呼び出し側が見る。

        入口は ``POST /api/jobs/analyze``（#70 第 4 段階）。受け付けられたら
        終わるまで待ち、第 3 段階の応答と同じ形にして返す。断られた応答は
        包まずそのまま返す。包むと 400 / 401 を確かめられない。
        """
        accepted = self.client.post(
            "/api/jobs/analyze",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "title": title,
                "author": author,
            },
        )
        if accepted.status_code != 202:
            return accepted
        return self.wait_for_analysis(accepted.json()["id"])

    def wait_for_analysis(self, job_id: str) -> AnalyzedResponse:
        """解析ジョブが終わるのを待ち、出来上がる本を取り出す"""
        deadline = time.monotonic() + 30.0
        while True:
            response = self.client.get(f"/api/jobs/{job_id}", params=self.auth())
            job = response.json()
            running = job["state"] in {"queued", "running"}
            if not running or time.monotonic() > deadline:
                return AnalyzedResponse(
                    status_code=200 if job["state"] == "succeeded" else 500,
                    text=response.text,
                    books=(job.get("result") or {}).get("books", []),
                )
            time.sleep(0.01)

    def analyzed_books(self, targets: list[Path]) -> list[dict]:
        """解析が返した本の一覧。応答の形もここで確かめる"""
        response = self.analyze(targets)
        self.assertEqual(
            200, response.status_code, f"解析の入口が応答しない: {response.text}"
        )
        payload = response.json()
        self.assertIn("books", payload, f"本の一覧が入っていない: {payload}")
        return payload["books"]

    def submit_organize(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict] | None = None,
    ):
        """整理ジョブを投入する。books を省くと従来どおりの投入になる"""
        body: dict = {
            "archives": [str(target) for target in targets],
            "output_directory": str(output_directory),
            "title": TITLE,
            "author": AUTHOR,
            "keep_originals": True,
        }
        if books is not None:
            body["books"] = books
        return self.client.post("/api/jobs/organize", params=self.auth(), json=body)

    def organize(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict] | None = None,
    ) -> dict:
        """整理ジョブを投入し、終わったジョブの詳細を返す"""
        accepted = self.submit_organize(targets, output_directory, books)
        self.assertEqual(
            202,
            accepted.status_code,
            f"整理の投入が受け付けられていない: {accepted.text}",
        )
        job_id = accepted.json()["id"]
        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job

    def files_under(self, root: Path) -> list[str]:
        """出力先に実在するファイルの名前。

        ジョブの報告（result.produced）だけを見ると、報告しなかっただけで
        中身は全部作っている実装を見逃す。ディスクの側からも数える。
        """
        if not root.exists():
            return []
        return sorted(path.name for path in root.rglob("*") if path.is_file())

    def selection(self, books: list[dict], names: list[str]) -> list[dict]:
        """解析結果から、出来上がる名前で本を選び出す。

        本ごとの作品名・著者も、解析が返したまま載せる（#73 段階 4a）。画面
        （``plan.ts`` の ``selectedBooks``）が組み立てる形と揃える。自分の名前を
        持たない本では ``None`` になり、整理は依頼の対を使う。ここで欄ごと落とすと、
        「欄が増えても選択の振る舞いは 1 つも変わらない」ことを誰も見張らなくなる。
        """
        chosen = [book for book in books if book["output_name"] in names]
        self.assertEqual(
            len(names),
            len(chosen),
            f"選ぼうとした本が解析結果に無い: {names} / {books}",
        )
        return [
            {
                "source": book["source"],
                "entry": book["entry"],
                "title": book["title"],
                "author": book["author"],
            }
            for book in chosen
        ]


class PlanAnalysisTest(PlanApiTestBase):
    """1. 解析の入口が、出来上がる本を返す"""

    def test_lists_the_books_a_submitted_folder_will_produce(self):
        # Arrange - フォルダ 1 つの中に、2 冊入りの ZIP と、巻数が読めない ZIP。
        # アーカイブの件数（2）と本の冊数（3）を食い違わせ、アーカイブを
        # そのまま並べ直しただけの実装で通らないようにする
        folder = self.work_dir / "取り込み"
        compound = self.write_compound(folder / "合本.zip")
        special = self.write_archive(folder / "特別編.zip", ("001.jpg", "002.jpg"))

        # Act - 投入するのはフォルダ 1 つ。中のアーカイブは名指ししない
        books = self.analyzed_books([folder])

        # Assert - 出来上がる名前が実行前に全部そろう
        by_name = {book["output_name"]: book for book in books}
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} Unknown.zip",
                f"[{AUTHOR}] {TITLE} 第001巻.zip",
                f"[{AUTHOR}] {TITLE} 第002巻.zip",
            ],
            sorted(by_name),
            f"出来上がる本の一覧が違う: {books}",
        )

        # Assert - 各項目に元のアーカイブ・巻数・印が入っている。
        # 2 冊入りの ZIP は、同じ元から位置違いで 2 冊出る
        first = by_name[f"[{AUTHOR}] {TITLE} 第001巻.zip"]
        second = by_name[f"[{AUTHOR}] {TITLE} 第002巻.zip"]
        for book in (first, second):
            self.assertEqual(
                compound.resolve(),
                Path(book["source"]).resolve(),
                f"元のアーカイブが違う: {book}",
            )
        self.assertEqual(1, first["volume"], first)
        self.assertEqual(2, second["volume"], second)
        self.assertNotEqual(
            first["entry"],
            second["entry"],
            f"同じ ZIP から出る 2 冊が同じ位置になっている: {first} / {second}",
        )
        self.assertEqual([], list(first["issues"]), first)

        # Assert - 名前に数字が無いものは巻数が読めず、印が付く
        unknown = by_name[f"[{AUTHOR}] {TITLE} Unknown.zip"]
        self.assertEqual(special.resolve(), Path(unknown["source"]).resolve(), unknown)
        self.assertIsNone(unknown["volume"], unknown)
        self.assertIn(VOLUME_UNKNOWN, list(unknown["issues"]), unknown)

    def test_requires_a_token(self):
        # Arrange - 解析はディスクを読む。トークン無しで叩けてはいけない
        folder = self.work_dir / "無認可"
        self.write_archive(folder / "raw_01.zip")

        # Act
        response = self.client.post(
            "/api/jobs/analyze",
            json={"archives": [str(folder)], "title": TITLE, "author": AUTHOR},
        )

        # Assert
        self.assertEqual(401, response.status_code, response.text)


class PlanAnalysisAllowedRootsTest(PlanApiTestBase):
    """2. 許可された場所の外は拒む。

    「拒む」だけを見ると、入口がまだ無い（404）ときも通ってしまう。許可の中の
    同じ形は受け付けることまで併せて見る。
    """

    def test_refuses_a_folder_outside_the_allowed_roots(self):
        # Arrange - 許可の外と中に、同じ形のフォルダを用意する
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = Path(outside_temp.name).resolve() / "許可の外"
        self.write_archive(outside / "raw_01.zip")

        inside = self.work_dir / "許可の中"
        self.write_archive(inside / "raw_01.zip")

        # Act
        refused = self.analyze([outside])

        # Assert - 400 で、しかも「許可の外だから」と読める理由で断る
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertIn(
            "対象外",
            refused.json().get("detail", ""),
            f"許可の外だから拒んだ、とは読めない: {refused.text}",
        )

        # Act / Assert - 同じ形でも許可の中なら解析する。これが無いと
        # 「何でも拒む」実装でも上の検証を通せる
        accepted = self.analyze([inside])
        self.assertEqual(
            200, accepted.status_code, f"許可の中まで拒んでいる: {accepted.text}"
        )
        self.assertEqual(
            [f"[{AUTHOR}] {TITLE} 第001巻.zip"],
            [book["output_name"] for book in accepted.json()["books"]],
            accepted.text,
        )

    def test_leaves_out_files_that_point_outside_through_a_link(self):
        # Arrange - 許可の中のフォルダに、外を指すリンクを置く。名前のままでは
        # 中に見えて、開くと外を読む。整理の投入（app.py）は展開したものを
        # 1 件ずつ確かめており、解析も同じでなければ抜け道になる
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        secret = self.write_archive(Path(outside_temp.name).resolve() / "外.zip")

        folder = self.work_dir / "リンク入り"
        allowed = self.write_archive(folder / "許可_01.zip")
        link = folder / "外_09.zip"
        link.symlink_to(secret)

        # Act
        books = self.analyzed_books([folder])

        # Assert - 許可の中のものだけが本になる。リンクの先は読まない
        sources = {Path(book["source"]).resolve() for book in books}
        self.assertNotIn(
            secret.resolve(), sources, f"許可の外のアーカイブを解析している: {books}"
        )
        self.assertEqual({allowed.resolve()}, sources, f"解析の対象が違う: {books}")


class PlanSelectionTest(PlanApiTestBase):
    """3. 整理の投入で、外した本を除ける。チェックボックスの実体はここ"""

    def prepare(self) -> tuple[Path, Path, list[dict]]:
        """2 冊入りの ZIP と 1 冊の ZIP が入ったフォルダを解析まで済ませる"""
        folder = self.work_dir / "選別"
        self.write_compound(folder / "合本.zip")
        self.write_archive(folder / "単体_03.zip", ("001.jpg", "002.jpg"))
        output = self.work_dir / "out-selection"

        books = self.analyzed_books([folder])
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} 第001巻.zip",
                f"[{AUTHOR}] {TITLE} 第002巻.zip",
                f"[{AUTHOR}] {TITLE} 第003巻.zip",
            ],
            sorted(book["output_name"] for book in books),
            f"選ぶ前の解析結果が想定と違う: {books}",
        )
        return folder, output, books

    def test_creates_only_the_selected_books(self):
        # Arrange - 3 冊のうち、2 冊入り ZIP の 2 冊目だけを外す。アーカイブの
        # 単位でしか選べない実装では、この外し方が表現できない
        folder, output, books = self.prepare()
        chosen = self.selection(
            books,
            [f"[{AUTHOR}] {TITLE} 第001巻.zip", f"[{AUTHOR}] {TITLE} 第003巻.zip"],
        )

        # Act
        job = self.organize([folder], output, books=chosen)

        # Assert - 外した 1 冊は報告にも出ない
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} 第001巻.zip",
                f"[{AUTHOR}] {TITLE} 第003巻.zip",
            ],
            sorted(Path(raw).name for raw in job["result"]["produced"]),
            f"作った本の報告が選択と合わない: {job['result']}",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - ディスクにも無い。「見た目だけ外れて全部作られる」実装は
        # ここで落ちる
        on_disk = self.files_under(output)
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} 第001巻.zip",
                f"[{AUTHOR}] {TITLE} 第003巻.zip",
            ],
            on_disk,
            f"外した本が出力先に出来ている: {on_disk}",
        )

        # Assert - 残した本は中身まで出来ている。名前だけ作って通らないように。
        # 名前で rglob を掛けないのは、`[著者]` の角括弧が glob の文字クラスに
        # なって literal のファイル名に当たらないため
        produced_paths = {path.name: path for path in output.rglob("*")}
        for name in on_disk:
            produced = produced_paths[name]
            with zipfile.ZipFile(produced) as archive:
                self.assertTrue(archive.namelist(), f"中身が空: {produced}")

    def test_the_two_books_in_one_archive_are_unaffected_by_the_name_fields(self):
        # Arrange - 合本から出る 2 冊。この 2 冊はどうやっても自分の名前を
        # 持たない（成果物はファイルであって、その中身ではない）ので、
        # 本ごとの名前が増えても行き先は依頼の対のままでなければならない
        folder, output, books = self.prepare()
        first = f"[{AUTHOR}] {TITLE} 第001巻.zip"
        second = f"[{AUTHOR}] {TITLE} 第002巻.zip"
        chosen = self.selection(books, [first, second])
        self.assertEqual(
            [None, None],
            [book["title"] for book in chosen],
            f"合本の中の 1 冊に名前が付いている: {chosen}",
        )

        # Act
        job = self.organize([folder], output, books=chosen)

        # Assert - 名前も冊数も今までどおり
        self.assertEqual(
            [first, second],
            sorted(Path(raw).name for raw in job["result"]["produced"]),
            f"欄が増えたことで作られる本が変わった: {job['result']}",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual([first, second], self.files_under(output))

        # Assert - 欄が本当に受け取られていること。pydantic は知らない鍵を黙って
        # 捨てるので、「投入が通った」だけでは受け取ったことにならない。画面の型は
        # この schema（openapi.json）から起こすので、ここに無い欄は画面から
        # 送っても永久に届かない
        book_ref = self.app.openapi()["components"]["schemas"]["BookRef"]["properties"]
        for field in ("title", "author"):
            self.assertIn(
                field,
                book_ref,
                f"BookRef が本ごとの名前を受け取らない: {sorted(book_ref)}",
            )

    def test_creates_nothing_when_no_book_is_selected(self):
        # Arrange - 全部のチェックを外した状態。空の一覧は「指定なし」ではない
        folder, output, _ = self.prepare()

        # Act
        job = self.organize([folder], output, books=[])

        # Assert - 1 冊も作らない。空を「省略」と同じに扱うと、全部外して
        # 実行したときに全部作られる
        self.assertEqual([], job["result"]["produced"], job["result"])
        self.assertEqual([], self.files_under(output), "外したはずの本が出来ている")


if __name__ == "__main__":
    unittest.main()
