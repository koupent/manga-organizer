"""画像をバイト列のまま返すための、経路によらない部分。

``/api/thumb``・``/api/image``・``/api/original`` の 3 経路は、どれも
「ZIP から取り出したバイト列を画像として返す」だけで、違うのは取り出し方だけ。
media type の決め方と条件付き要求（ETag / If-None-Match）の扱いはまったく
同じなので、経路の側に置くと 3 か所へ同じ判断が散る。

アプリの状態には触れない。引数で受け取ったものだけで決まる。
"""

from pathlib import Path

from fastapi import Request, status
from fastapi.responses import Response

from manga_core.original_store import content_hash

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


def media_type_of(name: str) -> str:
    """エントリ名から media type を決める。知らない拡張子は画像として扱わない"""
    return IMAGE_MEDIA_TYPES.get(Path(name).suffix.lower(), FALLBACK_MEDIA_TYPE)


def _weak_form(candidate: str) -> str:
    """W/ を外した検証子。弱い比較はこの形どうしで照合する"""
    return candidate[2:] if candidate.startswith("W/") else candidate


def _matches_tag(header: str | None, tag: str) -> bool:
    """ブラウザが持っている版が、いまの中身と同じかどうか。

    If-None-Match の書き方はブラウザが決めるもので、こちらでは選べない
    （RFC 9110 13.1.2）。W/ 付き・`*`・複数並べのどれかを読み落とすと、
    持っている版を名乗られても丸ごと送り直すことになり、200 ページの本を
    開き直すたびに全ページが再送される。
    """
    if not header:
        return False
    candidates = {candidate.strip() for candidate in header.split(",")}
    if "*" in candidates:
        return True
    return _weak_form(tag) in {_weak_form(candidate) for candidate in candidates}


def image_response(request: Request, body: bytes, media_type: str) -> Response:
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
