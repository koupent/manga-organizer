"""作品単位のグルーピング推定。

複数巻で構成される作品を 1 つのディレクトリにまとめるため、ファイル名から
作品名と巻数を推定する。命名は揃っていないのが普通で、自動推定は必ず外れる。
外れる前提で、確信度を添えて人が直せる初期案として返す。
"""

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from manga_core.naming import natural_sort_key
from manga_core.volume_detector import VolumeDetector

logger = logging.getLogger(__name__)

# 巻数として現れる書き方。長いものから順に試す
_VOLUME_MARKERS = (
    r"第\s*(\d+)\s*巻",
    r"第\s*(\d+)\s*話",
    r"vol\s*[.\s_-]*\s*(\d+)",
    r"\bv\s*(\d+)\b",
    r"#\s*(\d+)",
    r"(\d+)\s*巻",
)

# 末尾に裸で置かれた数字。区切り文字が前にあるものだけを巻数とみなす
_TRAILING_NUMBER = re.compile(r"[\s_\-.　]+(\d{1,4})\s*$")

# 重複コピーの印。巻数ではない
_COPY_SUFFIX = re.compile(r"[\s_\-]*[(（]\s*\d+\s*[)）]\s*$")

# 作者名やタグ。作品の同一性には関わらない
_BRACKETED = re.compile(r"[\[\(【（][^\]\)】）]*[\]\)】）]")

_SEPARATORS = re.compile(r"[\s_\-.,;:!?　・~〜\|]+")

CONFIDENT = 0.9
LIKELY = 0.6
UNCERTAIN = 0.3


@dataclass(frozen=True)
class SeriesVolume:
    """作品を構成する 1 冊"""

    path: Path
    volume: int | None

    def to_dict(self) -> dict:
        """API 応答用に直す"""
        return {"path": str(self.path), "name": self.path.name, "volume": self.volume}


@dataclass
class SeriesGroup:
    """同じ作品と推定した巻のまとまり"""

    title: str
    volumes: list[SeriesVolume] = field(default_factory=list)
    confidence: float = UNCERTAIN

    @property
    def has_duplicate_volumes(self) -> bool:
        """同じ巻数が重複しているか"""
        numbers = [v.volume for v in self.volumes if v.volume is not None]
        return len(numbers) != len(set(numbers))

    def to_dict(self) -> dict:
        """API 応答用に直す"""
        return {
            "title": self.title,
            "confidence": self.confidence,
            "hasDuplicateVolumes": self.has_duplicate_volumes,
            "volumes": [volume.to_dict() for volume in self.volumes],
        }


def strip_volume_marker(name: str) -> str:
    """名前から巻数の表記を取り除き、作品名らしき部分を残す"""
    stripped = _COPY_SUFFIX.sub("", name)
    for pattern in _VOLUME_MARKERS:
        replaced = re.sub(pattern, " ", stripped, count=1, flags=re.IGNORECASE)
        if replaced != stripped:
            return _tidy(replaced)

    # 末尾の裸の数字。区切りが前にある場合だけ巻数とみなす。
    # 「20世紀少年」のように題名の一部である数字を落とさないため
    trailing = _TRAILING_NUMBER.sub("", stripped)
    return _tidy(trailing)


def _tidy(text: str) -> str:
    """余分な区切りを詰める"""
    return _SEPARATORS.sub(" ", text).strip(" 　_-.")


def series_key(name: str) -> str:
    """同じ作品かどうかを突き合わせるための鍵。

    作者名やタグの有無、区切り文字、全角半角、大小文字で別作品にしない。
    """
    without_tags = _BRACKETED.sub(" ", name)
    title = strip_volume_marker(without_tags)
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return _SEPARATORS.sub("", normalized)


def _display_title(names: list[str]) -> str:
    """まとまりを代表する作品名を選ぶ。

    タグを外した候補のうち、最も多く現れた綴りを採る。同数なら短いものを選ぶ
    （余計な語が付いていない可能性が高い）。
    """
    candidates: dict[str, int] = {}
    for name in names:
        title = strip_volume_marker(_BRACKETED.sub(" ", name))
        if title:
            candidates[title] = candidates.get(title, 0) + 1
    if not candidates:
        return names[0] if names else ""
    return sorted(candidates.items(), key=lambda item: (-item[1], len(item[0])))[0][0]


def _confidence(volumes: list[SeriesVolume], titles: list[str]) -> float:
    """推定の確からしさ。UI で「怪しいもの」を目立たせるために使う"""
    numbered = [v for v in volumes if v.volume is not None]
    if not numbered:
        # 巻数が読めていない。単巻かもしれないし、命名が独特なだけかもしれない
        return UNCERTAIN
    if len(volumes) > 1 and len(numbered) == len(volumes):
        return CONFIDENT
    if len({strip_volume_marker(t) for t in titles}) == 1:
        return LIKELY
    return UNCERTAIN


def estimate_series(paths) -> list[SeriesGroup]:
    """アーカイブ群を作品ごとにまとめた初期案を返す"""
    detector = VolumeDetector()
    buckets: dict[str, list[Path]] = {}
    for path in paths:
        buckets.setdefault(series_key(Path(path).stem), []).append(Path(path))

    groups: list[SeriesGroup] = []
    for members in buckets.values():
        names = [member.stem for member in members]
        volumes = [
            SeriesVolume(path=member, volume=_detect_volume(detector, member))
            for member in members
        ]
        # 辞書順だと 10 が 2 より前に来る。巻数が読めないものは末尾へ
        volumes.sort(
            key=lambda v: (
                v.volume is None,
                v.volume or 0,
                natural_sort_key(v.path.name),
            )
        )
        groups.append(
            SeriesGroup(
                title=_display_title(names),
                volumes=volumes,
                confidence=_confidence(volumes, names),
            )
        )

    groups.sort(key=lambda group: natural_sort_key(group.title))
    return groups


def _detect_volume(detector: VolumeDetector, path: Path) -> int | None:
    """巻数を読む。題名の一部の数字を巻数と取り違えないようにする"""
    stem = _COPY_SUFFIX.sub("", path.stem)
    marked = detector.detect_volume_from_patterns(stem)
    if marked is not None:
        return marked
    trailing = _TRAILING_NUMBER.search(stem)
    return int(trailing.group(1)) if trailing else None
