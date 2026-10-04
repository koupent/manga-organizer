"""整理済みの本が、自分の名前のまま作り直されること（#73 段階 4a）。

段階 1-3 で「その本は既にこの道具が作る物そのものか」を判定し、画面に見せる所
までは出来た。既定は 1 つも変えていない。段階 4a はここを 1 歩だけ進める。

**整理済みの本が、自分の名前のまま端から端まで運ばれること。**
**自分自身の上に書き出さないこと。**

外す（段階 4b）のはここではない。外す前に、外した本を入れ直したときへ備えて
名前が本ごとに運ばれる形にしておく。

## いま 3 つの側が食い違っていて、それを見ているテストが 1 つも無い

| 側 | いまの振る舞い |
|---|---|
| ``toc_analyzer._Planner._plan`` | 整理済みなら ``source.stem`` を予告する |
| ``FileOrganizer._process_volume`` | 依頼の対（著者・作品名）で毎回作り直す |
| ``plan.ts`` の ``outputNames`` | 左の列の対で毎回組み直す |

``OrganizedFidelityTest.test_a_book_judged_organized_is_still_built_by_an_organize_run``
は依頼の対を**蔵書と揃えて**走らせている。揃えた回は 3 つの側が同じ答えを出すので、
食い違いはそこからは決して見えない。ここでは必ず**わざと違える**。

## 求める公開契約

- ``BookRef`` に ``title`` / ``author`` が増える（既定は ``None``）
- 名前を載せてよいのは ``entry == ""`` の本だけで、その ``source`` の
  ``BookRef`` が依頼の中に 1 つだけのときに限る。外れていれば 422 で断る。
  黙って無視すると、古い画面が合本の 1 冊に名前を載せてきたとき、
  アーカイブ全体がその 1 冊の名前になり、症状は「ファイル名がおかしい」だけになる
- ``FileOrganizer`` は本ごとの名前（``SeriesName``）で書き出す。渡されなければ
  いままでどおり依頼の対を使う
- 書き出す先が元のアーカイブ自身になるときは、書かずに飛ばす

## 自分自身の上に書き出す道（この段階で塞ぐ）

既定の出力先は「投入した 1 件目の親フォルダ」。``…/蔵書/[著者] 作品`` を放り込むと
出力先は ``…/蔵書`` になり、整理済みの本の書き出し先は**その本自身**になる。
``get_unique_filename`` は既にある名前を返さないので ``…第003巻_1.zip`` が出来、
``keep_originals=False`` なら ``_handle_original_deletion`` が元を消す。静かで、
取り返しがつかない。段階 4b はこれを 1 クリックの所まで近づける。
"""

import sys
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方は既存のテストと共有する。同じ物を別々に書くと、片方を直した
# ときに「同じ入力のはず」の 2 つが静かに食い違う
from test_organized_detection import (  # noqa: E402
    AUTHOR,
    ORGANIZED_NAME,
    OTHER_AUTHOR,
    OTHER_TITLE,
    PAGE_COUNT,
    SERIES_DIR,
    TITLE,
    VOLUME,
    OrganizedTestBase,
)
from test_toc_analysis import pages, zip_with  # noqa: E402

from manga_api.app import create_app  # noqa: E402
from manga_core.file_organizer import FileOrganizer  # noqa: E402

# 同じ蔵書に居る、もう 1 つの作品。1 つの実行に 2 つの対を混ぜるための素材で、
# 蔵書の対（著者 / 作品）とも依頼の対（別人 / 別作品）とも重ならない名前にする
SECOND_AUTHOR = "二人目"
SECOND_TITLE = "二作目"
SECOND_VOLUME = 5

# 自分の名前を持たない本。名前に数字が 1 つだけあるので巻数は 9 に読める
PLAIN_NAME = "raw_09.zip"
PLAIN_VOLUME = 9


