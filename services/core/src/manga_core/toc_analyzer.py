"""展開せずに ZIP の目次を読み、出来上がる本を実行前に推定する（#70 第 2 段階）。

利用者は「最終的にできる ZIP はこれ」という一覧を実行前に見たい。判定に要るのは
「そのフォルダに画像があるか」「何巻か」「出来上がる名前」の 3 つだけで、どれも
中央ディレクトリ（目次）に載っている。展開してから解析すると、数百 GB の蔵書で
展開が 2 回になるため、ここではディスクへ 1 バイトも書かない。

入れ子の ZIP だけは、内側の目次の位置を知るために内側のバイト列をメモリへ読む。
読むだけで、展開先を作ることはしない。

**解析は実処理に一致させる。** 予告した名前と実際に出来る名前が違うほうが、
巻数を賢く読めないことより害が大きい。そのため次の 2 つは実処理と共有する。

- 巻数の優先順位 …… ``VolumeDetector.resolve_volume``
- 名前の組み立てと衝突時の ``_1`` …… ``format_volume_name`` / ``unique_file_name``

一致のために、既知の欠陥もそのまま写している。実処理は入れ子アーカイブを
``_extracted_内_05_zip`` のような名前のフォルダへ展開し、``VolumeDetector`` は
``_extracted_`` 始まりの名前を巻数なしと見なす。結果として内側の ``05.zip`` は
第005巻ではなく並び順の第001巻になる。ここでもその名前を使って判定する
（欠陥そのものは #74 で扱う）。

RAR / 7z は目次の読み方が ZIP と異なるため対象外（第 5 段階）。

**将来の足し方**: 「整理済みのアーカイブを判定する」（#73）は同じ目次解析を使う。
``_scan_directory`` は既に 1 冊分のページ名をすべて見ているので、判定はそこで
足せる。結果は ``PlannedBook.issues`` に印を 1 つ増やす形で載せられる。
"""

import logging
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath

from manga_core.input_expander import expand_inputs, is_archive_name
from manga_core.naming import natural_sort_key
from manga_core.safe_extract import DEFAULT_LIMITS
from manga_core.viewer_contract import is_page_source
from manga_core.volume_detector import (
    ORIGIN_LAST_NUMBER,
    ORIGIN_POSITION,
    VolumeDecision,
    VolumeDetector,
    unique_file_name,
)

logger = logging.getLogger(__name__)

# 実行前に利用者へ見せる印
VOLUME_UNKNOWN = "volume-unknown"
VOLUME_UNCERTAIN = "volume-uncertain"

# 目次を読める形式。ArchiveHandler が ZIP として展開するものと揃える
ZIP_SUFFIXES = frozenset({".zip", ".cbz", ".epub"})

# 実処理が入れ子アーカイブの展開先に付ける接頭辞
EXTRACTED_PREFIX = "_extracted_"


@dataclass(frozen=True)
class PlannedBook:
    """実行すると 1 冊出来る、という予告。

    ``entry`` はアーカイブ内での位置で、アーカイブ全体が 1 冊なら空文字。
    ``issues`` は実行前に利用者へ見せる印で、後から種類を増やせるようにしてある。
    """

    source: Path
    entry: str
    output_name: str
    volume: int | None
    issues: tuple[str, ...] = ()


def analyze_inputs(paths: Iterable[Path], author: str, title: str) -> list[PlannedBook]:
    """投入されたパスから、出来上がる本を実行前に並べる。

    投入の展開は実処理と同じ ``expand_inputs`` を通す。処理順が変わると同名衝突の
    ``_1`` の付き方が変わり、予告と実際の出来上がりが食い違うため。
    """
    planner = _Planner(author, title)
    books: list[PlannedBook] = []
    for path in expand_inputs(paths):
        if path.is_dir():
            books.append(planner.plan_folder(path))
        else:
            books.extend(planner.plan_archive(path))
    return books


@dataclass(frozen=True)
class _Place:
    """展開後に出来るフォルダ 1 つ分の位置。

    見せる位置と巻数判定に使う名前は別物になる。実処理は入れ子アーカイブを
    ``_extracted_内_05_zip`` へ展開し、その名前で巻数を判定するため（#74）。
    利用者には ``内_05.zip`` と見せたい。
    """

    # 元アーカイブ内での位置。利用者に見せる
    entry: str
    # 展開ルートからの相対パス。``__MACOSX/`` の判定が先頭一致なので、
    # ページ判定は必ずこの形の名前で行う
    extracted_path: str
    # 実処理が作るフォルダ名。巻数の判定はこれで行う
    extracted_name: str

    def child(self, name: str) -> "_Place":
        """下位フォルダの位置"""
        return _Place(_join(self.entry, name), _join(self.extracted_path, name), name)

    def nested(self, archive_name: str) -> "_Place":
        """入れ子アーカイブを展開したときに出来るフォルダの位置"""
        extracted = f"{EXTRACTED_PREFIX}{archive_name.replace('.', '_')}"
        return _Place(
            _join(self.entry, archive_name),
            _join(self.extracted_path, extracted),
            extracted,
        )


