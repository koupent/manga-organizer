import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)


class VolumeDetector:
    def __init__(self):
        # Common volume patterns in Japanese manga naming
        self.volume_patterns = [
            r"第(\d+)巻",  # 第1巻
            r"vol[.\s]*(\d+)",  # vol.1, vol 1
            r"v(\d+)",  # v1
            r"第(\d+)話",  # 第1話 (chapter)
            r"(\d+)巻",  # 1巻
            r"\[(\d+)\]",  # [1]
            r"#(\d+)",  # #1
        ]

    def extract_numbers(self, text: str) -> list[int]:
        # Extract all number sequences from text
        numbers = re.findall(r"\d+", text)
        return [int(n) for n in numbers]

    def detect_volume_from_patterns(self, text: str) -> int | None:
        text_lower = text.lower()

        # Try each volume pattern
        for pattern in self.volume_patterns:
            match = re.search(pattern, text_lower, re.IGNORECASE)
            if match:
                try:
                    return int(match.group(1))
                except ValueError:
                    pass

        return None

    def detect_volume_from_archive(self, archive_path: Path) -> int | None:
        """Detect volume number from archive filename"""
        archive_name = archive_path.stem  # Get filename without extension
        return self.detect_volume_from_name(archive_name)

    def detect_volume_from_name(self, name: str) -> int | None:
        """Detect volume number from a name string"""
        # Try pattern-based detection
        volume = self.detect_volume_from_patterns(name)
        if volume:
            return volume

        # Fallback: extract all numbers and use the last one
        numbers = self.extract_numbers(name)
        if numbers:
            # Common heuristic: the last number is often the volume
            return numbers[-1]

        return None

    def detect_volume(self, directory_path: Path) -> int | None:
        dir_name = directory_path.name

        # Skip obvious temporary directories (but not normal manga_vol type names)
        if dir_name.startswith("_extracted_") or dir_name.startswith("temp"):
            return None

        # Use existing name-based detection logic
        return self.detect_volume_from_name(dir_name)

    def format_volume_name(
        self,
        author: str,
        title: str,
        volume: int | None,
    ) -> str:
        base_name = f"[{author}] {title}"

        if volume is not None:
            return f"{base_name} 第{volume:03d}巻"
        else:
            return f"{base_name} Unknown"

    def get_unique_filename(
        self, base_path: Path, base_name: str, extension: str = ".zip"
    ) -> Path:
        output_path = base_path / f"{base_name}{extension}"

        if not output_path.exists():
            return output_path

        # If file exists, add a counter
        counter = 1
        while True:
            output_path = base_path / f"{base_name}_{counter}{extension}"
            if not output_path.exists():
                return output_path
            counter += 1
