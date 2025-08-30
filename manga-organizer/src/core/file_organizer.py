import os
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
import logging

import zipfile
import py7zr

from core.archive_handler import ArchiveHandler
from core.volume_detector import VolumeDetector

logger = logging.getLogger(__name__)


@dataclass
class ProcessResult:
    original_path: Path
    output_path: Optional[Path]
    success: bool
    error_message: Optional[str] = None
    volume_number: Optional[int] = None
    special_type: Optional[str] = None


class FileOrganizer:
    def __init__(
        self, output_directory: Path, keep_originals: bool = True, log_callback=None
    ):
        self.output_directory = output_directory
        self.keep_originals = keep_originals
        self.log_callback = log_callback
        self.archive_handler = ArchiveHandler(log_callback=log_callback)
        self.volume_detector = VolumeDetector()
        self.results: List[ProcessResult] = []
        self.author = ""
        self.title = ""

    def _log(self, message: str, level: str = "info"):
        """Unified logging helper method"""
        if self.log_callback:
            self.log_callback(message)
        
        if level == "error":
            logger.error(message)
        elif level == "warning":
            logger.warning(message)
        else:
            logger.info(message)

    def set_manga_info(self, author: str, title: str):
        self.author = author
        self.title = title

    def collect_archives(self, paths: List[Path]) -> List[Path]:
        """Collect all archive files from given paths"""
        archives = []

        for path in paths:
            if path.is_file() and self.archive_handler.is_archive(path):
                archives.append(path)
            elif path.is_dir():
                # Scan directory for archives
                for file_path in path.rglob("*"):
                    if file_path.is_file() and self.archive_handler.is_archive(
                        file_path
                    ):
                        archives.append(file_path)

        return archives

    def _validate_and_extract_archive(self, archive_path: Path) -> Tuple[List[Path], Optional[str]]:
        """Validate and extract archive, returning image directories and any error"""
        self._log(f"  Processing archive structure...")
        image_dirs, error = self.archive_handler.process_archive(archive_path)
        
        if error or not image_dirs:
            return [], error or "No images found"
            
        self._log(f"Found {len(image_dirs)} volumes in {archive_path.name}")
        return image_dirs, None

    def _create_manga_directory(self) -> Path:
        """Create output directory for manga series"""
        self._log(f"  Creating output directory for manga series...")
        manga_dir = self.output_directory / f"[{self.author}] {self.title}"
        manga_dir.mkdir(parents=True, exist_ok=True)
        return manga_dir

    def _detect_volume_number(
        self, image_dir: Path, archive_path: Path, vol_idx: int, total_dirs: int
    ) -> Tuple[Optional[int], Optional[str]]:
        """Detect volume number using priority-based detection"""
        # Priority 1: Try to get volume from the image directory name first
        volume, special = self.volume_detector.detect_volume(image_dir)
        
        # Priority 2: For single directory archives only, try archive name
        if volume is None and total_dirs == 1:
            volume_from_archive, special_from_archive = (
                self.volume_detector.detect_volume_from_archive(archive_path)
            )
            if volume_from_archive is not None:
                volume = volume_from_archive
                special = special_from_archive
        # Priority 3: If multiple dirs and no volume number, use index
        elif volume is None and total_dirs > 1:
            volume = vol_idx
            
        return volume, special

    def _process_volume(
        self, image_dir: Path, archive_path: Path, manga_dir: Path,
        volume: Optional[int], special: Optional[str]
    ) -> ProcessResult:
        """Process a single volume and create output archive"""
        # Generate output filename
        output_name = self.volume_detector.format_volume_name(
            self.author, self.title, volume, special
        )
        
        # Get unique output path in the manga subdirectory
        output_path = self.volume_detector.get_unique_filename(
            manga_dir, output_name
        )
        
        # Create new archive for this volume
        success = self.archive_handler.create_archive(image_dir, output_path)
        
        if success:
            self._log(f"Created: {output_path.name}")
            return ProcessResult(
                original_path=archive_path,
                output_path=output_path,
                success=True,
                volume_number=volume,
                special_type=special,
            )
        else:
            return ProcessResult(
                original_path=archive_path,
                output_path=None,
                success=False,
                error_message=f"Failed to create archive for volume {volume}",
            )

    def _handle_original_deletion(self, archive_path: Path, results: List[ProcessResult]):
        """Delete original archive if requested and all volumes were successful"""
        if not self.keep_originals and all(r.success for r in results):
            try:
                archive_path.unlink()
                self._log(f"Deleted original: {archive_path}")
            except Exception as e:
                self._log(f"Failed to delete original: {e}", "error")

    def process_single_archive(self, archive_path: Path) -> List[ProcessResult]:
        """Process a single archive file"""
        self._log(f"Processing: {archive_path}")
        results = []

        try:
            # Step 1: Validate and extract archive
            image_dirs, error = self._validate_and_extract_archive(archive_path)
            if error:
                return [
                    ProcessResult(
                        original_path=archive_path,
                        output_path=None,
                        success=False,
                        error_message=error,
                    )
                ]
            
            # Step 2: Create manga directory
            manga_dir = self._create_manga_directory()
            
            # Step 3: Process each volume
            if len(image_dirs) > 1:
                self._log(f"  Processing {len(image_dirs)} volumes...")
            
            for vol_idx, image_dir in enumerate(image_dirs, 1):
                if len(image_dirs) > 1:
                    self._log(f"  Processing volume {vol_idx}/{len(image_dirs)}...")
                
                # Detect volume number
                volume, special = self._detect_volume_number(
                    image_dir, archive_path, vol_idx, len(image_dirs)
                )
                
                # Process the volume
                result = self._process_volume(
                    image_dir, archive_path, manga_dir, volume, special
                )
                results.append(result)
            
            # Step 4: Handle original deletion
            self._handle_original_deletion(archive_path, results)
            
            return (
                results
                if results
                else [
                    ProcessResult(
                        original_path=archive_path,
                        output_path=None,
                        success=False,
                        error_message="No volumes processed",
                    )
                ]
            )

        except Exception as e:
            self._log(f"Error processing {archive_path}: {e}", "error")
            return [
                ProcessResult(
                    original_path=archive_path,
                    output_path=None,
                    success=False,
                    error_message=str(e),
                )
            ]
        finally:
            # Cleanup temporary files
            self.archive_handler.cleanup()

    def process_archives(
        self, archives: List[Path], progress_callback=None
    ) -> List[ProcessResult]:
        """Process multiple archive files"""
        self.results = []

        for i, archive in enumerate(archives):
            if progress_callback:
                progress_callback(i + 1, len(archives), archive.name)

            # process_single_archive now returns a list of results
            results_for_archive = self.process_single_archive(archive)
            self.results.extend(results_for_archive)

        return self.results

    def get_summary(self) -> Dict:
        """Get processing summary"""
        successful = sum(1 for r in self.results if r.success)
        failed = sum(1 for r in self.results if not r.success)

        return {
            "total": len(self.results),
            "successful": successful,
            "failed": failed,
            "results": self.results,
        }