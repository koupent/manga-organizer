"""サイドカーの FastAPI アプリ。

Tauri シェル（#22）が子プロセスとして起動し、127.0.0.1 でのみ待ち受ける。
同一 PC 上の他プロセスから操作されないよう、起動ごとに発行する使い捨て
トークンを全経路で必須にする。
"""

import io
import logging
import secrets
import threading
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field, field_validator

from manga_api import thumbnails
from manga_api.jobs import Job, JobNotFound, JobStore
from manga_core.cover_editor import (
    COVER_ASPECT_RATIO,
    CoverEditError,
    CoverTransform,
    apply_to_archive,
    is_spread,
)
from manga_core.input_expander import ARCHIVE_SUFFIXES, expand_inputs
from manga_core.manga_database import MangaDatabase
from manga_core.naming import natural_sort_key
from manga_core.original_store import (
    OriginalStoreError,
    content_hash,
    find_original,
    read_original,
)
from manga_core.page_reorder import PageReorderError, ZipPageEditor
from manga_core.toc_analyzer import analyze_inputs, locate_books

logger = logging.getLogger(__name__)

TITLE = "Manga Organizer サイドカー"
# 外部からは触らせない。Tauri シェルと同一ホスト内でのみ使う
HOST = "127.0.0.1"

# 作品名として妥当な長さ。これを超えるものは打ち間違いか攻撃とみなす
MAX_TITLE_LENGTH = 200

# 拡張子から media type を決める。画像として名指しできる形式だけを並べ、
# 知らない拡張子はブラウザに画像として解釈させない
IMAGE_MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}
FALLBACK_MEDIA_TYPE = "application/octet-stream"

# サムネイルは描き直したもの。名前ではなく描き出した形式で決まる
THUMBNAIL_MEDIA_TYPE = "image/jpeg"

# Tauri の WebView と、開発・検証で使う Vite の dev server
DEFAULT_ALLOWED_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "tauri://localhost",
    "http://tauri.localhost",
)


class ReorderRequest(BaseModel):
    """ページ並べ替えの依頼"""

    archive: str = Field(description="対象アーカイブの絶対パス")
    order: list[str] = Field(description="並べ替え後のページ名（先頭が 1 ページ目）")


class BookRef(BaseModel):
    """本 1 冊の指定。

    名前ではなく「元のアーカイブ + その中での位置」で指す。出来上がる名前は
    作品名と著者で毎回変わるので、名前を鍵にすると入力欄をいじった瞬間に
    選択が外れる。``entry`` はアーカイブ全体が 1 冊なら空文字。
    """

    source: str = Field(description="元のアーカイブ（または画像フォルダ）の絶対パス")
    entry: str = Field(default="", description="アーカイブ内での位置")


class AnalyzeRequest(BaseModel):
    """出来上がる本を実行前に調べる依頼"""

    archives: list[str] = Field(
        description="解析対象の絶対パス。フォルダを渡すと中を再帰的に辿る"
    )
    title: str = Field(default="", description="作品名")
    author: str = Field(default="", description="著者名")


class PlannedBookView(BaseModel):
    """実行すると 1 冊出来る、という予告"""

    source: str
    entry: str
    output_name: str
    volume: int | None = None
    issues: list[str] = Field(
        default_factory=list, description="実行前に利用者へ見せる印"
    )


class AnalyzeResult(BaseModel):
    """解析の結果。出来上がる本を、実行するのと同じ順に並べる"""

    books: list[PlannedBookView]


class OrganizeRequest(BaseModel):
    """アーカイブ整理の依頼"""

    archives: list[str] = Field(
        description="整理対象の絶対パス。フォルダを渡すと中を再帰的に辿る"
    )
    output_directory: str = Field(description="出力先ディレクトリ")
    title: str = Field(default="", description="作品名")
    author: str = Field(default="", description="著者名")
    keep_originals: bool = Field(default=True, description="元ファイルを残すか")
    books: list[BookRef] | None = Field(
        default=None,
        description=(
            "作る本。省くと投入されたものを全部作る。"
            "与えると、その本だけを作る（空の配列は 1 冊も作らない）"
        ),
    )


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


class LibraryEntry(BaseModel):
    """タイトルと著者の対応"""

    title: str
    author: str


class LibraryEntries(BaseModel):
    """辞書の中身"""

    entries: list[LibraryEntry]


class SuggestRequest(BaseModel):
    """外部サービスへの問い合わせ依頼"""

    title: str = Field(
        description="調べたい作品名。空白のみは受け付けない",
        max_length=MAX_TITLE_LENGTH,
    )

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, value: str) -> str:
        """中身の無い作品名を境界で断る。

        空文字はどの作品にも当たってしまい、外部サービスへの問い合わせも
        無駄になる。前後の空白を落としたうえで空なら受け付けない。
        """
        stripped = value.strip()
        if not stripped:
            raise ValueError("作品名を入力してください")
        return stripped