class NamingTestBase(OrganizedTestBase):
    """整理済みの本を蔵書に並べ、解析 → 整理を API 越しに走らせる土台。

    素材の作り方（``build_organized`` / ``copy_into``）は
    ``test_organized_detection`` と共有する。判定の素材と名前の素材が別々に
    育つと、判定では整理済みなのに名前のテストでは違う物、という状態を
    誰も見張らなくなる。

    経路を ``FileOrganizer`` の直呼びではなく HTTP にするのは、この段階で
    増えるものの半分が**依頼の検証**（422）で、そこは経路にしか無いため。
    """

    def setUp(self):
        super().setUp()
        # 許可された場所を実際に絞る。絞らないと出力先の検証が意味を持たない
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self) -> dict:
        return {"token": self.token}

    def shelve(self, library: Path, author: str, title: str, volume: int) -> Path:
        """整理そのものに「整理済みの本」を作らせ、蔵書へ並べる。

        ``build_organized`` を対と巻数について一般化したもの。段階 4a は
        「1 回の実行に対が 2 つ以上ある」ことそのものが主題なので、対を 1 つに
        固定した土台だけでは素材を作れない。

        期待値は ``format_volume_name`` を呼ばずに書き下す。作る側と同じ関数で
        期待値を作ると、名前の作り方が変わったときに素材も期待値も一緒に動いて
        しまい、何も見張らない検証になる。
        """
        source = zip_with(
            self.work_dir / "素材" / f"{author}_{title}_{volume:02d}.zip",
            pages(count=PAGE_COUNT),
        )
        organizer = FileOrganizer(output_directory=library, keep_originals=True)
        organizer.set_manga_info(author=author, title=title)
        results = organizer.process_single_archive(source)
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "整理が失敗した"
        )
        built = results[0].output_path
        self.assertIsNotNone(built)
        self.assertEqual(
            f"[{author}] {title} 第{volume:03d}巻.zip",
            built.name,
            "整理の出力名が想定と違う",
        )
        self.assertEqual(
            f"[{author}] {title}", built.parent.name, "整理の出力先が想定と違う"
        )
        return built

    def analyze(
        self,
        targets: list[Path],
        author: str = OTHER_AUTHOR,
        title: str = OTHER_TITLE,
    ) -> list[dict]:
        """解析ジョブを走らせ、出来上がる本を返す。

        既定の対は蔵書の中身と**わざと違える**。揃えて走らせると、本ごとの
        名前と依頼の対が同じ答えを出してしまい、この段階の主題が見えなくなる。
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
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job["result"]["books"]

    def job(self, job_id: str) -> dict:
        """ジョブの詳細。テストの起動は同期実行なので、投入の直後に読める"""
        return self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

    def selection(self, books: list[dict]) -> list[dict]:
        """解析の結果を、そのまま整理の依頼に載せる形へ写す。

        画面（``plan.ts`` の ``selectedBooks``）が組み立てる形と同じにする。
        整理済みでない本は名前を持たないので ``None`` が載る。ここで対を
        書き足すと、解析が返した名前ではなくテストが決めた名前を試すことになる。
        """
        return [
            {
                "source": book["source"],
                "entry": book["entry"],
                "title": book["title"],
                "author": book["author"],
            }
            for book in books
        ]

    def submit_organize(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict],
        author: str = OTHER_AUTHOR,
        title: str = OTHER_TITLE,
        keep_originals: bool = True,
    ):
        """整理ジョブを投入する。受け付けられたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "output_directory": str(output_directory),
                "title": title,
                "author": author,
                "keep_originals": keep_originals,
                "books": books,
            },
        )

    def organize(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict],
        author: str = OTHER_AUTHOR,
        title: str = OTHER_TITLE,
        keep_originals: bool = True,
    ) -> dict:
        """整理ジョブを投入し、終わったジョブの詳細を返す"""
        accepted = self.submit_organize(
            targets, output_directory, books, author, title, keep_originals
        )
        self.assertEqual(
            202,
            accepted.status_code,
            f"整理の投入が受け付けられていない: {accepted.text}",
        )
        return self.job(accepted.json()["id"])

    def one(self, books: list[dict], source: Path) -> dict:
        """その入れ物から出た本を 1 冊だけ取り出す"""
        matched = [
            book for book in books if Path(book["source"]).resolve() == source.resolve()
        ]
        self.assertEqual(1, len(matched), f"本が 1 冊でない: {matched}")
        return matched[0]

    def produced_map(self, output: Path) -> dict[str, list[str]]:
        """出力先を「作品フォルダ -> その中のファイル名」で写し取る。

        件数では本の取り違えを見張れない。4 冊が 2 つのフォルダに分かれる
        ことと、4 冊が 1 つのフォルダに固まることは、どちらも「4 件」になる。
        """
        if not output.exists():
            return {}
        found: dict[str, list[str]] = {}
        for path in sorted(output.rglob("*")):
            if not path.is_file():
                continue
            folder = path.parent.relative_to(output).as_posix()
            found.setdefault(folder, []).append(path.name)
        return {folder: sorted(names) for folder, names in found.items()}

    def assert_no_duplicate_suffix(self, root: Path) -> None:
        """``_1`` の付いた本がどこにも出来ていないこと"""
        duplicated = sorted(
            path.relative_to(root).as_posix() for path in root.rglob("*_1.zip")
        )
        self.assertEqual([], duplicated, f"同じ本が二重に書き出された: {duplicated}")


