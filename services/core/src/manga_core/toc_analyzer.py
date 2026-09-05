"""展開せずにアーカイブの目次を読み、出来上がる本を実行前に推定する（#70）。

利用者は「最終的にできる ZIP はこれ」という一覧を実行前に見たい。判定に要るのは
「そのフォルダに画像があるか」「何巻か」「出来上がる名前」の 3 つだけで、どれも
中央ディレクトリ（目次）に載っている。展開してから解析すると、数百 GB の蔵書で
展開が 2 回になるため、ここではディスクへ 1 バイトも書かない。

入れ子のアーカイブだけは、内側の目次の位置を知るために内側のバイト列をメモリへ
読む。読むだけで、展開先を作ることはしない。

**解析は実処理に一致させる。** 予告した名前と実際に出来る名前が違うほうが、
巻数を賢く読めないことより害が大きい。そのため次の 2 つは実処理と共有する。

- 巻数の優先順位 …… ``VolumeDetector.resolve_volume``
- 名前の組み立てと衝突時の ``_1`` …… ``format_volume_name`` / ``unique_file_name``

一致のために、実処理が作るフォルダ名をそのまま使う。実処理は入れ子アーカイブを
``_extracted_内_05_zip`` のような名前のフォルダへ展開し、``VolumeDetector`` は
その名前から接頭辞と形式の接尾辞を外して元の名前を取り戻す。結果として内側の
``05.zip`` は第005巻になる（#74）。ここでも同じ名前を渡すので、巻数を読む規則を
書き写さずに予告と実処理が揃う。

**形式は ZIP・RAR・7z の 3 つ**（第 5 段階）。目次の読み方だけが形式ごとに違い、
そこから先――どのフォルダが 1 冊になるか、何巻か、名前が衝突したらどうするか――は
1 本の道筋を共有する（``_Toc`` → ``_build_tree`` → ``_scan_directory``）。形式ごとに
たどり方を書き分けると、同じ中身の RAR と ZIP で予告が食い違う。

**目次を読むのに外部ツールは要らない。** ``rarfile`` は RAR3 / RAR5 の解析器を
自前で持ち、``py7zr`` は純 Python。外部ツール（unrar / 7-Zip）が要るのは展開の
ほうで、そちらは ``archive_handler`` の担当。ここから ``UNRAR_TOOL`` を差したり
子プロセスを起こしたりすると、7-Zip の入った開発機では通り、道具の無い利用者の
機械と CI で落ちる。

入口は 2 つある。``analyze_stream`` は「走査 → 1 つずつ目次を読む」を 1 件ずつ
返し、``analyze_inputs`` はそれを最後まで畳む。畳んだ結果が 1 件でも変わると、
予告した名前と実際に出来る名前が食い違うため、後者は前者の消費者にしてある。

**将来の足し方**: 「整理済みのアーカイブを判定する」（#73）は同じ目次解析を使う。
``_scan_directory`` は既に 1 冊分のページ名をすべて見ているので、判定はそこで
足せる。結果は ``PlannedBook.issues`` に印を 1 つ増やす形で載せられる。
"""

import logging
import zipfile
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath

import py7zr
import rarfile
from py7zr.io import BytesIOFactory

