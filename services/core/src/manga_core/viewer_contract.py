"""suzume-viewer が解釈できる出力の規約。

整理機能とページ修正機能は、どちらも最終的に suzume-viewer で読まれる ZIP を
出力する。ページとみなす条件と連番の付け方が両者で食い違うと、viewer 側で
ページが欠けたり並び順が崩れたりするため、判定をここに集約する。

参照実装は koupent/suzume-viewer の `lib/archive/manga_archive.dart`。

- `filterImageEntries` はディレクトリエントリ、`__MACOSX/`、ドット始まりを
  除外し、対応拡張子のみを採用する（サブフォルダ内の画像は保持する）
- ただし viewer のドット判定は末尾の要素だけを見ている。こちらはパスの
  どの要素で判定しても除外する側に倒す。ページ並べ替えは書き換えなので、
  隠しフォルダの中身を取り込むと取り返しがつかない（#66）。viewer が
  追いついた後は二重に守られるだけで、出力は変わらない
- 並び順は `a.name.compareTo(b.name)`、つまり単純な辞書順。ZIP の格納順は
  見ていない。表紙は並べ替え後の先頭
"""

from pathlib import Path, PurePosixPath

# viewer が復号できる形式
VIEWER_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"})

# 画像ではあるが viewer が復号できない形式。出力時に変換する
UNSUPPORTED_IMAGE_EXTENSIONS = frozenset({".bmp"})

# 変換先。BMP は無圧縮なだけなので、可逆な PNG へ移せば劣化しない
CONVERSION_TARGET = ".png"

MACOS_METADATA_DIR = "__MACOSX"
MACOS_METADATA_PREFIX = f"{MACOS_METADATA_DIR}/"
MIN_SEQUENCE_DIGITS = 3


def _is_excluded(name: str) -> bool:
    """viewer が読み飛ばすエントリかどうかを判定する。

    ドット始まりは末尾の要素（ベース名）だけでなくパスの全要素で見る。
    ベース名しか見ないと `.manga-organizer/originals/a3f2.jpg` が素通りし、
    ページとして扱われて並べ替えで `001.jpg` へ改名される。表示がずれるだけでは
    済まず、隠しておいた元画像が本文に混ざったうえ失われる（#66）。
    `.thumbnails/` や `.cache/` を抱えたアーカイブは実在するため、元画像の
    置き場に限らずパス全体で判定する。
    """
    if not name or name.endswith("/"):
        return True
    if name.startswith(MACOS_METADATA_PREFIX):
        return True
    path = PurePosixPath(name)
    if not path.name:
        return True
    return any(part.startswith(".") for part in path.parts)


def is_viewer_page(name: str) -> bool:
    """viewer がページとして表示するエントリかどうかを判定する"""
    if _is_excluded(name):
        return False
    return Path(name).suffix.lower() in VIEWER_IMAGE_EXTENSIONS


def needs_conversion(name: str) -> bool:
    """画像だが viewer が読めないため、変換が必要なエントリかを判定する"""
    if _is_excluded(name):
        return False
    return Path(name).suffix.lower() in UNSUPPORTED_IMAGE_EXTENSIONS


def is_page_source(name: str) -> bool:
    """ページとして扱う候補か（変換すれば読めるものも含む）"""
    return is_viewer_page(name) or needs_conversion(name)


def sequence_digits(total: int) -> int:
    """総ページ数に対する連番の桁数。

    viewer は辞書順で並べるため、桁が揃っていないと `1000` が `100` の直後に
    割り込む。総数に合わせて桁を広げることで辞書順と数値順を一致させる。
    """
    return max(MIN_SEQUENCE_DIGITS, len(str(max(total, 1))))


def output_suffix(suffix: str) -> str:
    """出力時の拡張子。viewer が読めない形式は変換先に置き換える"""
    normalized = suffix.lower()
    if normalized in UNSUPPORTED_IMAGE_EXTENSIONS:
        return CONVERSION_TARGET
    return normalized


def sequential_name(position: int, total: int, suffix: str) -> str:
    """ページ位置から、viewer が正しく並べられる連番名を組み立てる"""
    return f"{position:0{sequence_digits(total)}d}{output_suffix(suffix)}"


def relative_entry_name(path: Path, root: Path) -> str:
    """展開先のファイルパスを、アーカイブ内エントリ名と同じ形へ直す。

    `is_viewer_page` は `__MACOSX/` を先頭一致で見るため、絶対パスのまま
    渡すと判定をすり抜ける。判定前に必ず展開ルートからの相対名にする。
    """
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        # ルート外のパスは相対化できない。安全側に倒して名前だけで判定する
        return path.name