@dataclass(frozen=True)
class BookLocation:
    """1 冊になる場所。巻数を決める前の状態。

    ``entry`` は利用者に見せる位置で、``extracted_path`` は実処理が展開先に
    作るフォルダの相対パス。整理を実行するとき「予告したどの本か」を実際の
    展開結果と突き合わせるのに使う（外した本を作らないため）。位置を 2 つ
    持つのは、実処理が入れ子アーカイブを ``_extracted_...`` へ展開するため。
    """

    entry: str
    extracted_path: str
    extracted_name: str


@dataclass(frozen=True)
class _Tree:
    """目次から起こした、展開後のフォルダ構成"""

    # フォルダの位置 -> 直下のファイル名
    files: dict[str, list[str]]
    # フォルダの位置 -> 直下のフォルダ名
    subdirs: dict[str, set[str]]
    # 正規化した位置 -> 目次に記録されている名前。読み出しには元の名前が要る
    stored_names: dict[str, str]


class _Planner:
    """1 回の解析のあいだ、出来上がる名前を覚えておく。

    実処理は全冊を同じ出力フォルダへ書き出すので、同名の衝突は投入全体で起きる。
    1 冊ずつ独立に名前を決めると ``_1`` の付き方が実処理とずれる。

    見ているのはこれから作る名前だけで、出力先に既に置かれているファイルは
    数えていない（解析の入口が出力先を受け取らないため）。画面から出力先を
    渡せるようになったら、その中身を ``_taken`` の初期値にすれば揃う。
    """

    def __init__(self, author: str, title: str):
        self.detector = VolumeDetector()
        self.author = author
        self.title = title
        self._taken: set[str] = set()

    def plan_archive(self, archive_path: Path) -> list[PlannedBook]:
        """アーカイブ 1 つから出来る本を並べる"""
        candidates = locate_books(archive_path)
        total = len(candidates)
        return [
            self._plan(
                archive_path,
                candidate.entry,
                self.detector.resolve_volume(
                    Path(candidate.extracted_name), archive_path, position, total
                ),
            )
            for position, candidate in enumerate(candidates, 1)
        ]

    def plan_folder(self, folder: Path) -> PlannedBook:
        """画像が直接置かれたフォルダから出来る本。

        実処理（``FileOrganizer._process_image_directory``）も展開を伴わず、
        巻数をフォルダ名だけで決めるので、ここでも優先順位は使わない。
        """
        return self._plan(folder, "", self.detector.decide_volume(folder))

    def _plan(self, source: Path, entry: str, decision: VolumeDecision) -> PlannedBook:
        base_name = self.detector.format_volume_name(
            self.author, self.title, decision.number
        )
        output_name = unique_file_name(
            base_name, lambda candidate: candidate in self._taken
        )
        self._taken.add(output_name)
        return PlannedBook(
            source=source,
            entry=entry,
            output_name=output_name,
            volume=decision.number,
            issues=_volume_issues(self.detector, decision),
        )


def _volume_issues(
    detector: VolumeDetector, decision: VolumeDecision
) -> tuple[str, ...]:
    """巻数に付ける印を決める。

    読めたものにまで印を付けると、印そのものが意味を失う。疑うのは根拠が
    弱いときだけにする。
    """
    if decision.number is None:
        return (VOLUME_UNKNOWN,)
    if decision.origin == ORIGIN_POSITION:
        # 名前から読めず、並び順を巻数に当てはめただけ
        return (VOLUME_UNCERTAIN,)
    if (
        decision.origin == ORIGIN_LAST_NUMBER
        and len(detector.extract_numbers(decision.source_name)) > 1
    ):
        # `frieren_07_fix2` のように数字が複数ある名前は、最後の数字を拾うため
        # 巻数（07）ではない数字（2）を掴みうる
        return (VOLUME_UNCERTAIN,)
    return ()


