"""巻数の根拠を、画面まで通す（段階 A）。

利用者の困りごとは「なぜこの本が第005巻になったのか分からない」こと。いまの
一覧は番号だけを見せていて、``第3巻`` と書いてあったから 5 巻にしたのか、名前の
最後に転がっていた数字を拾っただけなのか、名前から何も読めず並び順を当てはめた
だけなのかが区別できない。利用者にとって信頼度がまるで違う 3 つが、同じ顔で並ぶ。

根拠そのものは既に計算されている。``VolumeDetector.decide_volume`` は
``VolumeDecision(number, origin, source_name)`` を返し、``toc_analyzer._plan`` が
``decision.number`` だけを取り出して**残り 2 つを捨てている**。段階 A はこの 2 つを
``PlannedBook`` → ``PlannedBookView`` まで通すだけで、依頼の形も振る舞いも 1 つも
変えない。出力が増えるだけ。

増える 2 欄は次のとおり。

| 欄 | 中身 |
|---|---|
| ``volume_origin`` | ``pattern`` / ``last-number`` / ``position`` / ``none`` |
| ``volume_source_name`` | 巻数を読み取った名前。``position`` のときは空 |

``volume_source`` ではなく ``volume_source_name`` なのは、``PlannedBookView`` に
既に ``source``（元アーカイブの絶対パス）があり、同じ JSON の中で紛らわしいため。
dataclass 側の ``VolumeDecision.source_name`` とも揃う。

**``Literal`` にはしない。** ``str`` + description に値を列挙する（``organized_reason``
の先例に合わせる）。``Literal`` にすると ``volume_detector`` に 5 個目の origin が
足された瞬間、表示用の欄のせいで解析ジョブ全体が ``ValidationError`` で落ちる。
巻数の読み方を増やしただけで解析が全滅するのは、増やす側から見えない罠になる。

欄は ``organized`` の 4 欄と同じく**決して省かない**。省くと画面から「並び順で
決めた」のか「まだ判定していない」のかを区別できない。

判定を ``issues`` から逆算してはいけない。``volume-uncertain`` は ``position`` と
「数字が複数ある ``last-number``」の**両方**に付き、``内_05`` のような素直な
``last-number`` には付かない。印と根拠は別物なので、ここでは根拠そのものを見る。
"""

import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方は既存のテストと共有する。同じ物を別々に書くと、片方を直した
# ときに「同じ入力のはず」の 2 つが静かに食い違う
from test_toc_analysis import pages, zip_with  # noqa: E402

from manga_api.analysis_job import analysis_work  # noqa: E402
from manga_core.file_organizer import FileOrganizer  # noqa: E402

# 蔵書に入っている本の著者・作品名
AUTHOR = "著者"
TITLE = "作品"
SERIES_DIR = f"[{AUTHOR}] {TITLE}"

# 依頼に載せる著者・作品名。蔵書の中身と**わざと違える**。根拠が依頼の値から
# 作られているだけなら、整理済みの本のところで必ず食い違う
OTHER_AUTHOR = "別人"
OTHER_TITLE = "別作品"

# 増える 2 欄の鍵。画面はこの名前で読むので、名前そのものが契約
VOLUME_ORIGIN = "volume_origin"
VOLUME_SOURCE_NAME = "volume_source_name"

# 巻数をどこから読んだか。値は manga_core.volume_detector と揃える。画面は
# この文字列で読み分けるので、値そのものが契約
ORIGIN_PATTERN = "pattern"
ORIGIN_LAST_NUMBER = "last-number"
ORIGIN_POSITION = "position"
ORIGIN_NONE = "none"

# 実行前に利用者へ見せる印。値は manga_core.toc_analyzer と揃える
VOLUME_UNKNOWN = "volume-unknown"
VOLUME_UNCERTAIN = "volume-uncertain"

