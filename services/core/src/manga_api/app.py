"""サイドカーの FastAPI アプリ。

Tauri シェル（#22）が子プロセスとして起動し、127.0.0.1 でのみ待ち受ける。
同一 PC 上の他プロセスから操作されないよう、起動ごとに発行する使い捨て
トークンを全経路で必須にする。
"""

import io
import logging
import secrets
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field
from send2trash import send2trash

from manga_api import thumbnails
from manga_api.analysis_job import AnalyzeRequest, analysis_work
from manga_api.cover_job import CoverRequest, cover_work
from manga_api.cover_views import CoverView, describe_original
from manga_api.drop_scan import walk_shallow_first
from manga_api.http_images import (
    THUMBNAIL_MEDIA_TYPE,
    image_response,
    media_type_of,
)
from manga_api.job_runner import start_job
from manga_api.job_views import (
    JobAccepted,
    JobDetail,
    JobList,
    to_detail,
    to_view,
)
from manga_api.jobs import JobNotFound, JobStore
from manga_api.library_import import import_into_library
from manga_api.library_views import (
    AuthorCandidate,
    LibraryEntries,
    LibraryEntry,
    LibraryImportRequest,
    LibraryImportResult,
    Suggestion,
    SuggestRequest,
)
from manga_api.organize_job import (
    OrganizeRequest,
    organize_work,
    source_key,
    wanted_books,
)
from manga_api.output_roots import ChosenOutputRoots
from manga_api.paths import PathGuard
from manga_api.reorder_job import ReorderRequest, reorder_work
from manga_api.split_job import (
    SplitConfirmRequest,
    SplitScanRequest,
    confirm_work,
    intent_rows,
    refuse_stale_token,
    scan_work,
)
from manga_core.cover_editor import COVER_ASPECT_RATIO, is_spread
from manga_core.input_expander import ARCHIVE_SUFFIXES
from manga_core.manga_database import MangaDatabase
from manga_core.naming import natural_sort_key
from manga_core.original_store import (
    OriginalStoreError,
    find_original,
    read_original,
    recorded_edits,
)
from manga_core.page_reorder import PageReorderError

logger = logging.getLogger(__name__)

TITLE = "Manga Organizer サイドカー"
# 外部からは触らせない。Tauri シェルと同一ホスト内でのみ使う
HOST = "127.0.0.1"

# Tauri の WebView と、開発・検証で使う Vite の dev server
DEFAULT_ALLOWED_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "tauri://localhost",
    "http://tauri.localhost",
)


class OutputRootRequest(BaseModel):
    """出力先として選んだ場所を伝える依頼"""

    directory: str = Field(description="利用者が選んだ出力先の絶対パス")


class OutputRootView(BaseModel):
    """覚えた出力先。

    辿り直した形で返す。自由入力なので `.../整理後/../整理後` のような書き方も
    届く。画面が「どこを覚えたか」を確かめられるようにするため。
    """

    directory: str = Field(description="覚えた出力先（辿り直した絶対パス）")


class TrashRequest(BaseModel):
    """一覧から消すファイル（#164）"""

    path: str = Field(description="ごみ箱へ移すファイルの絶対パス")


class TrashedView(BaseModel):
    """ごみ箱へ移したファイル"""

    path: str = Field(description="ごみ箱へ移したファイル（辿り直した絶対パス）")


class BrowseEntry(BaseModel):
    """ファイル選択に出す 1 項目"""

    name: str
    path: str
    is_directory: bool


class BrowseResult(BaseModel):
    """辿っている場所と、その中身"""

    path: str
    parent: str | None = None
    entries: list[BrowseEntry]


class DroppedFile(BaseModel):
    """ドロップされたファイルの手がかり"""

    name: str
    size: int = 0


class ResolveRequest(BaseModel):
    """ドロップされたものを実パスに結びつける依頼"""

    files: list[DroppedFile]


class ResolveResult(BaseModel):
    """見つかったもの、見つからなかったもの、絞りきれなかったもの"""

    resolved: list[str]
    unresolved: list[str]
    ambiguous: list[str]
    searched_roots: list[str] = []


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


