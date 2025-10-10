# Manga Organizer - Changelog

## Version 3.8.1 - AVIF Image Format Support

### New Features

#### Modern Image Format Support

- **AVIF support**: Added support for AVIF (AV1 Image File Format)
  - High-efficiency image format with superior compression compared to JPEG and WebP
  - Native support via Pillow 11.3.0+
  - Preserves original .avif extension during image renaming
  - Fully compatible with archive creation and processing workflows

### Technical Changes

- **IMAGE_EXTENSIONS**: Updated to include `.avif` extension
- **Pillow dependency**: Upgraded to Pillow 11.3.0+ for native AVIF support
- **No additional dependencies**: Uses built-in Pillow AVIF support (libavif included in wheels)

### Benefits

- **Better compression**: AVIF provides smaller file sizes while maintaining quality
- **Future-proof**: Support for modern image formats from web and mobile sources
- **Seamless integration**: Works with existing archive processing and renaming features

## Version 3.8.0 - Breaking Change: 7-Zip External Dependency

**重要**: このバージョンから 7-Zip の内蔵を廃止しました。RAR 形式のサポートには 7-Zip の事前インストールが必要です。

### Breaking Changes

#### 7-Zip 内蔵の廃止

- **理由**: Windows Defender および他のアンチウイルスソフトによる誤検知を削減
- **影響**: RAR 形式（.rar, .cbr）を扱うユーザーは 7-Zip を別途インストールする必要があります
- **対象外**: ZIP, 7z, CBZ 形式は引き続き追加ソフトウェアなしで動作します

### Improvements

#### Security and Compatibility

- **PyInstaller optimization**: Disabled UPX compression to reduce false positive detections
  - File size increased to ~30MB but significantly reduces antivirus false positives
  - Improved startup performance (no decompression needed)
  - Better compatibility with Windows Defender and other antivirus software

#### Build System

- **Build script improvements**: Enhanced build scripts for consistent optimization
  - Preserved spec file in version control for reproducible builds
  - Added clear warnings about bundling executable files
  - Improved build output messages for transparency

#### Architecture Changes

- **7-Zip distribution strategy**: Moved to system-installed 7-Zip approach
  - No longer bundles 7za.exe to reduce false positive risks
  - Relies on user-installed 7-Zip for RAR support
  - Cleaner executable without embedded binaries

### Technical Changes

- **MangaOrganizer.spec**: Set `upx=False` to disable compression
- **build.sh**: Updated to preserve spec file and show optimization settings
- **build-windows.ps1**: Enhanced for Windows-specific optimizations

### Notes

- Users need to install 7-Zip separately for RAR archive support
- ZIP, 7z, and CBZ formats work without additional software
- This version focuses on reducing false positive detections by antivirus software

## Version 3.7.1 - Logging Improvements and Documentation

### Improvements

#### Logging System

- **Enhanced log file management**: Logs are now saved in a dedicated `logs/` directory
  - Date-based file naming: `manga_organizer_YYYYMMDD.log`
  - Automatic cleanup of logs older than 30 days
  - UTF-8 encoding support for Japanese text
  - Better organization for troubleshooting

#### Documentation

- **Comprehensive README.md**: Added detailed installation and usage instructions
  - Step-by-step installation guide
  - Folder structure after installation
  - Troubleshooting section
- **Developer documentation**: Separated developer content into DEVELOPMENT.md
  - Version update procedures
  - Build instructions
  - Development environment setup

### Technical Changes

- **main.py**: Refactored logging setup with automatic directory creation
- **README.md**: Focused on end-user documentation
- **DEVELOPMENT.md**: New file for developer-specific documentation

## Version 3.7.0 - Standalone 7za.exe Bundling Support

### New Features

#### Complete Standalone RAR Support

- **7za.exe bundling**: Implemented support for bundling 7za.exe (standalone version) with the executable
  - No DLL dependencies required - 7za.exe works completely standalone
  - Automatic extraction and usage from bundled executable
  - Users no longer need to install 7-Zip separately for RAR support
  - Smaller footprint compared to 7z.exe + 7z.dll combination

#### GitHub Actions Improvements

- **Updated build workflow**: Modified to download and bundle 7za.exe standalone version
  - Changed from 7z2408-extra to 7z2501-extra for latest version
  - Simplified extraction process for standalone executable
  - Better file verification and size reporting

### Technical Changes

- **archive_handler.py**: Enhanced bundled tool detection

  - Prioritizes 7za.exe (standalone) over 7z.exe
  - Improved logging to show which executable is being used
  - Better configuration for rarfile module with standalone 7za.exe

- **MangaOrganizer.spec**: Updated PyInstaller configuration

  - Changed to bundle 7za.exe instead of 7z.exe + 7z.dll
  - Added file size verification during build

- **build-release.yml**: Workflow improvements
  - Downloads 7-Zip Extra version 25.01
  - Extracts and bundles 7za.exe standalone executable
  - Improved error handling and progress reporting

### Benefits

- **Zero dependencies**: MangaOrganizer.exe now works completely standalone
- **Full RAR support**: Built-in RAR extraction without external tools
- **Smaller size**: Single 7za.exe (~1-2MB) instead of multiple files
- **Better user experience**: No installation requirements for end users