# 素材。4 通りの根拠を 1 回の解析で同時に作る
#
# ``合本.zip`` のフォルダ名に**数字を入れない**のが要。既存のテストが使う
# ``第01巻/`` ``第02巻/`` は名前から読めてしまい ``pattern`` になる。名前から
# 何も読めない名前でなければ ``position`` は出ない
COMPOUND = "合本.zip"
COMPOUND_FIRST = "上"
COMPOUND_SECOND = "下"
NUMBERED = "内_05.zip"
PATTERNED = f"{SERIES_DIR} 第003巻.zip"
UNREADABLE = "特別編.zip"

# 入れ子の形。``まとめ.zip`` の中の ``内_05.zip`` は ``_extracted_内_05_zip`` へ
# 展開されるが、``decide_volume`` は元の名前へ戻してから読む（#74）
NESTED = "まとめ.zip"
NESTED_ENTRY = "内_05.zip"
NESTED_EXTRACTED = "_extracted_内_05_zip"


class VolumeOriginTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def build_library(self, with_nested: bool = False) -> Path:
        """4 通りの根拠が同時に出る蔵書を作る。

        1 回の解析にまとめるのは、根拠を決め打ちで返す実装を落とすため。
        1 冊ずつ別々に解析すると、``"pattern"`` を返すだけの実装が 1 本通る。
        """
        library = self.work_dir / "蔵書"

        # position - 1 つの ZIP に 2 冊。どちらのフォルダ名にも数字が無いので、
        # 名前からは何も読めず、並び順が巻数に当てられる
        zip_with(
            library / COMPOUND,
            {**pages(f"{COMPOUND_FIRST}/"), **pages(f"{COMPOUND_SECOND}/")},
        )

        # last-number - 名前の最後の数字を拾っただけ。数字が 1 つなので印は付かない
        zip_with(library / NUMBERED, pages())

        # pattern - ``第003巻`` の型から読んだ
        zip_with(library / PATTERNED, pages())

        # none - 名前に数字が 1 つも無く、読めなかった
        zip_with(library / UNREADABLE, pages())

        if with_nested:
            inner = zip_with(self.work_dir / "素材" / NESTED_ENTRY, pages())
            zip_with(library / NESTED, {NESTED_ENTRY: inner.read_bytes()})

        return library

    def build_organized(self, output: Path, volume: int) -> Path:
        """整理そのものに「整理済みの本」を作らせる。

        比べる相手を手で組み立てると定義を書き写すことになる。実処理に作らせれば、
        名前の作り方が変わっても素材は自動で追随する。
        """
        source = zip_with(
            self.work_dir / f"素材{volume}" / f"素材_{volume:02d}.zip", pages(count=3)
        )
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results = organizer.process_single_archive(source)
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "整理が失敗した"
        )
        built = results[0].output_path
        self.assertIsNotNone(built)
        # 素材が本当に「整理が作る物」であることをここで固定する
        self.assertEqual(f"{SERIES_DIR} 第{volume:03d}巻.zip", built.name)
        self.assertEqual(SERIES_DIR, built.parent.name)
        return built

    def analyze(self, root: Path) -> dict[tuple[str, str], dict]:
        """解析ジョブが画面へ返す形そのものを、本ごとに引ける形で返す。

        鍵は ``(元アーカイブの名前, アーカイブ内での位置)``。名前は依頼の著者・
        作品名で変わるので、``output_name`` を鍵にはしない。
        """
        work = analysis_work([root], OTHER_AUTHOR, OTHER_TITLE, lambda path: True)
        result = work(lambda **kwargs: None)
        views = {
            (Path(view["source"]).name, view["entry"]): view for view in result["books"]
        }
        self.assertEqual(
            len(result["books"]), len(views), f"本が重なっている: {result['books']}"
        )
        return views

    def assert_fields_present(self, views: dict[tuple[str, str], dict]) -> None:
        """2 欄が 1 冊も省かれずに載っていること。

        ``.get()`` で読むと、欄が無い実装でも ``None == None`` で通ってしまう。
        鍵そのものを見てから、以降は必ず添字で読む。
        """
        for key, view in sorted(views.items()):
            for field in (VOLUME_ORIGIN, VOLUME_SOURCE_NAME):
                self.assertIn(field, view, f"{key} に欄が無い: {sorted(view)}")


