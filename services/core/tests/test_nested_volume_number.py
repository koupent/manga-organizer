"""入れ子アーカイブの巻数を、並び順ではなく元の名前から読む（#74）。

観測した欠陥。``まとめ.zip`` の中に ``05.zip`` と ``09.zip`` が入っていると、
出来上がるのは第005巻・第009巻ではなく**第001巻・第002巻**になる。利用者が
意図した巻数と違う番号が付き、入れ子の ZIP は実際によくある形なので日常的に
起こる。

道筋は 3 つの部品にまたがる。

1. ``ArchiveHandler`` は入れ子を ``_extracted_内_05_zip`` へ展開する。
   元の名前は失われていない。接頭辞が付き、``.`` が ``_`` になっただけ
2. ``VolumeDetector.decide_volume`` は ``_extracted_`` 始まりの名前を
   巻数なしに落とし、そこで元の名前を捨てている
3. 巻数が読めないまま複数冊あると ``resolve_volume`` の Priority 3
   （並び順の番号）に落ちる

中の名前がたまたま 1, 2, 3 と並んでいれば結果は合う。**ずれるのは飛び番と
順不同のとき**で、実際の蔵書ではそちらが普通。だからここの素材は必ず
飛び番かつ格納順を逆にしてある。

ここで求める公開契約。

- ``_extracted_`` を外し、末尾の形式（``_zip`` / ``_rar`` / ``_7z`` /
  ``_cbz`` / ``_cbr`` / ``_cb7`` / ``_epub``）を落とした残りで、既存の
  名前判定を走らせる。``_extracted_内_05_zip`` → ``内_05`` → 5 巻
- Priority 3（並び順）は**残す**。名前に数字が無いときの最後の手段であり、
  無くすと数字を持たない入れ子が全部 Unknown になって今より悪くなる
- ``temp`` 始まりのフォルダは今までどおり読み飛ばす。``_extracted_`` と
  ``temp`` は 1 つの条件に同居しているので、片方を直した拍子に
  もう片方まで動くと、作業用フォルダの名前の数字が巻数になる
- 解析（``toc_analyzer``）も同時に直る。``toc_analyzer`` は実処理と同じ
  ``resolve_volume`` を通しているので、直す場所は ``volume_detector`` 1 つ。
  予告した名前と実際に出来る名前が食い違うほうが、巻数を賢く読めないことより
  害が大きい

**実測で分かった、名前の集合だけを比べても足りないこと。** 今の実装でも
「解析が並べた名前の集合」と「実処理が作ったファイル名の集合」は一致する
（どちらも第001〜003巻）。食い違っているのは**どの中身にどの番号が付くか**で、
解析は名前順（05, 09, 12）、実処理は格納順（09, 12, 05）で番号を振っている。
そのためここでは中の**ページ枚数を巻数ごとに変えて**、出来上がった ZIP を
開いて中身と番号の結び付きまで見る。枚数を見ないと、番号を一貫して間違える
実装がそのまま通る。
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core import toc_analyzer  # noqa: E402
from manga_core.file_organizer import FileOrganizer, ProcessResult  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402
from manga_core.volume_detector import (  # noqa: E402
    ORIGIN_LAST_NUMBER,
    ORIGIN_NONE,
    ORIGIN_PATTERN,
    ORIGIN_POSITION,
    VolumeDetector,
)

AUTHOR = "著者"
TITLE = "作品"


def page() -> bytes:
    """テスト用のページ画像。実処理まで走らせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def pages(prefix: str = "", count: int = 2) -> dict[str, bytes]:
    """アーカイブに入れるページの並び。prefix でフォルダの中に置ける"""
    return {f"{prefix}{index:03d}.jpg": page() for index in range(1, count + 1)}


def zip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の ZIP を作る。途中のフォルダも掘る。

    ``entries`` の順序がそのまま格納順になる。格納順は実処理（os.walk）が
    冊を積む順序、つまり Priority 3 の番号そのものなので、素材では意図的に
    巻数と食い違う順序を使う。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


class NestedVolumeTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def nested_zip(self, name: str, page_count: int) -> bytes:
        """入れ子に入れる ZIP のバイト列。

        ページ枚数を巻ごとに変えるのは、出来上がった ZIP を開いたときに
        「どの中身にどの番号が付いたか」を言えるようにするため。名前の
        集合だけを比べると、番号を一貫して取り違える実装が通ってしまう。
        """
        path = self.work_dir / "素材" / name
        return zip_with(path, pages(count=page_count)).read_bytes()

    def analyze(self, root: Path) -> list:
        """実行前の予測。投入するのは利用者と同じくフォルダ 1 つ"""
        return list(toc_analyzer.analyze_inputs([root], author=AUTHOR, title=TITLE))

    def organize(self, root: Path, output: Path) -> list[ProcessResult]:
        """実処理を走らせる。経路は manga_api の整理ジョブと同じにする"""
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results: list[ProcessResult] = []
        for archive in expand_inputs([root]):
            results.extend(organizer.process_single_archive(archive))
        return results

    def produced_pages(self, results: list[ProcessResult]) -> dict[str, int]:
        """出来たファイル名 -> 中のページ枚数。

        枚数が素材の見分け札。名前と中身の結び付きを、ここで初めて見られる。
        """
        self.assertEqual(
            [],
            [result.error_message for result in results if not result.success],
            "実処理が失敗した。0 冊同士の一致では何も確かめられない",
        )
        produced: dict[str, int] = {}
        for result in results:
            if result.output_path is None:
                continue
            self.assertTrue(
                result.output_path.is_file(),
                f"出来たはずのファイルが無い: {result.output_path}",
            )
            with zipfile.ZipFile(result.output_path) as archive:
                produced[result.output_path.name] = len(archive.namelist())
        return produced

    def shape(self, books: list) -> list[tuple[str, str, int | None, tuple[str, ...]]]:
        """本の並びを (中の位置, 出来る名前, 巻数, 印) で写す"""
        return [
            (book.entry, book.output_name, book.volume, tuple(book.issues))
            for book in books
        ]


