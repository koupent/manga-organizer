import tkinter as tk
from tkinter import ttk
import threading
from typing import List, Callable, Optional, Tuple
import logging

from core.api_client import MangaMetadataFetcher

logger = logging.getLogger(__name__)


class EnhancedTitleCombobox(ttk.Frame):
    """Enhanced title combobox with API search integration"""
    
    def __init__(self, parent, database, on_select_func: Optional[Callable[[str, str], None]] = None, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.database = database
        self.on_select = on_select_func
        self.metadata_fetcher = MangaMetadataFetcher()
        
        # Data storage
        self.all_items = []  # [(display_text, title, author, source), ...]
        self.api_search_thread = None
        self.last_search_text = ""
        
        # Debounce control
        self.search_timer = None
        self.debounce_delay = 500  # milliseconds
        self.dropdown_open = False
        
        # Create UI
        self.setup_ui()
        
        # Load initial data from database
        self.refresh_from_database()
    
    def setup_ui(self):
        """Setup the UI components"""
        # Title combobox
        self.title_var = tk.StringVar()
        self.combobox = ttk.Combobox(self, textvariable=self.title_var, width=40)
        self.combobox.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        # Loading indicator (initially hidden)
        self.loading_label = ttk.Label(self, text="検索中...", foreground="gray")
        # Don't pack initially
        
        # Bind events
        self.combobox.bind('<<ComboboxSelected>>', self.on_selection)
        self.combobox.bind('<KeyRelease>', self.on_key_release)
        self.combobox.bind('<FocusOut>', self.on_focus_out)
    
    def refresh_from_database(self):
        """Refresh the list from database"""
        # Get recent manga from database
        recent = self.database.get_recent_manga(limit=100)
        
        self.all_items = []
        display_values = []
        
        for title, author in recent:
            display_text = f"[DB] {title}"
            self.all_items.append((display_text, title, author, 'DB'))
            display_values.append(display_text)
        
        self.combobox['values'] = display_values
        logger.info(f"Loaded {len(recent)} titles from database")
    
    def on_key_release(self, event):
        """Handle typing for search with debounce"""
        # Handle special keys
        if event.keysym == 'Down':
            # Open dropdown on down arrow
            if not self.dropdown_open:
                self.combobox.event_generate('<Button-1>')
                self.dropdown_open = True
            return
        elif event.keysym == 'Up':
            return
        elif event.keysym in ['Left', 'Right', 'Return', 'Tab', 'Escape']:
            return
        
        # Cancel previous timer if exists
        if self.search_timer:
            self.after_cancel(self.search_timer)
            self.search_timer = None
        
        current_text = self.title_var.get()
        
        # Skip if text hasn't changed
        if current_text == self.last_search_text:
            return
        
        self.last_search_text = current_text
        
        if not current_text:
            # Show only database entries when empty
            self.refresh_from_database()
            return
        
        # Filter database entries immediately (no delay)
        self.filter_database_entries(current_text)
        
        # Check if title exists in database (exact match)
        db_author = self.database.get_author_by_title(current_text)
        if db_author:
            # Found exact match in database, auto-fill author
            if self.on_select:
                self.on_select(current_text, db_author)
            return
        
        # If not in database and text is long enough, search APIs with debounce
        if len(current_text) >= 3:
            # Set timer for API search
            self.search_timer = self.after(self.debounce_delay, lambda: self.search_apis(current_text))
    
    def filter_database_entries(self, search_text: str):
        """Filter and show database entries matching search text"""
        search_lower = search_text.lower()
        
        filtered_items = []
        display_values = []
        
        for display_text, title, author, source in self.all_items:
            if source == 'DB' and search_lower in title.lower():
                filtered_items.append((display_text, title, author, source))
                display_values.append(display_text)
        
        self.combobox['values'] = display_values
    
    def search_apis(self, search_text: str):
        """Search APIs for manga metadata"""
        # Cancel previous search if running
        if self.api_search_thread and self.api_search_thread.is_alive():
            return
        
        # Show loading indicator
        self.loading_label.pack(side=tk.LEFT, padx=(5, 0))
        
        # Start search in background thread
        self.api_search_thread = threading.Thread(
            target=self._api_search_worker,
            args=(search_text,),
            daemon=True
        )
        self.api_search_thread.start()
    
    def _api_search_worker(self, search_text: str):
        """Worker thread for API search"""
        try:
            # Search APIs
            results = self.metadata_fetcher.search(search_text)
            
            # Update UI in main thread
            self.after(0, self._update_with_api_results, search_text, results)
            
        except Exception as e:
            logger.error(f"API search error: {e}")
            self.after(0, self._hide_loading)
    
    def _update_with_api_results(self, search_text: str, results: List[dict]):
        """Update combobox with API results"""
        # Hide loading indicator
        self._hide_loading()
        
        # Only update if search text hasn't changed
        if self.title_var.get() != search_text:
            return
        
        # Keep existing DB entries that match
        search_lower = search_text.lower()
        
        filtered_items = []
        display_values = []
        
        # Add matching DB entries first
        for display_text, title, author, source in self.all_items:
            if source == 'DB' and search_lower in title.lower():
                filtered_items.append((display_text, title, author, source))
                display_values.append(display_text)
        
        # Add API results
        for result in results:
            title = result.get('title', '')
            title_japanese = result.get('title_japanese', '')
            authors = result.get('authors', [])
            source = result.get('source', 'API')
            
            if authors:
                author = authors[0]  # Use first author
                
                # Use Japanese title if available
                display_title = title_japanese if title_japanese else title
                display_text = f"[{source}] {display_title} - {author}"
                
                # Check if not already in list (avoid duplicates)
                if not any(item[1] == display_title and item[2] == author for item in filtered_items):
                    filtered_items.append((display_text, display_title, author, source))
                    display_values.append(display_text)
        
        # Update items and combobox values without opening dropdown
        self.all_items = filtered_items
        self.combobox['values'] = display_values
        
        # Don't automatically open dropdown - let user control it
        # User can press Down arrow to see results
    
    def _hide_loading(self):
        """Hide the loading indicator"""
        self.loading_label.pack_forget()
    
    def on_selection(self, event=None):
        """Handle selection from dropdown"""
        selected_text = self.combobox.get()
        
        # Find the corresponding item
        for display_text, title, author, source in self.all_items:
            if display_text == selected_text:
                # Update combobox to show just the title
                self.title_var.set(title)
                
                # Notify callback with title and author
                if self.on_select:
                    self.on_select(title, author)
                
                # Save to database if from API
                if source != 'DB':
                    self.database.save_manga_info(title, author)
                    logger.info(f"Saved to database: {title} by {author}")
                    # Refresh to include in DB entries
                    self.refresh_from_database()
                
                logger.info(f"Selected: {title} by {author} (source: {source})")
                break
    
    def on_focus_out(self, event=None):
        """Handle focus out event"""
        # Hide loading if shown
        self._hide_loading()
        
        # Check if current text matches a title in database
        current_text = self.title_var.get()
        if current_text:
            db_author = self.database.get_author_by_title(current_text)
            if db_author and self.on_select:
                self.on_select(current_text, db_author)
    
    def get_title(self) -> str:
        """Get the current title text"""
        return self.title_var.get()
    
    def set_title(self, title: str):
        """Set the title text"""
        self.title_var.set(title)
    
    def refresh(self):
        """Refresh data from database"""
        self.refresh_from_database()