class AuthorCandidate(BaseModel):
    """検索で見つかった作品と、その著者"""

    title: str
    author: str
    source: str
    similarity: float


class Suggestion(BaseModel):
    """補完の結果。近い順に候補を並べ、先頭を既定として示す"""

    title: str | None = None
    author: str | None = None
    candidates: list[AuthorCandidate] = Field(default_factory=list)


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


class OperationView(BaseModel):
    """元画像に施した加工 1 つ分。params の形は kind ごとに決まる"""

    kind: str
    params: dict[str, Any] = Field(default_factory=dict)


class OriginalView(BaseModel):
    """いま見ている 1 枚の、加工前の姿。

    ZIP 内のどのエントリに入っているかは返さない。返すと、書き換えられた
    manifest を使って画面からアーカイブ内の任意のエントリを読ませる道ができる。
    画面が要るのは「どれだけ広い絵が残っているか」と「前回どこを選んだか」だけ。
    """

    width: int
    height: int
    operations: list[OperationView] = Field(default_factory=list)


class CoverView(BaseModel):
    """表紙の状態。

    寸法と見開き判定は「いま保存されている 1 枚」を指す。original は、その
    1 枚が加工の結果なら加工前の姿を添える。画面は加工前を対象にして枠を
    置き直すので、両方を 1 回の問い合わせで受け取る必要がある。
    """

    name: str
    width: int
    height: int
    is_spread: bool
    target_aspect_ratio: float
    original: OriginalView | None = Field(
        default=None,
        description="加工前の画像。一度も加工していなければ null",
    )


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


def _media_type(name: str) -> str:
    """エントリ名から media type を決める。知らない拡張子は画像として扱わない"""
    return IMAGE_MEDIA_TYPES.get(Path(name).suffix.lower(), FALLBACK_MEDIA_TYPE)


def _matches_tag(header: str | None, tag: str) -> bool:
    """ブラウザが持っている版が、いまの中身と同じかどうか"""
    if not header:
        return False
    return tag in {candidate.strip() for candidate in header.split(",")}


def _image_response(request: Request, body: bytes, media_type: str) -> Response:
    """画像を返す。取り直すかどうかは、中身が変わったかどうかで決めさせる。

    max-age で日持ちさせると、加工でページの中身が変わっても URL が同じなので
    ブラウザは取りに行かず、加工前の絵を出し続ける。実際、同じ窓で本を開き直すと
    サイドカーは新しい画像を返しているのに画面は古い画像を描いていた。

    no-cache は「保存するな」ではなく「使う前に必ず確かめろ」なので、中身が
    変わっていなければ 304 で済み、日持ちさせていたときの転送量とほぼ変わらない。
    版の目印は中身そのもののハッシュにする。加工はファイルの日時を元に戻すので、
    日時を目印にすると変わったことに気づけない。
    """
    tag = f'"{content_hash(body)}"'
    headers = {
        "Cache-Control": "no-cache",
        "ETag": tag,
        "X-Content-Type-Options": "nosniff",
    }
    if _matches_tag(request.headers.get("if-none-match"), tag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=body, media_type=media_type, headers=headers)


def _describe_original(archive_path: Path, image: bytes) -> OriginalView | None:
    """加工後の 1 枚から、加工前の姿を引く。記録が無ければ None。

    寸法は PIL が見出しだけ読んで返すので、画素まで展開しない。
    """
    ref = find_original(archive_path, image)
    if ref is None:
        return None
    try:
        with Image.open(io.BytesIO(read_original(archive_path, ref))) as opened:
            width, height = opened.size
    except (OriginalStoreError, OSError):
        # 記録はあるが読めない。同梱が失われた古いアーカイブでも画面が
        # 開けるよう、元画像が無いものとして扱う
        logger.warning("元画像を読めませんでした: %s", archive_path)
        return None
    return OriginalView(
        width=width,
        height=height,
        operations=[
            OperationView(kind=operation.kind, params=dict(operation.params))
            for operation in ref.operations
        ],
    )


def _to_view(job: Job) -> JobView:
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


def _to_detail(job: Job, log: list[str]) -> JobDetail:
    """ジョブを詳細用の形へ直す"""
    return JobDetail(**_to_view(job).model_dump(), log=log)


