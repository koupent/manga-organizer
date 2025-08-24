# Manga Organizer - Changelog

## Version 3.6.1 - Console Window Suppression Fix

### Bug Fixes

#### Windows Console Window Issue
- **Fixed Console Window Flashing**: Subprocess calls no longer show console windows
  - Added STARTUPINFO configuration for Windows subprocess calls
  - Implemented CREATE_NO_WINDOW flag (0x08000000) for complete suppression
  - All 7z.exe calls now run silently in background
  - No visual interruption during archive extraction

### Build Improvements
- **PyInstaller v6.0+ Compatibility**: Updated build scripts for latest PyInstaller
  - Removed deprecated --win-no-prefer-redirects and --win-private-assemblies flags
  - Updated Windows-specific .spec file for v6.0+ compatibility
  - Created PowerShell build script for Windows users
  - Maintained console suppression with proper flags

### Version Management
- **Centralized Version Control**: Improved version consistency across builds
  - Created src/__version__.py as single source of truth
  - Updated all modules to import version from __version__.py
  - Build scripts automatically read version from source
  - Window title shows version number
  - Eliminates version mismatch issues

## Version 3.6.0 - Image Renaming Feature

### New Features

#### Sequential Image Renaming
- **Automatic Image Renaming**: Images in archives are now renamed to sequential numbers
  - Renames files to 001.jpg, 002.jpg, 003.jpg format
  - Preserves original file extensions (.jpg, .png, .webp, etc.)
  - Natural sorting ensures correct page order before renaming
  - Prevents duplicate or confusing filenames in output

### Technical Details
- **Natural Sort Algorithm**: Implements intelligent sorting for mixed alphanumeric filenames
  - Handles names like "page1", "page2", "page10" correctly
  - Processes complex patterns like "000 (1).jpg" through "000 (150).jpg"
  - Ensures consistent reading order across all manga volumes

### Benefits
- **Standardized Naming**: All archives have consistent, predictable filenames
- **Reader Compatibility**: Works better with manga readers expecting sequential numbers
- **Clean Organization**: Removes inconsistent naming patterns from various sources
- **Preserved Extensions**: Maintains original image formats for compatibility

## Version 3.5.0 - Volume Detection Fix & Code Cleanup

### Bug Fixes

#### Volume Detection Improvements
- **Fixed Temporary Directory Issue**: Volume detection no longer extracts numbers from temporary directories
  - Skips directories starting with `manga_`, `_extracted_`, or `temp`
  - Prioritizes original archive filename over extracted directory names
  - Prevents incorrect volume numbers from temporary paths

### Code Quality

#### Cleanup & Refactoring
- **Removed Test Files**: Cleaned up all test scripts from production release
- **Simplified Logic**: Streamlined volume detection with minimal complexity
- **Documentation**: Added comprehensive README with usage instructions
- **Code Organization**: Removed unused imports and debug code

### Technical Improvements
- **Detection Priority**: Archive name → Directory name → Index fallback
- **Better Heuristics**: More reliable volume number extraction
- **Maintainability**: Cleaner, more maintainable codebase

## Version 3.4.0 - Modal Database Editor

### Improvements

#### Database Editor Enhancements
- **Modal Window Implementation**: Database editor now opens as modal window
  - Parent window locked during database editing
  - Prevents accidental data corruption
  - Window centered on parent
  - Proper focus management with grab/release

- **Export/Import Integration**: Moved Export/Import buttons to database editor
  - All database operations now in one place
  - Removed from main window for cleaner interface
  - Japanese UI labels (エクスポート/インポート)
  - Better workflow organization

## Version 3.3.0 - UI Improvements & Natural Sorting

### Improvements

#### Button Layout Reorganization
- **Database Controls Grouped**: Export/Import DB buttons moved next to DB編集
  - All database operations in one location
  - Better workflow for database management
  - More intuitive UI organization

- **File List Controls**: Add Files and Clear List moved to drag-drop area
  - Controls placed at top of file list
  - Direct association with list operations
  - Cleaner main button area

