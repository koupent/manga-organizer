"""表紙を加工するジョブの、依頼の形と中身。

加工は ZIP を書き直すので要求の中では終わらない。整理・解析・見開き割りと
同じくジョブにして、受け付けだけを即返す。

依頼の形（``CoverRequest``）を中身と同じところに置いてあるのは、``split`` と
``crop`` と ``rotate`` の適用順という 1 つの決まりを、受け取る側と適用する側で
分けて持たないため。経路（``POST /api/jobs/cover``）は ``app.py``。
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_api.thumbnails import ThumbnailCache
from manga_core.cover_editor import (
    CoverEditError,
    CoverTransform,
    apply_to_archive,
)


class CoverRequest(BaseModel):
    """表紙加工の依頼。分割 → 切り抜き → 回転の順に適用される"""

    archive: str = Field(description="対象アーカイブの絶対パス")
    name: str = Field(description="加工するページ名（通常は先頭）")
    split: str | None = Field(
        default=None, description="見開きの残す側（left / right）"
    )
    crop: tuple[int, int, int, int] | None = Field(
        default=None, description="切り抜き範囲 (left, upper, right, lower)"
    )
    rotate: int = Field(default=0, description="回転角。90 度単位")
    make_first: bool = Field(
        default=False,
        description="加工した 1 枚を先頭ページ（サムネイル）へ移すかどうか",
    )
    from_original: bool = Field(
        default=False,
        description=(
            "加工前の画像を対象にするかどうか。"
            "立てると crop は加工前の画像の画素で解釈される"
        ),
    )


def cover_work(
    path: Path, request: CoverRequest, thumbnails: ThumbnailCache
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """表紙加工ジョブの中身を組み立てる"""

    def work(report: ProgressReporter) -> dict[str, Any]:
        report(current=0, total=1, message="加工中")
        try:
            result = apply_to_archive(
                path,
                request.name,
                CoverTransform(
                    split=request.split, crop=request.crop, rotate=request.rotate
                ),
                make_first=request.make_first,
                from_original=request.from_original,
            )
        except CoverEditError as error:
            raise RuntimeError(str(error)) from error
        thumbnails.discard(str(path))
        report(current=1, total=1, message="完了")
        return {
            "name": result.name,
            "width": result.width,
            "height": result.height,
            "renamed": result.renamed,
        }

    return work
