import os
import zipfile
import tempfile
import shutil
import subprocess
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple, Dict
import py7zr
from PIL import Image
import logging

logger = logging.getLogger(__name__)


def natural_sort_key(text: str):
    """Generate a key for natural sorting (1, 2, 10 instead of 1, 10, 2)"""

    def convert(part):
        return int(part) if part.isdigit() else part

    # Split text into numeric and non-numeric parts
    parts = re.split(r"(\d+)", text.lower())
    # Convert numeric parts to integers for proper sorting
    return [convert(part) for part in parts if part]


class ArchiveHandler:
    SUPPORTED_ARCHIVES = {".zip", ".rar", ".7z", ".cbz", ".cbr", ".cb7", ".epub"}
    IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}

    def __init__(self, log_callback=None):
        self.temp_dir = None
        self.progress_callback = None
        self.log_callback = log_callback  # For detailed logging to GUI

        # Setup subprocess creation flags for hiding console windows on Windows
        self.subprocess_startupinfo = None
        self.subprocess_creationflags = 0
        if sys.platform == "win32":
            self.subprocess_startupinfo = subprocess.STARTUPINFO()
            self.subprocess_startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            self.subprocess_startupinfo.wShowWindow = subprocess.SW_HIDE
            # Use CREATE_NO_WINDOW flag for additional suppression (0x08000000)
            self.subprocess_creationflags = getattr(
                subprocess, "CREATE_NO_WINDOW", 0x08000000
            )

    def is_archive(self, file_path: Path) -> bool:
        return file_path.suffix.lower() in self.SUPPORTED_ARCHIVES

    def is_image(self, file_path: Path) -> bool:
        if file_path.suffix.lower() not in self.IMAGE_EXTENSIONS:
            return False
        try:
            with Image.open(file_path) as img:
                img.verify()
            return True
        except:
            return False

    def extract_archive(
        self, archive_path: Path, extract_to: Path, progress_callback=None
    ) -> bool:
        try:
            suffix = archive_path.suffix.lower()

            if suffix in [".zip", ".cbz", ".epub"]:
                with zipfile.ZipFile(archive_path, "r") as zf:
                    members = zf.namelist()
                    total = len(members)
                    for i, member in enumerate(members):
                        if progress_callback:
                            progress_callback(f"Extracting: {member}", i, total)
                        zf.extract(member, extract_to)
                    return True

            elif suffix in [".rar", ".cbr"]:
                # Use 7-Zip for RAR files on Windows
                seven_zip_paths = [
                    "C:/Program Files/7-Zip/7z.exe",
                    "C:/Program Files (x86)/7-Zip/7z.exe",
                    "7z",  # Try system PATH
                ]

                seven_zip_exe = None
                for path in seven_zip_paths:
                    if Path(path).exists() or shutil.which(path):
                        seven_zip_exe = path
                        break

                if seven_zip_exe:
                    try:
                        if self.log_callback:
                            self.log_callback(
                                f"    Using 7-Zip to extract RAR archive..."
                            )

                        # First, list contents to get file count
                        list_result = subprocess.run(
                            [seven_zip_exe, "l", str(archive_path)],
                            capture_output=True,
                            text=True,
                            startupinfo=self.subprocess_startupinfo,
                            creationflags=self.subprocess_creationflags,
                        )

                        # Parse file count from output (rough estimate)
                        lines = list_result.stdout.split("\n")
                        file_count = 0
                        for line in lines:
                            if "files" in line.lower() and "folder" not in line.lower():
                                try:
                                    parts = line.split()
                                    for part in parts:
                                        if part.isdigit():
                                            file_count = int(part)
                                            break
                                except:
                                    pass

                        if self.log_callback and file_count > 0:
                            self.log_callback(
                                f"    Archive contains approximately {file_count} files"
                            )

                        # Extract with progress updates (7-Zip shows progress in its output)
                        result = subprocess.run(
                            [
                                seven_zip_exe,
                                "x",
                                str(archive_path),
                                f"-o{extract_to}",
                                "-y",  # Yes to all
                                "-bsp1",  # Show progress
                            ],
                            capture_output=True,
                            text=True,
                            check=True,
                            startupinfo=self.subprocess_startupinfo,
                            creationflags=self.subprocess_creationflags,
                        )

                        if self.log_callback:
                            self.log_callback(f"    RAR extraction complete")
                        return True
                    except subprocess.CalledProcessError as e:
                        logger.error(f"7-Zip failed to extract {archive_path}: {e}")
                else:
                    # Try with rarfile if 7-Zip not available
                    try:
                        import rarfile

                        if self.log_callback:
                            self.log_callback(
                                f"    7-Zip not found, using rarfile module..."
                            )
                        with rarfile.RarFile(archive_path, "r") as rf:
                            if self.log_callback:
                                members = rf.namelist()
                                self.log_callback(
                                    f"    Extracting {len(members)} files from RAR archive..."
                                )
                            rf.extractall(extract_to)
                            if self.log_callback:
                                self.log_callback(
                                    f"    RAR extraction complete (using rarfile)"
                                )
                            return True
                    except ImportError as e:
                        error_msg = (
                            "Failed to extract RAR file: Neither 7-Zip nor rarfile module is available.\n"
                            "Please install 7-Zip from https://www.7-zip.org/ for better RAR support."
                        )
                        logger.error(error_msg)
                        if self.log_callback:
                            self.log_callback(f"    ERROR: {error_msg}")
                        return False
                    except Exception as e:
                        logger.error(f"Failed to extract RAR with rarfile: {e}")
                        if self.log_callback:
                            self.log_callback(
                                f"    ERROR: Failed to extract RAR file: {e}"
                            )
                        return False

            elif suffix in [".7z", ".cb7"]:
                with py7zr.SevenZipFile(archive_path, "r") as szf:
                    if self.log_callback:
                        all_files = szf.getnames()
                        self.log_callback(
                            f"    Extracting {len(all_files)} files from 7z archive..."
                        )
                    szf.extractall(extract_to)
                    if self.log_callback:
                        self.log_callback(f"    7z extraction complete")
                    return True

        except Exception as e:
            logger.error(f"Failed to extract {archive_path}: {e}")
            return False

        return False

    def find_all_image_directories(self, root_path: Path) -> List[Path]:
        """Find all directories containing images, including nested archives"""
        image_dirs = []
        processed_archives = set()
        total_nested_archives = []

        def process_directory(dir_path: Path, depth: int = 0):
            if depth > 10:  # Prevent infinite recursion
                return

            # First pass: count directories and files
            total_dirs = sum(1 for _ in os.walk(dir_path))
            if self.log_callback and depth == 0:
                self.log_callback(
                    f"  Scanning {total_dirs} directories for images and nested archives..."
                )

            for dirpath, dirnames, filenames in os.walk(dir_path):
                current_dir = Path(dirpath)
                rel_path = (
                    current_dir.relative_to(root_path)
                    if current_dir != root_path
                    else Path(".")
                )

                # Check if this directory contains images
                image_files = [
                    f
                    for f in filenames
                    if Path(f).suffix.lower() in self.IMAGE_EXTENSIONS
                ]

                if image_files:
                    # This directory contains images
                    image_dirs.append(current_dir)
                    logger.info(f"Found image directory: {current_dir}")
                    if self.log_callback:
                        self.log_callback(
                            f"  Found {len(image_files)} images in: {rel_path}"
                        )

                # Check for nested archives
                archive_files = [
                    f
                    for f in filenames
                    if Path(f).suffix.lower() in self.SUPPORTED_ARCHIVES
                ]

                if archive_files and depth == 0:
                    total_nested_archives.extend(archive_files)
                    if self.log_callback:
                        self.log_callback(
                            f"  Found {len(archive_files)} nested archives to process"
                        )

                for idx, archive_file in enumerate(archive_files, 1):
                    nested_archive = current_dir / archive_file

                    # Skip if already processed
                    if nested_archive in processed_archives:
                        continue

                    processed_archives.add(nested_archive)

                    # Extract nested archive
                    nested_extract_dir = (
                        current_dir / f"_extracted_{archive_file.replace('.', '_')}"
                    )
                    nested_extract_dir.mkdir(parents=True, exist_ok=True)

                    logger.info(f"Extracting nested archive: {archive_file}")
                    if self.log_callback:
                        if depth == 0:
                            self.log_callback(
                                f"  Extracting nested archive {idx}/{len(total_nested_archives)}: {archive_file}"
                            )
                        else:
                            self.log_callback(f"    Extracting: {archive_file}")

                    if self.extract_archive(nested_archive, nested_extract_dir):
                        if self.log_callback:
                            self.log_callback(
                                f"    Extraction complete, scanning for volumes..."
                            )
                        # Recursively process extracted content
                        process_directory(nested_extract_dir, depth + 1)

        process_directory(root_path)
        return image_dirs

    def find_image_directory(self, root_path: Path) -> Optional[Path]:
        """Legacy method - finds first image directory"""
        dirs = self.find_all_image_directories(root_path)
        return dirs[0] if dirs else None

    def process_archive(self, archive_path: Path) -> Tuple[List[Path], Optional[str]]:
        """Process archive and return all image directories found"""
        self.temp_dir = Path(tempfile.mkdtemp(prefix="manga_"))
        
        # Create subdirectory named after the archive (without extension)
        # This ensures that flat archives get a proper directory name for volume detection
        archive_subdir = self.temp_dir / archive_path.stem
        archive_subdir.mkdir(parents=True, exist_ok=True)

        try:
            # Extract the main archive
            if self.log_callback:
                self.log_callback(f"  Starting extraction to temporary directory...")

            # Extract to the subdirectory instead of directly to temp_dir
            if not self.extract_archive(archive_path, archive_subdir):
                return [], "Failed to extract archive"

            if self.log_callback:
                self.log_callback(f"  Main archive extracted, analyzing contents...")

            # Find all directories containing images (now searching from archive_subdir)
            image_dirs = self.find_all_image_directories(archive_subdir)

            if not image_dirs:
                return [], "No images found in archive"

            logger.info(
                f"Found {len(image_dirs)} image directories in {archive_path.name}"
            )
            if self.log_callback:
                self.log_callback(
                    f"  Analysis complete: found {len(image_dirs)} volume(s) to process"
                )
            return image_dirs, None

        except Exception as e:
            logger.error(f"Error processing archive: {e}")
            return [], str(e)

    def process_archive_single(
        self, archive_path: Path
    ) -> Tuple[Optional[Path], Optional[str]]:
        """Legacy method for backward compatibility - returns single directory"""
        dirs, error = self.process_archive(archive_path)
        if error:
            return None, error
        return dirs[0] if dirs else None, None

    def create_archive(
        self, source_dir: Path, output_path: Path, rename_images: bool = True
    ) -> bool:
        try:
            # Collect all image files
            image_files = []
            for root, dirs, files in os.walk(source_dir):
                for file in files:
                    file_path = Path(root) / file
                    if self.is_image(file_path):
                        image_files.append(file_path)

            # Sort files in natural order (handles names like "page1", "page2", "page10" correctly)
            image_files.sort(key=lambda p: natural_sort_key(str(p)))

            if self.log_callback:
                self.log_callback(
                    f"    Compressing {len(image_files)} images to {output_path.name}..."
                )
                if rename_images:
                    self.log_callback(
                        f"    Renaming images to sequential numbers (001, 002, ...)"
                    )

            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for idx, file_path in enumerate(image_files, 1):
                    if rename_images:
                        # Rename to sequential number, preserving extension
                        ext = file_path.suffix.lower()
                        arcname = f"{idx:03d}{ext}"  # 001.jpg, 002.png, etc.
                    else:
                        # Keep original structure
                        arcname = str(file_path.relative_to(source_dir))

                    zf.write(file_path, arcname)
                    if self.log_callback and idx % 10 == 0:  # Log every 10 files
                        self.log_callback(
                            f"      Compressed {idx}/{len(image_files)} images..."
                        )

            if self.log_callback:
                self.log_callback(f"    ✓ Created: {output_path.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to create archive: {e}")
            return False

    def cleanup(self):
        if self.temp_dir and self.temp_dir.exists():
            try:
                shutil.rmtree(self.temp_dir)
                self.temp_dir = None
            except Exception as e:
                logger.error(f"Failed to cleanup temp directory: {e}")
