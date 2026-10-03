"""ジョブ基盤を検証する。

展開・整理・梱包は数分かかるため HTTP リクエスト内では完結しない。
投入して即座に受付を返し、進捗を別途取得できることを保証する。
"""

import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api import jobs  # noqa: E402
from manga_api.jobs import (  # noqa: E402
    JobCancelled,
    JobNotFound,
    JobState,
    JobStore,
)


def wait_until(predicate, timeout: float = 5.0) -> bool:
    """条件が満たされるまで短く待つ"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class JobStoreTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.store = JobStore(Path(self._temp.name).resolve() / "jobs.db")
        self.addCleanup(self.store.close)

    def stored_log_count(self, job_id: str) -> int:
        """実際に SQLite へ保存されているログ行数を数える"""
        connection = sqlite3.connect(self.store.path)
        self.addCleanup(connection.close)
        return connection.execute(
            "SELECT COUNT(*) FROM job_logs WHERE job_id = ?", (job_id,)
        ).fetchone()[0]

    def test_submitted_job_starts_queued_and_reaches_succeeded(self):
        # Arrange
        job_id = self.store.submit("organize", {"note": "テスト"})

        # Assert - 投入直後は待機中
        self.assertEqual(JobState.QUEUED, self.store.get(job_id).state)

        # Act
        self.store.run(job_id, lambda report: "done")

        # Assert
        job = self.store.get(job_id)
        self.assertEqual(JobState.SUCCEEDED, job.state)
        self.assertEqual("done", job.result)
        self.assertIsNone(job.error)

    def test_keeps_every_reported_message_in_order(self):
        # Arrange - 進捗は上書きされるため、取りこぼさない履歴が要る
        job_id = self.store.submit("organize", {})

        def work(report):
            report(current=1, total=2, message="1 冊目")
            report(current=2, total=2, message="2 冊目")
            return "ok"

        # Act
        self.store.run(job_id, work)

        # Assert
        self.assertEqual(["1 冊目", "2 冊目"], self.store.log_of(job_id))

    def test_does_not_record_empty_messages(self):
        # Arrange
        job_id = self.store.submit("organize", {})

        # Act - 件数だけ更新する報告はログに残さない
        self.store.run(job_id, lambda report: report(current=1, total=1))

        # Assert
        self.assertEqual([], self.store.log_of(job_id))

    def test_stored_log_does_not_grow_without_a_limit(self):
        # Arrange - 実際の上限は大きいので、テスト中だけ小さくする
        job_id = self.store.submit("organize", {})
        limit = 5
        reported = limit * 3

        def work(report):
            for index in range(reported):
                report(current=index + 1, total=reported, message=f"{index + 1} 冊目")
            return "ok"

        # Act
        with mock.patch.object(jobs, "MAX_LOG_LINES", limit):
            self.store.run(job_id, work)

        # Assert - 保存行そのものが上限で頭打ちになる
        stored = self.stored_log_count(job_id)
        self.assertGreater(stored, 0, "ログが 1 行も残っていない")
        self.assertLessEqual(stored, limit)

    def test_keeps_the_newest_lines_when_the_log_is_trimmed(self):
        # Arrange
        job_id = self.store.submit("organize", {})
        limit = 3
        reported = limit * 4

        def work(report):
            for index in range(reported):
                report(current=index + 1, total=reported, message=f"{index + 1} 冊目")
            return "ok"

        # Act
        with mock.patch.object(jobs, "MAX_LOG_LINES", limit):
            self.store.run(job_id, work)

        # Assert - 捨てるのは古い行のほう
        self.assertEqual(["10 冊目", "11 冊目", "12 冊目"], self.store.log_of(job_id))

    def test_progress_is_visible_while_running(self):
        # Arrange
        job_id = self.store.submit("organize", {})
        released = threading.Event()

        def work(report):
            report(current=3, total=10, message="展開中")
            released.wait(5)
            return "ok"

        worker = threading.Thread(target=self.store.run, args=(job_id, work))
        worker.start()
        self.addCleanup(worker.join)

        # Act / Assert - 実行中に進捗が読める
        self.assertTrue(wait_until(lambda: self.store.get(job_id).current == 3))
        running = self.store.get(job_id)
        self.assertEqual(JobState.RUNNING, running.state)
        self.assertEqual(10, running.total)
        self.assertEqual("展開中", running.message)
        released.set()

    def test_logging_does_not_reset_the_progress(self):
        """ログを出しても、設定済みの件数が保たれる（#65）。

        整理は 1 冊につき数行のログを出す。ログのたびに件数が 0 で
        上書きされると、画面には 0 / N が出続ける。
        """
        # Arrange
        job_id = self.store.submit("organize", {})
        during: list[jobs.Job] = []

        def work(report):
            # 2 冊目に入ったことを伝える
            report(current=2, total=4, message="2 冊目")
            # その 1 冊を処理する間に出るログ。件数は触っていない
            report(message="  Processing archive structure...")
            report(message="  Created: 2 冊目.zip")
            # 実行中の見え方をその場で控える
            during.append(self.store.get(job_id))
            return "ok"

        # Act
        self.store.run(job_id, work)

        # Assert
        observed = during[0]
        self.assertEqual(2, observed.current, f"ログで件数が失われた: {observed}")
        self.assertEqual(4, observed.total, f"ログで総数が失われた: {observed}")

    def test_keeps_both_the_progress_and_the_log(self):
        """進捗とログは互いを壊さない（#65）"""
        # Arrange
        job_id = self.store.submit("organize", {})

        def work(report):
            report(current=1, total=3, message="1 冊目")
            report(message="  展開中")
            report(message="  書き出し中")
            return "ok"

        # Act
        self.store.run(job_id, work)

        # Assert - 進捗は残る
        job = self.store.get(job_id)
        self.assertEqual((1, 3), (job.current, job.total), f"進捗がログで消えた: {job}")

        # Assert - ログも残る。進捗を守るためにログを捨ててはいけない
        self.assertEqual(
            ["1 冊目", "  展開中", "  書き出し中"], self.store.log_of(job_id)
        )

    def test_failure_records_the_reason_without_losing_the_job(self):
        # Arrange
        job_id = self.store.submit("organize", {})

        def explode(report):
            raise RuntimeError("展開に失敗しました")

        # Act
        self.store.run(job_id, explode)

        # Assert
        job = self.store.get(job_id)
        self.assertEqual(JobState.FAILED, job.state)
        self.assertIn("展開に失敗しました", job.error)
        self.assertIsNone(job.result)

    def test_cancellation_stops_the_job(self):
        # Arrange
        job_id = self.store.submit("organize", {})
        started = threading.Event()

        def work(report):
            started.set()
            for index in range(100):
                report(current=index, total=100)
                time.sleep(0.01)
            return "ok"

        worker = threading.Thread(target=self.store.run, args=(job_id, work))
        worker.start()
        self.addCleanup(worker.join)
        self.assertTrue(started.wait(5))

        # Act
        self.store.cancel(job_id)

        # Assert
        cancelled = wait_until(
            lambda: self.store.get(job_id).state == JobState.CANCELLED
        )
        self.assertTrue(cancelled)

    def test_reports_progress_raises_after_cancellation(self):
        # Arrange
        job_id = self.store.submit("organize", {})
        self.store.cancel(job_id)

        # Act / Assert - キャンセル済みなら報告時点で止まる
        with self.assertRaises(JobCancelled):
            self.store.run(job_id, lambda report: report(current=1, total=2))

    def test_unknown_job_is_reported(self):
        # Act / Assert
        with self.assertRaises(JobNotFound):
            self.store.get("存在しない")

    def test_jobs_survive_reopening_the_database(self):
        # Arrange - サイドカーが再起動しても履歴を失わない
        job_id = self.store.submit("organize", {"title": "テスト作品"})
        self.store.run(job_id, lambda report: "ok")
        path = self.store.path
        self.store.close()

        # Act
        reopened = JobStore(path)
        self.addCleanup(reopened.close)

        # Assert
        job = reopened.get(job_id)
        self.assertEqual(JobState.SUCCEEDED, job.state)
        self.assertEqual({"title": "テスト作品"}, job.payload)

    def test_lists_jobs_newest_first(self):
        # Arrange
        first = self.store.submit("organize", {})
        second = self.store.submit("reorder", {})

        # Act
        listed = [job.id for job in self.store.list_jobs()]

        # Assert
        self.assertEqual([second, first], listed)


