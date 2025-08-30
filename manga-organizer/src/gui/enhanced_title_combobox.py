import tkinter as tk
from tkinter import ttk
from typing import List, Callable, Optional, Tuple
import logging

logger = logging.getLogger(__name__)


class EnhancedTitleCombobox(ttk.Frame):
    """Enhanced title combobox with API search integration"""
    
    def __init__(self, parent, database, on_select_func: Optional[Callable[[str, str], None]] = None, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.database = database
        self.on_select = on_select_func
        
        # Data storage
        self.all_db_items = []  # Complete DB list for reference
        self.current_filtered_items = []  # Currently displayed items
        self.last_search_text = ""
        self.dropdown_open = False
        
        # Track changes to avoid duplicate processing
        self.processing_change = False
        
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
        
        # Bind events
        self.combobox.bind('<<ComboboxSelected>>', self.on_selection)
        self.combobox.bind('<KeyRelease>', self.on_key_release)
        self.combobox.bind('<FocusOut>', self.on_focus_out)
        
        # Bind paste and cut events for proper author field updates
        self.combobox.bind('<<Paste>>', self.on_paste)
        self.combobox.bind('<<Cut>>', self.on_cut)
        self.combobox.bind('<Control-v>', self.on_paste)
        self.combobox.bind('<Control-x>', self.on_cut)
        
        # Watch for StringVar changes (catches all updates including paste)
        self.title_var.trace('w', self.on_title_var_changed)
    
    def refresh_from_database(self):
        """Refresh the list from database"""
        # Get recent manga from database
        recent = self.database.get_recent_manga(limit=100)
        
        self.all_db_items = []  # Store complete DB list
        self.current_filtered_items = []  # Currently displayed items
        display_values = []
        
        for title, author in recent:
            display_text = f"[DB] {title}"
            item = (display_text, title, author, 'DB')
            self.all_db_items.append(item)
            self.current_filtered_items.append(item)
            display_values.append(display_text)
        
        self.combobox['values'] = display_values
        logger.info(f"Loaded {len(recent)} titles from database")
    
    def on_key_release(self, event):
        """Handle typing for search with debounce"""
        # Handle special keys
        if event.keysym == 'Down':
            # Open dropdown on down arrow without stealing focus
            if not self.dropdown_open:
                self.dropdown_open = True
                self.combobox.event_generate('<<ComboboxPopdown>>')
            return
        elif event.keysym == 'Up':
            return
        elif event.keysym in ['Left', 'Right', 'Tab']:
            return
        elif event.keysym == 'Return':
            # Confirm current title
            self.confirm_title()
            return
        elif event.keysym == 'Escape':
            # Clear field and notify author field to clear
            self.title_var.set("")
            self.dropdown_open = False
            if self.on_select:
                self.on_select("", "")
            return
        
        # For regular typing, use the shared processing method
        self._process_title_change()

    
    def on_title_var_changed(self, *args):
        """Handle any change to title_var (including paste, cut, programmatic)"""
        # Avoid recursive processing
        if self.processing_change:
            return
            
        self.processing_change = True
        try:
            self._process_title_change()
        finally:
            self.processing_change = False
    
    def on_paste(self, event=None):
        """Handle paste event"""
        # After paste, the StringVar trace will handle the update
        # Just log for debugging
        logger.debug("Paste event detected")
        # Schedule processing after paste completes
        self.after(10, self._process_title_change)
        return None  # Allow default paste behavior
    
    def on_cut(self, event=None):
        """Handle cut event"""
        # After cut, the StringVar trace will handle the update
        logger.debug("Cut event detected")
        # Schedule processing after cut completes
        self.after(10, self._process_title_change)
        return None  # Allow default cut behavior
    
    def _process_title_change(self):
        """Process title change regardless of input method"""
        current_text = self.title_var.get()
        
        # Skip if text hasn't changed
        if current_text == self.last_search_text:
            return
        
        self.last_search_text = current_text
        logger.info(f"Processing title change: '{current_text}'")
        
        # IMPORTANT: Clear author field first when title changes
        # This ensures old author doesn't remain when switching titles
        if self.on_select:
            self.on_select(current_text, "")  # Clear author first
        
        if not current_text:
            # Show only database entries when empty
            self.refresh_from_database()
            return
        
        # Filter database entries immediately
        self.filter_and_show_suggestions(current_text)
        
        # Check if title exists in database (exact match)
        db_author = self.database.get_author_by_title(current_text)
        if db_author:
            # Found exact match in database, auto-fill author
            logger.info(f"DB match found: {current_text} -> {db_author}")
            if self.on_select:
                self.on_select(current_text, db_author)
        else:
            # No DB match - prepare for API search when author field is focused
            logger.info(f"No DB match for: {current_text}, will search API on author focus")
            if self.on_select:
                self.on_select(current_text, None)
    
    def filter_and_show_suggestions(self, search_text: str):
        """Filter and show database entries matching search text"""
        search_lower = search_text.lower()
        
        self.current_filtered_items = []  # Reset current filtered items
        display_values = []
        
        # Search from complete DB list
        for display_text, title, author, source in self.all_db_items:
            if search_lower in title.lower():
                self.current_filtered_items.append((display_text, title, author, source))
                display_values.append(display_text)
        
        self.combobox['values'] = display_values
        logger.debug(f"Filtered {len(display_values)} DB entries for '{search_text}'")
        
        # Auto-open dropdown if we have results
        if display_values and not self.dropdown_open:
            self.dropdown_open = True
            self.combobox.event_generate('<<ComboboxPopdown>>')
            # Keep focus on the input field
            self.combobox.focus_set()
    
    
    def on_selection(self, event=None):
        """Handle selection from dropdown"""
        selected_text = self.combobox.get()
        
        # Find the corresponding item from current filtered items
        for display_text, title, author, source in self.current_filtered_items:
            if display_text == selected_text:
                # Update combobox to show just the title
                self.title_var.set(title)
                
                # Notify callback with title and author
                if self.on_select:
                    self.on_select(title, author)
                
                # Don't save to database automatically - will save during repackaging
                # Just log the selection
                logger.info(f"Selected: {title} by {author} (source: {source})")
                
                # Close dropdown after selection
                self.dropdown_open = False
                
                break
    
    def on_focus_out(self, event=None):
        """Handle focus out event"""
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
    
    def confirm_title(self):
        """Confirm the current title and trigger author search"""
        current_text = self.title_var.get()
        if current_text:
            # Check if exact DB match exists
            db_author = self.database.get_author_by_title(current_text)
            if db_author and self.on_select:
                # DB exact match - auto-fill author
                self.on_select(current_text, db_author)
            elif self.on_select:
                # No DB match - prepare for API search when author field is focused
                self.on_select(current_text, None)

    def refresh(self):
        """Refresh data from database"""
        self.refresh_from_database()