class VolumeOriginSurfaceTest(VolumeOriginTestBase):
    """4 通りの根拠が、1 回の解析で同時に画面まで届くこと（A1）"""

    def test_all_four_origins_reach_the_view_in_one_analysis(self):
        # Arrange - 4 通りの根拠が同時に出る蔵書
        library = self.build_library()

        # Act - 解析ジョブが画面へ返す形そのもの
        views = self.analyze(library)

        # Assert - 欄が 1 冊も省かれていない
        self.assertEqual(5, len(views), f"冊数が合わない: {sorted(views)}")
        self.assert_fields_present(views)

        # Assert - 印と根拠は別物。``内_05`` は数字が 1 つなので印が付かないまま
        # ``last-number`` になる。``issues`` を写しただけの実装はこの本で落ちる
        self.assertEqual(
            {
                (COMPOUND, COMPOUND_FIRST): [VOLUME_UNCERTAIN],
                (COMPOUND, COMPOUND_SECOND): [VOLUME_UNCERTAIN],
                (NUMBERED, ""): [],
                (PATTERNED, ""): [],
                (UNREADABLE, ""): [VOLUME_UNKNOWN],
            },
            {key: view["issues"] for key, view in views.items()},
            "素材の印が変わった。根拠と印の食い違いを試せていない",
        )

        # Assert - 4 通りを**一度に**比べる。1 冊ずつ確かめると、根拠を決め打ちで
        # 返す実装が 1 本だけ通る。番号を同じ比較に入れるのは、根拠だけ正しくて
        # 巻数が壊れた実装を落とすため
        self.assertEqual(
            {
                (COMPOUND, COMPOUND_FIRST): (1, ORIGIN_POSITION),
                (COMPOUND, COMPOUND_SECOND): (2, ORIGIN_POSITION),
                (NUMBERED, ""): (5, ORIGIN_LAST_NUMBER),
                (PATTERNED, ""): (3, ORIGIN_PATTERN),
                (UNREADABLE, ""): (None, ORIGIN_NONE),
            },
            {key: (view["volume"], view[VOLUME_ORIGIN]) for key, view in views.items()},
            "巻数とその根拠が合わない",
        )


class VolumeSourceNameTest(VolumeOriginTestBase):
    """巻数を読み取った名前が、読み取った本の名前そのものであること（A2）"""

    def test_only_a_book_decided_by_position_has_no_source_name(self):
        """名前が空になるのは ``position`` の本だけ。

        **画面は「空かどうか」で判定してはいけない。** ``volume_origin`` が
        ``position`` かどうかで判定する。空文字は名前を読まなかったことの
        **結果**であって、判定の根拠ではない。読み取り規則が変われば空になる
        条件も変わるので、空文字を条件に書いた画面はそのとき静かに壊れる。
        """
        # Arrange - 4 通りの根拠に、入れ子の形を足す
        library = self.build_library(with_nested=True)

        # Act
        views = self.analyze(library)

        # Assert - 欄が 1 冊も省かれていない
        self.assertEqual(6, len(views), f"冊数が合わない: {sorted(views)}")
        self.assert_fields_present(views)

        # Assert（主） - 名前を読んでいない本は ``position`` の 2 冊だけ。
        # 画面はこの ``volume_origin`` だけを見て読み分ければよい
        self.assertEqual(
            {(COMPOUND, COMPOUND_FIRST), (COMPOUND, COMPOUND_SECOND)},
            {
                key
                for key, view in views.items()
                if view[VOLUME_ORIGIN] == ORIGIN_POSITION
            },
            "並び順で決めた本が想定と違う",
        )

        # Assert（従） - その 2 冊だけが空。全冊を一度に比べるので、「空文字を
        # 返すだけ」の実装は ``last-number`` の行で落ち、「常に名前を返す」実装は
        # ``position`` の行で落ちる
        self.assertEqual(
            {
                (COMPOUND, COMPOUND_FIRST): "",
                (COMPOUND, COMPOUND_SECOND): "",
                (NUMBERED, ""): "内_05",
                (PATTERNED, ""): f"{SERIES_DIR} 第003巻",
                (UNREADABLE, ""): "特別編",
                (NESTED, NESTED_ENTRY): "内_05",
            },
            {key: view[VOLUME_SOURCE_NAME] for key, view in views.items()},
            "巻数を読み取った名前が合わない",
        )

        # Assert（従） - 入れ子は**元のアーカイブ名**。展開先フォルダの名前を
        # そのまま載せた実装は、利用者が見たことのない名前を画面に出す
        self.assertNotEqual(
            NESTED_EXTRACTED,
            views[(NESTED, NESTED_ENTRY)][VOLUME_SOURCE_NAME],
            "展開先フォルダの名前が画面へ漏れている",
        )