class OwnNameTest(NamingTestBase):
    """整理済みの本は、自分の名前のまま作り直される"""

    def test_an_organized_book_is_rebuilt_under_its_own_name(self):
        # Arrange - 蔵書には 著者 / 作品 の本。依頼は 別人 / 別作品 で出す。
        # 対を揃えて走らせると、3 つの側の食い違いは決して現れない
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        output = self.work_dir / "再出力"

        # Act
        books = self.analyze([library])
        book = self.one(books, built)
        self.assertIs(True, book["organized"], f"素材が整理済みでない: {book}")
        self.assertEqual(AUTHOR, book["author"], book)
        self.assertEqual(TITLE, book["title"], book)
        job = self.organize([library], output, self.selection(books))

        # Assert - 走り切っていること。名前を見る前に、まず実行されたこと
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 名前だけでなく**置き場所まで**自分のもの。名前だけを見ると、
        # 名前を差し替えて置き場所は依頼の対のまま、という実装が通ってしまう
        expected = output / SERIES_DIR / ORGANIZED_NAME
        self.assertTrue(
            expected.is_file(),
            f"自分の名前で作り直されていない: {self.produced_map(output)}",
        )

        # Assert - 依頼の対は出力先のどこにも現れない。フォルダにもファイルにも
        for path in output.rglob("*"):
            relative = path.relative_to(output).as_posix()
            for unwanted in (OTHER_AUTHOR, OTHER_TITLE):
                self.assertNotIn(
                    unwanted, relative, f"依頼の対が出力先に混ざる: {relative}"
                )

        # Assert - 中身まで出来ている。名前だけ作って通らないように
        with zipfile.ZipFile(expected) as archive:
            self.assertTrue(archive.namelist(), f"中身が空: {expected}")

    def test_two_works_in_one_run_land_in_two_folders(self):
        # Arrange - 1 回の実行に 2 つの作品、それぞれ 2 冊ずつ
        library = self.work_dir / "蔵書"
        for volume in (VOLUME, VOLUME + 1):
            self.shelve(library, AUTHOR, TITLE, volume)
        for volume in (SECOND_VOLUME, SECOND_VOLUME + 1):
            self.shelve(library, SECOND_AUTHOR, SECOND_TITLE, volume)
        output = self.work_dir / "再出力"

        # Act
        books = self.analyze([library])
        self.assertEqual(4, len(books), f"素材が 4 冊でない: {books}")
        for book in books:
            self.assertIs(True, book["organized"], f"素材が整理済みでない: {book}")
        job = self.organize([library], output, self.selection(books))

        # Assert - 数えるのではなく、どのフォルダに何が入ったかを見る。
        # 「4 件出来た」は、4 冊が 1 つのフォルダに固まっても満たされる
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual(
            {
                f"[{AUTHOR}] {TITLE}": [
                    f"[{AUTHOR}] {TITLE} 第{VOLUME:03d}巻.zip",
                    f"[{AUTHOR}] {TITLE} 第{VOLUME + 1:03d}巻.zip",
                ],
                f"[{SECOND_AUTHOR}] {SECOND_TITLE}": [
                    f"[{SECOND_AUTHOR}] {SECOND_TITLE} 第{SECOND_VOLUME:03d}巻.zip",
                    f"[{SECOND_AUTHOR}] {SECOND_TITLE} 第{SECOND_VOLUME + 1:03d}巻.zip",
                ],
            },
            self.produced_map(output),
            "2 つの作品が 2 つのフォルダに分かれていない",
        )

    def test_a_book_without_its_own_name_still_uses_the_requested_pair(self):
        # Arrange - 整理済みの本と、まだ整理していない本を**同じ実行**に混ぜる。
        # 整理済みだけの実行では「常に本の名前を使う」実装でも通ってしまい、
        # 依頼の対がまだ効くことを何も確かめられない
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        plain = zip_with(library / PLAIN_NAME, pages(count=PAGE_COUNT))
        output = self.work_dir / "再出力"

        # Act
        books = self.analyze([library])
        self.assertIs(True, self.one(books, built)["organized"])
        self.assertIs(False, self.one(books, plain)["organized"])
        self.assertIsNone(
            self.one(books, plain)["author"], "整理済みでない本に名前が付いている"
        )
        job = self.organize([library], output, self.selection(books))

        # Assert - 名前を持つ本は自分の対、持たない本は依頼の対。両方の
        # フォルダを見る。片方だけを見ると、もう片方が消えても気づけない
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual(
            {
                SERIES_DIR: [ORGANIZED_NAME],
                f"[{OTHER_AUTHOR}] {OTHER_TITLE}": [
                    f"[{OTHER_AUTHOR}] {OTHER_TITLE} 第{PLAIN_VOLUME:03d}巻.zip"
                ],
            },
            self.produced_map(output),
            "自分の名前を持つ本と持たない本の行き先が分かれていない",
        )


