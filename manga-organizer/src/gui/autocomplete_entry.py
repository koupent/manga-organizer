import tkinter as tk
from tkinter import ttk
from typing import List, Callable, Optional
import logging

logger = logging.getLogger(__name__)


class AutocompleteEntry(ttk.Entry):
    """Entry widget with autocomplete functionality"""
    
    def __init__(self, parent, get_suggestions_func: Callable[[str], List[str]], 
                 on_select_func: Optional[Callable[[str], None]] = None, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.get_suggestions = get_suggestions_func
        self.on_select = on_select_func
        self.listbox = None
        self.listbox_window = None
        
        # Bind events
        self.bind('<KeyRelease>', self.on_key_release)
        self.bind('<FocusOut>', self.hide_listbox)
        self.bind('<Down>', self.on_down_arrow)
        self.bind('<Return>', self.on_return)
        
    def on_key_release(self, event):
        """Handle key release events"""
        if event.keysym in ['Up', 'Down', 'Left', 'Right', 'Return', 'Tab']:
            return
        
        value = self.get().strip()
        if len(value) < 1:
            self.hide_listbox()
            return
        
        # Get suggestions
        suggestions = self.get_suggestions(value)
        
        if suggestions:
            self.show_listbox(suggestions)
        else:
            self.hide_listbox()
    
    def show_listbox(self, suggestions: List[str]):
        """Show the suggestion listbox"""
        if not self.listbox_window:
            # Create toplevel window for listbox
            self.listbox_window = tk.Toplevel(self)
            self.listbox_window.overrideredirect(True)
            self.listbox_window.configure(bg='white', highlightthickness=1, highlightbackground='gray')
            
            # Create listbox
            self.listbox = tk.Listbox(self.listbox_window, height=min(len(suggestions), 5),
                                     selectmode=tk.SINGLE, activestyle='dotbox')
            self.listbox.pack(fill=tk.BOTH, expand=True)
            
            # Bind listbox events
            self.listbox.bind('<Button-1>', self.on_listbox_click)
            self.listbox.bind('<Return>', self.on_listbox_select)
        
        # Clear and populate listbox
        self.listbox.delete(0, tk.END)
        for suggestion in suggestions[:10]:  # Limit to 10 suggestions
            self.listbox.insert(tk.END, suggestion)
        
        # Position the window below the entry
        x = self.winfo_rootx()
        y = self.winfo_rooty() + self.winfo_height()
        width = self.winfo_width()
        
        self.listbox_window.geometry(f"{width}x100+{x}+{y}")
        
        # Configure listbox size
        self.listbox.configure(height=min(len(suggestions), 5))
        
        # Select first item by default
        if suggestions:
            self.listbox.selection_set(0)
            self.listbox.activate(0)
    
    def hide_listbox(self, event=None):
        """Hide the suggestion listbox"""
        if self.listbox_window:
            self.listbox_window.destroy()
            self.listbox_window = None
            self.listbox = None
    
    def on_down_arrow(self, event):
        """Handle down arrow key"""
        if self.listbox and self.listbox.size() > 0:
            current = self.listbox.curselection()
            if current:
                next_idx = min(current[0] + 1, self.listbox.size() - 1)
            else:
                next_idx = 0
            
            self.listbox.selection_clear(0, tk.END)
            self.listbox.selection_set(next_idx)
            self.listbox.activate(next_idx)
            return 'break'
    
    def on_return(self, event):
        """Handle return key"""
        if self.listbox and self.listbox.curselection():
            self.on_listbox_select()
            return 'break'
    
    def on_listbox_click(self, event):
        """Handle listbox click"""
        self.on_listbox_select()
    
    def on_listbox_select(self, event=None):
        """Handle selection from listbox"""
        if self.listbox and self.listbox.curselection():
            selected = self.listbox.get(self.listbox.curselection())
            self.delete(0, tk.END)
            self.insert(0, selected)
            
            # Call the callback if provided
            if self.on_select:
                self.on_select(selected)
            
            self.hide_listbox()
            
            # Move focus to next widget
            self.event_generate('<Tab>')


class TitleAuthorPair:
    """Widget pair for title and author with autocomplete and database integration"""
    
    def __init__(self, parent, database):
        self.database = database
        self.parent = parent
        
        # Create frame for the pair
        self.frame = ttk.Frame(parent)
        
        # Title label and entry (LEFT)
        ttk.Label(self.frame, text="Title:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.title_entry = AutocompleteEntry(
            self.frame,
            get_suggestions_func=self.get_title_suggestions,
            on_select_func=self.on_title_selected,
            width=35
        )
        self.title_entry.grid(row=0, column=1, padx=(0, 20))
        
        # Author label and entry (RIGHT)
        ttk.Label(self.frame, text="Author:").grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        self.author_entry = ttk.Entry(self.frame, width=35)
        self.author_entry.grid(row=0, column=3)
    
    def get_title_suggestions(self, query: str) -> List[str]:
        """Get title suggestions from database"""
        results = self.database.search_titles(query, limit=10)
        return [title for title, _ in results]
    
    def on_title_selected(self, title: str):
        """When a title is selected, auto-fill the author"""
        author = self.database.get_author_by_title(title)
        if author:
            self.author_entry.delete(0, tk.END)
            self.author_entry.insert(0, author)
            logger.info(f"Auto-filled author '{author}' for title '{title}'")
    
    def get_title(self) -> str:
        """Get the current title value"""
        return self.title_entry.get().strip()
    
    def get_author(self) -> str:
        """Get the current author value"""
        return self.author_entry.get().strip()
    
    def set_title(self, title: str):
        """Set the title value"""
        self.title_entry.delete(0, tk.END)
        self.title_entry.insert(0, title)
    
    def set_author(self, author: str):
        """Set the author value"""
        self.author_entry.delete(0, tk.END)
        self.author_entry.insert(0, author)
    
    def clear(self):
        """Clear both fields"""
        self.title_entry.delete(0, tk.END)
        self.author_entry.delete(0, tk.END)
    
    def grid(self, **kwargs):
        """Grid the frame"""
        self.frame.grid(**kwargs)
        return self