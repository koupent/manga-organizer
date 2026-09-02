"""長時間処理をジョブとして扱うための最小限の基盤。

展開・整理・梱包は数分かかるため HTTP リクエスト内では完結しない。投入を
即座に受け付け、進捗を別途取得できるようにする。単一利用者のデスクトップ
アプリなので、キューは SQLite とスレッドで足りる。
"""

import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class JobState(StrEnum):
    """ジョブの状態"""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATES = frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED})


class JobNotFound(LookupError):
    """指定された ID のジョブが存在しない"""


class JobCancelled(RuntimeError):
    """キャンセルされたジョブの処理を続けようとした"""


@dataclass(frozen=True)
class Job:
    """1 件のジョブの状態一式"""

    id: str
    kind: str
    state: JobState
    payload: dict[str, Any]
    current: int
    total: int
    message: str
    result: Any | None
    error: str | None
    created_at: str
    updated_at: str


ProgressReporter = Callable[..., None]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    current INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs (created_at DESC);
"""


def _now() -> str:
    """記録用の時刻。並べ替えできるよう UTC の ISO 8601 で持つ"""
    return datetime.now(UTC).isoformat()


class JobStore:
    """ジョブの永続化と実行を担う。

    サイドカーが再起動しても履歴を失わないよう SQLite に置く。書き込みは
    ワーカースレッドからも来るためロックで直列化する。
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.executescript(_SCHEMA)
            self._connection.commit()
            # 前回の異常終了で running のまま残ったものを畳む
            self._connection.execute(
                "UPDATE jobs SET state = ?, error = ?, updated_at = ?"
                " WHERE state IN (?, ?)",
                (
                    JobState.FAILED.value,
                    "サイドカーが終了したため中断されました",
                    _now(),
                    JobState.QUEUED.value,
                    JobState.RUNNING.value,
                ),
            )
            self._connection.commit()

    def close(self) -> None:
        """接続を閉じる"""
        with self._lock:
            self._connection.close()

    def submit(self, kind: str, payload: dict[str, Any]) -> str:
        """ジョブを登録し、その ID を返す"""
        job_id = uuid.uuid4().hex
        timestamp = _now()
        with self._lock:
            self._connection.execute(
                "INSERT INTO jobs (id, kind, state, payload, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job_id,
                    kind,
                    JobState.QUEUED.value,
                    json.dumps(payload, ensure_ascii=False),
                    timestamp,
                    timestamp,
                ),
            )
            self._connection.commit()
        return job_id

    def get(self, job_id: str) -> Job:
        """ジョブを 1 件取得する"""
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise JobNotFound(job_id)
        return _to_job(row)

    def list_jobs(self, limit: int = 50) -> list[Job]:
        """新しい順にジョブを並べる"""
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_to_job(row) for row in rows]

    def cancel(self, job_id: str) -> None:
        """キャンセルを要求する。実行中なら次の進捗報告で止まる"""
        with self._lock:
            row = self._connection.execute(
                "SELECT state FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise JobNotFound(job_id)
            if JobState(row["state"]) in TERMINAL_STATES:
                return
            self._update(job_id, state=JobState.CANCELLED)

    def run(self, job_id: str, work: Callable[[ProgressReporter], Any]) -> None:
        """ジョブを実行し、結果と失敗理由を記録する。

        `work` には進捗報告用の関数を渡す。キャンセル済みのジョブで報告すると
        `JobCancelled` が送出され、処理はそこで打ち切られる。
        """
        if self._state_of(job_id) is JobState.CANCELLED:
            raise JobCancelled(job_id)
        self._update(job_id, state=JobState.RUNNING)

        def report(current: int = 0, total: int = 0, message: str = "") -> None:
            if self._state_of(job_id) is JobState.CANCELLED:
                raise JobCancelled(job_id)
            self._update(job_id, current=current, total=total, message=message)

        try:
            result = work(report)
        except JobCancelled:
            logger.info("ジョブがキャンセルされました: %s", job_id)
            raise
        except Exception as error:  # noqa: BLE001 - 失敗理由を残して次へ進む
            logger.exception("ジョブが失敗しました: %s", job_id)
            self._update(job_id, state=JobState.FAILED, error=str(error))
            return

        if self._state_of(job_id) is JobState.CANCELLED:
            return
        self._update(job_id, state=JobState.SUCCEEDED, result=result)

    def _state_of(self, job_id: str) -> JobState:
        with self._lock:
            row = self._connection.execute(
                "SELECT state FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise JobNotFound(job_id)
        return JobState(row["state"])

    def _update(self, job_id: str, **fields: Any) -> None:
        """指定された列だけを書き換える"""
        assignments = ["updated_at = ?"]
        values: list[Any] = [_now()]
        for column, value in fields.items():
            assignments.append(f"{column} = ?")
            if isinstance(value, JobState):
                values.append(value.value)
            elif column == "result":
                values.append(json.dumps(value, ensure_ascii=False))
            else:
                values.append(value)
        values.append(job_id)
        with self._lock:
            self._connection.execute(
                f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?", values
            )
            self._connection.commit()


def _to_job(row: sqlite3.Row) -> Job:
    """SQLite の行を Job に変換する"""
    return Job(
        id=row["id"],
        kind=row["kind"],
        state=JobState(row["state"]),
        payload=json.loads(row["payload"]),
        current=row["current"],
        total=row["total"],
        message=row["message"],
        result=json.loads(row["result"]) if row["result"] is not None else None,
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
