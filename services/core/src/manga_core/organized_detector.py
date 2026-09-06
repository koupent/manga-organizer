"""整理済みのアーカイブを判定する（#73 第 1 段階）。

利用者の困りごとは「一度整理した蔵書をもう一度投入すると、既に完成している本まで
作り直される」こと。作り直しても得るものは無く、失うもの（加工前の画像、ファイルの
時刻、手を入れた並び）はある。

**定義**: 整理済み = その本が既に「この道具が作る物そのもの」である状態。

条件はすべて「作る側と同じ関数で期待値を作り直し、等しいか比べる」形で見る。
「整っているように見える名前」を正規表現で探すのではなく往復させる。これが実処理から
離れない唯一の定義で、調整の余地（閾値）を持たない。名前の作り方や連番の付け方を
変えたとき、判定側を直し忘れても静かにずれない。

判定の単位は「1 冊だけを出し、その ``entry`` が空である入れ物」。合本の中の 1 冊は
決して整理済みにならない。この道具の成果物は**ファイル**であって、その中身ではない。

| # | 条件 | 期待値を作る関数 |
|---|---|---|
| 0 | 入れ物から出る本が 1 冊で ``entry`` が空 | ``toc_analyzer.locate_books`` |
| 1 | 拡張子が ``.zip`` | ``ArchiveHandler.create_archive`` は ZIP しか書かない |
| 2 | 名前 == ``format_volume_name(a, t, v) + ".zip"`` | ``VolumeDetector`` |
| 3 | ページ名が順に ``sequential_name(i, N, 拡張子)`` | ``viewer_contract`` |
| 4 | 目次にそのページ以外が無い（同梱物だけ許す） | ``original_store`` |
| 5 | 親フォルダ名 == ``[著者] 作品`` | ``FileOrganizer`` |

``True`` は必ず「肯定的な事実の積」。読めない目次・未対応の形式・名前を読めないと
いった「分からない」はすべて ``False`` へ落ちる。偽陰性（未整理と見て作り直す）は
今までどおりの動きだが、偽陽性（未整理の本を整理済みと見て飛ばす）は利用者が
待っていた整理が黙って行われないことになる。

**理由は 1 つだけ返す。** 画面がそのまま読む文字列なので、値そのものが公開契約。
順序は上の表のとおりで、先に見た条件が理由になる。とくに条件 3 は条件 4 より先に
見る。目次をまるごと期待するページ一覧と突き合わせると、``001, 002, 004`` の本が
「余計な物がある」と説明されてしまう。条件 4 が見るのは**ページ候補でないもの**だけ。
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from manga_core.original_store import MANIFEST_ENTRY, ORIGINALS_PREFIX
from manga_core.viewer_contract import is_page_source, sequential_name
from manga_core.volume_detector import VolumeDetector, format_series_dir

# 整理済みでない理由。画面がそのまま読む文字列なので、値そのものが公開契約
MULTIPLE_BOOKS = "multiple-books"
NOT_ZIP = "not-zip"
NAME_MISMATCH = "name-mismatch"
PAGES_MISMATCH = "pages-mismatch"
EXTRA_ENTRIES = "extra-entries"
FOLDER_MISMATCH = "folder-mismatch"

# 整理が書き出す唯一の拡張子。``create_archive`` は ZIP しか書かないので、
# ``.cbz`` や ``.rar`` は中身がどれだけ整っていても出来上がりではない
ARCHIVE_SUFFIX = ".zip"

# ``format_volume_name`` の出力を読み戻す形。巻数まで required にしてあるのは、
# ``[著者] 作品 Unknown.zip`` が ``format_volume_name(a, t, None)`` の出力そのもの
# だから。往復だけを見ると等しくなってしまうが、巻数の分からない本は出来上がりでは
# ない（整理し直せば巻数が付くかもしれない）。ここで外すのが、最悪の偽陽性――巻数を
# 読めなかった本をそのまま凍結すること――を止める唯一の場所
_ORGANIZED_STEM = re.compile(r"^\[(?P<author>.+)\] (?P<title>.+) 第(?P<volume>\d+)巻$")

# ``format_volume_name`` は状態を持たないので、判定のたびに作り直さない
_DETECTOR = VolumeDetector()


@dataclass(frozen=True)
class OrganizedVerdict:
    """整理済みかどうかと、その根拠。

    ``author`` / ``title`` は**本の名前から読んだ**値で、依頼の値ではない。
    名前が往復したときだけ入る。半分しか読めない名前から拾った値は、この道具が
    責任を持てる値ではない。
    """

    organized: bool
    reason: str | None = None
    author: str | None = None
    title: str | None = None


def pages_are_sequential(names: Iterable[str]) -> bool:
    """ページ名の並びが、整理の出力そのものかどうか。

    期待値は ``viewer_contract.sequential_name`` に作らせる。桁は総ページ数に
    従うので（1000 ページなら ``0001``）、桁を決め打ちした判定は長い本を丸ごと
    「未整理」にする。拡張子はページごとにそのまま残るが、viewer が読めない形式は
    変換後の拡張子になるため ``001.bmp`` は決して整理済みにならない。
    """
    ordered = list(names)
    if not ordered:
        # この道具は 0 ページの本を作らない。空同士を「等しい」と見ると、
        # 画像の 1 枚も無い ZIP が整理済みとして飛ばされる
        return False
    total = len(ordered)
    return ordered == [
        sequential_name(position, total, PurePosixPath(name).suffix)
        for position, name in enumerate(ordered, 1)
    ]


def judge_organized(
    source: Path,
    entry: str,
    book_count: int,
    toc_names: Sequence[str],
) -> OrganizedVerdict:
    """入れ物 1 つから出た本 1 冊が、整理済みかどうかを決める。

    ``book_count`` は同じ入れ物から出る本の数、``toc_names`` はその入れ物の目次
    そのもの。目次を持たない入れ物（画像を直接置いたフォルダ）は空を渡す。空でも
    特別扱いは要らない。拡張子と名前で先に落ち、万一そこを抜けてもページが 0 枚で
    落ちる。「分からない」はすべて ``False`` へ落ちるという一本の道に乗る。
    """
    if book_count != 1 or entry != "":
        # 入れ物そのものが 1 冊でない。合本の中の 1 冊も、フォルダの中にだけ
        # ページがある入れ物も、この道具の成果物（ファイル）と同じ形ではない
        return OrganizedVerdict(False, MULTIPLE_BOOKS)

    if source.suffix != ARCHIVE_SUFFIX:
        return OrganizedVerdict(False, NOT_ZIP)

    parsed = _parse_name(source.name)
    if parsed is None:
        return OrganizedVerdict(False, NAME_MISMATCH)
    author, title = parsed

    pages, extras = _split_entries(toc_names)
    if not pages_are_sequential(pages):
        return OrganizedVerdict(False, PAGES_MISMATCH)

    if not all(_is_bundled(name) for name in extras):
        return OrganizedVerdict(False, EXTRA_ENTRIES)

    if source.parent.name != format_series_dir(author, title):
        return OrganizedVerdict(False, FOLDER_MISMATCH)

    return OrganizedVerdict(True, None, author, title)


def _parse_name(file_name: str) -> tuple[str, str] | None:
    """本の名前から著者と作品名を読む。整理が作る名前でなければ None。

    読んだ値で名前を**作り直して**突き合わせる。読めただけでは足りない。
    ``第3巻`` は巻数として読めるが、整理が作る名前は ``第003巻`` なので、
    見た目が整っていることと出来上がりであることは別。
    """
    matched = _ORGANIZED_STEM.match(PurePosixPath(file_name).stem)
    if matched is None:
        return None

    author = matched["author"]
    title = matched["title"]
    volume = int(matched["volume"])
    rebuilt = _DETECTOR.format_volume_name(author, title, volume) + ARCHIVE_SUFFIX
    if rebuilt != file_name:
        return None
    return author, title


def _split_entries(toc_names: Sequence[str]) -> tuple[list[str], list[str]]:
    """目次を「ページの候補」と「それ以外」に分ける。並び順はそのまま保つ。

    区切り文字を ``/`` に直すのは ``toc_analyzer._build_tree`` と揃えるため。
    揃えないと、冊数を数えるときの目次の見え方と、ここでの見え方が食い違う。
    """
    pages: list[str] = []
    extras: list[str] = []
    for stored in toc_names:
        name = stored.replace("\\", "/")
        (pages if is_page_source(name) else extras).append(name)
    return pages, extras


def _is_bundled(name: str) -> bool:
    """この道具自身が同梱した物かどうか（#66 / #96）。

    許可一覧は手心ではなく安全条件。表紙を切り抜いた本は加工前の画像と記録を
    ``.manga-organizer/`` に抱えている。許さないと、加工した本がすべて「未整理」と
    判定され、既定で作り直されて加工前の画像を失う。

    許すのは ``.manga-organizer/`` 配下だけで、「ドットで始まる物は見逃す」には
    しない。``.thumbnails/`` を抱えた本は、この道具が作った物ではない。
    """
    return name == MANIFEST_ENTRY or name.startswith(ORIGINALS_PREFIX)
