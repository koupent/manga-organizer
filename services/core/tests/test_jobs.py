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
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.store = JobStore(Path(self._temp.name) / "jobs.db")
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


if __name__ == "__main__":
    unittest.main()