## Version 3.6.6 - RAR Archive Support Improvements

### Improvements

#### RAR Archive Support

- **Enhanced RAR extraction reliability**: Improved RAR file handling for PyInstaller-built executables
  - Added automatic configuration for rarfile module to use 7-Zip when available
  - Implemented fallback mechanism to search for multiple RAR extraction tools (7-Zip, UnRAR, WinRAR)
  - Added support for bundling 7-Zip portable version with executable
  - Better error messages with specific instructions when RAR tools are not found

#### Build System

- **PyInstaller spec file support**: Added configuration for bundling external tools
  - Created MangaOrganizer.spec for customized build process
  - Support for including 7-Zip portable files in the executable
  - Added resources directory structure for bundled tools

#### Error Handling

- **Improved RAR error diagnostics**: Better error messages and recovery options
  - Specific handling for RarCannotExec and RarExecError exceptions
  - Clear instructions for users on how to install required tools
  - Automatic detection and configuration of available extraction tools

### Technical Changes

- **archive_handler.py**: Enhanced to support bundled 7-Zip in PyInstaller builds
- **build.sh**: Updated to use spec file when available
- **Added helper scripts**: Created download_7zip.py for easier setup

## Version 3.6.5 - Volume Detection Fix for Flat Archives

### Bug Fixes

#### Volume Detection

- **Fixed incorrect volume number detection**: Resolved critical issue where temporary directory names were incorrectly used for volume detection
  - Previously: Flat archives extracted to `manga_xxxxx/` caused random numbers in temp directory names to be detected as volume numbers
  - Now: Archives are extracted to `manga_xxxxx/[archive_name]/` subdirectory structure
  - Example: `[渡邊ダイスケ] 善悪の屑 第001巻.zip` now correctly creates `第001巻.zip` instead of random volume numbers

### Improvements

#### Archive Processing

- **Improved temporary directory structure**: Enhanced extraction process for better volume detection
  - Creates subdirectory named after archive file (without extension) before extraction
  - Ensures flat archives maintain proper naming for volume detection
  - Prevents temporary directory random strings from interfering with volume numbering

## Version 3.6.4 - UI Performance and Author Search Improvements

### Removed

#### Title Input

- **Removed API Title Suggestions**: Eliminated API-based title suggestions for better performance
  - Title input now uses database-only search for immediate response
  - Removed debouncing and threading for title suggestions
  - Significantly improved UI responsiveness during title input

### Changed

#### Author Search

- **Automatic Author Search**: Author API search now triggers automatically when title has 2+ characters
  - Previously required 3 characters and manual focus on author field
  - Removed focus-based triggering in favor of automatic execution
  - Author suggestions appear immediately without user interaction

### Improvements

#### Performance

- **Faster Title Input Response**: Removed 300ms debounce delay for title suggestions
- **Reduced API Calls**: Only author search uses API, title search is database-only
- **Better User Experience**: More predictable and responsive interface

#### Code Quality

- **Simplified Component Logic**: Removed unnecessary API search code from EnhancedTitleCombobox
- **Cleaner Architecture**: Clear separation between title (DB) and author (API) search

## Version 3.6.3 - RAR Module Build Fix

### Bug Fixes

#### Build Process

- **Fixed rarfile Module Not Included in Build**: Resolved issue where rarfile module was missing in built executable
  - Added `rarfile>=4.0` to project dependencies in `pyproject.toml`
  - Added `--hidden-import rarfile` flag to PyInstaller build command
  - This ensures RAR archives can be extracted even without 7-Zip installed
  - Fixes "No module named 'rarfile'" error on distribution targets

### Improvements

#### Error Handling

- **Improved RAR Extraction Error Messages**: Enhanced error reporting for RAR file processing
  - Clear distinction between ImportError and extraction failures
  - Added helpful message when neither 7-Zip nor rarfile is available
  - Better logging during rarfile fallback extraction process
  - Shows file count and progress when using rarfile module

## Version 3.6.2 - Volume Detection Logic Fix

### Bug Fixes

#### Volume Number Detection

- **Fixed Multiple Volume Detection**: Archives containing multiple volumes now correctly detect individual volume numbers
  - Changed priority: Now checks image directory names first before archive names
  - Example: `DLRAW.TO_3Gatsu Lion vol 01-17.rar` with directories `001/`, `002/`...`017/` now correctly creates volumes 1-17
  - Previously all volumes from such archives were incorrectly labeled as volume 1

### Improvements

#### Documentation

- **Volume Detection Specification**: Added detailed specification document at `docs/volume-detection-spec.md`
  - Comprehensive explanation of volume number detection logic
  - Priority rules for different archive types
  - Examples of various naming patterns
- **README Updates**: Added link to detailed volume detection specification
  - Clarified that `manga_` prefix directories are now processed correctly
  - Updated troubleshooting section with v3.6.2 improvements

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
  - Created src/**version**.py as single source of truth
  - Updated all modules to import version from **version**.py
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

- **Database Controls Grouped**: Export/Import DB buttons moved next to DB 編集

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
  - Instructions added: "📝 ドラッグで順番変更 | Delete キーで削除"
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

- **DB 編集 Button Relocation**: Moved database edit button
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
  - Access via "DB 編集" button in main window

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
