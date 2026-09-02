import logging
import threading
import tkinter as tk
from tkinter import ttk

from manga_core.api_client import MangaMetadataFetcher

logger = logging.getLogger(__name__)


class EnhancedAuthorCombobox(ttk.Frame):
    """Enhanced author combobox with API search integration based on title"""

    def __init__(self, parent, database, **kwargs):
        super().__init__(parent, **kwargs)

        self.database = database
        self.metadata_fetcher = MangaMetadataFetcher()

        # Data storage
        self.author_suggestions = []  # List of author names
        self.api_search_thread = None
        self.current_title = ""
        self.pending_title = None  # Title to search when field gets focus

        # Create UI
        self.setup_ui()

    def setup_ui(self):
        """Setup the UI components"""
        # Author combobox
        self.author_var = tk.StringVar()
        self.combobox = ttk.Combobox(self, textvariable=self.author_var, width=35)
        self.combobox.pack(side=tk.LEFT, fill=tk.X, expand=True)

        # Loading indicator (initially hidden)
        self.loading_label = ttk.Label(self, text="検索中...", foreground="gray")
        # Don't pack initially

        # Track dropdown state
        self.dropdown_open = False

        # Bind events
        self.combobox.bind("<<ComboboxSelected>>", self.on_selection)
        self.combobox.bind("<FocusIn>", self.on_focus_in)
        self.combobox.bind("<Button-1>", self.on_click)
        self.combobox.bind("<KeyRelease>", self.on_key_release)

    def search_author_for_title(self, title: str):
        """Search author based on title - automatic API search when 2+ characters"""
        # Reset state and clear author field first
        self.current_title = title
        self.pending_title = None
        self.author_suggestions = []

        # Cancel any existing search thread
        if self.api_search_thread and self.api_search_thread.is_alive():
            pass  # Thread will finish naturally

        # Clear author field first when title changes
        # This ensures old author doesn't remain
        self.author_var.set("")
        self.combobox["values"] = []
        self.combobox.configure(foreground="black")  # Reset to default color
        self.dropdown_open = False

        if not title:
            self.clear()
            return

        # First check database for exact match
        db_author = self.database.get_author_by_title(title)
        if db_author:
            # DB match found - auto-fill immediately
            self.author_suggestions = [db_author]
            self.combobox["values"] = self.author_suggestions
            self.author_var.set(db_author)
            self.combobox.configure(foreground="#1976d2")  # Blue for DB
            self.pending_title = None  # No API search needed
            logger.info(f"DB match found: {title} -> {db_author}")
            return

        # No DB match - start API search automatically when 2+ characters
        if len(title) >= 2:
            logger.info(f"Starting automatic API search for: {title}")

            # Show loading indicator
            self.loading_label.pack(side=tk.LEFT, padx=(5, 0))

            # Start API search immediately
            self.api_search_thread = threading.Thread(
                target=self._api_search_worker, args=(title,), daemon=True
            )
            self.api_search_thread.start()

    def _api_search_worker(self, title: str):
        """Worker thread for API search"""
        try:
            # Search APIs for the title
            results = self.metadata_fetcher.search(title)

            # Extract unique authors from results
            authors_set = set()
            authors_list = []

            for result in results:
                # Get authors from the result
                result_authors = result.get("authors", [])
                for author in result_authors:
                    if author and author not in authors_set:
                        authors_set.add(author)
                        authors_list.append(author)

            # Update UI in main thread
            self.after(0, self._update_with_api_results, title, authors_list)

        except Exception as e:
            logger.error(f"API search error: {e}")
            self.after(0, self._hide_loading)

    def _update_with_api_results(self, title: str, authors: list[str]):
        """Update combobox with API results"""
        # Hide loading indicator
        self._hide_loading()

        # Only update if title hasn't changed
        if self.current_title != title:
            return

        self.author_suggestions = authors
        self.combobox["values"] = authors

        # If we have suggestions, show them
        if authors:
            logger.info(f"Found {len(authors)} author suggestions for '{title}'")
            # Set the first suggestion and color (yellow for API)
            if not self.author_var.get():
                self.author_var.set(authors[0])
                self.combobox.configure(foreground="#ffa726")  # Yellow for API

            # Open dropdown to show suggestions
            if not self.dropdown_open:
                self.dropdown_open = True
                self.combobox.event_generate("<<ComboboxPopdown>>")
                self.combobox.focus_set()
        else:
            logger.info(f"No author suggestions found for '{title}'")

    def _hide_loading(self):
        """Hide the loading indicator"""
        self.loading_label.pack_forget()

    def on_selection(self, event=None):
        """Handle selection from dropdown"""
        selected_author = self.combobox.get()
        logger.info(f"Selected author: {selected_author}")
        # Don't save to database immediately - will save during repackaging

        # Close dropdown after selection by multiple methods
        self.dropdown_open = False

        # Method 1: Generate Escape key event to close dropdown
        self.combobox.event_generate("<Escape>")

        # Method 2: Move focus away and back to ensure dropdown closes
        self.after(10, lambda: self.focus_set())

        # Method 3: Clear and reset the state
        self.after(50, lambda: self.combobox.selection_clear())

    def on_focus_in(self, event=None):
        """Handle focus in; API search runs automatically elsewhere."""
        # API search is now automatic when title is 2+ characters
        # This method is kept for potential future use or dropdown control
        pass

    def on_click(self, event=None):
        """Handle click event - toggle dropdown"""
        if self.author_suggestions and len(self.author_suggestions) > 1:
            if not self.dropdown_open:
                self.dropdown_open = True
                # Let the default behavior handle opening
            else:
                self.dropdown_open = False
                # Close by moving focus
                self.focus_set()

    def on_key_release(self, event):
        """Handle key release events"""
        if event.keysym == "Escape":
            # Clear the field
            self.clear()
            return
        elif event.keysym in ["Return", "Tab"]:
            # Confirm selection
            self.dropdown_open = False
            return

        # If user is typing manually, set black color
        if self.author_var.get() and not self.author_suggestions:
            self.combobox.configure(foreground="black")  # Manual input

    def get_author(self) -> str:
        """Get the current author text"""
        return self.author_var.get().strip()

    def set_author(self, author: str):
        """Set the author text"""
        self.author_var.set(author)
        self.author_suggestions = [author]
        self.combobox["values"] = self.author_suggestions
        # Set blue color as this is typically from DB
        self.combobox.configure(foreground="#1976d2")

    def clear(self):
        """Clear the author field"""
        self.author_var.set("")
        self.author_suggestions = []
        self.combobox["values"] = []
        self.current_title = ""
        self.pending_title = None
        self.dropdown_open = False
        # Reset color to default
        self.combobox.configure(foreground="black")
        # Hide loading if shown
        self.loading_label.pack_forget()