def create_app(
    state_dir: Path | None = None,
    token: str | None = None,
    allowed_roots: list[Path] | None = None,
    allowed_origins: list[str] | None = None,
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
        """
        return MangaDatabase(app.state.database_path)

    def within_allowed(path: Path) -> bool:
        """許可された場所に留まるかを見る。

        判定は必ず resolve() した後のパスで行う。許可の中に置かれたリンクが
        外を指していると、名前のままでは中に見えて、開くと外を読んでしまう。
        """
        roots = app.state.allowed_roots
        if not roots:
            return True
        return any(path.resolve().is_relative_to(root) for root in roots)

    def refuse_outside(path: Path) -> None:
        """許可の外なら、開く前に断る"""
        if not within_allowed(path):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="対象外のディレクトリです",
            )

    def resolve_archive(raw: str) -> Path:
        """受け取ったパスを検証して解決する"""
        path = Path(raw).resolve()
        refuse_outside(path)
        if not path.is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        return path

    def resolve_organize_target(raw: str) -> Path:
        """整理の対象を検証して解決する。

        こちらはフォルダも受け付ける。利用者はアーカイブを 1 つずつ選ばず、
        フォルダごと投げ込むため（#70）。中身の展開は投入時に行う。
        """
        path = Path(raw).resolve()
        refuse_outside(path)
        if not path.exists():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        return path

    def expand_targets(raws: list[str]) -> list[Path]:
        """投入されたパスを、1 冊ずつの入力へ展開する。

        辿って見つけたものは利用者が名指ししていない。リンクで許可の外を
        指していないか、1 件ずつ確かめてから処理対象に入れる。

        解析と整理で同じ展開を通すのは、処理順が同名衝突の ``_1`` の付き方を
        決めるため。片方だけ順番が変わると、予告した名前と実際に出来る名前が
        食い違う。
        """
        targets = [resolve_organize_target(raw) for raw in raws]
        expanded: list[Path] = []
        for found in expand_inputs(targets):
            if within_allowed(found):
                expanded.append(found)
            else:
                logger.warning("許可された場所の外を指すため除きました: %s", found)
        return expanded

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
    def thumbnail(
        request: Request, archive: str, name: str, width: int = 240
    ) -> Response:
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
        return _image_response(request, body, THUMBNAIL_MEDIA_TYPE)

    @app.post("/api/resolve", dependencies=guarded, response_model=ResolveResult)
    def resolve(request: ResolveRequest) -> ResolveResult:
        """ドロップされたファイルを実パスに結びつける。

        ブラウザは実パスを渡さないが、名前とサイズは分かる。許可された場所の
        中から同じものを探せば、ドロップからでも対象を特定できる。同名が複数
        あってサイズでも絞れない場合は、勝手に選ばず返す。
        """
        roots = app.state.allowed_roots or [Path.home()]
        wanted = {file.name for file in request.files}

        # 走査は 1 回で済ませる。巻数が多いと候補も増える
        candidates: dict[str, list[Path]] = {name: [] for name in wanted}
        for root in roots:
            if not root.is_dir():
                continue
            for found in root.rglob("*"):
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
            refuse_outside(target)
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
        """タイトルと著者の辞書。query を与えると絞り込む"""
        database = open_database()
        pairs = (
            database.search_titles(query, limit=50)
            if query
            else database.get_recent_manga(limit=200)
        )
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

    @app.delete("/api/library/entries", dependencies=guarded)
    def delete_entry(title: str) -> dict[str, bool]:
        """辞書から取り除く"""
        database = open_database()
        try:
            return {"deleted": bool(database.delete_manga(title))}
        finally:
            database.close()

    @app.post("/api/library/suggest", dependencies=guarded, response_model=Suggestion)
    def suggest(request: SuggestRequest) -> Suggestion:
        """外部サービスから著者名を補完する。

        ネットワークに出るため失敗しうる。見つからない場合と区別せず、
        空の結果として返して画面を止めない。
        """
        # 取り込みが重く、ネットワークにも出るのでここで読み込む
        from manga_core.api_client import MangaMetadataFetcher

        try:
            found = MangaMetadataFetcher().get_author_candidates(request.title)
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
        editor = open_editor(archive)
        try:
            body = editor.read_entry(name)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        finally:
            editor.close()
        return _image_response(request, body, _media_type(name))

    @app.get("/api/original", dependencies=guarded, response_class=Response)
    def original(request: Request, archive: str, name: str) -> Response:
        """いま見ている 1 枚の、加工前の画像そのものを返す。

        求めるのは加工後のページ名だけで、元画像が ZIP のどのエントリに
        入っているかは受け取らない。エントリ名を外から取ると、書き換えられた
        manifest 経由でアーカイブ内の任意のエントリを読ませる道ができる。

        バイト列を /api/cover と分けているのは、画像が JSON に載らないうえ、
        /api/cover は画面を描き直すたびに引かれる軽い経路であってほしいため。
        """
        editor = open_editor(archive)
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
        return _image_response(request, data, _media_type(ref.entry))

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
        editor = open_editor(archive)
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
            original=_describe_original(path, body),
        )

    @app.post(
        "/api/jobs/cover",
        dependencies=guarded,
        status_code=status.HTTP_202_ACCEPTED,
        response_model=JobAccepted,
    )
    def submit_cover(request: CoverRequest) -> JobAccepted:
        """表紙の加工をジョブとして投入する"""
        path = resolve_archive(request.archive)
        job_id = app.state.jobs.submit(
            "cover", {"archive": str(path), "name": request.name}
        )

        def work(report):
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
            app.state.thumbnails.discard(str(path))
            report(current=1, total=1, message="完了")
            return {
                "name": result.name,
                "width": result.width,
                "height": result.height,
                "renamed": result.renamed,
            }

        _start(app, job_id, work)
        return JobAccepted(id=job_id)

    @app.get("/api/jobs", dependencies=guarded, response_model=JobList)
    def list_jobs() -> JobList:
        """新しい順にジョブを並べる"""
        return JobList(jobs=[_to_view(job) for job in app.state.jobs.list_jobs()])

    @app.get("/api/jobs/{job_id}", dependencies=guarded, response_model=JobDetail)
    def get_job(job_id: str) -> JobDetail:
        """ジョブ 1 件の状態を、経過のログとともに返す"""
        try:
            return _to_detail(app.state.jobs.get(job_id), app.state.jobs.log_of(job_id))
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

    @app.post("/api/analyze", dependencies=guarded, response_model=AnalyzeResult)
    def analyze(request: AnalyzeRequest) -> AnalyzeResult:
        """展開せずに目次を読み、出来上がる本を実行前に並べる（#70）。

        利用者はチェックを外す前に「何が出来るのか」を見る必要がある。
        整理と同じ展開・同じ巻数判定を通すので、ここで見えた名前が
        そのまま実行の結果になる。
        """
        return AnalyzeResult(
            books=[
                PlannedBookView(
                    source=str(book.source),
                    entry=book.entry,
                    output_name=book.output_name,
                    volume=book.volume,
                    issues=list(book.issues),
                )
                for book in analyze_inputs(
                    expand_targets(request.archives), request.author, request.title
                )
            ]
        )

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
        """
        archives = expand_targets(request.archives)
        # 選んだ本が与えられていれば、その本を含まないアーカイブごと外す。
        # 進捗の総数もここで決まるので、外したぶんは最初から数に入らない
        wanted = _wanted_entries(request.books)
        if wanted is not None:
            archives = [archive for archive in archives if archive.resolve() in wanted]
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
            failed: list[dict[str, str]] = []
            for index, archive in enumerate(archives, 1):
                report(current=index, total=len(archives), message=archive.name)
                skip = _skipped_locations(archive, wanted)
                for result in organizer.process_single_archive(archive, skip):
                    if result.success and result.output_path:
                        produced.append(str(result.output_path))
                        continue
                    # process_single_archive() は処理中の例外を握りつぶして
                    # success=False を返すので、ジョブは最後まで走り succeeded で
                    # 終わる。ここで拾わないと「produced が空の成功」になり、
                    # 全件失敗と「対象が 0 件だった」の区別が付かなくなる
                    failed.append(
                        {
                            "archive": str(result.original_path),
                            "reason": result.error_message or "原因不明の失敗",
                        }
                    )
            # 走り切ったこと（state）と、何が出来たか（result）は別に伝える。
            # failed はキーごと省かない。省くと画面から見て「失敗が無い」のか
            # 「失敗を数えていない」のかを区別できない
            return {"produced": produced, "failed": failed}

        _start(app, job_id, work)
        return JobAccepted(id=job_id)

    return app


def _wanted_entries(books: list[BookRef] | None) -> dict[Path, set[str]] | None:
    """作る本を、元のアーカイブごとにまとめる。

    ``None``（指定なし）と空の辞書（1 冊も作らない）は別物なので、``books`` を
    省いたときだけ ``None`` を返す。パスはリンクを解いた形に揃える。解析が
    返した文字列と整理で辿り直したパスは、同じ物でも書き方が違いうる。
    """
    if books is None:
        return None
    wanted: dict[Path, set[str]] = {}
    for book in books:
        wanted.setdefault(Path(book.source).resolve(), set()).add(book.entry)
    return wanted


def _skipped_locations(
    archive: Path, wanted: dict[Path, set[str]] | None
) -> frozenset[str]:
    """このアーカイブの中で、作らない本の位置を求める。

    外すのは「解析で予告できていて、かつ選ばれなかった」本だけにする。
    予告できなかったもの（RAR・壊れたアーカイブ・入れ子の RAR）を黙って
    落とすと、利用者が外したつもりのない本が何も言わずに消える。
    """
    if wanted is None:
        return frozenset()
    chosen = wanted.get(archive.resolve(), set())
    return frozenset(
        location.extracted_path
        for location in locate_books(archive)
        if location.entry not in chosen
    )


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
