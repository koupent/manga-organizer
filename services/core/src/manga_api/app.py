"""サイドカーの FastAPI アプリ。

Tauri シェル（#22）が子プロセスとして起動し、127.0.0.1 でのみ待ち受ける。
同一 PC 上の他プロセスから操作されないよう、起動ごとに発行する使い捨て
トークンを全経路で必須にする。
"""

import logging
import secrets
import threading
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from manga_api import thumbnails
from manga_api.jobs import Job, JobNotFound, JobStore
from manga_core.page_reorder import PageReorderError, ZipPageEditor

logger = logging.getLogger(__name__)

TITLE = "Manga Organizer サイドカー"
# 外部からは触らせない。Tauri シェルと同一ホスト内でのみ使う
HOST = "127.0.0.1"


class ReorderRequest(BaseModel):
    """ページ並べ替えの依頼"""

    archive: str = Field(description="対象アーカイブの絶対パス")
    order: list[str] = Field(description="並べ替え後のページ名（先頭が 1 ページ目）")


class OrganizeRequest(BaseModel):
    """アーカイブ整理の依頼"""

    archives: list[str] = Field(description="整理対象アーカイブの絶対パス")
    output_directory: str = Field(description="出力先ディレクトリ")
    title: str = Field(default="", description="作品名")
    author: str = Field(default="", description="著者名")
    keep_originals: bool = Field(default=True, description="元ファイルを残すか")


class JobAccepted(BaseModel):
    """ジョブの受付結果"""

    id: str


class JobView(BaseModel):
    """ジョブの状態"""

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


class JobList(BaseModel):
    """ジョブ一覧"""

    jobs: list[JobView]


class PageView(BaseModel):
    """ページ 1 枚の情報"""

    name: str
    size: int
    modified: str


class PageList(BaseModel):
    """アーカイブ内のページ一覧"""

    archive: str
    pages: list[PageView]
    thumbnail_widths: list[int]


class HealthView(BaseModel):
    """疎通確認"""

    status: str
    version: str


def _to_view(job: Job) -> JobView:
    """ジョブを応答用の形へ直す"""
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


