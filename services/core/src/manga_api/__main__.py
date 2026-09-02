"""サイドカーの起動口。

Tauri シェル（#22）が子プロセスとして起動する。待ち受けポートと使い捨て
トークンは起動時に stdout へ 1 行の JSON で出し、シェルはそれを読んで
接続先を知る。ポートを固定しないのは、他プロセスとの衝突を避けるため。
"""

import argparse
import json
import logging
import sys
import threading
import time
from pathlib import Path

import uvicorn

from manga_api.app import HOST, create_app

READY_PREFIX = "MANGA_API_READY "


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """コマンドライン引数を解釈する"""
    parser = argparse.ArgumentParser(description="Manga Organizer サイドカー")
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path.home() / ".manga-organizer",
        help="ジョブ履歴などを置くディレクトリ",
    )
    parser.add_argument(
        "--allow-root",
        type=Path,
        action="append",
        default=[],
        help="読み書きを許可するディレクトリ（複数指定可。省略時は制限しない）",
    )
    parser.add_argument(
        "--port", type=int, default=0, help="待ち受けポート（0 で自動）"
    )
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="WebView のオリジン（省略時は既定の localhost / tauri）",
    )
    parser.add_argument("--log-level", default="info")
    return parser.parse_args(argv)


def announce(port: int, token: str, stream=sys.stdout) -> None:
    """接続先を親プロセスへ伝える"""
    stream.write(
        READY_PREFIX
        + json.dumps({"host": HOST, "port": port, "token": token}, ensure_ascii=False)
        + "\n"
    )
    stream.flush()


def main(argv: list[str] | None = None) -> int:
    """サイドカーを起動する"""
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level.upper())

    app = create_app(
        state_dir=args.state_dir,
        allowed_roots=args.allow_root,
        allowed_origins=args.allow_origin or None,
    )
    config = uvicorn.Config(
        app, host=HOST, port=args.port, log_level=args.log_level, access_log=False
    )
    server = uvicorn.Server(config)

    # ポートを自動割り当てにすると、確定するのは bind した後になる
    server.config.load()
    sockets = [config.bind_socket()]
    port = sockets[0].getsockname()[1]

    # READY は「接続を受け付けられる状態」を表す。bind 直後に出すと、
    # シェルが受付開始前に接続して弾かれる
    worker = threading.Thread(
        target=server.run, kwargs={"sockets": sockets}, name="uvicorn"
    )
    worker.start()
    while not server.started and worker.is_alive():
        time.sleep(0.01)
    if not server.started:
        print("サイドカーの起動に失敗しました", file=sys.stderr)
        return 1

    announce(port, app.state.token)
    worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
