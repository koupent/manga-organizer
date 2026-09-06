"""ページを並べ替えるジョブの、依頼の形と中身。

並べ替えは連番を振り直すので ZIP を丸ごと書き直す。数百枚の本では要求の中で
終わらないため、ほかの重い操作と同じくジョブにして受け付けだけを即返す。

経路（``POST /api/jobs/reorder``）は ``app.py``。
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_api.thumbnails import ThumbnailCache
from manga_core.page_reorder import ZipPageEditor


class ReorderRequest(BaseModel):
    """ページ並べ替えの依頼"""

    archive: str = Field(description="対象アーカイブの絶対パス")
    order: list[str] = Field(description="並べ替え後のページ名（先頭が 1 ページ目）")


def reorder_work(
    path: Path, request: ReorderRequest, thumbnails: ThumbnailCache
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """並べ替えジョブの中身を組み立てる"""

    def work(report: ProgressReporter) -> dict[str, Any]:
        editor = ZipPageEditor(path)
        try:
            result = editor.apply_order(
                request.order,
                progress=lambda current, total: report(
                    current=current, total=total, message="書き換え中"
                ),
            )
        finally:
            editor.close()
        thumbnails.discard(str(path))
        return {
            "changed": result.changed,
            "pageCount": result.page_count,
            "renamedCount": result.renamed_count,
            "timesRestored": result.times_restored,
        }

    return work
