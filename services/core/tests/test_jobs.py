"""ジョブ基盤を検証する。

展開・整理・梱包は数分かかるため HTTP リクエスト内では完結しない。
投入して即座に受付を返し、進捗を別途取得できることを保証する。
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

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