class ExtractedDirectoryNameTest(unittest.TestCase):
    """1. 展開先のフォルダ名から、元の入れ子アーカイブ名を取り戻す

    直す場所はここ 1 つ。``VolumeDetector.decide_volume`` が
    ``_extracted_内_05_zip`` から 5 を読めれば、実処理も解析も同じ
    ``resolve_volume`` を通っているので両方が同時に直る。

    ``archive_handler`` は CRLF のファイルなので触らない。展開先の名前を
    変える直し方もあるが、それだと既にディスクに残っている展開物との
    互換が切れるうえ、CRLF のファイルを編集して差分が全行に散る。
    """

    def setUp(self):
        self.detector = VolumeDetector()
        # 形式ごとの表を丸ごと比べる。切り詰められると
        # 「どの形式で落ちたか」が失敗の出力から読めない
        self.maxDiff = None

    def test_reads_the_volume_from_the_original_nested_archive_name(self):
        # Arrange - 実処理が付ける名前そのもの。
        # `内_05.zip` -> `_extracted_` + `内_05.zip`.replace('.', '_')
        name = "_extracted_内_05_zip"

        # Act
        decision = self.detector.decide_volume(Path(name))

        # Assert - 5 巻。並び順の 1 でも、読めなかった None でもない
        self.assertEqual(
            5,
            decision.number,
            f"入れ子 内_05.zip の巻数が名前から読めていない: {decision}",
        )

        # Assert - 根拠が「並び順」ではないこと。番号だけ合っていても、
        # 根拠が position のままだと画面に volume-uncertain の印が残り、
        # 利用者は正しい巻数を疑い続けることになる
        self.assertNotEqual(
            ORIGIN_POSITION,
            decision.origin,
            f"巻数は合っているが根拠が並び順のまま: {decision}",
        )
        self.assertEqual(ORIGIN_LAST_NUMBER, decision.origin, decision)

    def test_reads_the_volume_from_every_nested_archive_format(self):
        """形式の接尾辞を落とし損ねると、その形式だけ違う巻数になる。

        ``_7z`` と ``_cb7`` は**接尾辞そのものに数字がある**。落とし損ねると
        ``内_05_7z`` の最後の数字 7 を拾い、5 巻が 7 巻になる。ZIP でだけ
        試した実装はここで落ちる。
        """
        # Arrange - ARCHIVE_SUFFIXES の 7 形式すべて。どれも中身は 5 巻
        names = {
            "_extracted_内_05_zip": 5,
            "_extracted_内_05_cbz": 5,
            "_extracted_内_05_rar": 5,
            "_extracted_内_05_cbr": 5,
            "_extracted_内_05_7z": 5,
            "_extracted_内_05_cb7": 5,
            "_extracted_内_05_epub": 5,
        }

        # Act
        actual = {
            name: self.detector.decide_volume(Path(name)).number for name in names
        }

        # Assert
        self.assertEqual(
            names,
            actual,
            "形式ごとに巻数が違う。接尾辞（数字を含む _7z / _cb7 に注意）を"
            "落とせていない",
        )

    def test_pattern_based_detection_runs_on_the_recovered_name(self):
        # Arrange - `第7巻.zip` を入れ子にしたときの展開先。最後の数字を拾う
        # だけでなく、既存のパターン判定まで効いていることを見る
        name = "_extracted_第7巻_zip"

        # Act
        decision = self.detector.decide_volume(Path(name))

        # Assert - 7 巻。根拠もパターン読み。パターンを通していない実装は
        # `内_05` のような素材では見分けが付かないので、ここで押さえる
        self.assertEqual(7, decision.number, decision)
        self.assertEqual(
            ORIGIN_PATTERN,
            decision.origin,
            f"取り戻した名前に既存のパターン判定が掛かっていない: {decision}",
        )

    def test_a_nested_archive_without_a_number_still_has_no_volume(self):
        # Arrange - `表紙.zip` のように数字を持たない入れ子。ここで無理に
        # 数字をひねり出すと、Priority 3 の出番が消える
        name = "_extracted_表紙_zip"

        # Act
        decision = self.detector.decide_volume(Path(name))

        # Assert - 読めないものは読めないまま返す。並び順に譲る
        self.assertIsNone(
            decision.number,
            f"数字の無い名前から巻数をひねり出している: {decision}",
        )
        self.assertEqual(ORIGIN_NONE, decision.origin, decision)

    def test_a_temporary_directory_is_still_skipped(self):
        """``temp`` の枝に直しが漏れないこと。

        ``_extracted_`` と ``temp`` は 1 つの条件に同居している。条件ごと
        外すと直しが ``temp`` にも及び、作業用フォルダ ``temp_08`` の 8 が
        巻数になる。利用者が作った物ではない名前の数字が巻数に化ける。
        """
        # Arrange - 数字を持つ作業用フォルダ。直しが漏れると 8 巻になる
        names = ["temp_08", "temp", "temporary_03"]

        # Act
        actual = {
            name: self.detector.decide_volume(Path(name)).number for name in names
        }

        # Assert - どれも巻数なしのまま
        self.assertEqual(
            dict.fromkeys(names),
            actual,
            "作業用フォルダの名前から巻数を読んでいる。"
            "_extracted_ の直しが temp の枝まで及んでいる",
        )