def locate_books(archive_path: Path) -> list[BookLocation]:
    """アーカイブの目次から、1 冊になる場所を拾う。

    読めなかったときは空を返す。「1 冊も無い」と「読めなかった」を呼び分けて
    いないのは、どちらでも実行前に予告できることが無い点で同じだから。
    実行時には展開してみて初めて分かる（RAR・壊れたアーカイブ）。
    """
    if archive_path.suffix.lower() not in ZIP_SUFFIXES:
        # RAR / 7z は目次の読み方が違う（第 5 段階）
        return []
    try:
        with zipfile.ZipFile(archive_path) as archive:
            # 展開先は一時領域の「アーカイブ名」フォルダ。巻数はその名前から読まれる
            return _scan(archive, _Place("", "", archive_path.stem), depth=0)
    except (zipfile.BadZipFile, OSError) as error:
        # 壊れたアーカイブは目次すら読めない。実行時には失敗として現れる（#62）
        logger.warning("目次を読めませんでした: %s (%s)", archive_path, error)
        return []


def _scan(archive: zipfile.ZipFile, place: _Place, depth: int) -> list[BookLocation]:
    """1 つの ZIP の目次を、展開後のフォルダ構成として読む"""
    return _scan_directory(archive, _build_tree(archive.namelist()), "", place, depth)


def _scan_directory(
    archive: zipfile.ZipFile,
    tree: _Tree,
    directory: str,
    place: _Place,
    depth: int,
) -> list[BookLocation]:
    """フォルダ 1 つ分を、実処理と同じ順序でたどる。

    実処理（``ArchiveHandler._process_directory_for_images``）は os.walk の
    都合で「このフォルダ → 直下の入れ子アーカイブ → 下位フォルダ」の順に
    冊を積む。並び順は巻数（Priority 3）に効くので、順序まで合わせる。
    実処理の並びは OS のフォルダ列挙任せだが、解析は何度走らせても同じ結果に
    なる必要があるため、ここでは名前順に固定する。
    """
    found: list[BookLocation] = []
    names = tree.files[directory]

    if any(is_page_source(_join(place.extracted_path, name)) for name in names):
        found.append(
            BookLocation(place.entry, place.extracted_path, place.extracted_name)
        )

    for name in sorted(names, key=natural_sort_key):
        if is_archive_name(name):
            found.extend(
                _scan_nested(
                    archive,
                    tree.stored_names[_join(directory, name)],
                    place.nested(name),
                    depth,
                )
            )

    for name in sorted(tree.subdirs[directory], key=natural_sort_key):
        found.extend(
            _scan_directory(
                archive, tree, _join(directory, name), place.child(name), depth
            )
        )
    return found


def _scan_nested(
    archive: zipfile.ZipFile,
    stored_name: str,
    place: _Place,
    depth: int,
) -> list[BookLocation]:
    """入れ子アーカイブの目次を、展開せずに読む。

    目次は末尾にあるので、内側のバイト列はメモリへ読み出す必要がある。読むだけで
    ディスクには何も書かない。
    """
    if depth + 1 >= DEFAULT_LIMITS.max_depth:
        # 実処理も同じ深さで打ち切る。ここだけ深く潜ると予告と結果がずれる
        logger.warning("入れ子が深すぎるため解析を打ち切りました: %s", stored_name)
        return []
    if PurePosixPath(stored_name).suffix.lower() not in ZIP_SUFFIXES:
        # RAR / 7z は目次の読み方が違う（第 5 段階）
        return []

    try:
        with zipfile.ZipFile(BytesIO(archive.read(stored_name))) as nested:
            return _scan(nested, place, depth + 1)
    except (zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError) as error:
        # 壊れている・暗号化されている・未対応の圧縮方式。実行時に失敗として現れる
        logger.warning("入れ子の目次を読めませんでした: %s (%s)", stored_name, error)
        return []


def _build_tree(names: Iterable[str]) -> _Tree:
    """目次のエントリ名から、展開後のフォルダ構成を組み立てる"""
    tree = _Tree(files={"": []}, subdirs={"": set()}, stored_names={})
    for stored in names:
        normalized = stored.replace("\\", "/")
        parts = [
            part
            for part in PurePosixPath(normalized).parts
            if part not in ("", ".", "..")
        ]
        if not parts:
            continue

        is_directory = normalized.endswith("/")
        current = ""
        for part in parts if is_directory else parts[:-1]:
            child = _join(current, part)
            tree.files.setdefault(child, [])
            tree.subdirs.setdefault(child, set())
            tree.subdirs[current].add(part)
            current = child

        if not is_directory:
            tree.files[current].append(parts[-1])
            tree.stored_names[_join(current, parts[-1])] = stored
    return tree


def _join(directory: str, name: str) -> str:
    """フォルダの位置と名前をつなぐ。ルート直下は名前だけになる"""
    return f"{directory}/{name}" if directory else name