class PartialResultTest(unittest.TestCase):
    """途中経過を result に載せる（#70 第 4 段階）。

    解析は「走査で行が先に並び、目次を読めた順に本の行が生える」形になる。
    育っていく中身を画面へ渡す場所は result しかない。いまは終わったときに
    1 度だけ書かれるので、実行中はずっと null のままになる。

    ここで求める公開契約は、進捗報告に result を足せること。

        report(current=1, total=3, result={...})

    進捗と同じロック・同じトランザクションで書く。別々に書くと「件数は
    2 冊目なのに中身は 1 冊目まで」という状態が途中で見えてしまう。
    """

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.store = JobStore(Path(self._temp.name).resolve() / "jobs.db")
        self.addCleanup(self.store.close)

    def test_a_partial_result_is_visible_while_the_job_is_still_running(self):
        # Arrange - 途中で止め、走っている最中の見え方をその場で読む
        job_id = self.store.submit("analyze", {})
        released = threading.Event()
        partial = {
            "scanned": True,
            "containers": ["/蔵書/a_01.zip", "/蔵書/b_02.zip"],
            "books": [{"source": "/蔵書/a_01.zip", "entry": ""}],
            "unreadable": [],
        }

        def work(report):
            report(current=1, total=2, result=partial)
            released.wait(5)
            return {"scanned": True, "containers": [], "books": [], "unreadable": []}

        worker = threading.Thread(target=self.store.run, args=(job_id, work))
        worker.start()
        # 後入れ先出しで片付くので、先に join を積んでおくと解放が先に走る
        self.addCleanup(worker.join)
        self.addCleanup(released.set)
        worker_started = wait_until(lambda: self.store.get(job_id).result is not None)

        # Assert - 途中経過と「まだ走っている」ことを 1 つの見え方から読む。
        # 終わってから result を見るだけでは、いまの実装でも通ってしまう
        self.assertTrue(worker_started, "実行中に途中経過が読めない")
        observed = self.store.get(job_id)
        self.assertEqual(partial, observed.result, f"途中経過が違う: {observed}")
        self.assertEqual(
            JobState.RUNNING,
            observed.state,
            f"終わってからしか書かれていない: {observed}",
        )
        self.assertEqual(
            (1, 2),
            (observed.current, observed.total),
            f"途中経過を書いたら進捗が消えた: {observed}",
        )

        # Act / Assert - 最後の結果で上書きされる
        released.set()
        worker.join(5)
        self.assertEqual([], self.store.get(job_id).result["containers"])

    def test_a_partial_result_is_not_written_after_cancellation(self):
        # Arrange - 1 度書いてから止められ、その後にもう 1 度書こうとする
        job_id = self.store.submit("analyze", {})
        first = {"scanned": True, "containers": ["/蔵書/a_01.zip"], "books": []}
        second = {"scanned": True, "containers": ["/蔵書/a_01.zip"], "books": [{}]}
        reported = threading.Event()
        cancelled = threading.Event()
        raised: list[BaseException] = []

        def work(report):
            report(current=1, total=2, result=first)
            reported.set()
            cancelled.wait(5)
            # ここで止まる。止まらなければ下の result が書かれてしまう
            report(current=2, total=2, result=second)
            return "ok"

        def runner():
            try:
                self.store.run(job_id, work)
            except JobCancelled as error:
                raised.append(error)

        worker = threading.Thread(target=runner)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(cancelled.set)
        self.assertTrue(reported.wait(5), "最初の途中経過が書かれていない")

        # Act
        self.store.cancel(job_id)
        cancelled.set()
        worker.join(5)

        # Assert - 報告そのものが止める。止まらないと、キャンセル後も
        # 画面の一覧が増え続ける
        self.assertEqual(1, len(raised), "キャンセル後の報告が素通りしている")
        self.assertEqual(
            first,
            self.store.get(job_id).result,
            "キャンセル後の途中経過まで書かれている",
        )
        self.assertEqual(JobState.CANCELLED, self.store.get(job_id).state)