def create_app(
    state_dir: Path | None = None,
    token: str | None = None,
    allowed_roots: list[Path] | None = None,
    run_jobs_inline: bool = False,
) -> FastAPI:
    """サイドカーのアプリを組み立てる。

    `allowed_roots` を与えると、その配下のアーカイブしか読み書きしない。
    省略時は制限しないが、それでもトークンは必須。

    `run_jobs_inline` はジョブをワーカースレッドではなく同期実行する。
    結果を確定させたいテスト用で、通常の起動では使わない。
    """
    resolved_state = Path(state_dir or Path.home() / ".manga-organizer")
    app = FastAPI(title=TITLE, version="0.1.0")
    app.state.token = token or secrets.token_urlsafe(24)
    app.state.jobs = JobStore(resolved_state / "jobs.db")
    app.state.thumbnails = thumbnails.ThumbnailCache()
    app.state.allowed_roots = [Path(r).resolve() for r in (allowed_roots or [])]
    app.state.run_jobs_inline = run_jobs_inline

    def require_token(
        request: Request,
        token: Annotated[str, Query(description="使い捨てトークン")] = "",
    ) -> None:
        """全経路で使い捨てトークンを検証する"""
        if not secrets.compare_digest(token, request.app.state.token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token"
            )

    guarded = [Depends(require_token)]

    def resolve_archive(raw: str) -> Path:
        """受け取ったパスを検証して解決する"""
        path = Path(raw).resolve()
        roots = app.state.allowed_roots
        if roots and not any(path.is_relative_to(root) for root in roots):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="対象外のディレクトリです",
            )
        if not path.is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        return path

    def open_editor(raw: str) -> ZipPageEditor:
        """アーカイブを開く。開けない理由はそのまま伝える"""
        path = resolve_archive(raw)
        try:
            return ZipPageEditor(path)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
            ) from error

    @app.get("/api/health", dependencies=guarded, response_model=HealthView)
    def health() -> HealthView:
        """サイドカーが応答することの確認"""
        return HealthView(status="ok", version=app.version)

    @app.get("/api/pages", dependencies=guarded, response_model=PageList)
    def list_pages(archive: str) -> PageList:
        """アーカイブ内のページを viewer と同じ並びで返す"""
        editor = open_editor(archive)
        try:
            return PageList(
                archive=str(editor.zip_path),
                pages=[
                    PageView(name=p.name, size=p.size, modified=p.modified)
                    for p in editor.pages
                ],
                thumbnail_widths=list(thumbnails.WIDTHS),
            )
        finally:
            editor.close()

    @app.get("/api/thumb", dependencies=guarded, response_class=Response)
    def thumbnail(archive: str, name: str, width: int = 240) -> Response:
        """ページのサムネイルを返す"""
        editor = open_editor(archive)
        resolved = thumbnails.nearest_width(width)
        try:
            body = app.state.thumbnails.get_or_create(
                (str(editor.zip_path), name, resolved),
                lambda: thumbnails.render(editor.read_entry(name), resolved),
            )
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except OSError as error:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"画像を読めません: {error}",
            ) from error
        finally:
            editor.close()
        return Response(
            content=body,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "max-age=3600",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/jobs", dependencies=guarded, response_model=JobList)
    def list_jobs() -> JobList:
        """新しい順にジョブを並べる"""
        return JobList(jobs=[_to_view(job) for job in app.state.jobs.list_jobs()])

    @app.get("/api/jobs/{job_id}", dependencies=guarded, response_model=JobView)
    def get_job(job_id: str) -> JobView:
        """ジョブ 1 件の状態を返す"""
        try:
            return _to_view(app.state.jobs.get(job_id))
        except JobNotFound as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="ジョブが見つかりません"
            ) from error

    @app.post("/api/jobs/{job_id}/cancel", dependencies=guarded, status_code=202)
    def cancel_job(job_id: str) -> JobAccepted:
        """実行中のジョブにキャンセルを要求する"""
        try:
            app.state.jobs.cancel(job_id)
        except JobNotFound as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="ジョブが見つかりません"
            ) from error
        return JobAccepted(id=job_id)

    @app.post(
        "/api/jobs/reorder",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_reorder(request: ReorderRequest) -> JobAccepted:
        """ページ並べ替えをジョブとして投入する"""
        path = resolve_archive(request.archive)
        job_id = app.state.jobs.submit(
            "reorder", {"archive": str(path), "pages": len(request.order)}
        )

        def work(report):
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
            app.state.thumbnails.discard(str(path))
            return {
                "changed": result.changed,
                "pageCount": result.page_count,
                "renamedCount": result.renamed_count,
                "timesRestored": result.times_restored,
            }

        _start(app, job_id, work)
        return JobAccepted(id=job_id)

    @app.post(
        "/api/jobs/organize",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_organize(request: OrganizeRequest) -> JobAccepted:
        """アーカイブの整理をジョブとして投入する"""
        archives = [resolve_archive(raw) for raw in request.archives]
        job_id = app.state.jobs.submit(
            "organize",
            {
                "archives": [str(a) for a in archives],
                "output_directory": request.output_directory,
                "title": request.title,
                "author": request.author,
            },
        )

        def work(report):
            # 取り込みが重いので、整理を投入したときだけ読み込む
            from manga_core.file_organizer import FileOrganizer

            organizer = FileOrganizer(
                output_directory=Path(request.output_directory),
                keep_originals=request.keep_originals,
                log_callback=lambda message: report(message=message),
            )
            organizer.set_manga_info(author=request.author, title=request.title)
            produced: list[str] = []
            for index, archive in enumerate(archives, 1):
                report(current=index, total=len(archives), message=archive.name)
                for result in organizer.process_single_archive(archive):
                    if result.success and result.output_path:
                        produced.append(str(result.output_path))
            return {"produced": produced}

        _start(app, job_id, work)
        return JobAccepted(id=job_id)

    return app


def _start(app: FastAPI, job_id: str, work) -> None:
    """ジョブを動かす。通常はワーカースレッド、テストでは同期実行する"""
    if app.state.run_jobs_inline:
        _run_quietly(app, job_id, work)
        return
    thread = threading.Thread(
        target=_run_quietly, args=(app, job_id, work), name=f"job-{job_id}", daemon=True
    )
    thread.start()


def _run_quietly(app: FastAPI, job_id: str, work) -> None:
    """ワーカースレッドの例外でプロセスを落とさない"""
    try:
        app.state.jobs.run(job_id, work)
    except Exception:  # noqa: BLE001 - 状態は JobStore が記録済み
        logger.exception("ジョブが失敗しました: %s", job_id)
