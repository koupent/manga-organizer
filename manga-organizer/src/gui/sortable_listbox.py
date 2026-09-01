import logging
import re
import tkinter as tk
from pathlib import Path
from tkinter import ttk

logger = logging.getLogger(__name__)


def natural_sort_key(text: str):
    """Generate a key for natural sorting (1, 2, 10 instead of 1, 10, 2)"""

    def convert(part):
        return int(part) if part.isdigit() else part

    # Split text into numeric and non-numeric parts
    parts = re.split(r"(\d+)", text.lower())
    # Convert numeric parts to integers for proper sorting
    return [convert(part) for part in parts if part]


class SortableListbox(tk.Frame):
    """Listbox with drag-and-drop reordering and Delete key support"""

    def __init__(self, parent, **kwargs):
        super().__init__(parent, **kwargs)

        self.items: list[Path] = []
        self.drag_start_index = None

        # Create listbox with scrollbar
        self.create_widgets()

    def create_widgets(self):
        """Create the listbox and associated widgets"""
        # Create frame for listbox and scrollbar
        list_frame = ttk.Frame(self)
        list_frame.pack(fill=tk.BOTH, expand=True)

        # Create listbox
        self.listbox = tk.Listbox(list_frame, selectmode=tk.EXTENDED)
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Create scrollbar
        scrollbar = ttk.Scrollbar(
            list_frame, orient=tk.VERTICAL, command=self.listbox.yview
        )
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox.config(yscrollcommand=scrollbar.set)

        # Bind drag and drop events for reordering
        self.listbox.bind("<Button-1>", self.on_drag_start)
        self.listbox.bind("<B1-Motion>", self.on_drag_motion)
        self.listbox.bind("<ButtonRelease-1>", self.on_drag_release)

        # Bind Delete key for removing items
        self.listbox.bind("<Delete>", lambda e: self.remove_selected())
        self.listbox.bind("<BackSpace>", lambda e: self.remove_selected())  # For Mac

        # Bind keyboard shortcuts
        self.listbox.bind("<Control-a>", lambda e: self.select_all())
        self.listbox.bind("<Control-A>", lambda e: self.select_all())

        # Visual feedback during drag
        self.drag_line = None

    def add_item(self, path: Path):
        """Add an item to the list"""
        if path not in self.items:
            self.items.append(path)
            # Insert in natural sorted position
            self.refresh_display()
            logger.debug(f"Added item: {path.name}")

    def add_items(self, paths: list[Path]):
        """Add multiple items to the list"""
        for path in paths:
            if path not in self.items:
                self.items.append(path)
        # Refresh once after adding all items
        self.refresh_display()

    def refresh_display(self):
        """Refresh the listbox display with natural sorting"""
        # Sort items using natural sort
        self.items.sort(key=lambda p: natural_sort_key(p.name))

        # Update listbox
        self.listbox.delete(0, tk.END)
        for item in self.items:
            self.listbox.insert(tk.END, item.name)

    def clear(self):
        """Clear all items"""
        self.items.clear()
        self.listbox.delete(0, tk.END)
        logger.debug("Cleared all items")

    def get_items(self) -> list[Path]:
        """Get the current list of items in order"""
        return self.items.copy()

    def remove_selected(self):
        """Remove selected items"""
        selection = self.listbox.curselection()
        if not selection:
            return

        # Remove items in reverse order to maintain indices
        for index in reversed(selection):
            del self.items[index]
            self.listbox.delete(index)

        logger.debug(f"Removed {len(selection)} items")

    def remove_item(self, path: Path):
        """Remove a specific item by path"""
        try:
            index = self.items.index(path)
            del self.items[index]
            self.listbox.delete(index)
            logger.debug(f"Removed item: {path.name}")
        except ValueError:
            logger.debug(f"Item not found for removal: {path.name}")

    def on_drag_start(self, event):
        """Start dragging an item"""
        index = self.listbox.nearest(event.y)
        if index >= 0:
            self.drag_start_index = index
            self.listbox.selection_clear(0, tk.END)
            self.listbox.selection_set(index)

    def on_drag_motion(self, event):
        """Handle drag motion"""
        if self.drag_start_index is None:
            return

        # Get current position
        current_index = self.listbox.nearest(event.y)

        # Show visual feedback
        if 0 <= current_index < len(self.items):
            self.listbox.selection_clear(0, tk.END)
            self.listbox.selection_set(self.drag_start_index)

            # Update cursor to show drag is active
            self.listbox.config(cursor="hand2")

    def on_drag_release(self, event):
        """Complete the drag operation"""
        if self.drag_start_index is None:
            return

        # Reset cursor
        self.listbox.config(cursor="")

        # Get drop position
        drop_index = self.listbox.nearest(event.y)

        if drop_index >= 0 and drop_index != self.drag_start_index:
            # Move the item
            item = self.items.pop(self.drag_start_index)
            self.items.insert(drop_index, item)

            # Update listbox
            self.listbox.delete(0, tk.END)
            for item in self.items:
                self.listbox.insert(tk.END, item.name)

            # Select the moved item
            self.listbox.selection_set(drop_index)

            logger.debug(f"Moved item from {self.drag_start_index} to {drop_index}")

        self.drag_start_index = None

    def get_selected_indices(self) -> list[int]:
        """Get indices of selected items"""
        return list(self.listbox.curselection())

    def select_all(self):
        """Select all items"""
        self.listbox.selection_set(0, tk.END)

    def deselect_all(self):
        """Deselect all items"""
        self.listbox.selection_clear(0, tk.END)