class NestedVolumeOrganizeRunTest(NestedVolumeTestBase):
    """2. 実処理。``05.zip`` が第005巻、``09.zip`` が第009巻になること

    素材は**飛び番かつ格納順が巻数と逆**。1, 2, 3 と並んだ素材は今の実装でも
    たまたま通る（実測済み）ので、それでは何も確かめられない。
    """

    def library(self) -> Path:
        """まとめ.zip の中に 09 / 12 / 05。格納順は 09, 12, 05。

        ページ枚数を巻数と同じにしてあるので、出来上がった ZIP を開けば
        どの中身にどの番号が付いたか分かる。
        """
        root = self.work_dir / "蔵書"
        zip_with(
            root / "まとめ.zip",
            {
                "09.zip": self.nested_zip("09.zip", 9),
                "12.zip": self.nested_zip("12.zip", 12),
                "05.zip": self.nested_zip("05.zip", 5),
            },
        )
        return root

    def test_a_nested_archive_named_05_becomes_volume_5(self):
        # Arrange
        root = self.library()
        output = self.work_dir / "out"

        # Act
        results = self.organize(root, output)

        # Assert - 名前と中身が結び付いている。第005巻 の中身が 5 ページの
        # 素材（05.zip）であること。枚数を見ないと、番号を一貫して取り違える
        # 実装（並び順で 001/002/003 を振るもの）がそのまま通る
        self.assertEqual(
            {
                "[著者] 作品 第005巻.zip": 5,
                "[著者] 作品 第009巻.zip": 9,
                "[著者] 作品 第012巻.zip": 12,
            },
            self.produced_pages(results),
            "入れ子の巻数が名前から読まれていない（出来た名前 -> 中のページ枚数）",
        )

    def test_the_reported_volume_numbers_match_the_created_files(self):
        # Arrange - 報告（``ProcessResult.volume_number``）はジョブの応答を
        # 通って画面に出る。ファイル名だけ直して報告が並び順のままだと、
        # 一覧と出来上がりが食い違う
        root = self.library()
        output = self.work_dir / "out"

        # Act
        results = self.organize(root, output)

        # Assert
        self.assertEqual(
            [5, 9, 12],
            sorted(result.volume_number for result in results if result.success),
            f"報告された巻数が違う: {[r.volume_number for r in results]}",
        )


class NestedVolumeAnalysisParityTest(NestedVolumeTestBase):
    """3. 実行前の予測が、実処理の出来上がりと同じであること

    ``toc_analyzer`` は「予告と実際を一致させる」ためだけに在る。実処理だけを
    直すと予告のほうが取り残され、モジュールの存在理由が消える。逆に予告だけ
    直すと、利用者は実行前に見た名前と違うファイルを受け取る。**片方だけを
    見るテストでは、この食い違いをどうやっても捕まえられない。**
    """

    def library(self) -> Path:
        """実処理側と同じ素材。飛び番・順不同"""
        root = self.work_dir / "蔵書"
        zip_with(
            root / "まとめ.zip",
            {
                "09.zip": self.nested_zip("09.zip", 9),
                "12.zip": self.nested_zip("12.zip", 12),
                "05.zip": self.nested_zip("05.zip", 5),
            },
        )
        return root

    def test_the_analysis_names_the_nested_books_by_their_own_names(self):
        # Arrange
        root = self.library()

        # Act
        books = self.analyze(root)

        # Assert - 位置ごとに巻数が決まる。並びは解析の側で名前順に固定
        # されているので、ここは決め打ちできる
        self.assertEqual(
            [
                ("05.zip", "[著者] 作品 第005巻.zip", 5, ()),
                ("09.zip", "[著者] 作品 第009巻.zip", 9, ()),
                ("12.zip", "[著者] 作品 第012巻.zip", 12, ()),
            ],
            self.shape(books),
            "実行前の予測が入れ子の名前から巻数を読めていない",
        )

    def test_the_analysis_predicts_the_files_the_organize_run_creates(self):
        # Arrange - 利用者と同じ順番。先に予告し、そのあと実際に整理する
        root = self.library()
        output = self.work_dir / "out"

        # Act
        planned = self.analyze(root)
        results = self.organize(root, output)

        # Assert - 予告した名前と、実際に出来たファイル名が一致する
        produced = self.produced_pages(results)
        self.assertEqual(
            sorted(produced),
            sorted(book.output_name for book in planned),
            "予告した名前と実際に出来るファイル名が違う",
        )

        # Assert - 名前の集合が合うだけでは足りない。実測では今の実装でも
        # 集合は一致していて（どちらも第001〜003巻）、食い違っているのは
        # 「どの中身に何番が付くか」だった。解析は名前順、実処理は格納順。
        # 予告の巻数と、出来たファイルの中のページ枚数で突き合わせる
        self.assertEqual(
            {book.output_name: book.volume for book in planned},
            produced,
            "予告した巻数と、実際にその名前で出来たファイルの中身が食い違う",
        )


