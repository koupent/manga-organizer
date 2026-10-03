"""許可の検査より前に重複を落とすと、並び順で本が黙って消える（#114 段階 C の後退）。

段階 C で ``iter_inputs`` の重複除去を、パスの形から**実体**（``file_key`` の
``st_dev`` / ``st_ino``）へ変えた。同じファイルの別の綴りを 1 冊にまとめるための
変更だが、**鍵を登録するのが許可された場所の検査より前**になっている。

    input_expander.iter_inputs      実体の鍵で重複を落とす（ここが先）
    paths.expand_targets            許可の外を指すものを除く（ここが後）
    analysis_job._scan              同上

許可された場所の中に、次の 2 つが並んでいると壊れる。

* 許可の**外**を指すシンボリックリンク
* 同じファイルの、許可の**内**にあるハードリンク

どちらも同じ実体なので鍵は 1 つ。**先に列挙されたほうが鍵を取る。** リンクが
先だとハードリンクは重複として落とされ、残ったリンクは許可の検査で除かれ、
**結果は 0 件**になる。順番が逆なら正しく 1 冊出来る。

利用者から見た症状は「本が黙って処理されない」。しかも並び順（＝ファイル名）
次第なので、同じ操作をしても棚によって結果が変わる。段階 C の前はパスの形で
重複を落としていたので、両方が残り、リンクだけが除かれていた。

整理（``expand_targets``）と解析（``_scan``）の両方に同じ形がある。片方だけ
直して片方が残らないよう、ここでは 2 つの経路をそれぞれ見る。

守るべき性質（同じ実体の 2 通りの綴りが 1 冊にまとまること）も、直すときに
壊さないための対照として同じファイルに置く。整理の経路は
``test_volume_override_api.py`` の C17 が既に見ているので、こちらは解析の経路。
"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方と経路の叩き方は既存のテストと共有する。同じ物を別々に書くと、
# 片方を直したときに「同じ入力のはず」の 2 つが静かに食い違う
from test_toc_analysis import pages, zip_with  # noqa: E402
from test_volume_override_api import (  # noqa: E402
    REQUEST_AUTHOR,
    REQUEST_DIR,
    REQUEST_TITLE,
    VolumeOverrideApiTestBase,
    volume_name,
)

from manga_core.input_expander import expand_inputs  # noqa: E402

# 許可の外に置く本物。ここへ 2 通りの綴りが向く
REAL_NAME = "本物_09.zip"

# 許可の内にあるハードリンク。この 1 冊が残らなければならない。名前の数字から
# 巻数は 9 に読める
TWIN_NAME = "本_09.zip"
TWIN_VOLUME = 9

# 許可の内にあり、外を指すシンボリックリンク。ハードリンクと同じ前置きにして、
# 並び順を数字だけで決める。数字を 9 と違えるのは、万一リンクの側が残った
# ときに出来上がりの巻数からそれと読めるようにするため
EARLY_LINK_NAME = "本_01.zip"
LATE_LINK_NAME = "本_99.zip"

# 同じ実体に与えるもう 1 つの名前（どちらも許可の内）。守るべき性質の側で使う
COPY_NAME = "複製_09.zip"

# 素材のページ枚数。中身は問わないので最小限に
PAGES = 2


class LinkOrderTestBase(VolumeOverrideApiTestBase):
    """許可の外を指すリンクと、許可の内のハードリンクを並べる土台。

    素材が本当にこの形（同じ実体・リンクは外・列挙はこの順）であることを、
    依頼を出す**前に**確かめる。前提が崩れた素材だと、下のテストは何も
    確かめずに緑になる。
    """

    def setUp(self):
        super().setUp()
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        # 許可された場所は work_dir だけ。その外に本物を置く
        self.outside = Path(outside_temp.name).resolve()

    # --- 素材 -------------------------------------------------------------

    def shelf(self, tag: str, link_name: str, link_first: bool) -> tuple[Path, Path]:
        """許可の中の棚を 1 つ作り、(棚, ハードリンク) を返す。

        ``link_first`` は、外を指すリンクとハードリンクのどちらが先に列挙
        されるかの指定。**指定どおりに並ぶことは実際に観測して確かめる。**
        """
        real = zip_with(self.outside / f"外の棚{tag}" / REAL_NAME, pages(count=PAGES))
        shelf = self.work_dir / f"蔵書{tag}"
        shelf.mkdir(parents=True)
        link = shelf / link_name
        link.symlink_to(real)
        twin = shelf / TWIN_NAME
        twin.hardlink_to(real)

        self.assert_link_points_outside(real, link)
        self.assert_two_spellings_of_one_file(link, twin)
        self.assert_twin_stays_inside(twin)
        self.assert_enumerated_in_order(
            tag, [link_name, TWIN_NAME] if link_first else [TWIN_NAME, link_name]
        )
        return shelf, twin

    def twin_of(self, original: Path, name: str) -> Path:
        """同じ実体に、もう 1 つの名前を与える。

        中身を写した別ファイルではいけない。それは「同じ本が 2 つある」だけの
        話になる。確かめたいのは**同じ 1 つのファイル**なので実体を 1 つに保つ。
        """
        link = original.parent / name
        link.hardlink_to(original)
        return link

    # --- 素材が本当にその形か ---------------------------------------------

    def assert_link_points_outside(self, real: Path, link: Path) -> None:
        """リンクが、許可の外の本物を指していること"""
        self.assertTrue(link.is_symlink(), f"リンクになっていない: {link}")
        self.assertEqual(
            real.resolve(), link.resolve(), f"リンクが本物を指していない: {link}"
        )
        self.assertFalse(
            link.resolve().is_relative_to(self.work_dir.resolve()),
            f"リンクの先が許可の中にある。これでは何も確かめられない: {link}",
        )

    def assert_twin_stays_inside(self, twin: Path) -> None:
        """ハードリンクが、許可の中に留まること"""
        self.assertFalse(
            twin.is_symlink(), f"ハードリンクのつもりがリンクになっている: {twin}"
        )
        self.assertTrue(
            twin.resolve().is_relative_to(self.work_dir.resolve()),
            f"ハードリンクが許可の外に解けている: {twin}",
        )

    def assert_two_spellings_of_one_file(self, one: Path, other: Path) -> None:
        """2 つの綴りが、同じ 1 つの実体を指していること"""
        self.assertTrue(
            one.samefile(other), f"素材が同じファイルになっていない: {one} / {other}"
        )
        self.assertNotEqual(
            one.resolve(),
            other.resolve(),
            f"2 つの綴りが同じパスに解けている。これでは穴を踏めない: {one} / {other}",
        )

    def assert_enumerated_in_order(self, tag: str, names: list[str]) -> None:
        """この名前が、この順に列挙されることを実際に観測する。

        素材そのもので観測することはできない。同じ実体なので重複除去が先に
        働き、1 件しか返らないため。確かめたいのは**並び順だけ**なので、
        同じ名前を持つ**別々の** ZIP を下見用の棚に置いて観測する。

        置く順は、期待する順の**逆**にする。期待どおりの順に作ってから同じ順を
        期待すると、並べ替えを丸ごと消して作成順をそのまま返す実装でも通る。
        逆に置けば、並べ替えが働いたときにしか期待どおりにならない。
        """
        rehearsal = self.work_dir / f"並び順の下見{tag}"
        for name in reversed(names):
            zip_with(rehearsal / name, pages(count=PAGES))
        self.assertEqual(
            names,
            [found.name for found in expand_inputs([rehearsal])],
            "素材の名前が、想定した順に列挙されない。並び順の前提が崩れている",
        )

    # --- 経路 -------------------------------------------------------------

    def analysis_result(self, targets: list[Path]) -> dict:
        """解析ジョブを走らせ、結果を丸ごと返す。

        ``VolumeOverrideApiTestBase.analyze`` は本しか返さないが、ここでは
        走査の一覧（``containers``）も見る。本が消えたのが走査の段なのか、
        目次読みの段なのかを失敗の出力から切り分けられるようにするため。
        """
        accepted = self.client.post(
            "/api/jobs/analyze",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "title": REQUEST_TITLE,
                "author": REQUEST_AUTHOR,
            },
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job["result"]

    def scanned_names(self, result: dict, shelf: Path) -> list[str]:
        """走査で拾った入れ物を、棚から見た名前で写す"""
        return [
            Path(path).resolve().relative_to(shelf.resolve()).as_posix()
            for path in result["containers"]
        ]

    def book_map(self, result: dict, shelf: Path) -> dict[str, list[str]]:
        """解析の結果を「入れ物の名前 -> 出来る本の名前」で写す。

        件数では取り違えを見張れない。棚からの相対名で写すのは、並び順を
        入れ替えた 2 つの棚の結果を、そのまま突き合わせられるようにするため。
        """
        found: dict[str, list[str]] = {}
        for book in result["books"]:
            source = Path(book["source"]).resolve()
            name = source.relative_to(shelf.resolve()).as_posix()
            found.setdefault(name, []).append(book["output_name"])
        return {name: sorted(names) for name, names in found.items()}


class OrganizeSurvivesLinkOrderTest(LinkOrderTestBase):
    """1. 許可の外を指すリンクが先に来ても、許可の中の本は整理される。

    並び順を入れ替えた対照を同じテストに置く。片方だけだと「たまたま順番が
    良かった」だけで通り、後退そのものを見張れない。
    """

    def test_the_book_is_organized_whichever_spelling_comes_first(self):
        # Arrange - リンクが先に来る棚と、ハードリンクが先に来る棚。中身も
        # ハードリンクの名前も同じなので、出来上がりは同じにならなければならない
        link_first, _ = self.shelf("A", EARLY_LINK_NAME, link_first=True)
        twin_first, _ = self.shelf("B", LATE_LINK_NAME, link_first=False)
        link_first_output = self.work_dir / "リンクが先の出力"
        twin_first_output = self.work_dir / "ハードリンクが先の出力"
        expected = {
            REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, TWIN_VOLUME)]
        }

        # Act
        early = self.organize([link_first], link_first_output, books=None)
        late = self.organize([twin_first], twin_first_output, books=None)

        # Assert - リンクが先でも 1 冊出来る。ここが後退で 0 件になる側
        self.assertEqual(
            expected,
            self.produced_map(link_first_output),
            "外を指すリンクが先に列挙されただけで、許可の中の本が処理されていない",
        )
        self.assertEqual([], early["result"]["failed"], early["result"])

        # Assert - 対照。ハードリンクが先なら通る。これが無いと「何も作らない」
        # 実装でも上の検証だけは説明が付いてしまう
        self.assertEqual(
            expected,
            self.produced_map(twin_first_output),
            "ハードリンクが先の棚まで処理されていない",
        )
        self.assertEqual([], late["result"]["failed"], late["result"])

        # Assert - 並び順で結果が変わらない
        self.assertEqual(
            self.produced_map(link_first_output),
            self.produced_map(twin_first_output),
            "列挙の並び順で出来上がりが変わっている",
        )


class AnalysisSurvivesLinkOrderTest(LinkOrderTestBase):
    """2. 解析の経路（``analysis_job._scan``）も同じ形をしている。

    整理だけ直して解析が残ると、画面には行が 1 つも出ないまま「解析は成功」と
    表示される。利用者はチェックを付ける対象すら見られない。
    """

    def test_the_book_is_analyzed_whichever_spelling_comes_first(self):
        # Arrange
        link_first, _ = self.shelf("A", EARLY_LINK_NAME, link_first=True)
        twin_first, _ = self.shelf("B", LATE_LINK_NAME, link_first=False)
        expected_books = {
            TWIN_NAME: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, TWIN_VOLUME)]
        }

        # Act
        early = self.analysis_result([link_first])
        late = self.analysis_result([twin_first])

        # Assert - リンクが先でも、走査に許可の中のハードリンクが残り、本になる
        self.assertEqual(
            [TWIN_NAME],
            self.scanned_names(early, link_first),
            f"走査の一覧が違う: {early['containers']}",
        )
        self.assertEqual(
            expected_books,
            self.book_map(early, link_first),
            "外を指すリンクが先に列挙されただけで、許可の中の本が解析されていない",
        )
        self.assertEqual([], early["unreadable"], early)

        # Assert - 対照。ハードリンクが先なら通る
        self.assertEqual(
            [TWIN_NAME],
            self.scanned_names(late, twin_first),
            f"走査の一覧が違う: {late['containers']}",
        )
        self.assertEqual(
            expected_books,
            self.book_map(late, twin_first),
            "ハードリンクが先の棚まで解析されていない",
        )
        self.assertEqual([], late["unreadable"], late)

        # Assert - 並び順で結果が変わらない
        self.assertEqual(
            self.book_map(early, link_first),
            self.book_map(late, twin_first),
            "列挙の並び順で解析の結果が変わっている",
        )


class AnalysisDuplicateSpellingTest(LinkOrderTestBase):
    """3. 実体が同じ本を 2 通りの綴りで投入しても、解析は 1 冊しか出さない。

    段階 C が入れた守るべき性質。**これは今も通る。** 上の 2 つを直すときに
    ここを壊さないための対照として置く。整理の経路は
    ``test_volume_override_api.py`` の C17 が見ているので、こちらは解析の経路。

    行が 2 つ並ぶと、利用者は同じ本に 2 回チェックを付け、整理で ``_1`` の
    付いた 2 冊目を受け取る。
    """

    def test_two_spellings_of_the_same_file_make_one_book(self):
        # Arrange - どちらの綴りも許可の中。ここには許可の話を持ち込まない
        library = self.work_dir / "蔵書C"
        original = zip_with(library / TWIN_NAME, pages(count=PAGES))
        copy = self.twin_of(original, COPY_NAME)
        self.assert_two_spellings_of_one_file(original, copy)

        # Act - 2 つの綴りを両方名指しで投入する
        result = self.analysis_result([original, copy])

        # Assert - 走査も本も 1 件。先に名指しした綴りが残る
        self.assertEqual(
            [TWIN_NAME],
            self.scanned_names(result, library),
            f"同じファイルの 2 通りの綴りが、走査に 2 件並んでいる: "
            f"{result['containers']}",
        )
        self.assertEqual(
            {TWIN_NAME: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, TWIN_VOLUME)]},
            self.book_map(result, library),
            "同じファイルの 2 通りの綴りから、本が 2 冊出来ている",
        )
        self.assertEqual([], result["unreadable"], result)


if __name__ == "__main__":
    unittest.main()
