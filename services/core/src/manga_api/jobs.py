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
CREATE TABLE IF NOT EXISTS job_logs (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
);
"""

# 保存する行数。整理は 1 冊ごとに数行出るため、この程度あれば足りる。
# 実行中に差し替えられるよう、参照はすべて呼び出し時に行う
MAX_LOG_LINES = 500


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

    def prune_finished(self, kind: str) -> None:
        """終わっている同じ種類のジョブを、記録ごと落とす。

        解析は投入の中身が変わるたびに走り直し、1 件ずつ入れ物と本の一覧を
        result に抱える。履歴を読む画面は無いので、残しても増え続けるだけに
        なる。走っているものは消さない。消すと、そのワーカーが書き戻す先を
        失う。

        ただし「終わっている」は行の状態のことで、ワーカーが止まったことでは
        ない。キャンセルはワーカーが気づくより先に行を終わりの状態にするので、
        止めた直後の解析はここで消えうる。書き戻す先を失ったワーカーの
        始末は ``_read_state`` を見ること。
        """
        unfinished = (JobState.QUEUED.value, JobState.RUNNING.value)
        with self._lock:
            self._connection.execute(
                "DELETE FROM job_logs WHERE job_id IN"
                " (SELECT id FROM jobs WHERE kind = ? AND state NOT IN (?, ?))",
                (kind, *unfinished),
            )
            self._connection.execute(
                "DELETE FROM jobs WHERE kind = ? AND state NOT IN (?, ?)",
                (kind, *unfinished),
            )
            self._connection.commit()

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

        報告は「進捗（何件目か）」「ログ 1 行」「途中経過（result）」の 3 つの
        用途を兼ねる。用が無い引数を省いた呼び出しは、省いた分を現在値のまま
        保つ。0 や None で上書きすると、ログだけを出したい報告が進捗を 0 に
        戻し続けたり、進捗だけの報告が途中経過を消したりする。
        """
        if self._state_of(job_id) is JobState.CANCELLED:
            raise JobCancelled(job_id)
        self._update(job_id, state=JobState.RUNNING)

        def report(
            current: int | None = None,
            total: int | None = None,
            message: str = "",
            result: Any | None = None,
        ) -> None:
            self._report(job_id, current, total, message, result)

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

    def log_of(self, job_id: str, limit: int | None = None) -> list[str]:
        """報告された経過を古い順に返す。

        進捗の message は上書きされるため、ポーリング間隔によっては行を
        取りこぼす。原本をここに残しておく。既定の上限は呼び出し時に読む。
        """
        with self._lock:
            rows = self._connection.execute(
                "SELECT message FROM job_logs WHERE job_id = ?"
                " ORDER BY seq DESC LIMIT ?",
                (job_id, MAX_LOG_LINES if limit is None else limit),
            ).fetchall()
        return [row["message"] for row in reversed(rows)]

    def _report(
        self,
        job_id: str,
        current: int | None,
        total: int | None,
        message: str,
        result: Any | None = None,
    ) -> None:
        """進捗・ログ・途中経過を 1 度のロックとトランザクションで書く。

        別々に書くと、進捗だけ進んでログが残らない状態や、「件数は 2 冊目な
        のに中身は 1 冊目まで」という状態が途中で見えてしまう。キャンセルの
        確認も同じロックの中で、書き込みより先に行う。判定と書き込みの間に
        状態が変わると、止めた後の途中経過まで書かれてしまう。

        current と total が None の報告は「ログを 1 行足すだけ」を意味する。
        整理は 1 件につき数行のログを出すので、ここで件数を書きに行くと、
        設定された直後の進捗をログが 0 に戻し続けてしまう。result も同じで、
        渡されたときだけ書く。渡されない報告で消すと、解析が育てている
        途中経過が進捗の報告 1 つで白紙に戻る。
        """
        fields: dict[str, Any] = {"message": message}
        if current is not None:
            fields["current"] = current
        if total is not None:
            fields["total"] = total
        if result is not None:
            fields["result"] = result
        with self._lock:
            if self._read_state(job_id) is JobState.CANCELLED:
                raise JobCancelled(job_id)
            self._write_fields(job_id, **fields)
            if message:
                self._write_log(job_id, message)
            self._connection.commit()

    def _write_log(self, job_id: str, message: str) -> None:
        """ログを 1 行足し、そのジョブの古い行を上限まで削る。

        追加だけでは行が際限なく増える。同じトランザクションで削ることで、
        上限を超えた状態を他の読み手に見せない。
        """
        self._connection.execute(
            "INSERT INTO job_logs (job_id, seq, message)"
            " SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM job_logs"
            " WHERE job_id = ?",
            (job_id, message, job_id),
        )
        # 新しい行を残し、上限からあふれた古い行を落とす
        self._connection.execute(
            "DELETE FROM job_logs WHERE job_id = ? AND seq <="
            " (SELECT MAX(seq) FROM job_logs WHERE job_id = ?) - ?",
            (job_id, job_id, MAX_LOG_LINES),
        )

    def _state_of(self, job_id: str) -> JobState:
        with self._lock:
            return self._read_state(job_id)

    def _read_state(self, job_id: str) -> JobState:
        """ワーカーから見た状態を読む。ロックは呼び出し側で取る。

        行が消えていたらキャンセル扱いにする。解析は投入の中身が変わるたびに
        走り直し、新しい投入はまず終わっている解析を ``prune_finished`` で
        落とす。キャンセルはワーカーが気づくより先に行を終わりの状態にするので、
        「まだ走っているのに行はもう無い」は例外ではなく普通に起きる。ここで
        ``JobNotFound`` を投げると、利用者は投入を編集しただけなのに
        「解析が失敗しました」という記録と例外を受け取ることになる。
        """
        row = self._connection.execute(
            "SELECT state FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return JobState.CANCELLED
        return JobState(row["state"])

    def _update(self, job_id: str, **fields: Any) -> None:
        """指定された列だけを書き換えて確定する"""
        with self._lock:
            self._write_fields(job_id, **fields)
            self._connection.commit()

    def _write_fields(self, job_id: str, **fields: Any) -> None:
        """指定された列だけを書き換える。ロックと確定は呼び出し側で行う"""
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
        self._connection.execute(
            f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?", values
        )


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
