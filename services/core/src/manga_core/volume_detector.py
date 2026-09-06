import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from manga_core.input_expander import ARCHIVE_SUFFIXES

logger = logging.getLogger(__name__)

# 実処理（``archive_handler``）が入れ子アーカイブの展開先フォルダに付ける接頭辞。
# ``内_05.zip`` の展開先は ``_extracted_内_05_zip`` になり、元の名前は接頭辞と
# ``.`` → ``_`` の置き換えを除いてそのまま残っている
EXTRACTED_PREFIX = "_extracted_"

# 展開先フォルダ名の末尾に残る、``.`` が ``_`` に化けた拡張子。
# ``ARCHIVE_SUFFIXES`` から導くのは、対応形式が増えたときにここだけ取り残されて
# その形式の巻数だけずれるのを防ぐため。``_7z`` と ``_cb7`` は接尾辞そのものに
# 数字があり、落とし損ねると ``内_05_7z`` の 7 を拾って 5 巻が 7 巻になる
EXTRACTED_SUFFIXES = tuple(f"_{suffix.lstrip('.')}" for suffix in ARCHIVE_SUFFIXES)

# 巻数をどこから読んだか。実行前の一覧（#70）で「この巻数は怪しい」と伝えるには、
# 番号だけでは足りない。`第3巻` から読んだ 3 と、名前の最後の数字を拾っただけの 3 と、
# 並び順を当てはめただけの 3 は、利用者にとって信頼度がまるで違う
ORIGIN_NONE = "none"
ORIGIN_PATTERN = "pattern"
ORIGIN_LAST_NUMBER = "last-number"
ORIGIN_POSITION = "position"


@dataclass(frozen=True)
class VolumeDecision:
    """巻数と、その根拠。

    ``source_name`` は番号を読み取った名前。並び順から決めた場合は空になる。
    根拠を持ち回るのは、解析側が「名前に数字が複数あるから誤読しうる」といった
    判断を、巻数の読み取り規則を書き写さずに行えるようにするため。
    """

    number: int | None
    origin: str = ORIGIN_NONE
    source_name: str = ""


def unique_file_name(
    base_name: str,
    is_taken: Callable[[str], bool],
    extension: str = ".zip",
) -> str:
    """同じ名前がぶつかったときの ``_1`` の付け方。

    実処理（ディスク上の存在で判定）と実行前の解析（これから作る名前の集合で
    判定）で規則を別々に書くと、片方だけ直したときに予告した名前と実際に出来る
    名前が食い違う。判定手段だけを ``is_taken`` で差し替えて規則を 1 つに保つ。
    """
    candidate = f"{base_name}{extension}"
    if not is_taken(candidate):
        return candidate

    counter = 1
    while True:
        candidate = f"{base_name}_{counter}{extension}"
        if not is_taken(candidate):
            return candidate
        counter += 1


def format_series_dir(author: str, title: str) -> str:
    """整理が作る、作品ごとのフォルダ名。

    実処理（``FileOrganizer._create_manga_directory``）と、整理済みかどうかの
    判定（``organized_detector``）で別々に書くと、片方を直したときに整理済みの
    本が「置き場が違う」と判定され、既定で作り直される。
    """
    return f"[{author}] {title}"


def format_volume_name(author: str, title: str, volume: int | None) -> str:
    """整理が作る、本 1 冊のファイル名（拡張子は付けない）。

    ``format_series_dir`` と同じ理由でモジュールの関数にしてある。名前を作る側
    （``FileOrganizer``）、予告する側（``toc_analyzer``）、整理済みかどうかを判定
    する側（``organized_detector``）が同じ 1 つの関数を呼ぶ形にしないと、名前の
    作り方を変えたときに整理済みの本が「名前が違う」と判定され、既定で作り直される。
    """
    base_name = format_series_dir(author, title)
    if volume is not None:
        return f"{base_name} 第{volume:03d}巻"
    return f"{base_name} Unknown"


@dataclass(frozen=True)
class SeriesName:
    """本 1 冊を置く場所と名前を決める、著者と作品名の対（#73 段階 4a）。

    整理済みの本は自分自身の名前を持っていて、1 回の実行の中に依頼の対とは
    別の対が混ざる。対を 2 つの引数で持ち回ると、片方だけを差し替えた呼び出しが
    書けてしまい、``[別人] 作品`` のような、どちらの本の物でもない名前が出来る。
    """

    author: str
    title: str

    def series_dir(self) -> str:
        """この本を置く、作品ごとのフォルダ名"""
        return format_series_dir(self.author, self.title)

    def volume_name(self, volume: int | None) -> str:
        """この本のファイル名（拡張子は付けない）"""
        return format_volume_name(self.author, self.title, volume)