class PositionalFallbackTest(NestedVolumeTestBase):
    """4. Priority 3（並び順）を最後の手段として残す

    名前に数字が無い入れ子まで巻数なしに倒すと、今まで番号が付いていた本が
    全部 Unknown になり、直したはずが利用者の目には劣化として映る。
    """

    def test_nested_archives_without_numbers_still_get_positional_numbers(self):
        # Arrange - 数字をまったく持たない入れ子だけ。ページ枚数だけ変えて
        # おき、どちらが何番になっても中身の対応を言えるようにする
        root = self.work_dir / "蔵書"
        zip_with(
            root / "まとめ.zip",
            {
                "本編.zip": self.nested_zip("本編.zip", 7),
                "表紙.zip": self.nested_zip("表紙.zip", 3),
            },
        )
        output = self.work_dir / "out"

        # Act
        planned = self.analyze(root)
        results = self.organize(root, output)

        # Assert - 実処理は今までどおり並び順の 1, 2 を振る。どちらの素材が
        # 何番になるかは格納順（os.walk）任せなので、番号と枚数の対応までは
        # 決め打ちしない。ここは名前から決まる真実がそもそも無い
        produced = self.produced_pages(results)
        self.assertEqual(
            ["[著者] 作品 第001巻.zip", "[著者] 作品 第002巻.zip"],
            sorted(produced),
            f"数字の無い入れ子で並び順の番号が使われていない: {produced}",
        )
        self.assertEqual(
            [3, 7],
            sorted(produced.values()),
            f"素材が 2 冊とも作られていない: {produced}",
        )

        # Assert - 予測も同じ。並びは解析の側で名前順に固定されている
        self.assertEqual(
            [
                ("本編.zip", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",)),
                ("表紙.zip", "[著者] 作品 第002巻.zip", 2, ("volume-uncertain",)),
            ],
            self.shape(planned),
            "数字の無い入れ子の予測が変わった。並び順の番号と "
            "volume-uncertain の印は今までどおりであるべき",
        )

    def test_a_lone_nested_archive_without_a_number_stays_unknown(self):
        # Arrange - 1 冊しか出ない入れ子。Priority 3 は複数冊のときだけ効き、
        # ここは外側の名前（まとめ）にも数字が無いので巻数なしのまま
        root = self.work_dir / "蔵書"
        zip_with(root / "まとめ.zip", {"表紙.zip": self.nested_zip("表紙.zip", 3)})
        output = self.work_dir / "out"

        # Act
        planned = self.analyze(root)
        results = self.organize(root, output)

        # Assert - Unknown のまま。印も今までどおり
        self.assertEqual(
            {"[著者] 作品 Unknown.zip": 3},
            self.produced_pages(results),
            "巻数が読めない入れ子の扱いが変わった",
        )
        self.assertEqual(
            [("表紙.zip", "[著者] 作品 Unknown.zip", None, ("volume-unknown",))],
            self.shape(planned),
            "巻数が読めない入れ子の予測が変わった",
        )

    def test_a_temporary_directory_does_not_take_its_own_number(self):
        """``temp`` の枝が、実際の整理でも今までどおりであること。

        単体（``ExtractedDirectoryNameTest``）だけでは、``resolve_volume`` の
        優先順位を通ったあと何が起きるかを言えない。作業用フォルダは並び順の
        番号に落ちる、という今までの動きをここで押さえる。
        """
        # Arrange - 入れ子の 内_05.zip と、作業用フォルダ temp_08。
        # 実処理も解析も「直下の入れ子 -> 下位フォルダ」の順に積むので、
        # 内_05.zip が 1 番目、temp_08 が 2 番目で確定する
        root = self.work_dir / "蔵書"
        zip_with(
            root / "まとめ.zip",
            {
                "内_05.zip": self.nested_zip("内_05.zip", 5),
                **pages("temp_08/", 8),
            },
        )
        output = self.work_dir / "out"

        # Act
        planned = self.analyze(root)
        results = self.organize(root, output)

        # Assert - 入れ子は名前どおり 5 巻。作業用フォルダは並び順の 2 巻で、
        # 名前の 08 は読まれない。第008巻 が出来ていたら直しが漏れている
        self.assertEqual(
            {"[著者] 作品 第005巻.zip": 5, "[著者] 作品 第002巻.zip": 8},
            self.produced_pages(results),
            "入れ子と作業用フォルダの扱いが分かれていない",
        )
        self.assertEqual(
            [
                ("内_05.zip", "[著者] 作品 第005巻.zip", 5, ()),
                ("temp_08", "[著者] 作品 第002巻.zip", 2, ("volume-uncertain",)),
            ],
            self.shape(planned),
            "予測でも入れ子と作業用フォルダの扱いが分かれていない",
        )


class DottedNestedNameTest(NestedVolumeTestBase):
    """5. 名前に ``.`` が混じる入れ子

    展開先の名前は ``.`` を ``_`` に置き換えて作られるので、``作品 2.5.zip``
    は ``_extracted_作品 2_5_zip`` になる。**小数点は取り戻せない。**

    実測した現在の動き。

    - 入れ子の ``作品 2.5.zip`` …… 巻数なし（Unknown / volume-unknown）
    - 直置きの ``作品 2.5.zip`` …… 第005巻（最後の数字 5 / volume-uncertain）

    取り戻せる名前は ``作品 2_5``。既存の判定は数字を ``[2, 5]`` と拾って
    最後の 5 を採るので、直置きと同じ第005巻になる。小数点が消えても
    結論は変わらない。**数字が 2 つある名前なので volume-uncertain の印は
    付いたまま**で、利用者は 2.5 巻かもしれないと気づける。ここで求めるのは
    「小数点を復元すること」ではなく「直置きと同じ扱いになること」。
    """

    def test_a_dotted_nested_name_is_treated_like_the_same_name_at_top_level(self):
        # Arrange - 同じ名前のアーカイブを、入れ子と直置きで別々の蔵書に置く。
        # 同じ蔵書に入れると出力名がぶつかって `_1` が付き、比べにくくなる
        nested_root = self.work_dir / "入れ子" / "蔵書"
        zip_with(
            nested_root / "まとめ.zip",
            {"作品 2.5.zip": self.nested_zip("作品 2.5.zip", 4)},
        )
        top_root = self.work_dir / "直置き" / "蔵書"
        zip_with(top_root / "作品 2.5.zip", pages(count=4))

        # Act
        nested = self.analyze(nested_root)
        top = self.analyze(top_root)

        # Assert - 直置きの側は今までどおり。比較の基準が崩れていないこと
        self.assertEqual(
            [("", "[著者] 作品 第005巻.zip", 5, ("volume-uncertain",))],
            self.shape(top),
            f"比較の基準になる直置きの側が想定と違う: {self.shape(top)}",
        )

        # Assert - 入れ子も同じ巻数・同じ名前・同じ印。位置だけが違う。
        # 小数点は取り戻せないが、最後の数字を採る既存の判定が同じ 5 に
        # 行き着く。数字が 2 つあるので印は残り、利用者は誤読に気づける
        self.assertEqual(
            [("作品 2.5.zip", "[著者] 作品 第005巻.zip", 5, ("volume-uncertain",))],
            self.shape(nested),
            "入れ子の 作品 2.5.zip が、直置きと違う扱いになっている",
        )

    def test_the_dotted_nested_name_survives_the_organize_run(self):
        # Arrange - 予測だけ直って実処理が付いてこない、を防ぐ
        root = self.work_dir / "蔵書"
        zip_with(
            root / "まとめ.zip",
            {"作品 2.5.zip": self.nested_zip("作品 2.5.zip", 4)},
        )
        output = self.work_dir / "out"

        # Act
        results = self.organize(root, output)

        # Assert
        self.assertEqual(
            {"[著者] 作品 第005巻.zip": 4},
            self.produced_pages(results),
            "入れ子の 作品 2.5.zip から出来るファイルが違う",
        )


if __name__ == "__main__":
    unittest.main()