class BookNameValidationTest(NamingTestBase):
    """名前を載せてよい所を、ジョブになる前に決める。

    黙って無視すると、古い画面が合本の 1 冊に名前を載せてきたときに
    アーカイブ全体がその 1 冊の名前になる。出来上がるファイル名が唯一の症状で、
    利用者はそれを「名前の付け方が変わった」としか読めない。
    """

    def test_a_name_on_a_book_inside_a_compound_archive_is_refused(self):
        # Arrange - 1 つの ZIP に 2 冊。それとは別に、名前を載せてよい本を 1 冊
        library = self.work_dir / "蔵書"
        compound = zip_with(
            library / "合本.zip", {**pages("第01巻/"), **pages("第02巻/")}
        )
        built = self.build_organized(library)
        output = self.work_dir / "再出力"
        books = self.analyze([library])
        inside = [
            book
            for book in books
            if Path(book["source"]).resolve() == compound.resolve()
        ]
        self.assertEqual(2, len(inside), f"合本から 2 冊出ない: {inside}")

        # Act - 合本の中の 1 冊に名前を載せる
        refused = self.submit_organize(
            [library],
            output,
            books=[
                {
                    "source": book["source"],
                    "entry": book["entry"],
                    "title": TITLE,
                    "author": AUTHOR,
                }
                for book in inside
            ],
        )

        # Assert - 断る。しかも 1 冊も書き出さない。ジョブにしてから失敗させると、
        # 途中まで書いた物が残る
        self.assertEqual(422, refused.status_code, refused.text)
        self.assertEqual({}, self.produced_map(output), "断ったのに書き出している")

        # Act / Assert - 位置が空でも、同じ入れ物の本が依頼に 2 つあれば断る。
        # 「``entry`` が空でなければ断る」だけの検証はここで落ちる。この形は
        # 合本の 1 冊に全体の名前を付けるのと同じ結果になる
        ambiguous = self.submit_organize(
            [library],
            output,
            books=[
                {
                    "source": inside[0]["source"],
                    "entry": "",
                    "title": TITLE,
                    "author": AUTHOR,
                },
                {"source": inside[1]["source"], "entry": inside[1]["entry"]},
            ],
        )
        self.assertEqual(422, ambiguous.status_code, ambiguous.text)
        self.assertEqual({}, self.produced_map(output), "断ったのに書き出している")

        # Act / Assert - 正しい形は受け付けて、実際に作る。何にでも 422 を返す
        # 実装はここで落ちる
        job = self.organize(
            [library],
            output,
            books=[
                {
                    "source": str(built),
                    "entry": "",
                    "title": TITLE,
                    "author": AUTHOR,
                }
            ],
        )
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(
            {SERIES_DIR: [ORGANIZED_NAME]},
            self.produced_map(output),
            "正しい形の依頼で本が出来ていない",
        )


