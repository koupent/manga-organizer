import tkinter as tk
from tkinter import ttk
from typing import List, Callable, Optional
import logging
import threading
from gui.enhanced_title_combobox import EnhancedTitleCombobox

logger = logging.getLogger(__name__)


class TitleCombobox(ttk.Combobox):
    """Combobox for title with autocomplete and database integration"""
    
    def __init__(self, parent, database, on_select_func: Optional[Callable[[str, str], None]] = None, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.database = database
        self.on_select = on_select_func
        self.all_titles = []
        
        # Load initial data
        self.refresh_titles()
        
        # Bind events
        self.bind('<<ComboboxSelected>>', self.on_selection)
        self.bind('<KeyRelease>', self.on_key_release)
        
    def refresh_titles(self):
        """Refresh the list of titles from database"""
        # Get recent manga (sorted by most recent first)
        recent = self.database.get_recent_manga(limit=100)
        self.all_titles = [(title, author) for title, author in recent]
        
        # Update dropdown values (show only titles)
        self['values'] = [title for title, _ in self.all_titles]
        
        logger.info(f"Loaded {len(self.all_titles)} titles from database")
    
    def on_selection(self, event=None):
        """Handle selection from dropdown"""
        selected_title = self.get()
        
        # Find the corresponding author
        for title, author in self.all_titles:
            if title == selected_title:
                if self.on_select:
                    self.on_select(title, author)
                logger.info(f"Selected: {title} by {author}")
                break
    
    def on_key_release(self, event):
        """Handle typing for autocomplete"""
        if event.keysym in ['Up', 'Down', 'Left', 'Right', 'Return', 'Tab']:
            return
        
        typed_text = self.get().lower()
        if not typed_text:
            # Show all titles if empty
            self['values'] = [title for title, _ in self.all_titles]
            return
        
        # Filter titles based on typed text
        filtered = []
        for title, author in self.all_titles:
            if typed_text in title.lower():
                filtered.append(title)
        
        # Update dropdown with filtered values
        self['values'] = filtered
        
        # If there's a match and it's the only one, check if we should auto-fill
        if len(filtered) == 1 and filtered[0].lower() == typed_text:
            for title, author in self.all_titles:
                if title == filtered[0]:
                    if self.on_select:
                        self.on_select(title, author)
                    break
    
    def set_title(self, title: str):
        """Set the title value"""
        self.set(title)
        # Trigger selection to auto-fill author
        self.on_selection()


class TitleAuthorCombo:
    """Widget pair for title dropdown and author entry with API search"""
    
    def __init__(self, parent, database):
        self.database = database
        self.parent = parent
        
        # Create frame for the pair
        self.frame = ttk.Frame(parent)
        
        # Title label and enhanced combobox with API search (LEFT)
        ttk.Label(self.frame, text="Title:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.title_combo = EnhancedTitleCombobox(
            self.frame,
            database=self.database,
            on_select_func=self.on_title_selected
        )
        self.title_combo.grid(row=0, column=1, padx=(0, 20))
        
        # Author label and entry (RIGHT)
        ttk.Label(self.frame, text="Author:").grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        self.author_entry = ttk.Entry(self.frame, width=35)
        self.author_entry.grid(row=0, column=3)
        
        # Refresh button for title dropdown
        ttk.Button(
            self.frame, 
            text="↻", 
            width=3,
            command=self.refresh
        ).grid(row=0, column=4, padx=(5, 0))
    
    def on_title_selected(self, title: str, author: str):
        """When a title is selected, auto-fill the author"""
        self.author_entry.delete(0, tk.END)
        self.author_entry.insert(0, author)
        logger.info(f"Auto-filled author '{author}' for title '{title}'")
    
    def get_title(self) -> str:
        """Get the current title value"""
        return self.title_combo.get().strip()
    
    def get_author(self) -> str:
        """Get the current author value"""
        return self.author_entry.get().strip()
    
    def set_title(self, title: str):
        """Set the title value"""
        self.title_combo.set_title(title)
    
    def set_author(self, author: str):
        """Set the author value"""
        self.author_entry.delete(0, tk.END)
        self.author_entry.insert(0, author)
    
    def clear(self):
        """Clear both fields"""
        self.title_combo.set("")
        self.author_entry.delete(0, tk.END)
    
    def refresh(self):
        """Refresh the title dropdown"""
        self.title_combo.refresh()
    
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
            self.refresh()  # Refresh to update the dropdown