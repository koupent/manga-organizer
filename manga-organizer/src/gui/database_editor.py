import tkinter as tk
from tkinter import ttk, messagebox, simpledialog, filedialog
from pathlib import Path
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class DatabaseEditorWindow:
    """Window for editing manga database entries"""
    
    def __init__(self, parent, database):
        self.parent = parent
        self.database = database
        self.window = None
        self.tree = None
        self.search_var = tk.StringVar()
        self.all_items = []
        
    def show(self):
        """Show the database editor window as modal"""
        if self.window and self.window.winfo_exists():
            self.window.lift()
            return
            
        self.window = tk.Toplevel(self.parent)
        self.window.title("データベース編集 - Manga Database Editor")
        self.window.geometry("800x600")
        
        # Make window modal
        self.window.transient(self.parent)  # Set parent window
        self.window.grab_set()  # Grab all events
        
        # Handle window close event
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        
        self.setup_ui()
        self.load_data()
        
        # Center window on parent
        self.center_window()
        
        # Wait for window to close (blocks parent)
        self.window.wait_window()
        
    def setup_ui(self):
        """Setup the UI components"""
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Configure grid weights
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)
        
        # Search frame
        search_frame = ttk.Frame(main_frame)
        search_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(search_frame, text="検索:").pack(side=tk.LEFT, padx=(0, 5))
        search_entry = ttk.Entry(search_frame, textvariable=self.search_var, width=30)
        search_entry.pack(side=tk.LEFT, padx=(0, 5))
        search_entry.bind('<KeyRelease>', self.on_search)
        
        ttk.Button(search_frame, text="クリア", command=self.clear_search).pack(side=tk.LEFT)
        
        # Treeview for displaying manga
        tree_frame = ttk.Frame(main_frame)
        tree_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        tree_frame.columnconfigure(0, weight=1)
        tree_frame.rowconfigure(0, weight=1)
        
        # Create treeview with scrollbars
        self.tree = ttk.Treeview(tree_frame, columns=('author', 'created', 'updated'), show='tree headings')
        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Configure columns
        self.tree.heading('#0', text='作品名', anchor=tk.W)
        self.tree.heading('author', text='作者名', anchor=tk.W)
        self.tree.heading('created', text='作成日', anchor=tk.W)
        self.tree.heading('updated', text='更新日', anchor=tk.W)
        
        self.tree.column('#0', width=250, minwidth=100)
        self.tree.column('author', width=200, minwidth=100)
        self.tree.column('created', width=150, minwidth=100)
        self.tree.column('updated', width=150, minwidth=100)
        
        # Scrollbars
        v_scrollbar = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=self.tree.yview)
        v_scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.tree.configure(yscrollcommand=v_scrollbar.set)
        
        h_scrollbar = ttk.Scrollbar(tree_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        h_scrollbar.grid(row=1, column=0, sticky=(tk.W, tk.E))
        self.tree.configure(xscrollcommand=h_scrollbar.set)
        
        # Button frame
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        # Left side buttons
        ttk.Button(button_frame, text="編集", command=self.edit_selected).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="削除", command=self.delete_selected).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="新規追加", command=self.add_new).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="更新", command=self.load_data).pack(side=tk.LEFT, padx=(0, 5))
        
        # Separator
        ttk.Separator(button_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)
        
        # Database operations
        ttk.Button(button_frame, text="エクスポート", command=self.export_database).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="インポート", command=self.import_database).pack(side=tk.LEFT, padx=(0, 5))
        
        # Right side button
        ttk.Button(button_frame, text="閉じる", command=self.close).pack(side=tk.RIGHT)
        
        # Double-click to edit
        self.tree.bind('<Double-Button-1>', lambda e: self.edit_selected())
        
    def load_data(self):
        """Load all manga data from database"""
        # Clear existing items
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Load from database
        self.all_items = self.database.get_all_manga()
        
        # Add to treeview
        for title, author, created, updated in self.all_items:
            # Format dates (remove time if present)
            created_date = created.split(' ')[0] if created else ''
            updated_date = updated.split(' ')[0] if updated else ''
            
            self.tree.insert('', 'end', text=title, 
                           values=(author, created_date, updated_date))
        
        logger.info(f"Loaded {len(self.all_items)} manga entries")
        
    def on_search(self, event=None):
        """Filter items based on search text"""
        search_text = self.search_var.get().lower()
        
        # Clear treeview
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Add filtered items
        for title, author, created, updated in self.all_items:
            if search_text in title.lower() or search_text in author.lower():
                created_date = created.split(' ')[0] if created else ''
                updated_date = updated.split(' ')[0] if updated else ''
                self.tree.insert('', 'end', text=title,
                               values=(author, created_date, updated_date))
    
    def clear_search(self):
        """Clear search and show all items"""
        self.search_var.set('')
        self.on_search()
    
    def edit_selected(self):
        """Edit the selected manga entry"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("選択エラー", "編集する項目を選択してください")
            return
        
        item = self.tree.item(selection[0])
        old_title = item['text']
        old_author = item['values'][0]
        
        # Create edit dialog
        dialog = EditMangaDialog(self.window, old_title, old_author)
        if dialog.result:
            new_title, new_author = dialog.result
            
            # Update in database
            if self.database.update_manga_info(old_title, new_title, new_author):
                messagebox.showinfo("成功", "データベースを更新しました")
                self.load_data()
                
                # Notify parent window to refresh
                if hasattr(self.parent, 'title_author_combo'):
                    self.parent.title_author_combo.refresh()
            else:
                messagebox.showerror("エラー", "更新に失敗しました。タイトルが既に存在する可能性があります。")
    
    def delete_selected(self):
        """Delete the selected manga entry"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("選択エラー", "削除する項目を選択してください")
            return
        
        item = self.tree.item(selection[0])
        title = item['text']
        author = item['values'][0]
        
        # Confirm deletion
        result = messagebox.askyesno(
            "削除確認", 
            f"本当に削除しますか？\n\n作品名: {title}\n作者名: {author}"
        )
        
        if result:
            if self.database.delete_manga(title):
                messagebox.showinfo("成功", "削除しました")
                self.load_data()
                
                # Notify parent window to refresh
                if hasattr(self.parent, 'title_author_combo'):
                    self.parent.title_author_combo.refresh()
            else:
                messagebox.showerror("エラー", "削除に失敗しました")
    
    def add_new(self):
        """Add a new manga entry"""
        dialog = EditMangaDialog(self.window, "", "")
        if dialog.result:
            title, author = dialog.result
            
            # Save to database
            if self.database.save_manga_info(title, author):
                messagebox.showinfo("成功", "新規追加しました")
                self.load_data()
                
                # Notify parent window to refresh
                if hasattr(self.parent, 'title_author_combo'):
                    self.parent.title_author_combo.refresh()
            else:
                messagebox.showerror("エラー", "追加に失敗しました。タイトルが既に存在する可能性があります。")
    
    def close(self):
        """Close the window"""
        if self.window:
            self.window.grab_release()  # Release the grab
            self.window.destroy()
            self.window = None
    
    def center_window(self):
        """Center the window on the parent window"""
        self.window.update_idletasks()
        
        # Get parent window position and size
        parent_x = self.parent.winfo_x()
        parent_y = self.parent.winfo_y()
        parent_width = self.parent.winfo_width()
        parent_height = self.parent.winfo_height()
        
        # Get this window size
        window_width = self.window.winfo_width()
        window_height = self.window.winfo_height()
        
        # Calculate center position
        x = parent_x + (parent_width - window_width) // 2
        y = parent_y + (parent_height - window_height) // 2
        
        # Set window position
        self.window.geometry(f"+{x}+{y}")
    
    def export_database(self):
        """Export database to JSON"""
        file_path = filedialog.asksaveasfilename(
            parent=self.window,
            title="データベースをエクスポート",
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        if file_path:
            if self.database.export_to_json(Path(file_path)):
                messagebox.showinfo("成功", "データベースを正常にエクスポートしました", parent=self.window)
            else:
                messagebox.showerror("エラー", "データベースのエクスポートに失敗しました", parent=self.window)
    
    def import_database(self):
        """Import database from JSON"""
        file_path = filedialog.askopenfilename(
            parent=self.window,
            title="データベースをインポート",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        if file_path:
            result = messagebox.askyesno(
                "確認",
                "既存のデータベースに追加されます。続行しますか？",
                parent=self.window
            )
            if result:
                if self.database.import_from_json(Path(file_path)):
                    messagebox.showinfo("成功", "データベースを正常にインポートしました", parent=self.window)
                    self.load_data()  # Refresh the display
                else:
                    messagebox.showerror("エラー", "データベースのインポートに失敗しました", parent=self.window)


class EditMangaDialog:
    """Dialog for editing manga information"""
    
    def __init__(self, parent, title: str, author: str):
        self.result = None
        
        # Create dialog window
        self.dialog = tk.Toplevel(parent)
        self.dialog.title("漫画情報編集")
        self.dialog.geometry("400x200")
        self.dialog.resizable(False, False)
        
        # Make modal
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        # Center the dialog
        self.dialog.update_idletasks()
        x = (self.dialog.winfo_screenwidth() // 2) - (400 // 2)
        y = (self.dialog.winfo_screenheight() // 2) - (200 // 2)
        self.dialog.geometry(f"+{x}+{y}")
        
        # Create form
        main_frame = ttk.Frame(self.dialog, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # Title field
        ttk.Label(main_frame, text="作品名:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.title_var = tk.StringVar(value=title)
        title_entry = ttk.Entry(main_frame, textvariable=self.title_var, width=40)
        title_entry.grid(row=0, column=1, pady=5)
        title_entry.focus()
        
        # Author field
        ttk.Label(main_frame, text="作者名:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.author_var = tk.StringVar(value=author)
        author_entry = ttk.Entry(main_frame, textvariable=self.author_var, width=40)
        author_entry.grid(row=1, column=1, pady=5)
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=2, column=0, columnspan=2, pady=20)
        
        ttk.Button(button_frame, text="保存", command=self.save).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="キャンセル", command=self.cancel).pack(side=tk.LEFT, padx=5)
        
        # Bind Enter key to save
        self.dialog.bind('<Return>', lambda e: self.save())
        self.dialog.bind('<Escape>', lambda e: self.cancel())
        
        # Wait for dialog to close
        self.dialog.wait_window()
    
    def save(self):
        """Save the entered data"""
        title = self.title_var.get().strip()
        author = self.author_var.get().strip()
        
        if not title:
            messagebox.showwarning("入力エラー", "作品名を入力してください", parent=self.dialog)
            return
        
        if not author:
            messagebox.showwarning("入力エラー", "作者名を入力してください", parent=self.dialog)
            return
        
        self.result = (title, author)
        self.dialog.destroy()
    
    def cancel(self):
        """Cancel the dialog"""
        self.dialog.destroy()