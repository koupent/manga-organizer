"""打ち切りは、目次を読んでいる最中にも効く（#80 段階 A）。

#80 は 2 つの問題を 1 つのイシューにしている。ここで固定するのは攻撃者の
話ではないほう――**打ち切ったのに仕事が続き、その打ち切りが「目次を読めま
せん」という嘘に化ける**ほうだけ。入れ子の展開に上限を付ける話（段階 B）は
別に扱う。

いまの経路を追うと、こうなっている。

- ``manga_api.jobs.JobCancelled`` は ``RuntimeError`` の一種
- ``manga_core.toc_analyzer._NESTED_READ_ERRORS`` に ``RuntimeError`` が入って
  いるので、入れ子の目次読みで上がった打ち切りは ``_scan_nested`` に食われる
- ``_read_container`` は素の ``Exception`` を受けるので、入れ物そのものの目次
  読みで上がった打ち切りは ``AnalysisStep.error`` に化け、画面には
  「目次を読めません」のバッジが出る
- ``manga_api.organize_job._archive_plan`` も ``locate_books`` を検査点
  無しで呼び、``except Exception`` で包んでいる。解析だけを直すと、2 つの
  経路が食い違う

利用者から見える害は 2 つ。投入を編集して解析が走り直しても前の解析が蔵書を
読み続けること（``analysis_job`` の冒頭が「ジョブにした理由」として挙げている
状態そのもの）と、止めただけのアーカイブに壊れている印が付くこと。整理の側も
同じで、打ち切ったあとも入れ子を最後まで読み切ってからでないと止まらない。

**状態が "cancelled" になったことを見ても、何の証拠にもならない。**
``JobStore.cancel`` はワーカーが気づくかどうかに関わらずその状態を書く
（``test_analysis_progress.ScanCancellationTest`` に同じ注意書きがある）。
``result`` も同じで、``JobStore._report`` は打ち切りのあと 1 文字も書かない
から、握りつぶされた打ち切りが ``unreadable`` に残ることはそもそも無い。
実際に読むのをやめたかは、読んだ回数でしか分からない。数えたうえで、止め
なければ最後まで読み切ることを対照で確かめる。

ここで求める契約は次のとおり。

1. 目次読みの最中（入れ子を含む）にも打ち切りの検査点があり、そこで上がった
   例外は ``toc_analyzer`` に握りつぶされず呼び出し側まで届く
2. 届いた打ち切りは ``unreadable``（「目次を読めません」）にしない
3. 整理の側（``_archive_plan``）も同じ検査点を通し、同じように握り
   つぶさない
4. **本当に壊れている入れ子は、いままでどおり外側の本ごと巻き添えにしない。**
   ``RecursionError`` も ``RuntimeError`` の一種なので、``_NESTED_READ_ERRORS``
   から ``RuntimeError`` を外すだけの直し方はここで落ちる
"""

import sys
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方と待ち方は既存のテストと共有する。同じ物を別々に書くと、片方を
# 直したときに「同じ入力のはず」の 2 つが静かに食い違う
from test_analysis_progress import AnalysisJobTestBase, wait_until  # noqa: E402
from test_toc_analysis import TocAnalysisTestBase, pages, zip_with  # noqa: E402

from manga_api.jobs import JobCancelled  # noqa: E402
from manga_core import toc_analyzer  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"


def member_name(name) -> str:
    """``ZipFile.read`` に渡された要素の名前。ZipInfo でも文字列でも受ける"""
    return name if isinstance(name, str) else name.filename