class PrunedWhileRunningTest(unittest.TestCase):
    """走っている最中に記録ごと消されたジョブ（#70 第 4 段階）。

    解析は投入の中身が変わるたびに走り直す。新しい解析の投入は、まず
    ``prune_finished("analyze")`` で「終わっている」解析の記録を落とす
    （``app.py`` の ``submit_analysis``）。ところがキャンセルは、ワーカーが
    気づくより先に行を終わりの状態にする。差し替えられた解析は毎回
    キャンセルされるので、「終わりの状態なのにワーカーはまだ走っている」は
    例外ではなく普通に起きる。

    そのとき、まだアーカイブを読んでいるワーカーの次の報告先は消えている。
    利用者から見ると、投入を編集しただけなのに「解析が失敗した」という
    記録と例外が残る。止めたものが静かに終わるのと、失敗として残るのとでは
    見え方がまるで違う。

    ここで求める振る舞いは「報告先が消えていたら、キャンセルされたときと
    同じ終わり方をする」こと。どの例外で終わるか（あるいは終わらせ方を
    変えるか）は実装の選択なので、キャンセルされた場合と突き合わせて見る。
    """

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.store = JobStore(Path(self._temp.name).resolve() / "jobs.db")
        self.addCleanup(self.store.close)

    def outcome_of(self, *, prune: bool) -> tuple[str, list[int]]:
        """止められたジョブを最後まで走らせ、終わり方と進んだ歩数を返す。

        ``prune`` は、止めた後に新しい解析が投入されたかどうか。投入は
        ``submit`` の前に ``prune_finished`` を呼ぶので、ここでも同じ順序で
        並べる。返すのは ``run`` から漏れたものの名前（何も漏れなければ
        「返った」）と、ワーカーが越えられた報告の数。
        """
        job_id = self.store.submit("analyze", {})
        steps: list[int] = []
        reported = threading.Event()
        released = threading.Event()
        escaped = ["返った"]

        def work(report):
            report(current=1, total=2, result={"containers": ["/蔵書/a_01.zip"]})
            steps.append(1)
            reported.set()
            released.wait(5)
            # 止められた後の報告。ここで止まらなければ、消された行へ
            # 書き続けることになる
            report(current=2, total=2, result={"containers": ["/蔵書/b_02.zip"]})
            steps.append(2)
            return "ok"

        def runner():
            try:
                self.store.run(job_id, work)
            except BaseException as error:  # noqa: BLE001 - 種類を控えるだけ
                escaped[0] = type(error).__name__

        worker = threading.Thread(target=runner)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(released.set)
        self.assertTrue(reported.wait(5), "ワーカーが動き出していない")

        # 差し替えの順序どおりに並べる。止めてから、新しい解析が投入される
        self.store.cancel(job_id)
        if prune:
            self.store.prune_finished("analyze")
        released.set()
        worker.join(5)
        self.assertFalse(worker.is_alive(), "ワーカーが終わらない")
        return escaped[0], steps

    def test_a_pruned_job_ends_the_same_way_as_a_cancelled_one(self):
        # Act - 記録ごと消された場合と、止められただけの場合
        abandoned, abandoned_steps = self.outcome_of(prune=True)
        cancelled, cancelled_steps = self.outcome_of(prune=False)

        # Assert - どちらも同じ終わり方をする。例外の名前を直に書かないのは、
        # 「消えていたらキャンセル扱い」を実装がどう表すかまでは縛らないため
        self.assertEqual(
            cancelled,
            abandoned,
            "記録を消されたワーカーが、止められたときと違う終わり方をしている",
        )

        # Assert - 対照。どちらも 1 歩目までで止まる。ここを見ないと、
        # 「何が来ても素通りさせる」実装でも上の突き合わせを通せる
        self.assertEqual([1], abandoned_steps, "記録が消えたのに、その先まで進んでいる")
        self.assertEqual([1], cancelled_steps, "止めたのに、その先まで進んでいる")

    def test_a_pruned_job_is_not_recorded_as_a_failure(self):
        # Act / Assert - 消えた行への報告を、失敗として残さない。利用者は
        # 投入を編集しただけで、失敗させた覚えはない
        with self.assertNoLogs("manga_api.jobs", level="ERROR"):
            self.outcome_of(prune=True)


if __name__ == "__main__":
    unittest.main()