class SelfDestinationTest(NamingTestBase):
    """書き出す先が元のアーカイブ自身になるとき、何もしないこと。

    ``…/蔵書/[著者] 作品`` を放り込むと既定の出力先は ``…/蔵書`` になり、
    整理済みの本の行き先はその本自身になる。いまは ``_1`` を付けた写しが出来、
    ``keep_originals=False`` なら元が消える。静かで取り返しがつかない。

    ここだけ依頼の対を蔵書と**揃える**。段階 4a のあとは本ごとの名前で必ず
    自分自身に重なるが、いまの実装で同じ所へ重ねるには対を揃えるしかない。
    揃えないと、塞ぎたい destructive な道そのものが走らず、この検証は
    「名前がまだ本ごとでない」ことしか言えなくなる。名前が本ごとに運ばれる
    ことは、同じ実行に混ぜたもう 1 冊（``二人目 / 二作目``）が受け持つ。
    """

    def prepare(self) -> tuple[Path, Path, Path]:
        """行き先が自分自身になる本と、行き先が空いている本"""
        library = self.work_dir / "蔵書"
        # 出力先を 蔵書 にすると、この本の行き先は自分自身になる
        here = self.build_organized(library)
        # 別の棚に居る本。行き先（蔵書/[二人目] 二作目）はまだ空
        elsewhere = self.shelve(
            self.work_dir / "別棚", SECOND_AUTHOR, SECOND_TITLE, SECOND_VOLUME
        )
        return library, here, elsewhere

    def run_organize(self, keep_originals: bool):
        """蔵書の中の 1 冊と、別の棚の 1 冊を、蔵書へ向けて整理する。

        自分自身の上に来る本の ``stat`` は**実行の前**に控える。実行のあとに
        取ると、書き直された値どうしを比べることになって何も見張らない。
        """
        library, here, elsewhere = self.prepare()
        before = here.stat()
        books = self.analyze([here, elsewhere], author=AUTHOR, title=TITLE)
        job = self.organize(
            [here, elsewhere],
            library,
            self.selection(books),
            author=AUTHOR,
            title=TITLE,
            keep_originals=keep_originals,
        )
        return library, here, elsewhere, before, job

    def expected_second(self, library: Path) -> Path:
        return (
            library
            / f"[{SECOND_AUTHOR}] {SECOND_TITLE}"
            / f"[{SECOND_AUTHOR}] {SECOND_TITLE} 第{SECOND_VOLUME:03d}巻.zip"
        )

    def test_a_book_already_at_its_destination_is_neither_duplicated_nor_deleted(self):
        # Arrange / Act - 2 冊とも整理済み。片方だけが自分自身の上に来る。
        # 出力先は蔵書そのもの
        library, here, _elsewhere, before, job = self.run_organize(keep_originals=True)

        # Assert - 走り切って、失敗も無い。「``_1`` が無い」だけの検証は、
        # ジョブが落ちたときも、1 件も処理されなかったときも満たされる
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 写しが出来ていない
        self.assert_no_duplicate_suffix(library)

        # Assert - 元のファイルに指 1 本触れていない。中身を書き直してから
        # 同じ名前で置き直す実装は、大きさか時刻のどちらかで落ちる
        after = here.stat()
        self.assertEqual(before.st_size, after.st_size, f"元の大きさが変わった: {here}")
        self.assertEqual(
            before.st_mtime_ns, after.st_mtime_ns, f"元が書き直された: {here}"
        )

        # Assert - もう 1 冊は**作られている**。何も処理しない実装、投入の時点で
        # 全部外す実装は、ここで落ちる
        made = self.expected_second(library)
        self.assertTrue(made.is_file(), f"行き先が空いている本が作られていない: {made}")
        self.assertEqual(
            [made.name],
            sorted(Path(raw).name for raw in job["result"]["produced"]),
            f"作った本の報告が合わない: {job['result']}",
        )

    def test_the_original_is_kept_when_the_book_is_already_at_its_destination(self):
        # Arrange / Act - 元を残さない設定。飛ばし損ねると元が消える
        library, here, elsewhere, before, job = self.run_organize(keep_originals=False)

        # Assert
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 自分自身の上に来た本は消えていない。1 冊だけの蔵書を
        # 放り込んだ利用者にとって、これは蔵書がまるごと消えることと同じ。
        # 取り返しのつかない側を先に見る
        self.assertTrue(here.is_file(), f"自分自身の上に来た本が消えた: {here}")
        self.assert_no_duplicate_suffix(library)
        self.assertEqual(before.st_size, here.stat().st_size, "元の大きさが変わった")
        self.assertEqual(
            before.st_mtime_ns, here.stat().st_mtime_ns, "元が書き直された"
        )

        # Assert - 対照。ふつうに作られた本の元は、頼まれたとおり消えている。
        # 「元を消さない」実装で通らないようにする
        self.assertTrue(self.expected_second(library).is_file(), "もう 1 冊が無い")
        self.assertFalse(elsewhere.exists(), f"頼まれたのに元が残っている: {elsewhere}")