class EditsRequest(BaseModel):
    """編集済みの種類を知りたい本の一覧（#143）"""

    paths: list[str] = Field(description="アーカイブの絶対パス")


class EditsView(BaseModel):
    """本ごとの編集済みの種類（#143）"""

    edits: dict[str, list[str]] = Field(
        description=(
            "受け取ったパスごとの編集の種類（thumbnail / reorder / split）。"
            "記録の無い本・読めない本は空"
        )
    )


class HealthView(BaseModel):
    """疎通確認"""

    status: str
    version: str


def create_app(
    state_dir: Path | None = None,
    token: str | None = None,
    allowed_roots: list[Path] | None = None,
    allowed_origins: list[str] | None = None,
    run_jobs_inline: bool = False,
) -> FastAPI:
    """サイドカーのアプリを組み立てる。

    `allowed_roots` を与えると、その配下のアーカイブしか読まない。書き出す先は
    そこに加えて、この起動で利用者が選んだ場所（`POST /api/output-roots`）も
    使える。省略時は制限しないが、それでもトークンは必須。

    `run_jobs_inline` はジョブをワーカースレッドではなく同期実行する。
    結果を確定させたいテスト用で、通常の起動では使わない。
    """
    resolved_state = Path(state_dir or Path.home() / ".manga-organizer")
    app = FastAPI(title=TITLE, version="0.1.0")
    app.state.token = token or secrets.token_urlsafe(24)
    app.state.jobs = JobStore(resolved_state / "jobs.db")
    app.state.thumbnails = thumbnails.ThumbnailCache()
    app.state.allowed_roots = [Path(r).resolve() for r in (allowed_roots or [])]
    # 読む側の守り。app.state と同じ一覧を指させる。写しを持たせると、
    # 許可を書き換えたときに守りと状態が別々の一覧を見ることになる
    path_guard = PathGuard(app.state.allowed_roots)
    # 書き出す先の覚え。allowed_roots とは別に持つ。ここへ混ぜると、出力先を
    # 選んだだけでその場所を読む入口まで開いてしまう
    app.state.chosen_output_roots = ChosenOutputRoots()
    app.state.run_jobs_inline = run_jobs_inline
    app.state.database_path = resolved_state / "manga.db"

    # WebView は別オリジンから呼ぶ。ブラウザで開発・検証する場合も同じ。
    # 待ち受けは 127.0.0.1 のみで、実際の防御はトークンが担う。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins or DEFAULT_ALLOWED_ORIGINS,
        # 削除も使うため DELETE を含める。抜けているとプリフライトで弾かれる
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    def require_token(
        request: Request,
        token: Annotated[str, Query(description="使い捨てトークン")] = "",
    ) -> None:
        """全経路で使い捨てトークンを検証する"""
        # compare_digest は非 ASCII の str を受け付けない。
        # バイト列で比べれば、どんなトークンでも安全に判定できる
        expected = request.app.state.token
        if not secrets.compare_digest(token.encode(), expected.encode()):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token"
            )

    guarded = [Depends(require_token)]

    def open_database() -> MangaDatabase:
        """辞書をリクエストごとに開く。

        MangaDatabase は接続を保持するが check_same_thread を既定のままに
        しているため、スレッドをまたいで使えない。単一スレッドの Tkinter
        では問題にならなかったが、ここでは要求ごとに開いて閉じる。

        開いた経路が ``finally`` で必ず閉じること。終了処理（``__del__``）は
        当てにしない。参照が例外の履歴などに掴まれれば走らず、別スレッドで
        走れば sqlite3 が「SQLite objects created in a thread can only be used
        in that same thread」を投げる。``__del__`` の中の例外は握り潰される
        ので、閉じ損ねたことは誰にも見えないまま接続がプロセスの終わりまで
        残り、Windows では辞書ファイルが掴まれたままになる（#90）。
        """
        return MangaDatabase(app.state.database_path)

    def resolve_output_directory(raw: str) -> Path:
        """書き出す先を検証して解決する。

        読む側と違い、許可された場所の外も通す。ただし利用者がこの起動で
        「ここを出力先にする」と選んだ場所（とその配下）に限る。蔵書を別の
        ドライブや NAS へ整理する道を残しつつ、トークンを握った呼び出しが
        1 回の依頼だけで好きな場所へ書き出せる状態を無くすため。

        まだ無いフォルダも通す。出力先は整理のときに作られる。
        """
        path = Path(raw).resolve()
        if path_guard.within_allowed(path) or app.state.chosen_output_roots.allows(
            path
        ):
            return path
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="選ばれていない出力先です。出力先を選び直してください",
        )

    @app.get("/api/health", dependencies=guarded, response_model=HealthView)
    def health() -> HealthView:
        """サイドカーが応答することの確認"""
        return HealthView(status="ok", version=app.version)

    @app.get("/api/pages", dependencies=guarded, response_model=PageList)
    def list_pages(archive: str) -> PageList:
        """アーカイブ内のページを viewer と同じ並びで返す"""
        editor = path_guard.open_editor(archive)
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
    def thumbnail(
        request: Request, archive: str, name: str, width: int = 240
    ) -> Response:
        """ページのサムネイルを返す"""
        editor = path_guard.open_editor(archive)
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
        return image_response(request, body, THUMBNAIL_MEDIA_TYPE)

    @app.post("/api/edits", dependencies=guarded, response_model=EditsView)
    def edits(request: EditsRequest) -> EditsView:
        """本ごとに、サムネイル・並べ替え・分割結合のどれを施したかを返す。

        整理の画面が、近道のアイコンに編集済みの印を出すのに使う（#143）。
        読むのは本の中の記録だけなので、一覧の冊数ぶんまとめて 1 回で返す。
        """
        found: dict[str, list[str]] = {}
        for raw in request.paths:
            path = Path(raw).resolve()
            path_guard.refuse_outside(path)
            found[raw] = list(recorded_edits(path)) if path.is_file() else []
        return EditsView(edits=found)

    @app.post("/api/resolve", dependencies=guarded, response_model=ResolveResult)
    def resolve(request: ResolveRequest) -> ResolveResult:
        """ドロップされたファイルを実パスに結びつける。

        ブラウザは実パスを渡さないが、名前とサイズは分かる。許可された場所の
        中から同じものを探せば、ドロップからでも対象を特定できる。同名が複数
        あってサイズでも絞れない場合は、勝手に選ばず返す。
        """
        roots = app.state.allowed_roots or [Path.home()]
        wanted = {file.name for file in request.files}

        # 走査は浅いところから、要求ごとの上限まで（``drop_scan``）。上限に
        # 阻まれて届かなかったものは、見つからなかったものと同じ扱いになる
        # （docstring に書くと openapi.json の description が動くのでここに）。
        # 走査は 1 回で済ませる。巻数が多いと候補も増える。見つけても打ち切ら
        # ない。同名が他にもあることを知らないまま 1 件目を選ぶと、絞りきれ
        # ない（ambiguous）はずのものを勝手に決めてしまう
        candidates: dict[str, list[Path]] = {name: [] for name in wanted}
        for found in walk_shallow_first(roots):
            if found.name in candidates and found.is_file():
                candidates[found.name].append(found)

        resolved: list[str] = []
        unresolved: list[str] = []
        ambiguous: list[str] = []
        for file in request.files:
            matches = candidates.get(file.name, [])
            if not matches:
                unresolved.append(file.name)
                continue
            if len(matches) > 1 and file.size:
                matches = [
                    m for m in matches if m.stat().st_size == file.size
                ] or matches
            if len(matches) == 1:
                resolved.append(str(matches[0]))
            else:
                ambiguous.append(file.name)
        return ResolveResult(
            resolved=resolved,
            unresolved=unresolved,
            ambiguous=ambiguous,
            searched_roots=[str(root) for root in roots],
        )

    @app.get("/api/browse", dependencies=guarded, response_model=BrowseResult)
    def browse(path: str = "") -> BrowseResult:
        """許可された場所の中を辿る。

        ブラウザはドロップされたファイルの実パスを取得できないため、
        サーバー側で辿って選んでもらう。Tauri ではネイティブのドロップも
        使えるが、同じ画面で両方使えるようにする。
        """
        roots = app.state.allowed_roots
        if not path:
            target = roots[0] if roots else Path.home()
        else:
            target = Path(path).resolve()
            path_guard.refuse_outside(target)
        if not target.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ディレクトリが見つかりません",
            )

        try:
            children = list(target.iterdir())
        except OSError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
            ) from error

        entries: list[BrowseEntry] = []
        for child in children:
            if child.name.startswith("."):
                continue
            if child.is_dir():
                entries.append(
                    BrowseEntry(name=child.name, path=str(child), is_directory=True)
                )
            elif child.suffix.lower() in ARCHIVE_SUFFIXES:
                entries.append(
                    BrowseEntry(name=child.name, path=str(child), is_directory=False)
                )
        # ディレクトリを先に並べる。辿る操作を優先させるため
        entries.sort(
            key=lambda entry: (not entry.is_directory, natural_sort_key(entry.name))
        )

        parent = target.parent
        inside = not roots or any(parent.is_relative_to(root) for root in roots)
        return BrowseResult(
            path=str(target),
            parent=str(parent) if inside and parent != target else None,
            entries=entries,
        )

    @app.get(
        "/api/library/entries", dependencies=guarded, response_model=LibraryEntries
    )
    def list_entries(query: str = "") -> LibraryEntries:
        """タイトルと著者の辞書。query を与えると絞り込む。

        絞り込まないときは全件を返す。画面はこの一覧の完全一致で著者を即座に
        埋め、外れたときだけ外部検索へ回る（元の Tkinter 版も辞書全体を引いて
        いた）。件数で切ると、辞書に入っている作品名でも毎回ネットワークへ出て
        数秒待たされる（#125）。
        """
        database = open_database()
        try:
            pairs = (
                database.search_titles(query, limit=50)
                if query
                # SQLite の LIMIT -1 は上限なし
                else database.get_recent_manga(limit=-1)
            )
        finally:
            database.close()
        return LibraryEntries(
            entries=[
                LibraryEntry(title=title, author=author) for title, author in pairs
            ]
        )

    @app.post("/api/library/entries", dependencies=guarded, response_model=LibraryEntry)
    def save_entry(entry: LibraryEntry) -> LibraryEntry:
        """辞書に記録する。同じタイトルがあれば上書きする"""
        if not entry.title.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="作品名が空です"
            )
        database = open_database()
        try:
            database.save_manga_info(entry.title, entry.author)
        finally:
            database.close()
        return entry

    @app.post(
        "/api/library/import",
        dependencies=guarded,
        response_model=LibraryImportResult,
    )
    def import_entries(request: LibraryImportRequest) -> LibraryImportResult:
        """整理済みの蔵書から拾った対を、まとめて辞書へ取り込む（#73 段階 6）。

        1 件ずつの記録と違い、辞書に無い作品名だけを足す。既にある著者は
        著者が違っても上書きしない。この表は以降のすべての整理で著者欄を
        埋めるので、利用者が手で直した著者を潰すと直した覚えが黙って消える。
        断ったものは食い違いとして返し、画面から見えるようにする。
        """
        database = open_database()
        try:
            return import_into_library(database, request.entries)
        finally:
            database.close()

    @app.delete("/api/library/entries", dependencies=guarded)
    def delete_entry(title: str) -> dict[str, bool]:
        """辞書から取り除く"""
        database = open_database()
        try:
            return {"deleted": bool(database.delete_manga(title))}
        finally:
            database.close()

    app.state.author_fetcher = None

    def author_fetcher():
        """外部検索の取得器。最初に要るときに作り、以後は使い回す。

        要求ごとに作り直すと ``requests.Session`` も毎回新しくなり、DNS・TCP・
        TLS をやり直したうえ、取得器が持つ結果のキャッシュも効かない（#125）。
        元の Tkinter 版も 1 つを使い回していた。
        """
        # 取り込みが重く、ネットワークにも出るので要るときに読み込む
        from manga_core.api_client import MangaMetadataFetcher

        if app.state.author_fetcher is None:
            app.state.author_fetcher = MangaMetadataFetcher()
        return app.state.author_fetcher

    @app.post("/api/library/suggest", dependencies=guarded, response_model=Suggestion)
    def suggest(request: SuggestRequest) -> Suggestion:
        """外部サービスから著者名を補完する。

        ネットワークに出るため失敗しうる。見つからない場合と区別せず、
        空の結果として返して画面を止めない。
        """
        try:
            found = author_fetcher().get_author_candidates(request.title)
        except Exception:  # noqa: BLE001 - 補完は失敗しても処理を続ける
            logger.warning("著者の補完に失敗しました: %s", request.title)
            return Suggestion()
        if not found:
            return Suggestion()
        return Suggestion(
            title=found[0]["title"],
            author=found[0]["author"],
            # 検索側の型に合わせて値を選び直す。辞書をそのまま展開すると
            # 応答の形が変わったときに気づけない
            candidates=[
                AuthorCandidate(
                    title=candidate["title"],
                    author=candidate["author"],
                    source=candidate["source"],
                    similarity=candidate["similarity"],
                )
                for candidate in found
            ],
        )

    @app.get("/api/image", dependencies=guarded, response_class=Response)
    def image(request: Request, archive: str, name: str) -> Response:
        """ページを原寸で返す。拡大表示に使う"""
        editor = path_guard.open_editor(archive)
        try:
            body = editor.read_entry(name)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        finally:
            editor.close()
        return image_response(request, body, media_type_of(name))

    @app.get("/api/original", dependencies=guarded, response_class=Response)
    def original(request: Request, archive: str, name: str) -> Response:
        """いま見ている 1 枚の、加工前の画像そのものを返す。

        求めるのは加工後のページ名だけで、元画像が ZIP のどのエントリに
        入っているかは受け取らない。エントリ名を外から取ると、書き換えられた
        manifest 経由でアーカイブ内の任意のエントリを読ませる道ができる。

        バイト列を /api/cover と分けているのは、画像が JSON に載らないうえ、
        /api/cover は画面を描き直すたびに引かれる軽い経路であってほしいため。
        """
        editor = path_guard.open_editor(archive)
        path = editor.zip_path
        try:
            body = editor.read_entry(name)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        finally:
            editor.close()

        ref = find_original(path, body)
        if ref is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="元画像がありません"
            )
        try:
            data = read_original(path, ref)
        except OriginalStoreError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        return image_response(request, data, media_type_of(ref.entry))

    @app.get("/api/cover", dependencies=guarded, response_model=CoverView)
    def cover(archive: str, name: str | None = None) -> CoverView:
        """サムネイルにする候補 1 枚の状態を返す。name を省くと先頭ページ。

        viewer は縦長 2:3 に中央クロップして描くため、横長だと表紙が
        見えない。UI で加工を促せるよう、見開きかどうかを添える。

        寸法と見開き判定をここで返すのは、UI が切り抜き枠を元画像の画素へ
        写すのに必要だから。画面側で画像から測り直すと、判定の基準が
        サーバーと二重になり、片方だけずれても気づけない。

        元画像の有無も同じ応答に載せる。画面は「どれだけ広い絵を出すか」と
        「枠をどこに置くか」を 1 度に決める。別の入口に分けると、2 回
        問い合わせる間に片方だけ古い値を見た状態が作れてしまう。
        """
        editor = path_guard.open_editor(archive)
        path = editor.zip_path
        try:
            if not editor.pages:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="ページがありません"
                )
            target = name or editor.pages[0].name
            body = editor.read_entry(target)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
            ) from error
        finally:
            editor.close()
        with Image.open(io.BytesIO(body)) as image:
            width, height = image.size
        return CoverView(
            name=target,
            width=width,
            height=height,
            is_spread=is_spread(width, height),
            target_aspect_ratio=COVER_ASPECT_RATIO,
            original=describe_original(path, body),
        )

    @app.post(
        "/api/jobs/cover",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_cover(request: CoverRequest) -> JobAccepted:
        """表紙の加工をジョブとして投入する"""
        path = path_guard.resolve_archive(request.archive)
        job_id = app.state.jobs.submit(
            "cover", {"archive": str(path), "name": request.name}
        )
        start_job(app, job_id, cover_work(path, request, app.state.thumbnails))
        return JobAccepted(id=job_id)

    @app.get("/api/jobs", dependencies=guarded, response_model=JobList)
    def list_jobs() -> JobList:
        """新しい順にジョブを並べる"""
        return JobList(jobs=[to_view(job) for job in app.state.jobs.list_jobs()])

    @app.get("/api/jobs/{job_id}", dependencies=guarded, response_model=JobDetail)
    def get_job(job_id: str) -> JobDetail:
        """ジョブ 1 件の状態を、経過のログとともに返す"""
        try:
            return to_detail(app.state.jobs.get(job_id), app.state.jobs.log_of(job_id))
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
        path = path_guard.resolve_archive(request.archive)
        job_id = app.state.jobs.submit(
            "reorder", {"archive": str(path), "pages": len(request.order)}
        )
        start_job(app, job_id, reorder_work(path, request, app.state.thumbnails))
        return JobAccepted(id=job_id)

    @app.post(
        "/api/jobs/split-scan",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_split_scan(request: SplitScanRequest) -> JobAccepted:
        """見開きを割る画面に並べる行を、ジョブとして走査する（#58 段階 2）。

        数百枚の ZIP を 1 枚ずつ開くので要求の中では終わらない。パスの検証と
        「そもそも開けるか」は投入のこの時点で済ませる。ジョブを作ってから
        失敗させると、許可の外を指したことが「失敗したジョブ」としてしか
        残らず、画面は投入できたと思ってしまう。
        """
        editor = path_guard.open_editor(request.archive)
        path = editor.zip_path
        editor.close()
        job_id = app.state.jobs.submit("split-scan", {"archive": str(path)})
        start_job(app, job_id, scan_work(path))
        return JobAccepted(id=job_id)

    @app.post(
        "/api/jobs/split",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_split(request: SplitConfirmRequest) -> JobAccepted:
        """割った結果を書き込むジョブを投入する（#58 段階 2）。

        断るものは、すべてジョブを作る前に断る。ZIP を丸ごと書き直す処理
        なので、受け付けてから失敗させると、画面は割れたつもりで先へ進む。
        見るのは順に、許可された場所か・走査したときから本が動いていないか
        （印）・行の名前を並べたものがいまのページ順と一致するか。どこで
        断ってもアーカイブは 1 バイトも変わらない。
        """
        editor = path_guard.open_editor(request.archive)
        path = editor.zip_path
        try:
            pages = editor.pages
        finally:
            editor.close()
        refuse_stale_token(pages, request.token)
        rows = intent_rows(pages, request.rows)
        job_id = app.state.jobs.submit(
            "split", {"archive": str(path), "rows": len(rows)}
        )
        start_job(app, job_id, confirm_work(path, rows, app.state.thumbnails))
        return JobAccepted(id=job_id)

    @app.post(
        "/api/jobs/analyze",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_analysis(request: AnalyzeRequest) -> JobAccepted | JSONResponse:
        """展開せずに目次を読み、出来上がる本を実行前に並べる（#70）。

        利用者はチェックを外す前に「何が出来るのか」を見る必要がある。
        整理と同じ展開・同じ巻数判定を通すので、ここで見えた名前が
        そのまま実行の結果になる。

        走査と目次読みはジョブに任せ、ここでは受け付けたことだけを返す。
        ただしパスの検証は投入のこの時点で済ませる。ジョブを作ってから
        失敗させると、許可の外を指したことが「失敗したジョブ」としてしか
        残らず、画面は投入できたと思ってしまう。
        """
        # 断るパスは全部集めて名指しで返す。1 件でも断ると投入全体が通らない
        # ので、画面はどれを外せば残りを解析できるのかを知る必要がある（#107）。
        # detail は今までどおり文字列（最初の理由）のままにして、読む側の
        # 互換を崩さない
        targets: list[Path] = []
        refused: list[dict[str, str]] = []
        for raw in request.archives:
            try:
                targets.append(path_guard.resolve_organize_target(raw))
            except HTTPException as error:
                refused.append({"path": raw, "reason": str(error.detail)})
        if refused:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"detail": refused[0]["reason"], "refused": refused},
            )
        # 前回までの解析は用済み。1 件ずつ入れ物と本の一覧を抱えるうえ、
        # 投入を編集するたびに増える。履歴を読む画面も無い
        app.state.jobs.prune_finished("analyze")
        job_id = app.state.jobs.submit(
            "analyze",
            {
                "archives": [str(target) for target in targets],
                "title": request.title,
                "author": request.author,
            },
        )
        start_job(
            app,
            job_id,
            analysis_work(
                targets, request.author, request.title, path_guard.within_allowed
            ),
        )
        return JobAccepted(id=job_id)

    @app.post("/api/output-roots", dependencies=guarded, response_model=OutputRootView)
    def choose_output_root(request: OutputRootRequest) -> OutputRootView:
        """利用者が出力先として選んだ場所を、この起動のあいだ覚える。

        呼ぶのは利用者が出力先を決めた操作からだけ（画面の DirectoryPicker）。
        整理の投入や起動パラメータから呼ぶと、依頼が自分の許可を連れてくる形に
        戻り、守りが素通しになる。
        """
        directory = Path(request.directory)
        if not directory.is_absolute():
            # 相対パスはサイドカーの作業ディレクトリを指してしまう。利用者が
            # 思っている場所ではないので、覚える前に断る
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="出力先は絶対パスで指定してください",
            )
        remembered = app.state.chosen_output_roots.remember(directory)
        return OutputRootView(directory=str(remembered))

    @app.post("/api/files/trash", dependencies=guarded, response_model=TrashedView)
    def trash_file(request: TrashRequest) -> TrashedView:
        """利用者が一覧で選んだファイルを、ごみ箱へ移す（#164）。

        消すのではなくごみ箱へ移す。画面は消す前に確かめるが、押し間違えた
        ときに取り戻せる道を残す。触れるのは読んでよい場所か、この起動で
        選んだ出力先の中のファイルだけ。フォルダは扱わない。中身ごと消える
        ことになり、確かめた 1 冊より多くを失いうるため。
        """
        path = Path(request.path).resolve()
        if not (
            path_guard.within_allowed(path)
            or app.state.chosen_output_roots.allows(path)
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="対象外のディレクトリです",
            )
        if not path.is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        try:
            send2trash(path)
        except OSError as error:
            # 開かれたままのファイルや、ごみ箱の無い場所（一部の NAS など）
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"ごみ箱へ移せませんでした: {error}",
            ) from error
        return TrashedView(path=str(path))

    @app.post(
        "/api/jobs/organize",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_organize(request: OrganizeRequest) -> JobAccepted:
        """アーカイブの整理をジョブとして投入する。

        フォルダを渡されたら、ここで中身を 1 冊ずつへ展開する。フォルダを
        1 件のまま走らせると、進捗の総数が 1 のまま複数冊が出来上がる。

        書き出す先は、ジョブにする前に確かめる。ジョブにして後から失敗させると、
        画面は投入できたと思ったまま、断る理由だけが後から届く（#58 と同じ）。
        """
        output_directory = resolve_output_directory(request.output_directory)
        archives = path_guard.expand_targets(request.archives)
        # 選んだ本が与えられていれば、その本を含まないアーカイブごと外す。
        # 進捗の総数もここで決まるので、外したぶんは最初から数に入らない
        wanted = wanted_books(request.books)
        if wanted is not None:
            # 鍵は ``wanted`` を組み立てたのと同じ ``source_key``。ここだけ
            # パスの形で引くと、同じファイルを別の綴りで指した依頼が、門は
            # 通ったのに 1 冊も作られないまま成功する
            archives = [
                archive for archive in archives if source_key(archive) in wanted
            ]
        job_id = app.state.jobs.submit(
            "organize",
            {
                "archives": [str(a) for a in archives],
                "output_directory": str(output_directory),
                "title": request.title,
                "author": request.author,
            },
        )
        start_job(
            app, job_id, organize_work(output_directory, archives, request, wanted)
        )
        return JobAccepted(id=job_id)

    return app
