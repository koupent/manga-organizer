"""整理済みの蔵書を、まとめて辞書へ取り込む（#73 段階 6）。

一度整理し終えた蔵書は、それ自体が「作品名 → 著者」の対応表になっている。
その対をまとめて辞書へ入れられれば、以降の整理では著者欄が勝手に埋まる。

## 既にある著者を上書きしない

``POST /api/library/entries`` は同じ作品名があれば上書きする。整理の実行時に
そのときの対を残すための経路だからである。取り込みで同じ書き方をすると、
名前の解釈をたまたま通っただけの 1 件が、利用者が手で直した著者を潰す。
しかもこの表は、以降のすべての整理で著者欄を自動的に埋める表である。
だからここでは辞書に**無い**作品名だけを足し、既にあるものは著者が違っても
触らず、何と食い違ったのかを返す。

## 画面側で合成できない理由

``GET /api/library/entries`` が返すのは新しい順 200 件までで、それを超える
辞書では在るものが「無い」と見える。その誤認のまま上書きする経路を叩けば
上の事故がそのまま起きる。有無の確認と書き込みは、辞書の全体が見える
こちら側で 1 つの操作として行う。
"""

from collections.abc import Iterable

from manga_api.library_views import (
    LibraryConflict,
    LibraryEntry,
    LibraryImportResult,
)
from manga_core.manga_database import MangaDatabase


def authors_by_title(entries: Iterable[LibraryEntry]) -> dict[str, list[str]]:
    """依頼を作品名でまとめる。届いた順を保ち、同じ著者は 1 つにする。

    まとめてから書くのが要る。整理済みの本は 1 冊 1 ファイルなので、5 巻ある
    作品は同じ対を 5 回よこす。素朴に 1 件ずつ書くと 2 件目以降は自分が今
    書いた行に当たり、利用者は押した覚えのない相手との食い違いを見せられる。

    作品名か著者が空の対はここで落とす。著者が空のまま入ると、その作品名を
    打つたびに著者欄が「辞書由来」として空で埋まり、利用者は補完が効いたと
    思って空のまま整理してしまう。作品名が空の行は、どの作品にも当たる行と
    して辞書に居座る。
    """
    grouped: dict[str, list[str]] = {}
    for entry in entries:
        title = entry.title.strip()
        author = entry.author.strip()
        if not title or not author:
            continue
        authors = grouped.setdefault(title, [])
        if author not in authors:
            authors.append(author)
    return grouped


def import_into_library(
    database: MangaDatabase, entries: Iterable[LibraryEntry]
) -> LibraryImportResult:
    """辞書に無い作品名だけを足し、何をしたかを 3 つの並びで返す"""
    imported: list[LibraryEntry] = []
    unchanged: list[LibraryEntry] = []
    conflicts: list[LibraryConflict] = []
    for title, authors in authors_by_title(entries).items():
        kept = database.get_author_by_title(title)
        if len(authors) > 1:
            # 蔵書の中で著者が割れている作品名は、どちらの著者でも書かない。
            # 先に来たほうを採ると道具が黙って勝者を決めることになり、以降の
            # 整理はその著者で埋まり続けるのに、利用者は選んだ覚えが無い
            conflicts.append(_refused(title, kept, authors))
            continue
        author = authors[0]
        if kept is None:
            if database.add_manga_info(title, author):
                imported.append(LibraryEntry(title=title, author=author))
                continue
            # 書けなかった。確かめてから書くまでの間に、辞書ダイアログの保存が
            # 同じ作品名を入れたときに起きる。書いてもいないのに「入れました」
            # とは返さず、いま辞書にあるもので言い直す
            kept = database.get_author_by_title(title)
        if kept == author:
            # 同じ著者で既にあるものは食い違いではない。ここを衝突として
            # 数えると、一度整理した蔵書を入れ直すたびに、直すところが何も
            # 無いのに警告が出て、本当の食い違いが埋もれる
            unchanged.append(LibraryEntry(title=title, author=author))
        else:
            conflicts.append(_refused(title, kept, authors))
    return LibraryImportResult(
        imported=imported, unchanged=unchanged, conflicts=conflicts
    )


def _refused(title: str, kept: str | None, authors: list[str]) -> LibraryConflict:
    """断った作品名を、辞書に残した著者と蔵書の著者の両方で言う"""
    return LibraryConflict(title=title, kept_author=kept, incoming_authors=authors)
