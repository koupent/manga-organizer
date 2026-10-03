import io
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import py7zr
from PIL import Image

from manga_core.input_expander import ARCHIVE_SUFFIXES
from manga_core.naming import natural_sort_key
from manga_core.safe_extract import (
    DEFAULT_LIMITS,
    ExtractionBudget,
    ExtractionLimitExceeded,
    ExtractionLimits,
    UnsafeEntryName,
    declared_size,
    safe_destination,
)
from manga_core.viewer_contract import (
    is_page_source,
    needs_conversion,
    output_suffix,
    relative_entry_name,
    sequential_name,
)

logger = logging.getLogger(__name__)


class ArchiveHandler:
    # Class-level constants
    # 扱う形式は投入時の展開と揃える。別々に持つと、片方だけ増やしたときに
    # 「一覧には出るのに整理されない」形式が生まれる
    SUPPORTED_ARCHIVES = ARCHIVE_SUFFIXES

    @staticmethod
    def _get_bundled_7zip_path():
        """Get path to bundled 7-Zip executable when running from PyInstaller bundle"""
        if hasattr(sys, "_MEIPASS"):
            # Running from PyInstaller bundle
            # First try 7za.exe (standalone version)
            bundled_7za = Path(sys._MEIPASS) / "resources" / "7zip" / "7za.exe"
            if bundled_7za.exists():
                return str(bundled_7za)

            # Fallback to 7z.exe if available
            bundled_7z = Path(sys._MEIPASS) / "resources" / "7zip" / "7z.exe"
            if bundled_7z.exists():
                return str(bundled_7z)
        return None

    def __init__(
        self,
        log_callback=None,
        limits: ExtractionLimits = DEFAULT_LIMITS,
        budget: ExtractionBudget | None = None,
    ):
        # 入れ子は合計で数える。1 段ごとの上限では多段の展開爆弾を止められない
        self.budget = budget or ExtractionBudget(limits)
        self.temp_dir = None
        # 直近に展開したアーカイブの中身を置いた場所。実行前の解析が
        # 予告した位置と、実際に出来たフォルダを突き合わせるのに使う（#70）
        self.extract_root: Path | None = None
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

    def is_archive(self, file_path: Path) -> bool:
        return file_path.suffix.lower() in self.SUPPORTED_ARCHIVES

    def is_image(self, file_path: Path, root: Path | None = None) -> bool:
        # suzume-viewer が読み飛ばすもの（__MACOSX/、ドット始まり）は
        # ページに含めない。含めると連番に組み込まれ、リネーム後に
        # viewer 側で壊れたページとして表示されてしまう。
        # 先頭一致で見るため、判定は展開ルートからの相対名で行う
        name = relative_entry_name(file_path, root) if root else file_path.name
        if not is_page_source(name):
            return False
        try:
            with Image.open(file_path) as img:
                img.verify()
            return True
        except Exception:
            return False

    def _find_7zip_executable(self) -> str | None:
        """Find 7-Zip executable path"""
        # Check for bundled 7-Zip first (when running from PyInstaller)
        bundled_path = self._get_bundled_7zip_path()
        if bundled_path:
            self._log(
                f"    Using bundled 7-Zip from executable: {Path(bundled_path).name}"
            )
            return bundled_path

        # Fall back to system 7-Zip
        system_paths = [
            "C:/Program Files/7-Zip/7z.exe",
            "C:/Program Files (x86)/7-Zip/7z.exe",
            "7za",  # Try standalone 7za in PATH
            "7z",  # Try 7z in PATH
        ]

        for path in system_paths:
            if path and (Path(path).exists() or shutil.which(path)):
                return path
        return None

    def _get_7zip_file_count(self, seven_zip_exe: str, archive_path: Path) -> int:
        """Get file count from 7-Zip archive listing"""
        try:
            list_result = subprocess.run(
                [seven_zip_exe, "l", str(archive_path)],
                capture_output=True,
                text=True,
                startupinfo=self.subprocess_startupinfo,
                creationflags=self.subprocess_creationflags,
            )

            # Parse file count from output
            lines = list_result.stdout.split("\n")
            for line in lines:
                if "files" in line.lower() and "folder" not in line.lower():
                    parts = line.split()
                    for part in parts:
                        if part.isdigit():
                            return int(part)
        except Exception:
            pass
        return 0

    def _extract_with_7zip(self, archive_path: Path, extract_to: Path) -> bool:
        """Extract archive using 7-Zip"""
        seven_zip_exe = self._find_7zip_executable()
        if not seven_zip_exe:
            return False

        try:
            self._log("    Using 7-Zip to extract archive...")

            # Get file count for progress reporting
            file_count = self._get_7zip_file_count(seven_zip_exe, archive_path)
            if file_count > 0:
                self._log(f"    Archive contains approximately {file_count} files")

            # Extract with 7-Zip
            subprocess.run(
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

            self._log("    Extraction complete")
            return True

        except subprocess.CalledProcessError as e:
            self._log(f"7-Zip failed to extract {archive_path}: {e}", "error")
            return False

    def _extract_zip(
        self, archive_path: Path, extract_to: Path, progress_callback=None
    ) -> bool:
        """Extract ZIP archive"""
        try:
            with zipfile.ZipFile(archive_path, "r") as zf:
                infos = zf.infolist()
                total = len(infos)
                for i, info in enumerate(infos):
                    if progress_callback:
                        progress_callback(f"Extracting: {info.filename}", i, total)
                    if info.is_dir():
                        continue
                    # zipfile は名前を正規化するが、拒否したことを記録に残す
                    try:
                        safe_destination(info.filename, extract_to)
                    except UnsafeEntryName:
                        self._log(
                            f"    危険なエントリを飛ばしました: {info.filename}",
                            "warning",
                        )
                        continue
                    self.budget.consume_entry()
                    self.budget.consume_bytes(info.file_size)
                    zf.extract(info, extract_to)
                return True
        except ExtractionLimitExceeded:
            raise
        except Exception as e:
            self._log(f"Failed to extract ZIP: {e}", "error")
            return False

    def _extract_rar(self, archive_path: Path, extract_to: Path) -> bool:
        """Extract RAR archive using 7-Zip or rarfile"""
        # Try 7-Zip first
        if self._extract_with_7zip(archive_path, extract_to):
            return True

        # Fallback to rarfile module
        try:
            import rarfile

            # Configure rarfile to use 7-Zip if available
            seven_zip_exe = self._find_7zip_executable()
            if seven_zip_exe:
                exe_name = Path(seven_zip_exe).name
                self._log(f"    Configuring rarfile to use {exe_name}: {seven_zip_exe}")
                rarfile.UNRAR_TOOL = seven_zip_exe

                # Different args depending on whether it's 7z.exe or 7za.exe
                # Both versions use the same command syntax
                rarfile.OPEN_ARGS = ("x", "-y")
                rarfile.EXTRACT_ARGS = ("x", "-y", "-o")
                rarfile.TEST_ARGS = ("t",)
            else:
                # Try to find unrar or other RAR tools
                import shutil

                unrar_tools = ["unrar", "UnRAR.exe", "WinRAR.exe"]
                found_tool = None
                for tool in unrar_tools:
                    if shutil.which(tool):
                        found_tool = tool
                        break

                if found_tool:
                    self._log(f"    Using {found_tool} for RAR extraction")
                    rarfile.UNRAR_TOOL = found_tool
                else:
                    self._log(
                        "    WARNING: No RAR extraction tool found. "
                        "Trying default configuration..."
                    )

            self._log(f"    Using rarfile module with tool: {rarfile.UNRAR_TOOL}")
            with rarfile.RarFile(archive_path, "r") as rf:
                members = rf.namelist()
                self._log(f"    Extracting {len(members)} files from RAR archive...")
                rf.extractall(extract_to)
                self._log("    RAR extraction complete (using rarfile)")
                return True

        except ImportError:
            error_msg = (
                "Failed to extract RAR file: Neither 7-Zip nor rarfile "
                "module is available.\n"
                "Please install 7-Zip from https://www.7-zip.org/ "
                "for better RAR support."
            )
            self._log(f"    ERROR: {error_msg}", "error")
            return False
        except (rarfile.RarCannotExec, rarfile.RarExecError) as e:
            error_msg = (
                f"Cannot find working tool for RAR extraction.\n"
                f"Please install one of the following:\n"
                f"  1. 7-Zip from https://www.7-zip.org/ (recommended)\n"
                f"  2. UnRAR command line tool\n"
                f"  3. WinRAR\n"
                f"Error details: {e}"
            )
            self._log(f"    ERROR: {error_msg}", "error")
            return False
        except Exception as e:
            self._log(f"    ERROR: Failed to extract RAR file: {e}", "error")
            return False

    def _extract_7z(self, archive_path: Path, extract_to: Path) -> bool:
        """Extract 7z archive"""
        try:
            with py7zr.SevenZipFile(archive_path, "r") as szf:
                all_files = szf.getnames()
                self._log(f"    Extracting {len(all_files)} files from 7z archive...")
                szf.extractall(extract_to)
                self._log("    7z extraction complete")
                return True
        except ExtractionLimitExceeded:
            raise
        except Exception as e:
            self._log(f"Failed to extract 7z: {e}", "error")
            return False

    def extract_archive(
        self, archive_path: Path, extract_to: Path, progress_callback=None
    ) -> bool:
        """Extract archive based on its type"""
        # 書き出しを始める前に、中央ディレクトリの申告で膨張を見抜く
        declared = declared_size(archive_path)
        if declared is not None:
            total_bytes, entry_count = declared
            if total_bytes > self.budget.remaining_bytes:
                raise ExtractionLimitExceeded(
                    f"{archive_path.name} の展開後サイズ {total_bytes} バイトが "
                    f"残量 {self.budget.remaining_bytes} バイトを超えます"
                )

        try:
            suffix = archive_path.suffix.lower()

            if suffix in [".zip", ".cbz", ".epub"]:
                return self._extract_zip(archive_path, extract_to, progress_callback)
            elif suffix in [".rar", ".cbr"]:
                return self._extract_rar(archive_path, extract_to)
            elif suffix in [".7z", ".cb7"]:
                return self._extract_7z(archive_path, extract_to)
            else:
                self._log(f"Unsupported archive format: {suffix}", "error")
                return False

        except ExtractionLimitExceeded:
            raise
        except Exception as e:
            self._log(f"Failed to extract {archive_path}: {e}", "error")
            return False

    def _process_directory_for_images(
        self, dir_path: Path, root_path: Path, image_dirs: list[Path], depth: int = 0
    ):
        """Process a directory to find image directories and nested archives"""
        if not self.budget.may_descend(depth):
            self._log(f"  入れ子の深さが上限に達しました (depth={depth})", "warning")
            return

        processed_archives = set()

        # First pass: count directories
        if depth == 0:
            total_dirs = sum(1 for _ in os.walk(dir_path))
            self._log(
                f"  Scanning {total_dirs} directories for images and nested archives..."
            )

        for dirpath, dirnames, filenames in os.walk(dir_path):
            # 並び順は巻数（並び順で決まる本）に効く。OS の列挙順に任せると
            # ファイルシステムごとに巻数が変わり、画面に出した解析
            # （toc_analyzer._scan_directory、名前順）とも食い違う。同じ順に固定する
            dirnames.sort(key=natural_sort_key)
            current_dir = Path(dirpath)
            rel_path = (
                current_dir.relative_to(root_path)
                if current_dir != root_path
                else Path(".")
            )

            # Check for images in this directory
            image_files = [
                f
                for f in filenames
                if is_page_source(relative_entry_name(current_dir / f, root_path))
            ]

            if image_files:
                image_dirs.append(current_dir)
                self._log(f"  Found {len(image_files)} images in: {rel_path}")

            # Check for nested archives
            archive_files = sorted(
                (
                    f
                    for f in filenames
                    if Path(f).suffix.lower() in self.SUPPORTED_ARCHIVES
                ),
                key=natural_sort_key,
            )

            if archive_files and depth == 0:
                self._log(f"  Found {len(archive_files)} nested archives to process")

            # Process nested archives
            for idx, archive_file in enumerate(archive_files, 1):
                nested_archive = current_dir / archive_file

                if nested_archive in processed_archives:
                    continue

                processed_archives.add(nested_archive)

                # Extract nested archive
                nested_extract_dir = (
                    current_dir / f"_extracted_{archive_file.replace('.', '_')}"
                )
                nested_extract_dir.mkdir(parents=True, exist_ok=True)

                if depth == 0:
                    self._log(
                        "  Extracting nested archive "
                        f"{idx}/{len(archive_files)}: {archive_file}"
                    )
                else:
                    self._log(f"    Extracting: {archive_file}")

                if self.extract_archive(nested_archive, nested_extract_dir):
                    self._log("    Extraction complete, scanning for volumes...")
                    # Recursively process extracted content
                    self._process_directory_for_images(
                        nested_extract_dir, root_path, image_dirs, depth + 1
                    )

    def find_all_image_directories(self, root_path: Path) -> list[Path]:
        """Find all directories containing images, including nested archives"""
        image_dirs = []
        self._process_directory_for_images(root_path, root_path, image_dirs)
        return image_dirs

    def find_image_directory(self, root_path: Path) -> Path | None:
        """Legacy method - finds first image directory"""
        dirs = self.find_all_image_directories(root_path)
        return dirs[0] if dirs else None

    def process_archive(self, archive_path: Path) -> tuple[list[Path], str | None]:
        """Process archive and return all image directories found"""
        self.temp_dir = Path(tempfile.mkdtemp(prefix="manga_"))

        # Create subdirectory named after the archive (without extension)
        # This ensures that flat archives get a proper directory name
        # for volume detection
        archive_subdir = self.temp_dir / archive_path.stem
        archive_subdir.mkdir(parents=True, exist_ok=True)
        self.extract_root = archive_subdir

        try:
            # Extract the main archive
            self._log("  Starting extraction to temporary directory...")

            # Extract to the subdirectory instead of directly to temp_dir
            if not self.extract_archive(archive_path, archive_subdir):
                return [], "Failed to extract archive"

            self._log("  Main archive extracted, analyzing contents...")

            # Find all directories containing images (now searching from archive_subdir)
            image_dirs = self.find_all_image_directories(archive_subdir)

            if not image_dirs:
                return [], "No images found in archive"

            self._log(
                f"  Analysis complete: found {len(image_dirs)} volume(s) to process"
            )
            return image_dirs, None

        except ExtractionLimitExceeded:
            # 上限超過は呼び出し側が判断すべき中断であって、失敗として畳まない
            raise
        except Exception as e:
            self._log(f"Error processing archive: {e}", "error")
            return [], str(e)

    def create_archive(
        self, source_dir: Path, output_path: Path, rename_images: bool = True
    ) -> bool:
        """Create a new archive from source directory"""
        try:
            # Collect all image files
            image_files = []
            for root, _dirs, files in os.walk(source_dir):
                for file in files:
                    file_path = Path(root) / file
                    if self.is_image(file_path, source_dir):
                        image_files.append(file_path)

            # Sort files in natural order
            image_files.sort(key=lambda p: natural_sort_key(str(p)))

            self._log(
                f"    Compressing {len(image_files)} images to {output_path.name}..."
            )
            if rename_images:
                self._log("    Renaming images to sequential numbers (001, 002, ...)")

            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
                total = len(image_files)
                written_names: set[str] = set()
                for idx, file_path in enumerate(image_files, 1):
                    if rename_images:
                        # 辞書順と数値順が一致するよう、総数に応じて桁を広げる
                        arcname = sequential_name(idx, total, file_path.suffix)
                    else:
                        # Keep original structure。変換する場合は拡張子も
                        # 合わせないと viewer が読み飛ばしてしまう
                        relative = file_path.relative_to(source_dir)
                        arcname = str(
                            relative.with_suffix(output_suffix(relative.suffix))
                        )

                    if arcname in written_names:
                        raise ValueError(
                            f"出力名が衝突します: {arcname} ({file_path.name})"
                        )
                    written_names.add(arcname)

                    if needs_conversion(relative_entry_name(file_path, source_dir)):
                        self._write_converted(zf, file_path, arcname)
                    else:
                        zf.write(file_path, arcname)
                    if idx % 10 == 0:  # Log every 10 files
                        self._log(
                            f"      Compressed {idx}/{len(image_files)} images..."
                        )

            self._log(f"    ✓ Created: {output_path.name}")
            return True

        except Exception as e:
            self._log(f"Failed to create archive: {e}", "error")
            return False

    def _write_converted(self, zf, file_path: Path, arcname: str) -> None:
        """viewer が読めない画像を PNG へ変換して書き込む。

        BMP は無圧縮なだけで、PNG は可逆圧縮なので画質は落ちない。
        """
        with Image.open(file_path) as image:
            mode = "RGBA" if "A" in image.getbands() else "RGB"
            buffer = io.BytesIO()
            image.convert(mode).save(buffer, "PNG", optimize=True)
        zf.writestr(arcname, buffer.getvalue())
        self._log(f"    Converted to PNG for viewer support: {file_path.name}")

    def cleanup(self):
        """Clean up temporary directory"""
        if self.temp_dir and self.temp_dir.exists():
            try:
                shutil.rmtree(self.temp_dir)
                self.temp_dir = None
                self.extract_root = None
            except Exception as e:
                self._log(f"Failed to cleanup temp directory: {e}", "error")
