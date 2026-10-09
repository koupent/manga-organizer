"""結合前の2枚を、そのまま復元するための記録。"""

import json
import zipfile
from pathlib import Path

from manga_core.original_store import (
    MANIFEST_ENTRY,
    MANIFEST_SIZE_LIMIT,
    ORIGINALS_PREFIX,
    OriginalRef,
    content_hash,
    plan_original,
    read_original,
)

MERGES_ENTRY = ".manga-organizer/merges.json"


def _records(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        if MERGES_ENTRY not in archive.namelist():
            return {}
        if archive.getinfo(MERGES_ENTRY).file_size > MANIFEST_SIZE_LIMIT:
            raise ValueError("結合の復元記録が大きすぎます")
        records = json.loads(archive.read(MERGES_ENTRY))
    if not isinstance(records, dict):
        raise ValueError("結合の復元記録が不正です")
    return records


def plan_merge(
    path: Path,
    produced: bytes,
    sources: list[tuple[str, bytes]],
    planned: dict[str, bytes],
) -> dict[str, bytes]:
    extras = planned
    records = (
        json.loads(extras[MERGES_ENTRY]) if MERGES_ENTRY in extras else _records(path)
    )
    entries = []
    for name, data in sources:
        extras = plan_original(path, data, name, planned=extras)
        digest = content_hash(data)
        entry = json.loads(extras[MANIFEST_ENTRY])["originals"][digest]
        entries.append([digest, entry])
    records[content_hash(produced)] = entries
    extras[MERGES_ENTRY] = json.dumps(records, ensure_ascii=False).encode()
    return extras


def merged_sources(path: Path, data: bytes) -> list[bytes] | None:
    entries = _records(path).get(content_hash(data))
    if entries is None:
        return None
    if not isinstance(entries, list) or len(entries) != 2:
        raise ValueError("結合の復元記録が不正です")
    if any(
        not isinstance(pair, list)
        or len(pair) != 2
        or not all(isinstance(value, str) for value in pair)
        or not pair[1].startswith(ORIGINALS_PREFIX)
        for pair in entries
    ):
        raise ValueError("結合の元画像の記録が不正です")
    return [
        read_original(path, OriginalRef(hash=digest, entry=entry))
        for digest, entry in entries
    ]