class SelfDestinationRebuildTest(NamingTestBase):
    """名前と置き場所は出来上がりなのに中身が違う本を、同じ場所で作り直すこと（#127）。

    ``蔵書/[著者] 作品`` を入れると、その中の本の行き先は本自身になる。整理済みの
    本はそこで飛ばしてよいが、ページ名や同梱物が違う本まで飛ばすと、利用者が
    選んで整理したのに何も変わらず、「整理済みではありません」が残り続ける。
    """

    def prepare(self) -> tuple[Path, Path, list[bytes]]:
        """整理の形の名前と置き場所のまま、番号が 1 つ抜けた本"""
        library = self.work_dir / "蔵書"
        here = self.build_organized(library)
        with zipfile.ZipFile(here) as archive:
            contents = [archive.read(name) for name in sorted(archive.namelist())]
        with zipfile.ZipFile(here, "w") as archive:
            for name, data in zip(
                ["001.jpg", "002.jpg", "004.jpg"], contents, strict=True
            ):
                archive.writestr(name, data)
        return library, here, contents

    def test_a_book_at_its_destination_with_wrong_pages_is_rebuilt_there(self):
        # Arrange
        library, here, contents = self.prepare()
        books = self.analyze([here], author=AUTHOR, title=TITLE)
        self.assertEqual("pages-mismatch", self.one(books, here)["organized_reason"])

        # Act - 元を残さない設定。作り直した本を「元」として消すと何も残らない
        job = self.organize(
            [here],
            library,
            self.selection(books),
            author=AUTHOR,
            title=TITLE,
            keep_originals=False,
        )

        # Assert - 走り切り、作った本としてその本自身が報告される
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual([str(here)], job["result"]["produced"], job["result"])

        # Assert - 同じ場所に、連番の本として残る。写しは出来ない
        self.assertTrue(here.is_file(), f"作り直した本が消えた: {here}")
        self.assert_no_duplicate_suffix(library)
        with zipfile.ZipFile(here) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], archive.namelist())
            self.assertEqual(contents, [archive.read(n) for n in archive.namelist()])

        # Assert - 解析し直すと整理済み。印が残り続けることはもう無い
        again = self.analyze([here], author=AUTHOR, title=TITLE)
        self.assertIs(True, self.one(again, here)["organized"])


class NamelessBookTest(NamingTestBase):
    """名前を 1 つも持たない本は、黙って ``[]`` の本にせず失敗させること"""

    def test_a_kept_book_with_no_name_and_no_requested_pair_fails_loudly(self):
        # Arrange - 依頼の対は空。自分の名前を持つ本と、持たない本を混ぜる。
        # 混ぜないと「何にでも失敗を返す」実装で通ってしまう
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        plain = zip_with(library / PLAIN_NAME, pages(count=PAGE_COUNT))
        output = self.work_dir / "再出力"

        # Act
        books = self.analyze([library], author="", title="")
        self.assertIs(True, self.one(books, built)["organized"])
        self.assertIs(False, self.one(books, plain)["organized"])
        job = self.organize([library], output, self.selection(books), "", "")

        # Assert - ジョブそのものは走り切る。1 冊のせいで実行全体を失敗させると、
        # 作れた本まで見えなくなる
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert - 名前を持たない本は失敗として並び、どの本かが読める
        failed = job["result"]["failed"]
        self.assertEqual(1, len(failed), f"失敗が 1 件でない: {failed}")
        self.assertIn(
            PLAIN_NAME, failed[0]["archive"], f"どの本か読めない: {failed[0]}"
        )
        self.assertNotEqual("", failed[0]["reason"], f"理由が空: {failed[0]}")
        self.assertRegex(
            failed[0]["reason"],
            r"[ぁ-んァ-ヶ一-龠]",
            f"理由が利用者の言葉になっていない: {failed[0]}",
        )

        # Assert - 名前を持つ本は今までどおり作られる
        self.assertEqual(
            {SERIES_DIR: [ORGANIZED_NAME]},
            self.produced_map(output),
            "自分の名前を持つ本まで作られていない",
        )
        self.assertEqual(
            [ORGANIZED_NAME],
            sorted(Path(raw).name for raw in job["result"]["produced"]),
            f"作った本の報告が合わない: {job['result']}",
        )

        # Assert - `[]` で始まる名前は 1 つも無い。フォルダもファイルも
        empty_named = sorted(
            path.relative_to(output).as_posix()
            for path in output.rglob("*")
            if path.name.startswith("[]")
        )
        self.assertEqual([], empty_named, f"名前の無い本が出来ている: {empty_named}")


if __name__ == "__main__":
    unittest.main()
