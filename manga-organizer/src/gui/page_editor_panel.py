"""ページ修正モードの画面。

整理モードとは独立した機能なので、対象ファイルの選択もこの画面が自前で持つ。
整理モード側の入力リストとは共有しない。
"""

import logging
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from core.page_reorder import is_editable_archive
from gui.page_editor_window import open_page_editor
from utils.naming import natural_sort_key

logger = logging.getLogger(__name__)

FILE_TYPES = [("ZIP / CBZ アーカイブ", "*.zip *.cbz"), ("すべてのファイル", "*.*")]


def collect_editable_archives(paths) -> list[Path]:
    """受け取ったパスから、ページ順を編集できるものだけを自然順で取り出す"""
    editable = {
        path.resolve()
        for path in (Path(raw) for raw in paths)
        if path.is_file() and is_editable_archive(path)
    }
    return sorted(editable, key=lambda path: natural_sort_key(path.name))


class PageEditorPanel(ttk.Frame):
    """ZIP を選んでページ順を修正する画面"""

    def __init__(self, parent: tk.Misc, log_callback=None):
        super().__init__(parent, padding="10")
        self.log_callback = log_callback
        self.archives: list[Path] = []

        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)
        self._build_widgets()
        self._update_buttons()

    def _build_widgets(self) -> None:
        ttk.Label(
            self,
            text="ページ順を修正したい ZIP / CBZ を選びます。"
            "整理モードとは独立していて、既にあるアーカイブをそのまま編集できます。",
            foreground="gray",
            wraplength=820,
            justify=tk.LEFT,
        ).grid(row=0, column=0, sticky=tk.W, pady=(0, 8))

        controls = ttk.Frame(self)
        controls.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 5))
        ttk.Button(controls, text="ファイルを選択", command=self.browse_files).pack(
            side=tk.LEFT, padx=(0, 5)
        )
        ttk.Button(controls, text="リストをクリア", command=self.clear).pack(
            side=tk.LEFT, padx=(0, 10)
        )
        ttk.Label(
            controls,
            text="📄 ここにドラッグ&ドロップ | ダブルクリックで開く",
            foreground="gray",
        ).pack(side=tk.LEFT)

        self.drop_frame = ttk.LabelFrame(self, text="Drag & Drop ZIP Here", padding="8")
        self.drop_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.drop_frame.columnconfigure(0, weight=1)
        self.drop_frame.rowconfigure(0, weight=1)

        self.listbox = tk.Listbox(self.drop_frame, selectmode=tk.BROWSE)
        self.listbox.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.listbox.bind("<Double-1>", lambda _event: self.edit_selected())
        self.listbox.bind("<<ListboxSelect>>", lambda _event: self._update_buttons())
        self.listbox.bind("<Delete>", lambda _event: self.remove_selected())

        scrollbar = ttk.Scrollbar(
            self.drop_frame, orient=tk.VERTICAL, command=self.listbox.yview
        )
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.listbox.config(yscrollcommand=scrollbar.set)

        actions = ttk.Frame(self)
        actions.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(8, 0))
        self.edit_button = ttk.Button(
            actions, text="ページ順を修正", command=self.edit_selected
        )
        self.edit_button.pack(side=tk.LEFT)
        self.summary_label = ttk.Label(actions, text="", foreground="gray")
        self.summary_label.pack(side=tk.LEFT, padx=(10, 0))

    def add_paths(self, paths) -> int:
        """アーカイブを一覧へ追加し、追加できた件数を返す"""
        candidates = collect_editable_archives(paths)
        added = [path for path in candidates if path not in self.archives]
        self.archives.extend(added)
        self.archives.sort(key=lambda path: natural_sort_key(path.name))
        self._refresh_list()
        if added and not self.listbox.curselection():
            self.listbox.selection_set(0)
        self._update_buttons()
        return len(added)

    def browse_files(self) -> None:
        """ファイルダイアログから追加する"""
        selected = filedialog.askopenfilenames(
            title="ページ順を修正するアーカイブを選択", filetypes=FILE_TYPES
        )
        if selected and self.add_paths(selected) == 0:
            messagebox.showinfo(
                "ページ修正", "追加できる ZIP / CBZ がありませんでした。", parent=self
            )

    def clear(self) -> None:
        """一覧を空にする"""
        self.archives.clear()
        self._refresh_list()
        self._update_buttons()

    def remove_selected(self) -> None:
        """選択中の 1 件を一覧から外す"""
        selected = self.selected_archive()
        if selected is not None:
            self.archives.remove(selected)
            self._refresh_list()
            self._update_buttons()

    def selected_archive(self) -> Path | None:
        """選択中のアーカイブ"""
        selection = self.listbox.curselection()
        if not selection:
            return None
        index = selection[0]
        return self.archives[index] if index < len(self.archives) else None

    def edit_selected(self) -> None:
        """選択中のアーカイブのページ修正 UI を開く"""
        target = self.selected_archive()
        if target is None:
            messagebox.showinfo(
                "ページ修正", "編集するアーカイブを選択してください。", parent=self
            )
            return
        open_page_editor(self.winfo_toplevel(), target, log_callback=self.log_callback)

    def _refresh_list(self) -> None:
        self.listbox.delete(0, tk.END)
        for path in self.archives:
            self.listbox.insert(tk.END, f"{path.name}    ({path.parent})")

    def _update_buttons(self) -> None:
        self.edit_button.config(
            state=tk.NORMAL if self.selected_archive() is not None else tk.DISABLED
        )
        self.summary_label.config(
            text=f"{len(self.archives)} 件" if self.archives else ""
        )