def original_nested_name(dir_name: str) -> str:
    """展開先フォルダ名から、元の入れ子アーカイブ名を取り戻す（#74）。

    ``_extracted_内_05_zip`` → ``内_05``。``.`` は ``_`` に置き換わったあとなので
    小数点は戻らないが、巻数を読むのに要る数字はそのまま残る。
    """
    body = dir_name[len(EXTRACTED_PREFIX) :]
    for suffix in EXTRACTED_SUFFIXES:
        if body.endswith(suffix):
            return body[: -len(suffix)]
    return body


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
        return self.decide_volume_from_archive(archive_path).number

    def detect_volume_from_name(self, name: str) -> int | None:
        """Detect volume number from a name string"""
        return self.decide_volume_from_name(name).number

    def detect_volume(self, directory_path: Path) -> int | None:
        return self.decide_volume(directory_path).number

    def decide_volume_from_archive(self, archive_path: Path) -> VolumeDecision:
        """アーカイブ名から巻数を読む。判定は拡張子を除いた名前で行う"""
        return self.decide_volume_from_name(archive_path.stem)

    def decide_volume_from_name(self, name: str) -> VolumeDecision:
        """名前から巻数を読み、どう読んだかを併せて返す"""
        # Try pattern-based detection
        volume = self.detect_volume_from_patterns(name)
        if volume:
            return VolumeDecision(volume, ORIGIN_PATTERN, name)

        # Fallback: extract all numbers and use the last one
        numbers = self.extract_numbers(name)
        if numbers:
            # Common heuristic: the last number is often the volume
            return VolumeDecision(numbers[-1], ORIGIN_LAST_NUMBER, name)

        return VolumeDecision(None, ORIGIN_NONE, name)

    def decide_volume(self, directory_path: Path) -> VolumeDecision:
        """フォルダ名から巻数を読み、どう読んだかを併せて返す"""
        dir_name = directory_path.name

        # 入れ子アーカイブの展開先は、元の名前を保っている。接頭辞と形式の
        # 接尾辞を外して元の名前で判定しないと、``まとめ.zip`` の中の
        # ``05.zip`` が並び順の第001巻になってしまう（#74）
        if dir_name.startswith(EXTRACTED_PREFIX):
            return self.decide_volume_from_name(original_nested_name(dir_name))

        # 作業用フォルダの名前は利用者が本に付けた名前ではないので、数字が
        # あっても読まない。``temp_08`` を 8 巻にすると、利用者が意図しない
        # 番号の本が出来る。上の枝と 1 つの条件に同居させると、片方の直しが
        # そのままこちらへ漏れる
        if dir_name.startswith("temp"):
            return VolumeDecision(None, ORIGIN_NONE, dir_name)

        # Use existing name-based detection logic
        return self.decide_volume_from_name(dir_name)

    def resolve_volume(
        self,
        directory_path: Path,
        archive_path: Path,
        position: int,
        total: int,
    ) -> VolumeDecision:
        """1 冊分の巻数を、優先順位に従って決める。

        整理の実処理と、実行前の解析（#70）が同じ番号を出す必要がある。規則を
        両方に書くと片方を直したときに予告と結果が食い違うため、ここに集約する。
        """
        # Priority 1: Try to get volume from the image directory name first
        decision = self.decide_volume(directory_path)
        if decision.number is not None:
            return decision

        # Priority 2: For single directory archives only, try archive name
        if total == 1:
            from_archive = self.decide_volume_from_archive(archive_path)
            if from_archive.number is not None:
                return from_archive
        # Priority 3: If multiple dirs and no volume number, use index
        elif total > 1:
            return VolumeDecision(position, ORIGIN_POSITION)

        return decision

    def format_volume_name(
        self,
        author: str,
        title: str,
        volume: int | None,
    ) -> str:
        """モジュールの ``format_volume_name`` へ委ねる。

        呼び出し側は検出器を持っている所と持っていない所があり、どちらからも
        同じ名前が出る必要がある。作り方そのものは 1 か所にしか置かない。
        """
        return format_volume_name(author, title, volume)

    def get_unique_filename(
        self, base_path: Path, base_name: str, extension: str = ".zip"
    ) -> Path:
        """まだ使われていない出力先を返す。既にあれば ``_1`` から番号を足す"""
        name = unique_file_name(
            base_name, lambda candidate: (base_path / candidate).exists(), extension
        )
        return base_path / name
