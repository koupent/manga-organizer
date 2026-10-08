"""共通余白の走査・切り取りジョブ。"""

import io
from pathlib import Path

from PIL import Image
from pydantic import BaseModel, Field

from manga_api.split_job import archive_token, refuse_stale_token
from manga_core.page_margins import common_margins, trim_pages, white_margins
from manga_core.page_reorder import ZipPageEditor


class MarginScanRequest(BaseModel):
    archive: str


class MarginRequest(MarginScanRequest):
    token: str
    names: list[str] = Field(min_length=1)
    margins: tuple[float, float, float, float]


def scan_work(path: Path):
    def work(report):
        editor = ZipPageEditor(path, include_deleted=True)
        try:
            token = archive_token(editor.pages)
            pages = []
            visible = [p for p in editor.pages if not p.deleted]
            for index, page in enumerate(visible):
                data = editor.read_entry(page.name)
                with Image.open(io.BytesIO(data)) as image:
                    width, height = image.size
                pages.append(
                    {
                        "name": page.name,
                        "width": width,
                        "height": height,
                        "margins": white_margins(data),
                    }
                )
                report(current=index + 1, total=len(visible))
            return {
                "token": token,
                "pages": pages,
                "margins": common_margins([p["margins"] for p in pages]),
            }
        finally:
            editor.close()

    return work


def confirm_work(path: Path, request: MarginRequest, thumbnails):
    def work(report):
        editor = ZipPageEditor(path, include_deleted=True)
        try:
            refuse_stale_token(editor.pages, request.token)
        finally:
            editor.close()
        count = trim_pages(
            path,
            request.names,
            request.margins,
            progress=lambda current, total: report(current=current, total=total),
        )
        thumbnails.discard(str(path))
        return {"trimmed_count": count}

    return work
