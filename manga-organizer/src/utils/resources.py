"""同梱リソースの解決。

PyInstaller の onefile ビルドでは実行時に展開先 (sys._MEIPASS) から読み出す
必要があるため、開発実行時とビルド後で参照先を切り替える。
"""

import sys
from pathlib import Path


def resource_path(relative: str) -> Path:
    """src/ からの相対パスを実行環境に応じた絶対パスへ解決する"""
    bundle_dir = getattr(sys, "_MEIPASS", None)
    base = Path(bundle_dir) if bundle_dir else Path(__file__).resolve().parents[1]
    return base / relative
