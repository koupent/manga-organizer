"""サムネイルの生成とキャッシュ。

数百枚のグリッドを扱うため、生成コストと再取得を抑える。JPEG は draft() で
デコード段階から間引けるので、大判ページでも軽い。
"""

import io
import threading

from PIL import Image, ImageOps

# 高密度画面で 2 列分に広がる見開きも、表示幅に足りる解像度で取得できるようにする。
WIDTHS = (160, 240, 360, 520, 800, 1600, 3200)
QUALITY = 82
CACHE_LIMIT = 800


def nearest_width(requested: int) -> int:
    """要求された表示幅に対して用意するサムネイル幅を選ぶ"""
    for width in WIDTHS:
        if requested <= width:
            return width
    return WIDTHS[-1]


def render(data: bytes, width: int) -> bytes:
    """ページ画像から表示用サムネイル (JPEG) を生成する"""
    with Image.open(io.BytesIO(data)) as image:
        image.draft("RGB", (width * 2, width * 2))
        oriented = ImageOps.exif_transpose(image)
        converted = oriented.convert("RGB")
        converted.thumbnail((width, width * 3), Image.LANCZOS)
        buffer = io.BytesIO()
        converted.save(buffer, "JPEG", quality=QUALITY, optimize=True)
    return buffer.getvalue()


class ThumbnailCache:
    """生成済みサムネイルを保持する上限付きキャッシュ"""

    def __init__(self, limit: int = CACHE_LIMIT):
        self._limit = limit
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str, int], bytes] = {}

    def get_or_create(self, key: tuple[str, str, int], factory) -> bytes:
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

    def discard(self, archive: str) -> None:
        """書き換えたアーカイブのサムネイルを捨てる"""
        with self._lock:
            for key in [k for k in self._entries if k[0] == archive]:
                self._entries.pop(key, None)