#### File List Enhancements
- **Natural Sorting**: Files now sort in natural order (1, 2, 10 instead of 1, 10, 2)
  - Proper numeric ordering for volumes and chapters
  - Automatic sorting when files are added
  - Manual reordering still available via drag-and-drop

- **Keyboard Support**: Delete key functionality implemented
  - Delete/Backspace keys remove selected files
  - Ctrl+A selects all files
  - No need for separate Remove button

- **Simplified Interface**: Removed redundant Sort/Move/Delete buttons
  - Instructions added: "📝 ドラッグで順番変更 | Deleteキーで削除"
  - Cleaner, more intuitive interface
  - Mouse drag for reordering clearly indicated

## Version 3.2.1 - Dropdown Fix

### Bug Fixes

#### Author Dropdown Behavior
- **Fixed Dropdown Closing**: Author dropdown now properly closes after selection
  - Added Escape key event to force dropdown closure
  - Improved focus management after selection
  - Prevents UI freeze after author selection
  - Multiple fallback methods ensure reliable closing

## Version 3.2.0 - Delayed Database Save

### Improvements

#### Delayed Database Save
- **Save on Processing**: Database save now occurs during repackaging, not on selection
  - Author selection doesn't immediately save to database
  - Database update happens when "Process Archives" is clicked
  - Allows changing selection without polluting database
  - Cleaner data management with confirmed entries only

## Version 3.1.0 - API Search Improvements & Author Dropdown

### Improvements

#### Author Dropdown Implementation
- **Author Suggestions in Author Field**: Moved API search to author dropdown
  - Title input triggers author candidate search
  - Multiple author suggestions shown in dropdown
  - Automatic API search when title is entered
  - Database check first, then API search if not found

#### Enhanced Search Accuracy
- **Similarity Filtering**: Added intelligent similarity calculation (threshold: 0.3)
  - Filters out unrelated search results
  - Exact matches prioritized (similarity: 1.0)
  - Partial matches supported (similarity: 0.9)
  - Low relevance results excluded automatically

#### API Priority Optimization
- **AniList First**: Changed API search order to prioritize AniList over MAL
  - Better Japanese author name availability
  - More accurate search results
  - Improved native name extraction

#### UI/UX Improvements  
- **Debounce Implementation**: 500ms delay before API search
  - Prevents excessive API calls while typing
  - Improves performance and reduces rate limit issues
  - Better typing experience

- **Focus Control Fix**: Dropdown no longer steals focus
  - User maintains control while typing
  - Manual dropdown opening with Down arrow key
  - Improved overall usability

- **DB編集 Button Relocation**: Moved database edit button
  - Now positioned next to title and author fields
  - Better accessibility and workflow
  - More intuitive UI layout

#### Japanese Name Enhancement
- **Strong Native Name Preference**: AniList now strongly prefers `name.native` field
  - Significantly higher percentage of Japanese author names
  - Fallback to romanized only when Japanese unavailable
  - Better support for Japanese manga organization

## Version 3.0.0 - Database Editing & API Integration

### New Features

#### Database Editing Functionality
- **Database Editor Window**: New GUI window for managing manga database entries
  - View all registered manga in a sortable table
  - Edit existing entries (title and author)
  - Delete entries with confirmation dialog
  - Add new entries manually
  - Search/filter functionality
  - Access via "DB編集" button in main window

#### API Integration for Author Auto-Suggestion
- **MyAnimeList Integration**: Search via Jikan API v4
  - No authentication required
  - Rate-limited to respect API limits (2 req/sec)
  - Returns Japanese author names when available
  
- **AniList Integration**: GraphQL API for manga metadata
  - Searches for manga and retrieves author information
  - Prioritizes native (Japanese) names
  - Fallback when MyAnimeList doesn't have results

#### Enhanced Title Input
- **Smart Title Combobox**: 
  - Shows `[DB]` prefix for database entries
  - Shows `[MAL]` prefix for MyAnimeList results
  - Shows `[AniList]` prefix for AniList results
  - Auto-searches APIs when title not in database
  - Loading indicator during API searches
  - Saves API results to database for future use

