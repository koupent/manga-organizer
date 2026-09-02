"""ページ修正 UI を配信するローカル HTTP サーバー。

Tkinter の Canvas ではサムネイルのグリッド表示とドラッグ&ドロップを
すべて手書きする必要があるため、この画面だけはブラウザに描かせる。
サーバーは 127.0.0.1 のみで待ち受け、起動ごとに発行するトークンを
必須にして、同一 PC 上の他プロセスからの操作を防ぐ。
"""

import io
import json
import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageOps

from core.page_reorder import PageReorderError, ZipPageEditor
from utils.resources import resource_path

logger = logging.getLogger(__name__)

HOST = "127.0.0.1"
THUMBNAIL_WIDTHS = (160, 240, 360, 520)
THUMBNAIL_QUALITY = 82
THUMBNAIL_CACHE_LIMIT = 800
MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024
HEARTBEAT_TIMEOUT_SECONDS = 90.0
TEMPLATE_NAME = "web/page_editor.html"

STATE_EDITING = "editing"
STATE_SAVED = "saved"
STATE_CANCELLED = "cancelled"


@dataclass
class SessionState:
    """UI 側の操作結果を Tkinter 側へ引き渡すための共有状態"""

    state: str = STATE_EDITING
    message: str = ""
    contacted: bool = False
    last_seen: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def finish(self, state: str, message: str) -> None:
        """保存またはキャンセルの結果を記録する"""
        with self.lock:
            self.state = state
            self.message = message

    def snapshot(self) -> tuple[str, str]:
        """現在の状態を読み取る"""
        with self.lock:
            return self.state, self.message

    def touch(self) -> None:
        """UI が生存していることを記録する"""
        with self.lock:
            self.contacted = True
            self.last_seen = time.monotonic()

    def is_abandoned(self) -> bool:
        """UI からの応答が途絶えたかどうかを判定する"""
        with self.lock:
            if not self.contacted:
                return False
            return time.monotonic() - self.last_seen > HEARTBEAT_TIMEOUT_SECONDS


def _nearest_thumbnail_width(requested: int) -> int:
    """要求された表示幅に対して用意するサムネイル幅を選ぶ"""
    for width in THUMBNAIL_WIDTHS:
        if requested <= width:
            return width
    return THUMBNAIL_WIDTHS[-1]


def render_thumbnail(data: bytes, width: int) -> bytes:
    """ページ画像から表示用サムネイル (JPEG) を生成する"""
    with Image.open(io.BytesIO(data)) as image:
        # draft は JPEG のデコード段階で間引くため、大判ページでも軽い
        image.draft("RGB", (width * 2, width * 2))
        oriented = ImageOps.exif_transpose(image)
        converted = oriented.convert("RGB")
        converted.thumbnail((width, width * 3), Image.LANCZOS)
        buffer = io.BytesIO()
        converted.save(buffer, "JPEG", quality=THUMBNAIL_QUALITY, optimize=True)
    return buffer.getvalue()


class ThumbnailCache:
    """生成済みサムネイルを保持する上限付きキャッシュ"""

    def __init__(self, limit: int = THUMBNAIL_CACHE_LIMIT):
        self._limit = limit
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, int], bytes] = {}

    def get_or_create(self, key: tuple[str, int], factory) -> bytes:
        """キャッシュを引き、無ければ生成して登録する"""
        with self._lock:
            cached = self._entries.get(key)
        if cached is not None:
            return cached

        created = factory()
        with self._lock:
            if len(self._entries) >= self._limit:
                self._entries.pop(next(iter(self._entries)), None)
            self._entries[key] = created
        return created


class PageEditorServer:
    """1 つの ZIP に対するページ修正セッション"""

    def __init__(self, zip_path: Path):
        self.editor = ZipPageEditor(zip_path)
        self.token = secrets.token_urlsafe(24)
        self.session = SessionState()
        self.cache = ThumbnailCache()
        self.progress: tuple[int, int] = (0, 0)
        self._httpd = ThreadingHTTPServer((HOST, 0), _make_handler(self))
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, name="page-editor-server", daemon=True
        )

    @property
    def url(self) -> str:
        """ブラウザで開くべき URL"""
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/?token={self.token}"

    def start(self) -> str:
        """サーバーを起動して URL を返す"""
        self._thread.start()
        logger.info("ページ修正サーバーを起動しました: %s", self._httpd.server_address)
        return self.url

    def shutdown(self) -> None:
        """サーバーを停止し、ZIP のハンドルを解放する"""
        self._httpd.shutdown()
        self._httpd.server_close()
        self.editor.close()

    def thumbnail(self, name: str, width: int) -> bytes:
        """指定ページのサムネイルを取得する"""
        resolved = _nearest_thumbnail_width(width)
        return self.cache.get_or_create(
            (name, resolved),
            lambda: render_thumbnail(self.editor.read_entry(name), resolved),
        )

    def page_payload(self) -> dict:
        """UI 初期表示用のページ一覧を組み立てる"""
        return {
            "archive": self.editor.zip_path.name,
            "archivePath": str(self.editor.zip_path),
            "thumbnailWidths": list(THUMBNAIL_WIDTHS),
            "pages": [
                {
                    "name": page.name,
                    "size": page.size,
                    "modified": page.modified,
                    "label": Path(page.name).name,
                }
                for page in self.editor.pages
            ],
        }

    def save(self, ordered_names: list[str]) -> dict:
        """新しい並び順を ZIP に適用する"""
        total = len(ordered_names)
        self.progress = (0, total)

        def report(current: int, count: int) -> None:
            self.progress = (current, count)

        result = self.editor.apply_order(ordered_names, progress=report)
        self.progress = (total, total)
        message = (
            f"{result.page_count} ページを並び替えました"
            if result.changed
            else "並び順に変更はありませんでした"
        )
        if result.changed and not result.times_restored:
            message += " (タイムスタンプの一部を復元できませんでした)"
        self.session.finish(STATE_SAVED, message)
        return {
            "changed": result.changed,
            "pageCount": result.page_count,
            "renamedCount": result.renamed_count,
            "timesRestored": result.times_restored,
            "message": message,
        }


