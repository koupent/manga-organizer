"""モード別の復元と、旧版の復元可能な編集の一括復元。"""

import shutil
import zipfile
from pathlib import Path

from manga_core.archive_save import create_archive_temp, replace_archive
from manga_core.edit_reset import BACKUP_ENTRY, reset_edits
from manga_core.file_times import capture_file_times, restore_file_times
from manga_core.merge_store import merged_sources
from manga_core.original_store import content_hash, read_original, stored_step
from manga_core.page_margins import restore_margins
from manga_core.page_reorder import OutputPage, ZipPageEditor
from manga_core.page_splitter import (
    SplitIntent,
    apply_rows,
    scan_rows,
)

MODES = ("trim", "split", "merge", "thumbnail")


def _pixel_restore(path: Path, mode: str, apply: bool = False) -> int:
    editor = ZipPageEditor(path, include_deleted=True)
    try:
        outputs = []
        count = 0
        for page in editor.pages:
            data = editor.read_entry(page.name)
            replacements = None
            if mode == "merge":
                replacements = merged_sources(path, data)
            else:
                step = stored_step(path, data)
                if step:
                    ref, operations = step
                    margin = (
                        len(operations) == 1
                        and operations[0].kind == "crop"
                        and operations[0].params.get("purpose") in (None, "margin")
                    )
                    cover = (
                        all(op.kind in ("crop", "rotate", "split") for op in operations)
                        and not margin
                        and all(
                            op.params.get("purpose") != "margin"
                            and "x" not in op.params
                            for op in operations
                        )
                    )
                    if (mode == "trim" and margin) or (mode == "thumbnail" and cover):
                        replacements = [
                            (read_original(path, ref), Path(ref.entry).suffix)
                        ]
            if replacements:
                count += 1
                outputs.extend(
                    OutputPage(
                        page.name,
                        data,
                        deleted=page.deleted,
                        suffix=suffix,
                    )
                    for data, suffix in replacements
                )
            else:
                outputs.append(OutputPage(page.name, deleted=page.deleted))
        if apply and count:
            if mode == "trim":
                # 元画像を使う既存の余白復元と、各モードの一括復元を共有する。
                names = [out.source for out in outputs if out.content is not None]
                # 非表示のページも復元するため、共通の原子的保存へ渡す。
                if all(not out.deleted for out in outputs if out.content is not None):
                    editor.close()
                    restore_margins(path, names)
                else:
                    editor.apply_pages(outputs)
            else:
                editor.apply_pages(outputs)
        return count
    finally:
        editor.close()


def _split_restore(path: Path, apply: bool = False) -> int:
    rows = scan_rows(path)
    count = sum(row.split is not None for row in rows)
    if apply and count:
        apply_rows(
            path,
            [
                SplitIntent(names=row.names, split=None, deleted=row.deleted)
                for row in rows
            ],
            allow_reorder=True,
        )
    return count


def restore_preview(path: Path, mode: str = "all") -> dict:
    with zipfile.ZipFile(path) as archive:
        complete = BACKUP_ENTRY in archive.namelist()
    if mode == "all" and complete:
        return {
            "complete": True,
            "counts": {},
            "message": (
                "画像加工・ページ順・削除状態・確認済みの印を、"
                "最初のファイル編集前へ戻します。"
            ),
        }
    counts = {
        kind: (_split_restore(path) if kind == "split" else _pixel_restore(path, kind))
        for kind in (MODES if mode == "all" else (mode,))
    }
    return {
        "complete": False,
        "counts": counts,
        "message": (
            "保存されている元画像を使って復元します。"
            "旧版のページ順・表紙の位置・結合など、記録がない編集は残ります。"
        )
        if mode == "all"
        else (
            "この加工の直前の元画像が保存されているページを戻します。"
            "他の加工が重なっている場合は、その加工を先に戻してください。"
        ),
    }


def restore_saved(path: Path, mode: str = "all") -> dict:
    if mode not in (*MODES, "all"):
        raise ValueError("復元する編集の種類が不正です")
    preview = restore_preview(path, mode)
    if preview["complete"]:
        reset_edits(path)
        return preview
    if not any(preview["counts"].values()):
        raise ValueError(
            "復元できる元画像がありません。旧版で編集した本は、元のファイルから復元してください。"
        )
    times = capture_file_times(path)
    staged = create_archive_temp()
    try:
        shutil.copyfile(path, staged)
        counts = {kind: 0 for kind in (MODES if mode == "all" else (mode,))}
        # 加工の重なりは外側から戻す。対象本は全処理の検証後に一度だけ置換する。
        seen = set()
        while True:
            editor = ZipPageEditor(staged, include_deleted=True)
            try:
                # 名前・枚数が増える循環も検出し、削除済みページの復元も追跡する。
                signature = frozenset(
                    content_hash(editor.read_entry(page.name)) for page in editor.pages
                )
            finally:
                editor.close()
            if signature in seen:
                raise ValueError("復元記録が循環しているため処理を中止しました")
            seen.add(signature)
            changed = 0
            for kind in counts:
                count = (
                    _split_restore(staged, True)
                    if kind == "split"
                    else _pixel_restore(staged, kind, True)
                )
                counts[kind] += count
                changed += count
            if not changed or mode != "all":
                break
        with zipfile.ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise ValueError("復元したZIPの検証に失敗しました")
        replace_archive(staged, path)
        restore_file_times(path, times)
        return {**preview, "counts": counts}
    finally:
        staged.unlink(missing_ok=True)