#### Japanese Name Priority
- Automatically fetches author names in Japanese when available
- MyAnimeList typically provides Japanese names by default
- AniList uses `name.native` field for Japanese names
- Falls back to romanized names when Japanese unavailable

### Technical Details
- **Dependencies**: Added `requests` library for API calls
- **Caching**: In-memory cache to reduce redundant API calls
- **Rate Limiting**: Respects API rate limits automatically
- **Database Methods**: Added `update_manga_info()` and `get_all_manga()`

## Version 2.1.0 - Enhanced Progress Logging

### New Features

#### Enhanced Progress Reporting for Large Nested Archives
- **Detailed extraction progress**: Shows step-by-step progress during extraction
- **Nested archive detection**: Reports number of nested archives found
- **Individual volume processing**: Shows progress for each nested archive extraction
- **Directory scanning updates**: Reports progress while scanning for images
- **Compression progress**: Shows progress during volume creation with file counts
- **No more "frozen" appearance**: Continuous feedback even for large operations

### Detailed Logging Improvements
- "Starting extraction to temporary directory..." - Initial extraction phase
- "Found X nested archives to process" - Discovery of nested content
- "Extracting nested archive X/Y: filename" - Progress through nested archives
- "Found X images in: directory" - Image discovery in each volume
- "Processing volume X/Y..." - Volume processing progress
- "Compressing X images to filename..." - Compression progress with counts
- "Compressed X/Y images..." - Periodic updates during compression

## Version 2.0.0 - Major Improvements

### New Features

#### 1. Enhanced Progress Visualization
- **Detailed extraction/compression logging**: Added a scrollable log window that shows real-time progress during archive extraction and compression
- **Per-file progress tracking**: Each archive being processed shows detailed status updates
- **Visual feedback**: Progress messages include success/failure indicators (✓/✗) for better clarity

#### 2. Progressive File List Management
- **Auto-removal of processed files**: Files are automatically removed from the list as they are successfully processed
- **Real-time list updates**: The file list updates immediately after each archive is processed
- **Better workflow**: Users can see which files remain to be processed at a glance

#### 3. Processing Control
- **Stop button**: Added ability to cancel processing mid-operation
- **Graceful stopping**: The stop operation finishes the current archive before stopping
- **Status feedback**: Clear indication when stopping is in progress

#### 4. EPUB Format Support
- **New format**: Added support for EPUB files (manga in e-book format)
- **Automatic detection**: EPUB files are recognized and processed like other archive formats
- **Image extraction**: Properly extracts images from EPUB internal structure

#### 5. Portable Database
- **Application-relative storage**: Database is now stored in the `data/` directory within the application folder
- **Portability**: The entire application folder can be moved to different locations or computers
- **Automatic detection**: Correctly detects whether running as script or compiled executable

### Technical Improvements

#### Archive Handler
- Added progress callback support to extraction methods
- Enhanced multi-format support with EPUB
- Improved error handling and logging

#### GUI Enhancements
- Increased window height to accommodate log panel (900x750)
- Added scrollable text widget for processing logs
- Stop button with proper state management
- Thread-safe UI updates for all progress operations

#### File Organization
- Better volume detection for nested archives
- Improved handling of multiple volumes in single archive
- Enhanced error reporting with detailed messages

### Bug Fixes
- Fixed nested archive processing that was only outputting the last volume
- Resolved issue where multiple volumes in a single archive weren't being extracted separately
- Fixed database path to be portable across different environments

### Usage Notes

#### Progress Monitoring
The new log window shows:
- Archive extraction progress
- Volume creation status
- Error messages with details
- Overall progress counter (e.g., "Processing 3/10")

#### Stop Functionality
- Click "Stop Processing" to cancel the current batch
- The current archive will complete before stopping
- Partially processed batches are saved

#### EPUB Support
- EPUB files can be added via drag-and-drop or file dialog
- Processed like other archive formats
- Output as standard ZIP archives with organized structure

#### Portable Installation
- Database is stored in `[app_directory]/data/manga_info.db`
- Can copy entire application folder to USB or another computer
- Settings and manga database travel with the application