from manga_core.input_expander import expand_inputs, is_archive_name
from manga_core.naming import natural_sort_key
from manga_core.safe_extract import DEFAULT_LIMITS
from manga_core.viewer_contract import is_page_source
from manga_core.volume_detector import (
    # 展開先フォルダ名の接頭辞。組み立てる側と、そこから元の名前を取り戻す側で
    # 別々に持つと、片方を変えた瞬間に予告と実処理の巻数が食い違う
    EXTRACTED_PREFIX,
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

# 目次の読み方ごとの拡張子。3 つ合わせて ``input_expander.ARCHIVE_SUFFIXES`` を
# 覆う。覆い切れない拡張子が出ると、その形式だけ「読めたうえで本が 0 冊」に戻り、
# #70 で無くしたかった silent skip が形式ごとに復活する
ZIP_SUFFIXES = frozenset({".zip", ".cbz", ".epub"})
RAR_SUFFIXES = frozenset({".rar", ".cbr"})
SEVENZIP_SUFFIXES = frozenset({".7z", ".cb7"})


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


@dataclass(frozen=True)
class AnalysisScan:
    """走査だけが終わった状態。目次はまだ 1 つも読んでいない。

    入れ物が 0 件でも必ず 1 度出す。出さないと画面の側で「まだ走査中」と
    「1 件も見つからなかった」を区別できない。
    """

    containers: tuple[Path, ...]


@dataclass(frozen=True)
class AnalysisStep:
    """入れ物 1 つ分の結果。

    ``error`` は目次を読めなかった理由で、読めたときは ``None``。読めなくても
    そこで流れは止めない。1 つ壊れているだけで残り全部を諦めると、利用者は
    原因の分からない空の一覧を見ることになる。
    """

    container: Path
    books: tuple[PlannedBook, ...]
    error: str | None = None


def analyze_stream(
    paths: Iterable[Path], author: str, title: str
) -> Iterator[AnalysisScan | AnalysisStep]:
    """投入されたパスを「走査 → 1 つずつ目次を読む」の流れで返す。

    数百 GB の蔵書では全部読み終わるまで数分かかる。待っている間ずっと空の
    画面を見せないよう、走査の結果を先に出し、以降は入れ物 1 つを読むごとに
    1 件返す。呼び出し側が次を求めるまで次の目次は読まない。

    投入の展開は実処理と同じ ``expand_inputs`` を通す。処理順が変わると同名衝突の
    ``_1`` の付き方が変わり、予告と実際の出来上がりが食い違うため。
    """
    containers = tuple(expand_inputs(paths))
    yield AnalysisScan(containers=containers)

    # 名前の帳簿は 1 回の解析で 1 つ。入れ物ごとに作り直すと、出力先が同じでも
    # ``_1`` の付き方が実処理とずれる
    planner = _Planner(author, title)
    for container in containers:
        yield _read_container(planner, container)


def _read_container(planner: "_Planner", container: Path) -> AnalysisStep:
    """入れ物 1 つを読む。読めなくても理由を添えて返し、流れは止めない。

    受け止めるのは壊れたアーカイブ（``BadZipFile``）・開けないアーカイブ
    （``OSError``）のほか、``MemoryError``・``LargeZipFile``・名前の復号に
    失敗した場合など、目次を読めなかったすべて。理由を捨てずにここまで
    上げてくるので、画面は「目次を読めません」の印を実行前に出せる。
    """
    try:
        books = (
            (planner.plan_folder(container),)
            if container.is_dir()
            else tuple(planner.plan_archive(container))
        )
    except Exception as error:  # noqa: BLE001 - 1 つの失敗で残りを諦めない
        logger.warning("目次を読めませんでした: %s (%s)", container, error)
        return AnalysisStep(
            container=container,
            books=(),
            error=str(error) or type(error).__name__,
        )
    return AnalysisStep(container=container, books=books, error=None)


def analyze_inputs(paths: Iterable[Path], author: str, title: str) -> list[PlannedBook]:
    """投入されたパスから、出来上がる本を実行前に並べる。

    途中経過を要らない呼び出しのための入口。``analyze_stream`` を最後まで
    畳んだだけで、返るものは 1 件も変わらない。
    """
    return [
        book
        for event in analyze_stream(paths, author, title)
        if isinstance(event, AnalysisStep)
        for book in event.books
    ]


@dataclass(frozen=True)
class _Place:
    """展開後に出来るフォルダ 1 つ分の位置。

    見せる位置と巻数判定に使う名前は別物になる。実処理は入れ子アーカイブを
    ``_extracted_内_05_zip`` へ展開し、その名前で巻数を判定する（そこから
    ``内_05`` を取り戻して 5 巻と読む。#74）。利用者には位置として
    ``内_05.zip`` と見せたい。
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


@dataclass(frozen=True)
class _Toc:
    """開いたアーカイブ 1 つ分の目次。形式ごとの違いはここで吸収する。

    ``names`` はフォルダに ``/`` が付いた形。``read`` は要素 1 つをメモリへ
    取り出す関数で、**取り出しに外部ツールが要る形式では None**。RAR がそれで、
    圧縮された要素を読もうとすると ``rarfile`` が unrar を起こしにいく
    （``RarCannotExec``）。入れ子を諦めるほうを選ぶ。目次が読めている以上、
    その RAR 自身の本は必ず出したい。
    """

    names: tuple[str, ...]
    read: Callable[[str], bytes] | None


# 目次を開く関数。パスでも、入れ子のためにメモリへ読んだバイト列でも受ける
_Opener = Callable[[Path | BytesIO], AbstractContextManager[_Toc]]


@contextmanager
def _open_zip(source: Path | BytesIO) -> Iterator[_Toc]:
    """ZIP の目次を開く"""
    with zipfile.ZipFile(source) as archive:
        yield _Toc(names=tuple(archive.namelist()), read=archive.read)


@contextmanager
def _open_rar(source: Path | BytesIO) -> Iterator[_Toc]:
    """RAR の目次を開く。

    ``rarfile`` は RAR3 / RAR5 の解析器を自前で持つので、目次を読むだけなら
    外部ツールは要らない。コメントの復号や分割ボリュームの継ぎ足しが要る
    書庫では例外（``RarCannotExec`` / ``NeedFirstVolume``）が上がるが、
    握りつぶさずに上へ返す。

    **ヘッダごと暗号化された RAR だけは例外が上がらない。** 何事もなく開いて
    目次が空で返るため、素直に書くと「読めたうえで本が 0 冊」になり、#70 で
    無くしたかった silent skip がそのまま残る。鍵が無い以上、中身は実行時にも
    永遠に取り出せないので、読めなかったこととして扱う。
    """
    with rarfile.RarFile(source) as archive:
        names = tuple(archive.namelist())
        if not names and archive.needs_password():
            raise rarfile.PasswordRequired(
                "目次ごと暗号化されているため、中身を読めません"
            )
        yield _Toc(names=names, read=None)


@contextmanager
def _open_7z(source: Path | BytesIO) -> Iterator[_Toc]:
    """7z の目次を開く。

    ``py7zr`` は純 Python で、目次も要素の取り出しもこの中で完結する。目次ごと
    暗号化されていれば開く時点で ``PasswordRequired`` が上がるので、RAR のような
    「静かに空で返る」経路は無い。
    """
    with py7zr.SevenZipFile(source) as archive:
        # py7zr はフォルダに ``/`` を付けない。付けないまま渡すと ``_build_tree``
        # がフォルダをファイルとして数え、``表紙.zip`` のような名前のフォルダを
        # 入れ子アーカイブと取り違える
        names = tuple(
            f"{item.filename}/" if item.is_directory else item.filename
            for item in archive.list()
        )
        yield _Toc(names=names, read=lambda stored: _read_7z_member(archive, stored))


def _read_7z_member(archive: py7zr.SevenZipFile, stored_name: str) -> bytes:
    """7z の要素 1 つを、ディスクを経由せずメモリへ取り出す。

    上限を実処理（``ExtractionLimits``）と同じ値にしてあるのは、解析だけが
    先に音を上げて「読めません」と出すのを避けるため。
    """
    # 目次を読んだあとは位置が進んでいる。巻き戻さないと取り出せない
    archive.reset()
    factory = BytesIOFactory(limit=DEFAULT_LIMITS.max_total_bytes)
    archive.extract(targets=[stored_name], factory=factory)
    buffer = factory.products.get(stored_name)
    if buffer is None:
        raise py7zr.exceptions.ArchiveError(f"要素を取り出せません: {stored_name}")
    buffer.seek(0)
    return buffer.read()


# 拡張子から目次の読み手を選ぶ表
_READERS: tuple[tuple[frozenset[str], _Opener], ...] = (
    (ZIP_SUFFIXES, _open_zip),
    (RAR_SUFFIXES, _open_rar),
    (SEVENZIP_SUFFIXES, _open_7z),
)

# 入れ子 1 つを読めなかったときに受け止める例外。壊れている・暗号化されている・
# 未対応の圧縮方式など。**外側の入れ物まで読めない扱いにはしない。** 入れ子が
# 読めないだけなら、外側の目次から出た本は実行すればそのまま出来る
_NESTED_READ_ERRORS = (
    zipfile.BadZipFile,
    OSError,
    RuntimeError,
    NotImplementedError,
    rarfile.Error,
    py7zr.exceptions.ArchiveError,
)


def _reader_for(name: str) -> _Opener | None:
    """名前の拡張子から、目次の読み手を選ぶ。読み方を知らない名前には None"""
    suffix = PurePosixPath(name).suffix.lower()
    return next(
        (opener for suffixes, opener in _READERS if suffix in suffixes),
        None,
    )


def locate_books(archive_path: Path) -> list[BookLocation]:
    """アーカイブの目次から、1 冊になる場所を拾う。

    **読めなかったときは例外がそのまま出る。** 以前は ``BadZipFile`` と
    ``OSError`` をここで握りつぶして空を返していたが、それだと呼び出し側には
    「読めたうえで 1 冊も無かった」として届く。壊れたアーカイブも本を持たない
    入れ物として既定で選ばれ、印も警告も無いまま整理の実行に載ってしまう
    （#70 第 4 段階）。読めなかったことは、握りつぶさずに上へ渡す。

    RAR / 7z も同じ扱いで、``RarCannotExec``・``NeedFirstVolume``・
    ``PasswordRequired`` などはここを素通りして ``_read_container`` に届き、
    画面の「目次を読めません」の印になる。

    アーカイブでない名前（利用者が名指しした ``.txt`` など）は、読めなかったの
    ではないので空を返す。
    """
    opener = _reader_for(archive_path.name)
    if opener is None:
        return []
    with opener(archive_path) as toc:
        # 展開先は一時領域の「アーカイブ名」フォルダ。巻数はその名前から読まれる
        return _scan(toc, _Place("", "", archive_path.stem), depth=0)


def _scan(toc: _Toc, place: _Place, depth: int) -> list[BookLocation]:
    """1 つのアーカイブの目次を、展開後のフォルダ構成として読む"""
    return _scan_directory(toc, _build_tree(toc.names), "", place, depth)


def _scan_directory(
    toc: _Toc,
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
                    toc,
                    tree.stored_names[_join(directory, name)],
                    place.nested(name),
                    depth,
                )
            )

    for name in sorted(tree.subdirs[directory], key=natural_sort_key):
        found.extend(
            _scan_directory(toc, tree, _join(directory, name), place.child(name), depth)
        )
    return found


def _scan_nested(
    toc: _Toc,
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
    if toc.read is None:
        # 外側が RAR。要素を取り出すには外部ツールが要るので、入れ子は諦める。
        # 読みに行くと ``rarfile`` が unrar を起こしにいき、道具の有無で解析の
        # 結果が変わる。外側の目次から出る本のほうを守る
        return []
    opener = _reader_for(stored_name)
    if opener is None:
        return []

    try:
        with opener(BytesIO(toc.read(stored_name))) as nested:
            return _scan(nested, place, depth + 1)
    except _NESTED_READ_ERRORS as error:
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
