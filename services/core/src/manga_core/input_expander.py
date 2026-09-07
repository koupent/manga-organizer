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
from collections.abc import Callable, Hashable, Iterable, Iterator
from pathlib import Path

from manga_core.file_identity import file_key
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
    return list(iter_inputs(paths))


def iter_inputs(
    paths: Iterable[Path],
    checkpoint: Callable[[], None] = lambda: None,
    accept: Callable[[Path], bool] = lambda _item: True,
) -> Iterator[Path]:
    """``expand_inputs`` と同じものを、見つけた順に 1 件ずつ返す。

    数百 GB の蔵書ではフォルダを歩くだけで数分かかる。一覧を作り終えるまで
    呼び出し側へ制御が戻らないと、その数分のあいだ打ち切りが何も止められない
    （``manga_api.analysis_job`` の言う「解析がスレッドプールに溜まる」状態）。

    ``checkpoint`` はフォルダを 1 つ覗くたびに呼ぶ。**拾ったものを返すだけでは
    打ち切りの機会にならない。** アーカイブが 1 つも無い木では 1 件も返さない
    まま数分歩き続けるので、区切りは「歩いた回数」の側に付ける。

    重複はパスの形ではなく**実体**で落とす（``file_key``）。利用者は同じ蔵書を
    別の綴りで 2 回投げ込める（フォルダとその中のファイル、大文字小文字違い、
    ハードリンク）。形で比べると同じ 1 冊を 2 回返し、2 冊目に ``_1`` が付いた
    同じ本が黙って出来る。中身が同じだけの別ファイルは別の実体なので、今までど
    おり両方返る。

    ``accept`` は、辿って見つけたものを処理対象にしてよいかの判定。何を許すかは
    呼ぶ側が持つ（``manga_core`` は許可された場所を知らない）。**重複を落とすより
    前に呼ぶ。** 順番を逆にすると、許可の外を指すリンクと許可の中のハードリンク
    が同じ実体を指しているとき、**先に列挙されたリンクが実体の鍵を取る**。中の
    ハードリンクは重複として落ち、残ったリンクは呼ぶ側で除かれ、利用者の本が
    並び順次第で黙って消える。
    """
    seen: set[Hashable] = set()
    for path in paths:
        found = _walk_directory(path, checkpoint) if path.is_dir() else (path,)
        for item in found:
            if not accept(item):
                continue
            # 同じものを二度処理しないよう、順番を保ったまま重複を落とす
            key = file_key(item)
            if key not in seen:
                seen.add(key)
                yield item


def _walk_directory(root: Path, checkpoint: Callable[[], None]) -> Iterator[Path]:
    """フォルダの下から、1 冊分になるものを拾い集める。

    リンクの先へは降りない（os.walk の既定）。降りると許可された場所の外の木を
    歩きかねないうえ、リンクが輪になっていると終わらない。ただしリンクされた
    ファイルは拾えるため、許可の検証は呼び出し側で 1 件ずつ行う。
    """
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        checkpoint()
        # 走査順は OS 任せなので、毎回同じ順番になるようここで揃える
        dirnames.sort(key=natural_sort_key)

        if any(is_page_source(name) for name in filenames):
            # 画像が直接置かれたフォルダは、ZIP に入っていなくても 1 冊。
            # その下にあるものは同じ 1 冊の中身なので、これ以上は掘らない
            dirnames.clear()
            yield current
            continue

        yield from (
            current / name
            for name in sorted(filenames, key=natural_sort_key)
            if is_archive_name(name)
        )