def _read_int(query: dict[str, list[str]], key: str, fallback: int) -> int:
    """クエリ文字列から整数を取り出す"""
    try:
        return int((query.get(key) or [""])[0])
    except ValueError:
        return fallback


def _read_content_length(raw: str | None) -> int | None:
    """Content-Length ヘッダを検証して返す"""
    if raw is None:
        return None
    try:
        length = int(raw)
    except ValueError:
        return None
    return length if length >= 0 else None


def _make_handler(server: PageEditorServer):
    """セッションに紐づくリクエストハンドラを生成する"""

    class PageEditorHandler(BaseHTTPRequestHandler):
        server_version = "MangaOrganizerPageEditor"
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):  # noqa: A002 - 基底クラスの引数名
            logger.debug("page-editor %s", format % args)

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler の規約
            route, query = self._parse()
            if not self._authorize(query):
                return
            handlers = {
                "/": self._serve_index,
                "/api/pages": self._serve_pages,
                "/api/thumb": self._serve_thumbnail,
                "/api/image": self._serve_image,
                "/api/ping": self._serve_ping,
                "/api/progress": self._serve_progress,
            }
            handler = handlers.get(route)
            if handler is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            handler(query)

        def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler の規約
            route, query = self._parse()
            if not self._authorize(query):
                return
            if route == "/api/save":
                self._handle_save()
            elif route == "/api/cancel":
                server.session.finish(STATE_CANCELLED, "編集を取り消しました")
                self._send_json(HTTPStatus.OK, {"ok": True})
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def _parse(self) -> tuple[str, dict[str, list[str]]]:
            parsed = urlparse(self.path)
            return parsed.path, parse_qs(parsed.query)

        def _authorize(self, query: dict[str, list[str]]) -> bool:
            """トークンを検証し、他プロセスからの操作を拒否する"""
            supplied = (query.get("token") or [""])[0]
            if not secrets.compare_digest(supplied, server.token):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "invalid token"})
                return False
            server.session.touch()
            return True

        def _serve_index(self, query):
            # ファイル名は HTML に埋め込まない。ファイル名由来のマークアップが
            # トークン付きオリジンで実行されるのを避け、JSON 経由で描画させる。
            template = resource_path(TEMPLATE_NAME).read_text(encoding="utf-8")
            page = template.replace("__TOKEN__", server.token)
            self._send_bytes(
                HTTPStatus.OK, page.encode("utf-8"), "text/html; charset=utf-8"
            )

        def _serve_pages(self, query):
            self._send_json(HTTPStatus.OK, server.page_payload())

        def _serve_ping(self, query):
            state, message = server.session.snapshot()
            self._send_json(HTTPStatus.OK, {"state": state, "message": message})

        def _serve_progress(self, query):
            current, total = server.progress
            self._send_json(HTTPStatus.OK, {"current": current, "total": total})

        def _serve_thumbnail(self, query):
            name = (query.get("name") or [""])[0]
            width = _read_int(query, "width", THUMBNAIL_WIDTHS[1])
            try:
                body = server.thumbnail(name, width)
            except PageReorderError as error:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except OSError as error:
                logger.warning("サムネイル生成に失敗しました (%s): %s", name, error)
                self._send_json(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "decode failed"}
                )
                return
            self._send_bytes(HTTPStatus.OK, body, "image/jpeg", cacheable=True)

        def _serve_image(self, query):
            name = (query.get("name") or [""])[0]
            try:
                body = server.editor.read_entry(name)
            except PageReorderError as error:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            suffix = Path(name).suffix.lower().lstrip(".")
            content_type = f"image/{'jpeg' if suffix in ('jpg', 'jpeg') else suffix}"
            self._send_bytes(HTTPStatus.OK, body, content_type, cacheable=True)

        def _handle_save(self):
            payload = self._read_json_body()
            if payload is None:
                return
            order = payload.get("order")
            if not isinstance(order, list) or not all(
                isinstance(item, str) for item in order
            ):
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "order must be a string list"}
                )
                return
            try:
                self._send_json(HTTPStatus.OK, server.save(order))
            except PageReorderError as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except OSError as error:
                logger.exception("ZIP の書き換えに失敗しました")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"保存に失敗しました: {error}"},
                )

        def _read_json_body(self) -> dict | None:
            length = _read_content_length(self.headers.get("Content-Length"))
            if length is None or length > MAX_REQUEST_BODY_BYTES:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid content length"}
                )
                return None
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
                return None
            if not isinstance(payload, dict):
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "body must be a json object"}
                )
                return None
            return payload

        def _send_json(self, status: HTTPStatus, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(status, body, "application/json; charset=utf-8")

        def _send_bytes(
            self,
            status: HTTPStatus,
            body: bytes,
            content_type: str,
            cacheable: bool = False,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header(
                "Cache-Control", "max-age=3600" if cacheable else "no-store"
            )
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return PageEditorHandler
