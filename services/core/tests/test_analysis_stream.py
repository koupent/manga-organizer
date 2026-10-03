"""解析を「走査 → 1 つずつ目次を読む」の流れに割る（#70 第 4 段階）。

第 2 段階の ``analyze_inputs`` は、全部読み終わるまで何も返さない。数百 GB の
蔵書では待っている間ずっと空の画面が続き、受け付けられたのかどうかも分からない。
利用者の要望は

    「解析中: 走査で行が先に全部並び、目次を読めた順に本の行が生えます」

なので、コア層に「途中まで」を出す入口が要る。ここで求める公開契約は次の形。

    from manga_core import toc_analyzer

    for event in toc_analyzer.analyze_stream([folder], author="著者", title="作品"):
        ...

- 最初の 1 件は必ず ``AnalysisScan(containers=(パス, ...))``。走査だけを終えた
  状態で、目次はまだ 1 つも読んでいない
- 以降は入れ物 1 つにつき ``AnalysisStep(container, books, error)`` が 1 件。
  ``books`` はその入れ物から出来る本、``error`` は目次を読めなかったときの理由

``analyze_inputs`` はこの流れを最後まで畳んだだけのものにする。畳んだ結果が
今までと 1 文字でも変われば、予告した名前と実際に出来る名前が食い違う。

RAR / 7z の目次読みは第 5 段階なので、ここでは扱わない。
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 流れを出す入口はこれから作る（第 4 段階）。モジュールごと取り込むのは、
# 名指しで取り込むと未実装の間だけ ruff の並べ替えが別の順序を要求するため
from manga_core import toc_analyzer  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"

# 1 つの ZIP に 2 冊分が入っている状態
COMPOUND_ENTRIES = (
    "第01巻/001.jpg",
    "第01巻/002.jpg",
    "第02巻/001.jpg",
    "第02巻/002.jpg",
)


def page() -> bytes:
    """テスト用のページ画像。実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


class AnalysisStreamTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

    def write_archive(self, path: Path, entries: tuple[str, ...] = ("001.jpg",)):
        """指定の中身の ZIP を作る。途中のディレクトリも掘る"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in entries:
                archive.writestr(name, page())
        return path

    def spy_on_locate_books(self) -> list[Path]:
        """目次を読みに行った先を記録する。

        「途中まで返している」ことは、返ってきた値だけでは確かめられない。
        全部読んでから小出しにする実装も同じ値を返す。開きに行った順を
        1 件ずつ控えて、読む前に走査だけが返っていることを見る。
        """
        opened: list[Path] = []
        original = toc_analyzer.locate_books

        def spy(archive_path: Path, *args, **kwargs):
            opened.append(archive_path)
            return original(archive_path, *args, **kwargs)

        patcher = mock.patch.object(toc_analyzer, "locate_books", spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return opened


class ScanArrivesFirstTest(AnalysisStreamTestBase):
    """1. 走査の結果は、目次を 1 つも読まないうちに出る"""

    def test_the_scan_event_precedes_every_table_of_contents_read(self):
        # Arrange - アーカイブ 3 つ。どれから読み始めたかが分かるようにする
        folder = self.work_dir / "走査"
        self.write_archive(folder / "a_01.zip")
        self.write_archive(folder / "b_02.zip")
        self.write_archive(folder / "c_03.zip")
        expected = expand_inputs([folder])
        self.assertEqual(3, len(expected), f"下準備が想定と違う: {expected}")

        opened = self.spy_on_locate_books()

        # Act - 1 件ずつ取り出す。まとめて list() にすると、全部読んでから
        # 小出しにする実装と見分けが付かない
        stream = toc_analyzer.analyze_stream([folder], author=AUTHOR, title=TITLE)
        first = next(stream)

        # Assert - 走査だけが終わった状態。目次はまだ 1 つも開いていない
        self.assertEqual(
            [],
            opened,
            f"走査を返す前に目次を読んでいる: {opened}",
        )
        self.assertEqual(
            expected,
            list(first.containers),
            f"走査の結果に入れ物が全部そろっていない: {first}",
        )

        # Act - 次の 1 件
        second = next(stream)

        # Assert - このときになって初めて、1 つ目の目次だけを読む。
        # ここで opened が 3 件になる実装は、先に全部読んでいる
        self.assertEqual(
            [expected[0]],
            opened,
            f"1 件進めただけで読みすぎている: {opened}",
        )
        self.assertEqual(
            expected[0],
            second.container,
            f"読んだ入れ物と報告が食い違う: {second}",
        )

    def test_the_scan_event_is_still_first_when_nothing_is_found(self):
        # Arrange - 中身が空のフォルダ。入れ物が 0 件でも走査は報告する。
        # 「まだ走査中」と「何も無かった」を画面から区別できなくなるため
        folder = self.work_dir / "空"
        folder.mkdir(parents=True)

        # Act
        events = list(toc_analyzer.analyze_stream([folder], author=AUTHOR, title=TITLE))

        # Assert
        self.assertEqual(1, len(events), f"走査の 1 件だけのはず: {events}")
        self.assertEqual((), tuple(events[0].containers), events[0])


class StreamMatchesTheWholeRunTest(AnalysisStreamTestBase):
    """2. 流して読んだ結果は、まとめて読んだ結果と 1 文字も違わない"""

    def test_streamed_books_are_identical_to_analyze_inputs(self):
        # Arrange - 巻数を読めない ZIP を 2 つ入れる。どちらも `Unknown` に
        # なるので、2 つ目には `_1` が付く。入れ物ごとに名前を決め直す実装は
        # ここで `Unknown.zip` を 2 つ作ってしまう
        folder = self.work_dir / "衝突"
        self.write_archive(folder / "合本.zip", COMPOUND_ENTRIES)
        self.write_archive(folder / "特別編.zip", ("001.jpg", "002.jpg"))
        self.write_archive(folder / "番外編.zip", ("001.jpg", "002.jpg"))

        expected = toc_analyzer.analyze_inputs([folder], author=AUTHOR, title=TITLE)
        names = [book.output_name for book in expected]
        self.assertIn(
            f"[{AUTHOR}] {TITLE} Unknown_1.zip",
            names,
            f"下準備で名前が衝突していない。これでは `_1` を確かめられない: {names}",
        )

        # Act - 走査の 1 件を除いた、入れ物ごとの本をつなぎ直す
        streamed = [
            book
            for event in toc_analyzer.analyze_stream(
                [folder], author=AUTHOR, title=TITLE
            )
            if isinstance(event, toc_analyzer.AnalysisStep)
            for book in event.books
        ]

        # Assert - 冊数ではなく 1 件ずつ突き合わせる。冊数だけを見ると、
        # `_1` の付き方がずれていても通ってしまう
        self.assertEqual(
            expected,
            streamed,
            f"流して読んだ結果がまとめて読んだ結果と違う: {streamed}",
        )

    def test_each_step_reports_the_container_its_books_came_from(self):
        # Arrange - 1 つの ZIP から 2 冊出るので、入れ物と冊数は一致しない
        folder = self.work_dir / "対応"
        compound = self.write_archive(folder / "合本.zip", COMPOUND_ENTRIES)
        single = self.write_archive(folder / "単体_03.zip", ("001.jpg", "002.jpg"))

        # Act
        steps = [
            event
            for event in toc_analyzer.analyze_stream(
                [folder], author=AUTHOR, title=TITLE
            )
            if isinstance(event, toc_analyzer.AnalysisStep)
        ]

        # Assert - 入れ物 1 つにつき 1 件。本はその入れ物から出たものだけ
        by_container = {step.container: step for step in steps}
        self.assertEqual(
            {compound, single},
            set(by_container),
            f"入れ物ごとの報告になっていない: {steps}",
        )
        self.assertEqual(2, len(by_container[compound].books), by_container[compound])
        self.assertEqual(1, len(by_container[single].books), by_container[single])
        for container, step in by_container.items():
            for book in step.books:
                self.assertEqual(container, book.source, f"元が違う: {step}")


class UnreadableContainerTest(AnalysisStreamTestBase):
    """3. 1 つ読めなくても、残りは最後まで読む"""

    def test_one_unreadable_container_does_not_stop_the_rest(self):
        """途中の 1 つで落ちても、後ろのアーカイブの本が出る。

        壊れた ZIP を置いて確かめてはいけない。``locate_books`` は
        ``BadZipFile`` と ``OSError`` を自分で握りつぶして空を返すので
        （``toc_analyzer.py`` の ``locate_books``）、壊れた ZIP は
        **今の実装のまま何も足さなくても** 素通りしてしまう。守りが要るのは
        握りつぶしていない種類の例外なので、``MemoryError`` を投げさせる。
        """
        # Arrange - 3 つのうち、真ん中で落ちる
        folder = self.work_dir / "読めない"
        first = self.write_archive(folder / "a_01.zip")
        broken = self.write_archive(folder / "b_02.zip")
        last = self.write_archive(folder / "c_03.zip")
        self.assertEqual(
            [first, broken, last],
            expand_inputs([folder]),
            "下準備の並び順が想定と違う",
        )
        original = toc_analyzer.locate_books

        def explode(archive_path: Path, *args, **kwargs):
            if archive_path == broken:
                raise MemoryError("目次が大きすぎます")
            return original(archive_path, *args, **kwargs)

        # Act
        with mock.patch.object(toc_analyzer, "locate_books", explode):
            steps = [
                event
                for event in toc_analyzer.analyze_stream(
                    [folder], author=AUTHOR, title=TITLE
                )
                if isinstance(event, toc_analyzer.AnalysisStep)
            ]

        # Assert - 読めなかった 1 つは、理由付きで報告される
        by_container = {step.container: step for step in steps}
        failed = by_container.get(broken)
        self.assertIsNotNone(failed, f"読めなかった入れ物の報告が無い: {steps}")
        self.assertTrue(failed.error, f"読めなかった理由が入っていない: {failed}")
        self.assertEqual((), tuple(failed.books), f"読めないのに本がある: {failed}")

        # Assert - 後ろのアーカイブは、そのまま最後まで読まれる。ここが
        # 落ちる実装は、1 つ壊れただけで残り全部を諦めている
        self.assertEqual(
            [first, broken, last],
            [step.container for step in steps],
            f"読めない 1 つで打ち切られている: {steps}",
        )
        self.assertEqual(
            [last],
            [book.source for book in by_container[last].books],
            f"読めない入れ物の後ろが解析されていない: {by_container[last]}",
        )

        # Assert - 読めたものには理由が付かない。何にでも理由を付ける実装で
        # 上の検証を通せないようにする
        self.assertIsNone(by_container[first].error, by_container[first])
        self.assertIsNone(by_container[last].error, by_container[last])

    def test_names_keep_advancing_across_an_unreadable_container(self):
        # Arrange - 読めなかった入れ物を挟んでも、名前の連番は前から続く。
        # 落ちたところで名前の帳簿ごと作り直す実装だと `_1` がずれる
        folder = self.work_dir / "連番"
        first = self.write_archive(folder / "a_あ.zip", ("001.jpg",))
        broken = self.write_archive(folder / "b_い.zip", ("001.jpg",))
        last = self.write_archive(folder / "c_う.zip", ("001.jpg",))
        self.assertEqual([first, broken, last], expand_inputs([folder]))
        original = toc_analyzer.locate_books

        def explode(archive_path: Path, *args, **kwargs):
            if archive_path == broken:
                raise MemoryError("目次が大きすぎます")
            return original(archive_path, *args, **kwargs)

        # Act
        with mock.patch.object(toc_analyzer, "locate_books", explode):
            books = [
                book
                for event in toc_analyzer.analyze_stream(
                    [folder], author=AUTHOR, title=TITLE
                )
                if isinstance(event, toc_analyzer.AnalysisStep)
                for book in event.books
            ]

        # Assert - 1 冊目が `Unknown`、次が `Unknown_1`
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} Unknown.zip",
                f"[{AUTHOR}] {TITLE} Unknown_1.zip",
            ],
            [book.output_name for book in books],
            f"読めない入れ物の後で名前が振り出しに戻っている: {books}",
        )


class CorruptContainerTest(AnalysisStreamTestBase):
    """4. 目次そのものを読めなかった入れ物は、理由付きで報告する

    ``locate_books`` は ``BadZipFile`` と ``OSError`` を自分で握りつぶして空を
    返す（``toc_analyzer.py``）。``_read_container`` にはそれが「読めたうえで
    1 冊も無かった」として届くので、壊れたアーカイブに理由が付かない。

    第 4 段階から、本を 1 冊も持たない入れ物も走査の行として残り、既定で
    選ばれてそのまま整理される。読めなかったことを誰も言わなければ、壊れた
    アーカイブは印すら出ないまま実行に載り、失敗して初めて分かる。

    ここで求める契約は「目次を読めなかった入れ物には ``error`` が入る」。
    ただし **読めたうえで 1 冊も無い入れ物には入らない**。両方を 1 つの
    テストに入れてあるのは、「本が 0 冊なら読めなかったことにする」実装で
    通らないようにするため。
    """

    def steps_of(self, targets: list[Path]) -> list:
        """入れ物ごとの報告を、読んだ順のまま取り出す"""
        return [
            event
            for event in toc_analyzer.analyze_stream(
                targets, author=AUTHOR, title=TITLE
            )
            if isinstance(event, toc_analyzer.AnalysisStep)
        ]

    def write_corrupt_archive(self, path: Path) -> Path:
        """ZIP の名前をした、ZIP ではないファイル"""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x00\x01 not a zip at all \x02\x03" * 16)
        with self.assertRaises(zipfile.BadZipFile):
            # 下準備の確認。本当に壊れていなければ、以下の検証に意味が無い
            zipfile.ZipFile(path)
        return path

    def write_bookless_archive(self, path: Path) -> Path:
        """壊れてはいないが、画像を 1 枚も含まない ZIP"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("おまけ/memo.txt", "画像は 1 枚も入っていません")
        return path

    def test_a_corrupt_archive_is_reported_but_an_empty_one_is_not(self):
        # Arrange - 壊れたもの・画像の無いもの・読めるものを混ぜる。並びは
        # 名前順（expand_inputs）なので、壊れたものの後ろにも読めるものが来る
        folder = self.work_dir / "壊れている"
        first = self.write_archive(folder / "a_01.zip")
        corrupt = self.write_corrupt_archive(folder / "b_02.zip")
        bookless = self.write_bookless_archive(folder / "c_03.zip")
        last = self.write_archive(folder / "d_04.zip")
        self.assertEqual(
            [first, corrupt, bookless, last],
            expand_inputs([folder]),
            "下準備の並び順が想定と違う",
        )

        # Act
        steps = self.steps_of([folder])
        by_container = {step.container: step for step in steps}

        # Assert - 壊れたものには理由が付く。空で返されると、画面に
        # 「目次を読めません」の印が出ないまま整理へ流れる
        self.assertIn(corrupt, by_container, f"壊れた入れ物の報告が無い: {steps}")
        self.assertTrue(
            by_container[corrupt].error,
            f"壊れているのに読めなかった理由が入っていない: {by_container[corrupt]}",
        )
        self.assertEqual((), tuple(by_container[corrupt].books), by_container[corrupt])

        # Assert - 読めたうえで 1 冊も無いものには付けない。ここが無いと
        # 「本が 0 冊なら読めなかったことにする」実装でも上を通せる
        self.assertIsNone(
            by_container[bookless].error,
            f"読めているのに読めなかったことにしている: {by_container[bookless]}",
        )
        self.assertEqual(
            (), tuple(by_container[bookless].books), by_container[bookless]
        )

        # Assert - 壊れた 1 つで流れは止まらない。後ろの本まで出そろう
        self.assertEqual(
            [first, corrupt, bookless, last],
            [step.container for step in steps],
            f"壊れた入れ物で解析が打ち切られている: {steps}",
        )
        self.assertEqual(
            [last],
            [book.source for book in by_container[last].books],
            f"壊れた入れ物の後ろが解析されていない: {by_container[last]}",
        )
        self.assertIsNone(by_container[first].error, by_container[first])
        self.assertIsNone(by_container[last].error, by_container[last])

    def test_an_archive_that_cannot_be_opened_is_reported(self):
        """開こうとして OSError になる入れ物も、理由付きで報告する。

        解析はジョブなので、投入から目次を読むまでには間がある。その間に
        動かされた・消された・読み取りを許されていないアーカイブは、開いた
        時点で ``OSError`` になる。``locate_books`` はこれも握りつぶすので、
        壊れた ZIP と同じく黙って素通りする。
        """
        # Arrange - 名指しされたが、読む時点にはもう無いアーカイブ
        folder = self.work_dir / "消えた"
        healthy = self.write_archive(folder / "a_01.zip")
        vanished = folder / "b_02.zip"
        self.assertFalse(vanished.exists(), "下準備で作ってしまっている")

        # Act - 走査は名指しされたファイルをそのまま通す（expand_inputs）
        by_container = {
            step.container: step for step in self.steps_of([healthy, vanished])
        }

        # Assert - 開けなかったことが理由として残る
        self.assertIn(
            vanished, by_container, f"開けない入れ物の報告が無い: {by_container}"
        )
        self.assertTrue(
            by_container[vanished].error,
            f"開けないのに読めなかった理由が入っていない: {by_container[vanished]}",
        )

        # Assert - 対照。隣の読めるアーカイブは、今までどおり本になる
        self.assertIsNone(by_container[healthy].error, by_container[healthy])
        self.assertEqual(
            [healthy],
            [book.source for book in by_container[healthy].books],
            f"読める入れ物まで巻き添えにしている: {by_container[healthy]}",
        )


if __name__ == "__main__":
    unittest.main()