class OrganizedVolumeOriginTest(VolumeOriginTestBase):
    """整理済みの本にも根拠が載り、根拠から状態を導けないこと（A3）"""

    def test_an_organized_book_carries_the_origin_it_was_actually_read_from(self):
        """整理済みの本の根拠は、その本の名前から実際に読んだもの。

        **「整理済みなら必ず ``pattern``」は偽。** ``第000巻`` は
        ``decide_volume_from_name`` の ``if volume:``（真偽値判定）で型の枝を抜け、
        ``last-number`` になる。0 は正しく読めた巻数なのに、真偽値で見ているため
        「読めなかった」と同じ扱いに落ちる。

        したがって**画面が ``volume_origin`` から ``organized`` を導いてはいけない**。
        逆も同じで、``organized`` から根拠を作ってはいけない。2 つは別の判定で、
        たまたま多くの本で揃って見えるだけ。
        """
        # Arrange - 整理そのものに作らせた整理済みの本を 2 冊と、名前だけが
        # 違う本を 1 冊、同じ作品フォルダへ並べる
        library = self.work_dir / "蔵書"
        patterned = self.build_organized(library, volume=3)
        zero = self.build_organized(self.work_dir / "ゼロ", volume=0)
        shutil.copy2(zero, library / SERIES_DIR / zero.name)
        stray = zip_with(library / SERIES_DIR / "raw_09.zip", pages(count=3))

        # Act
        views = self.analyze(library)

        # Assert - 欄が 1 冊も省かれていない
        self.assertEqual(3, len(views), f"冊数が合わない: {sorted(views)}")
        self.assert_fields_present(views)

        # Assert - 整理済みかどうかと根拠を**一度に**比べる。整理済みの本だけを
        # 見ると「整理済みなら pattern」と決め打った実装が通る。``第000巻`` は
        # 整理済みでありながら ``last-number`` で、その決め打ちを落とす
        self.assertEqual(
            {
                (patterned.name, ""): (
                    True,
                    3,
                    ORIGIN_PATTERN,
                    f"{SERIES_DIR} 第003巻",
                ),
                (zero.name, ""): (
                    True,
                    0,
                    ORIGIN_LAST_NUMBER,
                    f"{SERIES_DIR} 第000巻",
                ),
                (stray.name, ""): (False, 9, ORIGIN_LAST_NUMBER, "raw_09"),
            },
            {
                key: (
                    view["organized"],
                    view["volume"],
                    view[VOLUME_ORIGIN],
                    view[VOLUME_SOURCE_NAME],
                )
                for key, view in views.items()
            },
            "整理済みかどうかと巻数の根拠が合わない",
        )

        # Assert - 読み取った名前は拡張子を含まない。``source`` は絶対パス、
        # ``volume_source_name`` は判定に使った名前で、別の欄
        self.assertNotIn(
            ".zip",
            views[(patterned.name, "")][VOLUME_SOURCE_NAME],
            "拡張子まで載っている",
        )


if __name__ == "__main__":
    unittest.main()
