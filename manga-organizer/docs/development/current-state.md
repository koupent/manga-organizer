# Manga Organizer - Current State (v3.6.5)

## Recent Major Changes

### Version 3.6.5 - Volume Detection Architecture Fix

- **Fixed**: Temporary directory names no longer interfere with volume detection
- **Solution**: Archives are now extracted into subdirectories named after the archive
- **Impact**: Correctly detects volume numbers from archive file names

### Version 3.6.4 - UI Performance Improvements

- **Removed**: API-based title suggestions (performance issues)
- **Changed**: Author search triggers at 2+ characters (was 3+)
- **Result**: Faster, more responsive UI

## Current Architecture

### Title/Author Input System

```
Title Input (EnhancedTitleCombobox)
├── Database-only search (immediate)
└── No API calls

Author Input (EnhancedAuthorCombobox)
├── Automatic API search when title ≥2 chars
├── Debounced at 300ms
└── Shows API results + DB entries
```

### Volume Detection Flow

```
Archive Processing
├── Create temp directory
├── Create subdirectory named after archive
├── Extract to subdirectory
├── Detect volumes from:
│   ├── 1. Image directory names (highest priority)
│   └── 2. Archive name (for single volumes)
└── Clean up temp directory
```

## Key Components

### GUI Components

- `src/gui/main_window.py` - Main application window
- `src/gui/enhanced_title_combobox.py` - Title input with DB search
- `src/gui/enhanced_author_combobox.py` - Author input with API search
- `src/gui/title_author_combo.py` - Container for title/author inputs

### Core Logic

- `src/core/archive_handler.py` - Archive extraction with subdirectory structure
- `src/core/volume_detector.py` - Volume number detection logic
- `src/core/file_organizer.py` - Main processing orchestration
- `src/core/manga_database.py` - SQLite database management

### Utilities

- `scripts/update_version.py` - Automated version update script
- Updates 6 files with new version and release date

## Version Management

All version updates are handled by `scripts/update_version.py`:

```bash
python3 scripts/update_version.py 3.6.6
```

This updates:

1. `pyproject.toml`
2. `src/__version__.py`
3. `version.py`
4. `src/gui/main_window.py` (VERSION constant)
5. `README.md` (version mentions)
6. `CHANGELOG.md` (adds new version section)

## Current Features

### Working

- ✅ Multi-format archive support (ZIP, RAR, 7z, CBZ, CBR, CB7, EPUB)
- ✅ Accurate volume detection from directory/file names
- ✅ Database storage of manga titles and authors
- ✅ Author API search (AniList/MAL)
- ✅ Drag-and-drop file addition
- ✅ Sequential image renaming
- ✅ Natural sorting

### Removed

- ❌ API-based title suggestions (v3.6.4)

## Known Issues

None currently reported.

## Development Notes

### Testing Considerations

- GUI requires `tkinterdnd2` module
- Archive handling requires `py7zr` module
- API features require internet connection
- Volume detection should be tested with various archive structures

### Build Process

```bash
# Using PyInstaller
uv run pyinstaller --onefile --noconsole --windowed \
    --name MangaOrganizer --paths src \
    --add-data "data;data" \
    --hidden-import rarfile \
    src/main.py
```

## Future Considerations

### Potential Improvements

1. Add configuration file for user preferences
2. Implement batch processing progress persistence
3. Add support for more archive formats
4. Enhance error recovery mechanisms

### Architecture Stability

The current architecture is stable with:

- Clear separation of UI and core logic
- Robust volume detection
- Efficient database-only title search
- Reliable API integration for authors only
