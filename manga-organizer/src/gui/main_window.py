import logging
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from manga_core.file_organizer import FileOrganizer
from manga_core.manga_database import MangaDatabase
from tkinterdnd2 import DND_FILES, TkinterDnD

# Import version from the src directory
from __version__ import __version__ as VERSION
from gui.database_editor import DatabaseEditorWindow
from gui.page_editor_panel import PageEditorPanel
from gui.sortable_listbox import SortableListbox
from gui.title_author_combo import TitleAuthorCombo

logger = logging.getLogger(__name__)


class MainWindow:
    def __init__(self):
        self.root = TkinterDnD.Tk()
        self.root.title(f"Manga Organizer v{VERSION}")
        self.root.geometry("900x750")

        self.archive_files: list[Path] = []
        self.organizer = None
        self.database = MangaDatabase()
        self.processing = False
        self.stop_requested = False
        self.current_thread = None
        self.db_editor = DatabaseEditorWindow(self.root, self.database)

        self.setup_ui()
        self.setup_drag_drop()

    def setup_ui(self):
        # Configure grid weights
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)

        # 整理 / ページ修正 は独立した機能なので、タブで切り替えて使う
        self.mode_notebook = ttk.Notebook(self.root)
        self.mode_notebook.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        organize_tab = ttk.Frame(self.mode_notebook)
        organize_tab.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        organize_tab.columnconfigure(0, weight=1)
        organize_tab.rowconfigure(0, weight=1)
        self.mode_notebook.add(organize_tab, text="整理")

        # Main container
        main_frame = ttk.Frame(organize_tab, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(2, weight=1)

        # Input section with autocomplete
        input_frame = ttk.LabelFrame(main_frame, text="Manga Information", padding="10")
        input_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Title and Author with dropdown (Title LEFT with dropdown, Author RIGHT)
        title_author_frame = ttk.Frame(input_frame)
        title_author_frame.grid(row=0, column=0, sticky=(tk.W, tk.E))

        self.title_author_combo = TitleAuthorCombo(title_author_frame, self.database)
        self.title_author_combo.grid(row=0, column=0, sticky=(tk.W, tk.E))

        # Database button next to title and author
        ttk.Button(title_author_frame, text="DB編集", command=self.open_db_editor).grid(
            row=0, column=1, padx=(10, 0)
        )

        # Options section
        options_frame = ttk.LabelFrame(main_frame, text="Options", padding="10")
        options_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        self.keep_originals_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            options_frame, text="Keep original files", variable=self.keep_originals_var
        ).grid(row=0, column=0, sticky=tk.W)

        ttk.Label(options_frame, text="Output Directory:").grid(
            row=0, column=1, padx=(20, 5)
        )
        self.output_path_var = tk.StringVar(value=str(Path.home() / "MangaOrganized"))
        self.output_entry = ttk.Entry(
            options_frame, textvariable=self.output_path_var, width=40
        )
        self.output_entry.grid(row=0, column=2, padx=(0, 5))

        ttk.Button(
            options_frame, text="Browse", command=self.browse_output_directory
        ).grid(row=0, column=3)

        # Drop zone with sortable list
        drop_frame = ttk.LabelFrame(
            main_frame, text="Drag & Drop Archives Here", padding="10"
        )
        drop_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        drop_frame.columnconfigure(0, weight=1)
        drop_frame.rowconfigure(1, weight=1)

        # Buttons and instructions at the top of drop zone
        list_control_frame = ttk.Frame(drop_frame)
        list_control_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 5))

        ttk.Button(
            list_control_frame, text="Add Files", command=self.add_files_dialog
        ).pack(side=tk.LEFT, padx=(0, 5))

        ttk.Button(list_control_frame, text="Clear List", command=self.clear_list).pack(
            side=tk.LEFT, padx=(0, 10)
        )

        # Instructions
        ttk.Label(
            list_control_frame,
            text="📝 ドラッグで順番変更 | Deleteキーで削除",
            foreground="gray",
        ).pack(side=tk.LEFT, padx=(20, 0))

        # Sortable listbox
        self.sortable_listbox = SortableListbox(drop_frame)
        self.sortable_listbox.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # Control buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        self.process_button = ttk.Button(
            button_frame,
            text="Process Archives",
            command=self.process_archives,
            state=tk.DISABLED,
        )
        self.process_button.pack(side=tk.LEFT, padx=(0, 5))

        self.stop_button = ttk.Button(
            button_frame,
            text="Stop Processing",
            command=self.stop_processing,
            state=tk.DISABLED,
        )
        self.stop_button.pack(side=tk.LEFT, padx=(0, 5))

        # Progress bar
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(
            main_frame, variable=self.progress_var, maximum=100
        )
        self.progress_bar.grid(row=4, column=0, sticky=(tk.W, tk.E), pady=(0, 5))

        # Status label
        self.status_label = ttk.Label(main_frame, text="Ready")
        self.status_label.grid(row=5, column=0, sticky=tk.W)

        # Detailed progress log (scrollable text widget)
        log_frame = ttk.LabelFrame(main_frame, text="Processing Log", padding="5")
        log_frame.grid(row=6, column=0, sticky=(tk.W, tk.E), pady=(5, 0))
        log_frame.columnconfigure(0, weight=1)

        self.log_text = tk.Text(log_frame, height=5, wrap=tk.WORD)
        self.log_text.grid(row=0, column=0, sticky=(tk.W, tk.E))

        log_scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        log_scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.log_text.config(yscrollcommand=log_scrollbar.set)

        # ページ修正モード（対象ファイルの選択も含めて独立している）
        self.page_editor_panel = PageEditorPanel(
            self.mode_notebook, log_callback=self.log_message
        )
        self.mode_notebook.add(self.page_editor_panel, text="ページ修正")

    def setup_drag_drop(self):
        # Register drag and drop on the sortable listbox
        self.sortable_listbox.listbox.drop_target_register(DND_FILES)
        self.sortable_listbox.listbox.dnd_bind("<<Drop>>", self.on_drop)

        # ページ修正モードは自前の一覧を持つので別に登録する
        self.page_editor_panel.listbox.drop_target_register(DND_FILES)
        self.page_editor_panel.listbox.dnd_bind("<<Drop>>", self.on_page_editor_drop)

    def on_drop(self, event):
        files = self.root.tk.splitlist(event.data)
        self.add_files(files)

    def on_page_editor_drop(self, event):
        files = self.root.tk.splitlist(event.data)
        self.page_editor_panel.add_paths(files)

    def add_files(self, file_paths):
        first_file_added = len(self.sortable_listbox.get_items()) == 0

        for file_path in file_paths:
            path = Path(file_path)
            if path.exists():
                if path.is_file():
                    if path.suffix.lower() in {
                        ".zip",
                        ".rar",
                        ".7z",
                        ".cbz",
                        ".cbr",
                        ".cb7",
                        ".epub",
                    }:
                        self.sortable_listbox.add_item(path)
                elif path.is_dir():
                    # Add all archives in directory
                    for archive_path in path.rglob("*"):
                        if archive_path.is_file() and archive_path.suffix.lower() in {
                            ".zip",
                            ".rar",
                            ".7z",
                            ".cbz",
                            ".cbr",
                            ".cb7",
                            ".epub",
                        }:
                            self.sortable_listbox.add_item(archive_path)

        # Set default output directory from first file's location
        if first_file_added and self.sortable_listbox.get_items():
            first_file = self.sortable_listbox.get_items()[0]
            default_output = first_file.parent
            self.output_path_var.set(str(default_output))
            logger.info(f"Set default output directory to: {default_output}")

        self.update_ui_state()

    def add_files_dialog(self):
        files = filedialog.askopenfilenames(
            title="Select Archive Files",
            filetypes=[
                ("Archive files", "*.zip *.rar *.7z *.cbz *.cbr *.cb7 *.epub"),
                ("All files", "*.*"),
            ],
        )
        if files:
            self.add_files(files)

    def browse_output_directory(self):
        directory = filedialog.askdirectory(
            title="Select Output Directory", initialdir=self.output_path_var.get()
        )
        if directory:
            self.output_path_var.set(directory)

    def clear_list(self):
        self.sortable_listbox.clear()
        self.update_ui_state()

    def update_ui_state(self):
        has_files = len(self.sortable_listbox.get_items()) > 0
        self.process_button.config(state=tk.NORMAL if has_files else tk.DISABLED)

    def validate_inputs(self):
        if not self.title_author_combo.get_title():
            messagebox.showerror("Error", "Please enter the manga title")
            return False

        if not self.title_author_combo.get_author():
            messagebox.showerror("Error", "Please enter the author name")
            return False

        if not self.output_path_var.get().strip():
            messagebox.showerror("Error", "Please select an output directory")
            return False

        return True

    def open_db_editor(self):
        """Open the database editor window"""
        self.db_editor.show()

    def process_archives(self):
        if not self.validate_inputs():
            return

        # Get sorted list of archives
        archive_files = self.sortable_listbox.get_items()

        # Save manga info to database
        title = self.title_author_combo.get_title()
        author = self.title_author_combo.get_author()
        self.database.save_manga_info(title, author)

        # Create output directory if it doesn't exist
        output_dir = Path(self.output_path_var.get())
        output_dir.mkdir(parents=True, exist_ok=True)

        # Initialize organizer with log callback
        self.organizer = FileOrganizer(
            output_directory=output_dir,
            keep_originals=self.keep_originals_var.get(),
            log_callback=lambda msg: self.root.after(0, self.log_message, msg),
        )
        self.organizer.set_manga_info(author=author, title=title)

        # Disable UI during processing
        self.processing = True
        self.stop_requested = False
        self.process_button.config(state=tk.DISABLED)
        self.stop_button.config(state=tk.NORMAL)
        self.status_label.config(text="Processing...")
        self.log_text.delete(1.0, tk.END)

        # Process in separate thread
        self.current_thread = threading.Thread(
            target=self.process_worker, args=(archive_files,)
        )
        self.current_thread.start()

    def process_worker(self, archive_files):
        try:
            processed_files = []
            all_results = []

            for i, archive_file in enumerate(archive_files):
                if self.stop_requested:
                    self.root.after(0, self.log_message, "Processing stopped by user")
                    break

                # Update overall progress
                overall_progress = (i / len(archive_files)) * 100
                self.root.after(
                    0,
                    self.update_progress,
                    overall_progress,
                    f"Processing {i + 1}/{len(archive_files)}: {archive_file.name}",
                )

                # Log extraction start
                self.root.after(
                    0,
                    self.log_message,
                    f"\n[{i + 1}/{len(archive_files)}] Extracting: {archive_file.name}",
                )

                # Process single archive with detailed logging
                results = self.organizer.process_single_archive(archive_file)
                all_results.extend(results)

                # Log results for this archive
                successful = sum(1 for r in results if r.success)
                if successful > 0:
                    self.root.after(
                        0,
                        self.log_message,
                        f"  ✓ Created {successful} volume(s) successfully",
                    )
                    for result in results:
                        if result.success:
                            self.root.after(
                                0, self.log_message, f"    - {result.output_path.name}"
                            )
                else:
                    self.root.after(
                        0, self.log_message, "  ✗ Failed to process archive"
                    )
                    for result in results:
                        if not result.success:
                            self.root.after(
                                0,
                                self.log_message,
                                f"    Error: {result.error_message}",
                            )

                # Remove processed file from list
                processed_files.append(archive_file)
                self.root.after(0, self.remove_processed_file, archive_file)

            # Store results
            self.organizer.results = all_results
            summary = self.organizer.get_summary()

            if not self.stop_requested:
                self.root.after(0, self.process_complete, summary)
            else:
                self.root.after(0, self.process_stopped, summary)

        except Exception as e:
            logger.error(f"Processing error: {e}")
            self.root.after(0, self.process_error, str(e))

    def update_progress(self, value, text):
        self.progress_var.set(value)
        self.status_label.config(text=text)

    def log_message(self, message):
        """Add message to the log text widget"""
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)  # Auto-scroll to bottom

    def remove_processed_file(self, file_path):
        """Remove processed file from the list"""
        self.sortable_listbox.remove_item(file_path)
        self.update_ui_state()

    def stop_processing(self):
        """Request to stop the current processing"""
        if self.processing:
            self.stop_requested = True
            self.stop_button.config(state=tk.DISABLED)
            self.status_label.config(text="Stopping...")
            self.log_message("\nStop requested, finishing current archive...")

    def process_complete(self, summary):
        self.processing = False
        self.progress_var.set(100)
        self.process_button.config(state=tk.NORMAL)
        self.stop_button.config(state=tk.DISABLED)

        self.log_message(f"\n{'=' * 50}")
        self.log_message("Processing complete!")
        self.log_message(f"Total volumes: {summary['total']}")
        self.log_message(f"Successful: {summary['successful']}")
        self.log_message(f"Failed: {summary['failed']}")

        message = "Processing complete!\n\n"
        message += f"Total volumes: {summary['total']}\n"
        message += f"Successful: {summary['successful']}\n"
        message += f"Failed: {summary['failed']}"

        if summary["failed"] > 0:
            message += "\n\nSee log for details."

        messagebox.showinfo("Processing Complete", message)
        self.status_label.config(text="Ready")
        self.progress_var.set(0)

        # Refresh dropdown after successful processing
        if summary["successful"] > 0:
            self.title_author_combo.refresh()

    def process_stopped(self, summary):
        self.processing = False
        self.progress_var.set(0)
        self.process_button.config(state=tk.NORMAL)
        self.stop_button.config(state=tk.DISABLED)

        self.log_message(f"\n{'=' * 50}")
        self.log_message("Processing stopped by user")
        self.log_message(f"Processed: {summary['successful']} volumes")

        messagebox.showinfo(
            "Processing Stopped",
            f"Processing was stopped.\nProcessed: {summary['successful']} volumes",
        )
        self.status_label.config(text="Ready")

        # Refresh dropdown if any files were processed
        if summary["successful"] > 0:
            self.title_author_combo.refresh()

    def process_error(self, error_message):
        self.processing = False
        self.progress_var.set(0)
        self.process_button.config(state=tk.NORMAL)
        self.stop_button.config(state=tk.DISABLED)
        self.status_label.config(text="Error occurred")
        self.log_message(f"\n❌ Error: {error_message}")
        messagebox.showerror("Processing Error", f"An error occurred:\n{error_message}")

    def run(self):
        # Set window close handler
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
        self.root.mainloop()

    def on_closing(self):
        """Handle window closing"""
        # Close database connection
        if hasattr(self, "database"):
            self.database.close()
        self.root.destroy()
