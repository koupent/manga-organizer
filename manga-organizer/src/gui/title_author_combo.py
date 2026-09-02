import logging
import tkinter as tk
from collections.abc import Callable
from tkinter import ttk

from gui.enhanced_author_combobox import EnhancedAuthorCombobox

logger = logging.getLogger(__name__)


class SimpleTitleCombobox(ttk.Combobox):
    """Simple combobox for title selection from database"""

    def __init__(
        self,
        parent,
        database,
        on_change_func: Callable[[str], None] | None = None,
        **kwargs,
    ):
        super().__init__(parent, **kwargs)

        self.database = database
        self.on_change = on_change_func
        self.all_titles = []

        # Load initial data
        self.refresh_titles()

        # Bind events
        self.bind("<<ComboboxSelected>>", self.on_selection)
        self.bind("<KeyRelease>", self.on_key_release)

    def refresh_titles(self):
        """Refresh the list of titles from database"""
        # Get recent manga (sorted by most recent first)
        recent = self.database.get_recent_manga(limit=100)
        self.all_titles = [(title, author) for title, author in recent]

        # Update dropdown values (show only titles)
        self["values"] = [title for title, _ in self.all_titles]

        logger.info(f"Loaded {len(self.all_titles)} titles from database")

    def on_selection(self, event=None):
        """Handle selection from dropdown"""
        selected_title = self.get()
        if self.on_change:
            self.on_change(selected_title)

    def on_key_release(self, event):
        """Handle typing for autocomplete and trigger author search"""
        if event.keysym in ["Up", "Down", "Left", "Right", "Tab"]:
            return

        # For Return key, trigger author search
        if event.keysym == "Return":
            if self.on_change:
                self.on_change(self.get())
            return

        typed_text = self.get().lower()
        if not typed_text:
            # Show all titles if empty
            self["values"] = [title for title, _ in self.all_titles]
            return

        # Filter titles based on typed text
        filtered = []
        for title, _author in self.all_titles:
            if typed_text in title.lower():
                filtered.append(title)

        # Update dropdown with filtered values
        self["values"] = filtered

        # Trigger author search after typing
        if self.on_change:
            self.on_change(self.get())


class TitleAuthorCombo:
    """Widget pair for title dropdown and author dropdown with API search"""

    def __init__(self, parent, database):
        self.database = database
        self.parent = parent

        # Create frame for the pair
        self.frame = ttk.Frame(parent)

        # Title label and simple combobox (LEFT)
        ttk.Label(self.frame, text="Title:").grid(
            row=0, column=0, sticky=tk.W, padx=(0, 5)
        )
        self.title_combo = SimpleTitleCombobox(
            self.frame,
            database=self.database,
            on_change_func=self.on_title_changed,
            width=40,
        )
        self.title_combo.grid(row=0, column=1, padx=(0, 20))

        # Author label and enhanced combobox with API search (RIGHT)
        ttk.Label(self.frame, text="Author:").grid(
            row=0, column=2, sticky=tk.W, padx=(0, 5)
        )
        self.author_combo = EnhancedAuthorCombobox(self.frame, database=self.database)
        self.author_combo.grid(row=0, column=3)

        # Refresh button for title dropdown
        ttk.Button(self.frame, text="↻", width=3, command=self.refresh).grid(
            row=0, column=4, padx=(5, 0)
        )

    def on_title_changed(self, title: str):
        """When title changes, search for author suggestions"""
        if title:
            logger.info(f"Title changed to: {title}")
            # Trigger author search for this title
            self.author_combo.search_author_for_title(title)

    def get_title(self) -> str:
        """Get the current title value"""
        return self.title_combo.get().strip()

    def get_author(self) -> str:
        """Get the current author value"""
        return self.author_combo.get_author()

    def set_title(self, title: str):
        """Set the title value"""
        self.title_combo.set(title)
        # Trigger author search
        self.on_title_changed(title)

    def set_author(self, author: str):
        """Set the author value"""
        self.author_combo.set_author(author)

    def clear(self):
        """Clear both fields"""
        self.title_combo.set("")
        self.author_combo.clear()

    def refresh(self):
        """Refresh the title dropdown"""
        self.title_combo.refresh_titles()

    def grid(self, **kwargs):
        """Grid the frame"""
        self.frame.grid(**kwargs)
        return self

    def save_to_database(self):
        """Save current title and author to database"""
        title = self.get_title()
        author = self.get_author()
        if title and author:
            self.database.save_manga_info(title, author)
            logger.info(f"Saved to DB: {title} by {author}")

            # Update UI to reflect DB save
            self.refresh()  # Refresh title dropdown

            # Change author color to blue (DB registered)
            if hasattr(self.author_combo, "combobox"):
                self.author_combo.combobox.configure(
                    foreground="#1976d2"
                )  # Blue for DB

            return True
        return False  # Refresh to update the dropdown
