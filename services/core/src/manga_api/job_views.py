"""ジョブの状態を画面へ渡す形（``GET /api/jobs`` と ``GET /api/jobs/{job_id}``）。

一覧と詳細で持ち物を分けてある。ログを返すのは詳細だけで、一覧にも log を
持たせると常に空配列が載り、「ログが無い」と「一覧では取らない」を画面から
区別できなくなる。その分け方をここに閉じ込める。

ジョブの記録そのものは ``jobs``、走らせ方は ``job_runner``。
"""

from typing import Any

from pydantic import BaseModel

from manga_api.jobs import Job


class JobAccepted(BaseModel):
    """ジョブの受付結果"""

    id: str


class JobView(BaseModel):
    """ジョブの状態。一覧はログを読まないので log を持たない"""

    id: str
    kind: str
    state: str
    current: int
    total: int
    message: str
    result: Any | None = None
    error: str | None = None
    created_at: str
    updated_at: str


class JobDetail(JobView):
    """ジョブ 1 件の詳細。

    ログを返すのはここだけにする。一覧でも log を持つと、常に空配列が
    載ってしまい「ログが無い」と「一覧では取らない」を区別できない。
    """

    log: list[str]


class JobList(BaseModel):
    """ジョブ一覧"""

    jobs: list[JobView]


def to_view(job: Job) -> JobView:
    """ジョブを一覧用の形へ直す"""
    return JobView(
        id=job.id,
        kind=job.kind,
        state=job.state.value,
        current=job.current,
        total=job.total,
        message=job.message,
        result=job.result,
        error=job.error,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


def to_detail(job: Job, log: list[str]) -> JobDetail:
    """ジョブを詳細用の形へ直す"""
    return JobDetail(**to_view(job).model_dump(), log=log)
