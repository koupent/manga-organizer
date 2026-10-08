"""ページに共通する白い余白の推定と、一律の切り取り。"""

import io
from collections.abc import Sequence
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops

from manga_core.original_store import (
    Derivation,
    Operation,
    find_crop_source,
    plan_edit,
    plan_manifest,
    plan_original,
    read_original,
)
from manga_core.page_reorder import OutputPage, ProgressCallback, ZipPageEditor


def white_margins(data: bytes) -> tuple[float, float, float, float]:
    """白い縁を左・上・右・下の百分率で返す。白紙は推定に使わない。"""
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB")
        image.thumbnail((600, 900))
    width, height = image.size
    red, green, blue = image.split()
    mask = ImageChops.darker(ImageChops.darker(red, green), blue).point(
        lambda value: 255 if value >= 235 else 0
    )
    columns = [
        v >= 254 for v in mask.resize((width, 1), Image.Resampling.BOX).tobytes()
    ]
    rows = [v >= 254 for v in mask.resize((1, height), Image.Resampling.BOX).tobytes()]
    if all(columns) or all(rows):
        return (0, 0, 0, 0)

    def edge(values):
        return next((i for i, value in enumerate(values) if not value), 0)

    # 20%を超える領域は余白と断定しない。微細な描画の境界も残す。
    return tuple(
        round(max(0, min(20, (edge(values) - 1) / size * 100)), 2)
        for values, size in (
            (columns, width),
            (rows, height),
            (columns[::-1], width),
            (rows[::-1], height),
        )
    )


def common_margins(margins: Sequence[Sequence[float]]) -> list[float]:
    """少なくとも7割のページにある縁だけを共通余白として提案する。"""
    if not margins:
        return [0, 0, 0, 0]
    return [
        round(median(values), 2)
        if sum(v > 0 for v in values) >= len(values) * 0.7
        else 0
        for values in zip(*margins, strict=True)
    ]


def trim_pages(
    path: Path,
    names: Sequence[str],
    margins: Sequence[float],
    progress: ProgressCallback | None = None,
) -> int:
    """現在のページを切り取り、元画像と加工記録を同じ原子的保存に含める。"""
    if len(margins) != 4 or any(not 0 <= value <= 40 for value in margins):
        raise ValueError("切り取り量は各辺0〜40%で指定してください")
    if not any(margins) or not names or len(set(names)) != len(names):
        raise ValueError("切り取り範囲と対象ページを指定してください")
    editor = ZipPageEditor(path, include_deleted=True)
    try:
        selected = set(names)
        if not selected <= {p.name for p in editor.pages if not p.deleted}:
            raise ValueError("切り取り対象のページが見つかりません")
        outputs = []
        extras = {}
        processed = 0
        for page in editor.pages:
            if page.name not in selected:
                outputs.append(OutputPage(page.name, deleted=page.deleted))
                continue
            original = editor.read_entry(page.name)
            with Image.open(io.BytesIO(original)) as source:
                width, height = source.size
                left, top, right, bottom = margins
                box = (
                    round(width * left / 100),
                    round(height * top / 100),
                    width - round(width * right / 100),
                    height - round(height * bottom / 100),
                )
                if box[0] >= box[2] or box[1] >= box[3]:
                    raise ValueError("切り取り後の画像が空になります")
                image = source.crop(box)
                # 出力形式は既存ページの拡張子に合わせる。
                buffer = io.BytesIO()
                options = (
                    {"quality": 95, "subsampling": 0} if source.format == "JPEG" else {}
                )
                if source.format == "WEBP":
                    options = {"lossless": True}
                elif source.format == "AVIF":
                    options = {"quality": 100}
                image.save(buffer, format=source.format, **options)
                produced = buffer.getvalue()
            # 分割や表紙調整の後でも、直前の画像そのものへ戻せるよう残す。
            extras = plan_original(path, original, page.name, planned=extras)
            extras = plan_manifest(
                path,
                source=original,
                source_name=page.name,
                derivations=(
                    Derivation(
                        produced,
                        (Operation("crop", {"box": list(box), "purpose": "margin"}),),
                    ),
                ),
                planned=extras,
            )
            outputs.append(OutputPage(page.name, produced))
            processed += 1
            if progress:
                progress(processed, len(selected))
        extras = plan_edit(path, "review", planned=extras)
        editor.apply_pages(outputs, progress=progress, extra_entries=extras)
        return len(selected)
    finally:
        editor.close()


def restore_margins(
    path: Path,
    names: Sequence[str],
    progress: ProgressCallback | None = None,
) -> int:
    """選択ページの直前の切り取りだけを戻す。再圧縮せず原子的に保存する。"""
    if not names or len(set(names)) != len(names):
        raise ValueError("復元するページを指定してください")
    editor = ZipPageEditor(path, include_deleted=True)
    try:
        selected = set(names)
        if not selected <= {p.name for p in editor.pages if not p.deleted}:
            raise ValueError("復元するページが見つかりません")
        outputs = []
        processed = 0
        for page in editor.pages:
            data = None
            if page.name in selected:
                ref = find_crop_source(path, editor.read_entry(page.name))
                if ref is None:
                    raise ValueError("切り取り直前の画像が保存されていません")
                data = read_original(path, ref)
                processed += 1
                if progress:
                    progress(processed, len(selected))
            outputs.append(OutputPage(page.name, data, deleted=page.deleted))
        editor.apply_pages(outputs, progress=progress)
        return len(selected)
    finally:
        editor.close()
