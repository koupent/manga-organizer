"""ページ修正 UI の起動と後始末を担当する Tkinter 側の窓口。

UI 本体はローカル HTTP サーバー越しにブラウザ (Windows では Edge の
アプリモード) が描画する。この窓口はサーバーの起動、ブラウザの起動、
編集結果の受け取り、サーバーの停止までを面倒見る。
"""

import logging
import shutil
import subprocess
import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

from core.page_reorder import PageReorderError, is_editable_archive
from gui.page_editor_server import STATE_CANCELLED, STATE_EDITING, PageEditorServer

logger = logging.getLogger(__name__)

POLL_INTERVAL_MS = 400
WINDOW_SIZE = "1280,860"

# Edge / Chrome のアプリモードならタブやアドレスバーの無い単独窓で開ける
_APP_MODE_BROWSERS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def _find_app_mode_browser() -> str | None:
    """アプリモードで起動できるブラウザの実行ファイルを探す"""
    if sys.platform == "win32":
        for candidate in _APP_MODE_BROWSERS:
            if Path(candidate).is_file():
                return candidate
        return None
    for name in ("microsoft-edge", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    return None


def launch_browser_window(url: str) -> bool:
    """ページ修正 UI をブラウザで開く。アプリモードで開けたかを返す"""
    browser = _find_app_mode_browser()
    if browser is not None:
        try:
            subprocess.Popen(  # noqa: S603 - 実行ファイルは固定候補から解決済み
                [browser, f"--app={url}", f"--window-size={WINDOW_SIZE}"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                if sys.platform == "win32"
                else 0,
            )
            return True
        except OSError as error:
            logger.warning("アプリモードでの起動に失敗しました: %s", error)

    webbrowser.open(url)
    return False


class PageEditorDialog(tk.Toplevel):
    """ブラウザ側の編集が終わるまで待機する小さな進行ダイアログ"""

    def __init__(self, parent: tk.Misc, server: PageEditorServer, log_callback=None):
        super().__init__(parent)
        self.server = server
        self.log_callback = log_callback
        self._closed = False

        self.title("ページ修正")
        self.resizable(False, False)
        self.transient(parent)
        self.protocol("WM_DELETE_WINDOW", self._request_close)

        self._build_widgets()
        self.after(POLL_INTERVAL_MS, self._poll)

    def _build_widgets(self) -> None:
        frame = ttk.Frame(self, padding="16")
        frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        ttk.Label(
            frame,
            text=self.server.editor.zip_path.name,
            font=("TkDefaultFont", 10, "bold"),
        ).grid(row=0, column=0, sticky=tk.W)
        ttk.Label(
            frame,
            text=f"{len(self.server.editor.pages)} ページをブラウザで編集しています。",
        ).grid(row=1, column=0, sticky=tk.W, pady=(6, 0))

        self.status_var = tk.StringVar(
            value="ブラウザ側で「ZIP に保存」または「キャンセル」を押してください。"
        )
        ttk.Label(frame, textvariable=self.status_var, foreground="gray").grid(
            row=2, column=0, sticky=tk.W, pady=(6, 12)
        )

        buttons = ttk.Frame(frame)
        buttons.grid(row=3, column=0, sticky=tk.E)
        ttk.Button(buttons, text="ブラウザを再度開く", command=self._reopen).pack(
            side=tk.LEFT, padx=(0, 5)
        )
        ttk.Button(buttons, text="編集を中止", command=self._request_close).pack(
            side=tk.LEFT
        )

    def _reopen(self) -> None:
        launch_browser_window(self.server.url)

    def _log(self, message: str) -> None:
        logger.info(message)
        if self.log_callback:
            self.log_callback(message)

    def _poll(self) -> None:
        """ブラウザ側の状態を監視し、終了していれば後始末する"""
        if self._closed:
            return
        state, message = self.server.session.snapshot()
        if state != STATE_EDITING:
            self._finish(message)
            return
        if self.server.session.is_abandoned():
            self._finish("ブラウザが閉じられたため、ページ修正を中止しました")
            return
        self.after(POLL_INTERVAL_MS, self._poll)

    def _request_close(self) -> None:
        """Tkinter 側から編集を打ち切る"""
        self.server.session.finish(STATE_CANCELLED, "ページ修正を中止しました")
        self._finish("ページ修正を中止しました")

    def _finish(self, message: str) -> None:
        """サーバーを止めてダイアログを閉じる"""
        if self._closed:
            return
        self._closed = True
        self.server.shutdown()
        self._log(f"[ページ修正] {self.server.editor.zip_path.name}: {message}")
        self.destroy()


def open_page_editor(parent: tk.Misc, zip_path: Path, log_callback=None) -> bool:
    """指定した ZIP のページ修正 UI を開く。起動できたかを返す"""
    if not is_editable_archive(zip_path):
        messagebox.showwarning(
            "ページ修正",
            "ページ順を編集できるのは .zip / .cbz のみです。\n"
            f"選択されたファイル: {zip_path.name}",
            parent=parent,
        )
        return False

    try:
        server = PageEditorServer(zip_path)
    except PageReorderError as error:
        messagebox.showerror("ページ修正", f"{zip_path.name}\n{error}", parent=parent)
        return False
    except OSError as error:
        messagebox.showerror(
            "ページ修正", f"UI サーバーを起動できませんでした: {error}", parent=parent
        )
        return False

    url = server.start()
    dialog = PageEditorDialog(parent, server, log_callback)
    if not launch_browser_window(url):
        dialog.status_var.set("既定のブラウザで開きました。閉じずに編集してください。")
    return True