class TocReadHelpers:
    """コア層の目次読みを、外から止めたり壊したりするための道具。

    打ち切りの伝わり方を見るテストと、その対照（本当に壊れている入れ子）で
    同じ素材・同じ seam を使う。別々に書くと、片方だけ直したときに「同じ
    入力のはず」の 2 つが静かに食い違う。
    """

    def build_nest(self, root: Path) -> tuple[Path, Path]:
        """入れ子を 1 つ持つアーカイブと、その次に読まれるアーカイブ。

        次のアーカイブを置くのは、「打ち切ったのに残りまで読み続ける」ことを
        見るため。1 つしか置かないと、握りつぶしても見た目には現れない。
        """
        material = self.work_dir / "素材"
        inner = self.write_archive(material / "内_05.zip")
        outer = zip_with(
            root / "外_01.zip",
            {**pages("表紙/"), "内_05.zip": inner.read_bytes()},
        )
        following = self.write_archive(root / "次_02.zip")
        return outer, following

    def spy_on_opened_containers(self) -> list[Path]:
        """目次を読みに行った入れ物を控える。

        引数をそのまま渡すのは、段階 A で ``locate_books`` に検査点の引数が
        増えても、この見張りが黙って壊れないようにするため。
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

    def raise_on_nested_read(self, error: BaseException) -> list[str]:
        """入れ子のバイト列を読みに来たところで、指定の例外を投げる"""
        reads: list[str] = []
        original = zipfile.ZipFile.read

        def spy(zip_self, name, pwd=None):
            stored = member_name(name)
            if stored.lower().endswith(".zip"):
                reads.append(stored)
                raise error
            return original(zip_self, name, pwd)

        patcher = mock.patch.object(zipfile.ZipFile, "read", spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return reads

    def steps(self, root: Path) -> tuple[list, BaseException | None]:
        """解析を最後まで（か、例外が上がるまで）回し、出た事象と例外を返す"""
        events: list = []
        try:
            for event in toc_analyzer.analyze_stream([root], AUTHOR, TITLE):
                events.append(event)
        except BaseException as error:  # noqa: BLE001 - 上がったものを見せる
            return events, error
        return events, None


class NestedReadCancellationTest(TocReadHelpers, TocAnalysisTestBase):
    """1. 目次読みの最中に上がった打ち切りを、握りつぶさない（コア層）

    ここは打ち切りの伝わり方だけを見る。検査点そのものを ``toc_analyzer`` へ
    通す配線（段階 A の実装で ``locate_books`` / ``analyze_stream`` が受け取る
    ``checkpoint``）はまだ無いので、**検査点が置かれる場所と同じ所で例外を
    起こして**同じ形を作る。読み出しの seam（``ZipFile.read``）で
    ``JobCancelled`` を投げれば、「入れ子のバイト列を読んでいる最中に打ち切り
    が上がった」状態そのものになる。

    このやり方だと、検査点の置き方（1 要素ごとか、n 件ごとか）を決めずに
    「上がった打ち切りは食われない」だけを固定できる。
    """

    def test_a_cancellation_inside_a_nested_read_reaches_the_caller(self):
        # Arrange - 入れ子を持つアーカイブと、その次に読まれるアーカイブ
        root = self.work_dir / "入れ子の打ち切り"
        outer, following = self.build_nest(root)
        opened = self.spy_on_opened_containers()
        reads = self.raise_on_nested_read(JobCancelled("解析を打ち切りました"))

        # Act - 入れ子のバイト列を読んだ瞬間に打ち切りが上がる
        events, raised = self.steps(root)

        # Assert - 下準備の確認。入れ子を読みに行っていなければ以下に意味が無い
        self.assertEqual(["内_05.zip"], reads, "入れ子を読みに行っていない")

        # Assert - 打ち切りは呼び出し側まで届く。``_NESTED_READ_ERRORS`` に
        # ``RuntimeError`` が入っているので、いまはここで食われる
        self.assertIsInstance(
            raised,
            JobCancelled,
            f"入れ子の目次読みで打ち切りが握りつぶされている: {raised!r}",
        )

        # Assert - 打ち切りが「目次を読めません」に化けていない。化けると
        # 画面には、止めただけのアーカイブに壊れている印が出る
        failed = [
            event
            for event in events
            if isinstance(event, toc_analyzer.AnalysisStep) and event.error
        ]
        self.assertEqual(
            [], failed, f"打ち切りが「目次を読めません」になっている: {failed}"
        )

        # Assert - 残りの入れ物は読まない。読み続けるなら、投入を編集する
        # たびに蔵書を歩くワーカーが溜まる
        self.assertEqual(
            [outer],
            opened,
            f"打ち切ったのに {following.name} まで読んでいる: {opened}",
        )

    def test_a_cancellation_while_reading_a_container_is_not_reported_as_unreadable(
        self,
    ):
        # Arrange - 入れ物そのものの目次読みで打ち切りが上がる形。検査点を
        # 目次の中に置けば、入れ子でなくてもこの形になる
        root = self.work_dir / "入れ物の打ち切り"
        first = self.write_archive(root / "外_01.zip")
        following = self.write_archive(root / "次_02.zip")
        opened: list[Path] = []
        original = toc_analyzer.locate_books

        def cancel_on_first(archive_path: Path, *args, **kwargs):
            opened.append(archive_path)
            if archive_path == first:
                raise JobCancelled("解析を打ち切りました")
            return original(archive_path, *args, **kwargs)

        # Act
        with mock.patch.object(toc_analyzer, "locate_books", cancel_on_first):
            events, raised = self.steps(root)

        # Assert - ``_read_container`` の素の ``except Exception`` が、打ち切り
        # まで受け止めて ``AnalysisStep.error`` に変えてしまう
        self.assertIsInstance(
            raised,
            JobCancelled,
            f"入れ物の目次読みで打ち切りが握りつぶされている: {raised!r}",
        )
        failed = [
            event
            for event in events
            if isinstance(event, toc_analyzer.AnalysisStep) and event.error
        ]
        self.assertEqual(
            [], failed, f"打ち切りが「目次を読めません」になっている: {failed}"
        )
        self.assertEqual(
            [first],
            opened,
            f"打ち切ったのに {following.name} まで読んでいる: {opened}",
        )


class BrokenNestedArchiveStaysContainedTest(TocReadHelpers, TocAnalysisTestBase):
    """2. 対照。本当に読めない入れ子は、いままでどおり外側を巻き添えにしない

    ``_NESTED_READ_ERRORS`` から ``RuntimeError`` を外すだけの直し方をすると、
    ここが落ちる。``RecursionError`` は ``RuntimeError`` の一種で、深く入れ子
    になった目次を辿ったときに実際に上がりうる。外へ抜ければ
    ``_read_container`` が入れ物ごと「読めません」にするので、**入れ子 1 つの
    失敗で外側の本まで一覧から消える**。

    この 2 件はいまも通る。段階 A の実装のあとも通り続けることが要件で、
    「握りつぶすのをやめる」だけの直し方を止めるための対照になる。
    """

    def only_step(self, root: Path):
        """入れ物 1 つ分の結果を取り出す"""
        events, raised = self.steps(root)
        self.assertIsNone(raised, f"解析が例外で止まっている: {raised!r}")
        steps = [
            event for event in events if isinstance(event, toc_analyzer.AnalysisStep)
        ]
        self.assertEqual(1, len(steps), f"入れ物 1 つ分にならない: {steps}")
        return steps[0]

    def test_a_corrupt_nested_archive_still_yields_the_outer_books(self):
        # Arrange - 外側は読めるが、中の ``内_05.zip`` は ZIP ではない
        root = self.work_dir / "壊れた入れ子"
        zip_with(
            root / "外_01.zip",
            {**pages("表紙/"), "内_05.zip": b"\x00\x01 not a zip at all \x02\x03" * 16},
        )

        # Act
        step = self.only_step(root)

        # Assert - 外側の本は出る。入れ物は「読めません」にしない
        self.assertIsNone(step.error, f"外側まで読めない扱いになっている: {step}")
        self.assertEqual(
            ["表紙"],
            [book.entry for book in step.books],
            f"壊れた入れ子のせいで外側の本が消えている: {step.books}",
        )

    def test_a_recursion_error_in_a_nested_read_still_yields_the_outer_books(self):
        # Arrange - 入れ子の読み出しが ``RecursionError`` で落ちる。これも
        # ``RuntimeError`` の一種なので、打ち切りと同じ網に掛かっている
        root = self.work_dir / "深すぎる入れ子"
        self.build_nest(root)
        reads = self.raise_on_nested_read(RecursionError("入れ子が深すぎます"))

        # Act
        events, raised = self.steps(root)

        # Assert - 下準備の確認
        self.assertEqual(["内_05.zip"], reads, "入れ子を読みに行っていない")

        # Assert - 解析は止まらず、外側の本も次のアーカイブも出る
        self.assertIsNone(raised, f"入れ子 1 つの失敗で解析が止まっている: {raised!r}")
        steps = [
            event for event in events if isinstance(event, toc_analyzer.AnalysisStep)
        ]
        self.assertEqual(
            [None, None],
            [step.error for step in steps],
            f"入れ子 1 つの失敗が入れ物ごと読めない扱いになっている: {steps}",
        )
        self.assertEqual(
            ["表紙", ""],
            [book.entry for step in steps for book in step.books],
            f"入れ子 1 つの失敗で外側の本が消えている: {steps}",
        )


class NestedReadSpyMixin:
    """入れ子だらけのアーカイブと、その読み出しの見張り。

    ジョブとして走っている解析・整理の両方で同じ物を使う。片方だけ別の素材で
    確かめると、2 つの経路が同じ振る舞いになっているかを誰も見張らない。
    """

    # 1 つのアーカイブに入れる入れ子の数。見張りの間隔がどうであれ
    # 「途中で止まった」と言えるだけの数を置く
    NESTED_COUNT = 40

    def build_nest_heavy_folder(self, name: str) -> tuple[Path, Path]:
        """入れ子だけが並んだアーカイブ 1 つを持つフォルダ。

        入れ物を 1 つにしてあるのは、**入れ物の境目で止まったのか、目次を
        読んでいる最中に止まったのか**を混ぜないため。境目の検査点はいまも
        あるので、入れ物を並べて数えると今の実装のままでも通ってしまう。
        """
        material = self.work_dir / f"素材-{name}"
        inner = self.write_archive(material / "内.zip").read_bytes()
        folder = self.work_dir / name
        folder.mkdir(parents=True, exist_ok=True)
        outer = folder / "外_00.zip"
        with zipfile.ZipFile(outer, "w", zipfile.ZIP_STORED) as archive:
            for index in range(1, self.NESTED_COUNT + 1):
                archive.writestr(f"内_{index:03d}.zip", inner)
        return folder, outer

    def spy_on_nested_reads(self, pause_after: int | None = None):
        """入れ子を読み出した跡を控える。指定の件数まで来たら、そこで待たせる。

        見張るのは ``ZipFile.read``。``toc_analyzer._scan_nested`` が入れ子の
        バイト列を取り出すのに使う、そのものの入口なので、検査点をどこに
        置いても「入れ子をいくつ読んだか」はここで数えられる。
        """
        reads: list[str] = []
        reached = threading.Event()
        released = threading.Event()
        pause = [pause_after]
        original = zipfile.ZipFile.read

        def spy(zip_self, name, pwd=None):
            stored = member_name(name)
            if stored.lower().endswith(".zip"):
                reads.append(stored)
                if pause[0] is not None and len(reads) == pause[0]:
                    reached.set()
                    released.wait(15)
            return original(zip_self, name, pwd)

        def disarm():
            pause[0] = None

        patcher = mock.patch.object(zipfile.ZipFile, "read", spy)
        patcher.start()
        # 止めたまま片付けに入るとワーカースレッドが残るので、必ず解放する
        self.addCleanup(patcher.stop)
        self.addCleanup(released.set)
        return reads, reached, released, disarm

    def cancel(self, job_id: str) -> None:
        """走っているジョブに打ち切りを頼む"""
        cancelled = self.client.post(
            f"/api/jobs/{job_id}/cancel", params=self.auth(), json={}
        )
        self.assertEqual(202, cancelled.status_code, cancelled.text)


class AnalysisNestedReadCancellationTest(NestedReadSpyMixin, AnalysisJobTestBase):
    """3. 走っている解析を、入れ子の目次を読んでいる最中に止められる

    ``ScanCancellationTest``（走査の打ち切り）と同じ組み立てにしてある。
    見張り + 「止めなければ最後まで読む」対照。違うのは止める場所だけで、
    あちらは走査、こちらは目次読みの中。
    """

    inline = False

    def test_cancelling_during_a_nested_read_stops_the_reading(self):
        # Arrange - 入れ子が 40 個。1 つ目を読んだところで待たせる
        folder, outer = self.build_nest_heavy_folder("解析の打ち切り")
        reads, reached, released, disarm = self.spy_on_nested_reads(pause_after=1)

        # Act - まだ 1 つ目の入れ子を読んでいる最中に打ち切りを頼む
        job_id = self.accepted_id([folder])
        self.assertTrue(reached.wait(15), f"入れ子の目次読みが始まらない: {reads}")
        self.cancel(job_id)
        released.set()

        # Assert - 残りの入れ子を読み切らずに止まる。「ちょうど 1 つ目で
        # 止まる」ことは求めない（1 要素ごとの検査点は重すぎる）。求めるのは、
        # 半分にも届かないうちに止まること
        limit = self.NESTED_COUNT // 2
        self.assertFalse(
            wait_until(lambda: len(reads) > limit, timeout=5.0),
            f"打ち切ったのに入れ子を読み続けている: {len(reads)} / "
            f"{self.NESTED_COUNT} 件",
        )

        # Assert - 止まり方も見る。状態が "cancelled" であること自体は
        # 何の証拠にもならないが、"failed" で終わっていれば上の「読んで
        # いない」は別の理由で通ったことになる
        job = self.job(job_id)
        self.assertEqual("cancelled", job["state"], f"打ち切りで終わっていない: {job}")

        # Assert - 打ち切りを「目次を読めません」として残さない。**この 1 行は
        # いまも通る**。``JobStore._report`` が打ち切りのあと何も書かないので、
        # ジョブの ``result`` から握りつぶしを見ることは原理的にできない
        # （見えるのはコア層の ``NestedReadCancellationTest`` のほう）。上の
        # 「読み続けていない」と対にして、直した結果として印が生えていない
        # ことだけを見る
        self.assertEqual(
            [],
            (job.get("result") or {}).get("unreadable", []),
            f"打ち切りが「目次を読めません」として残っている: {job['result']}",
        )

        # Assert - 対照。止めなければ入れ子を全部読む。見張りが呼ばれて
        # いない・名前が合っていないだけの実装でも、上の「読んでいない」は
        # 通ってしまう
        disarm()
        reads.clear()
        again = self.accepted_id([folder])
        self.assertTrue(
            wait_until(lambda: self.job(again)["state"] == "succeeded", timeout=60.0),
            f"対照の解析が終わらない: {self.job(again)}",
        )
        self.assertEqual(
            {f"内_{index:03d}.zip" for index in range(1, self.NESTED_COUNT + 1)},
            set(reads),
            f"対照でも入れ子を読み切っていない: {len(reads)} 件 ({outer.name})",
        )


class OrganizeNestedReadCancellationTest(NestedReadSpyMixin, AnalysisJobTestBase):
    """4. 整理の側の目次読みも、同じところで止まる

    ``organize_job._archive_plan`` は「作らない本」を決めるために
    ``locate_books`` をもう一度呼ぶ。こちらは検査点を渡しておらず、
    ``except Exception`` で包んでいるので、解析だけを直すと 2 つの経路が
    食い違う。

    いまの整理は、目次を読み切ったあと最初のログ行で ``JobStore._report`` に
    捕まって止まる。つまり**止まる場所が「読み終えてから」しか無い**。数百
    GB の入れ子を抱えた 1 冊では、そこに至るまでが丸ごと無駄な読み出しになる。
    書き出しに進まないことは対で見るだけで、いまも通る。
    """

    inline = False
    # 整理は 1 冊ごとに展開して書き出す。対照を短く保つため、作る本は 1 冊
    # だけ選ぶ。残りは「外す本」になり、それを決めるために目次が読まれる
    CHOSEN_ENTRY = "内_007.zip"

    def submit_organize(self, folder: Path, output: Path, books: list[dict]) -> str:
        """整理ジョブを投入し、ジョブ番号を返す"""
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(folder)],
                "output_directory": str(output),
                "title": TITLE,
                "author": AUTHOR,
                "keep_originals": True,
                "books": books,
            },
        )
        self.assertEqual(
            202, accepted.status_code, f"整理の投入が受け付けられない: {accepted.text}"
        )
        return accepted.json()["id"]

    def produced(self, output: Path) -> list[str]:
        """出力先に実在する本。

        ジョブの報告（result.produced）は打ち切りのあと書かれないので、
        報告からは何も分からない。ディスクの側から数える。
        """
        if not output.exists():
            return []
        return sorted(path.name for path in output.rglob("*.zip") if path.is_file())

    def test_cancelling_during_the_skip_lookup_stops_the_reading_and_the_writing(self):
        # Arrange - 入れ子が 40 個。作るのはそのうち 1 冊だけ。残り 39 冊を
        # 「外す」と決めるために ``_archive_plan`` が目次を読みに行く
        folder, outer = self.build_nest_heavy_folder("整理の打ち切り")
        output = self.work_dir / "out-整理の打ち切り"
        books = [{"source": str(outer), "entry": self.CHOSEN_ENTRY}]
        reads, reached, released, disarm = self.spy_on_nested_reads(pause_after=1)

        # Act - 外す本を数えている最中に打ち切りを頼む
        job_id = self.submit_organize(folder, output, books)
        self.assertTrue(reached.wait(15), f"外す本の目次読みが始まらない: {reads}")
        self.cancel(job_id)
        released.set()

        # Assert - 残りの入れ子を読み切らずに止まる
        limit = self.NESTED_COUNT // 2
        self.assertFalse(
            wait_until(lambda: len(reads) > limit, timeout=5.0),
            f"打ち切ったのに外す本を数え続けている: {len(reads)} / "
            f"{self.NESTED_COUNT} 件",
        )

        # Assert - 書き出しにも進まない。**これはいまも通る**（最初のログ行が
        # ``_report`` に捕まるため）。上の「読み続けていない」と対にして、
        # 直した結果として書き出しが復活していないことを見る。上で 5 秒
        # 待っているので、出来ていればここに現れる
        self.assertEqual(
            [],
            self.produced(output),
            f"打ち切ったのに本が出来上がっている: {self.produced(output)}",
        )
        job = self.job(job_id)
        self.assertEqual("cancelled", job["state"], f"打ち切りで終わっていない: {job}")

        # Assert - 対照。止めなければ目次を読み切り、選んだ 1 冊が出来る
        disarm()
        reads.clear()
        again = self.submit_organize(folder, output, books)
        self.assertTrue(
            wait_until(lambda: self.job(again)["state"] == "succeeded", timeout=60.0),
            f"対照の整理が終わらない: {self.job(again)}",
        )
        nested_names = {
            f"内_{index:03d}.zip" for index in range(1, self.NESTED_COUNT + 1)
        }
        # 整理は展開でも同じ要素を読むので、読んだ回数ではなく「全部の名前が
        # 出たか」で見る
        self.assertEqual(
            set(),
            nested_names - set(reads),
            f"対照でも外す本を数え切っていない: {len(reads)} 件",
        )
        self.assertEqual(
            1,
            len(self.produced(output)),
            f"対照で選んだ 1 冊が出来ていない: {self.produced(output)}",
        )


if __name__ == "__main__":
    unittest.main()
