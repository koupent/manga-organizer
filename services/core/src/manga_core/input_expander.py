"""投入されたパスを、1 冊ずつの入力へ展開する。

利用者はアーカイブを 1 つずつ選ばず、フォルダごと投げ込む（#70）。その中は
入れ子で、ZIP が階層の途中に埋もれていることも、ZIP に入っていない裸の画像
フォルダのこともある。

展開を投入時に済ませるのは、整理ジョブの件数をそこで確定させるため。フォルダを
1 件のまま渡すと進捗の総数が 1 のまま複数冊が出来上がり、#65 で直した進捗が
また合わなくなる。

判定は拡張子だけで行い、展開や画像の読み込み（PIL・rarfile）は持ち込まない。
投入は利用者を待たせる経路なので、ここで重い取り込みを増やさない。
"""

import os
from collections.abc import Iterable
from pathlib import Path

from manga_core.naming import natural_sort_key
from manga_core.viewer_contract import is_page_source

# 整理の対象として扱うアーカイブ形式
ARCHIVE_SUFFIXES = frozenset({".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".epub"})


def is_archive_name(name: str) -> bool:
    """名前だけを見て、アーカイブとして扱うかを判定する"""
    return Path(name).suffix.lower() in ARCHIVE_SUFFIXES


def expand_inputs(paths: Iterable[Path]) -> list[Path]:
    """投入されたパスを、1 冊ずつの入力へ並べ直す。

    ファイルはそのまま通す。フォルダは中を再帰的に辿り、アーカイブと
    裸の画像フォルダを拾う。渡された順番は処理順そのものなので入れ替えず、
    1 つのフォルダから出てきたものの中だけを自然順に並べる。
    """
    expanded: list[Path] = []
    for path in paths:
        if path.is_dir():
            expanded.extend(_expand_directory(path))
        else:
            expanded.append(path)
    # 同じものを二度処理しないよう、順番を保ったまま重複を落とす
    return list(dict.fromkeys(expanded))


def _expand_directory(root: Path) -> list[Path]:
    """フォルダの下から、1 冊分になるものを拾い集める。

    リンクの先へは降りない（os.walk の既定）。降りると許可された場所の外の木を
    歩きかねないうえ、リンクが輪になっていると終わらない。ただしリンクされた
    ファイルは拾えるため、許可の検証は呼び出し側で 1 件ずつ行う。
    """
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        # 走査順は OS 任せなので、毎回同じ順番になるようここで揃える
        dirnames.sort(key=natural_sort_key)

        if any(is_page_source(name) for name in filenames):
            # 画像が直接置かれたフォルダは、ZIP に入っていなくても 1 冊。
            # その下にあるものは同じ 1 冊の中身なので、これ以上は掘らない
            dirnames.clear()
            found.append(current)
            continue

        found.extend(
            current / name
            for name in sorted(filenames, key=natural_sort_key)
            if is_archive_name(name)
        )
    return found
