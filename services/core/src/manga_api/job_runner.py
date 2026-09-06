"""ジョブを走らせる 1 か所。

経路は「受け付けた」ことだけを返し、中身はここから走らせる。スレッドで
走らせるか同期で走らせるかは ``app.state.run_jobs_inline`` の 1 か所だけで
決める。経路ごとに ``threading.Thread`` を組み立てると、テスト用の同期実行を
足し忘れた経路が 1 つ混じっただけで、その経路のテストだけ結果を待てなくなる。
"""

import logging
import threading
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

from manga_api.jobs import JobCancelled, ProgressReporter

logger = logging.getLogger(__name__)

# ジョブの中身。進捗の報告を受け取り、結果になるものを返す
JobWork = Callable[[ProgressReporter], Any]


def start_job(app: FastAPI, job_id: str, work: JobWork) -> None:
    """ジョブを動かす。通常はワーカースレッド、テストでは同期実行する"""
    if app.state.run_jobs_inline:
        _run_quietly(app, job_id, work)
        return
    thread = threading.Thread(
        target=_run_quietly, args=(app, job_id, work), name=f"job-{job_id}", daemon=True
    )
    thread.start()


def _run_quietly(app: FastAPI, job_id: str, work: JobWork) -> None:
    """ワーカースレッドの例外でプロセスを落とさない"""
    try:
        app.state.jobs.run(job_id, work)
    except JobCancelled:
        # 打ち切りは失敗ではない。解析は投入を編集するたびに走り直して前のものを
        # 止めるので、これを失敗として書き残すと、利用者は編集しただけで
        # 「ジョブが失敗しました」の山を見ることになる
        logger.debug("ジョブが打ち切られました: %s", job_id)
    except Exception:  # noqa: BLE001 - 状態は JobStore が記録済み
        logger.exception("ジョブが失敗しました: %s", job_id)
