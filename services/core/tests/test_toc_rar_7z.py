"""RAR と 7z の目次を、展開せずに読む（#70 第 5 段階）。

第 2 段階で ZIP の目次だけを読んで「出来上がる本」を予告できるようになったが、
``locate_books`` は ZIP 以外の拡張子を**ファイルを開く前に**弾いて空を返す。
そのため RAR / 7z は「読めたうえで 1 冊も無い」として画面へ届く。第 4 段階で
目次を読めなかった入れ物には ``result.unreadable`` 経由で「目次を読めません」の
印が付くようになったが、RAR / 7z はその印すら付かない。利用者から見ると
「読めたのに何も出来ない本」に見え、実行するまで何が起きるか分からない。

ここで求める公開契約は次の 5 つ。

1. RAR の本が、同じ中身の ZIP と**同じ** ``output_name`` / ``volume`` /
   ``issues`` / ``entry`` で出ること（冊数が合うだけでは足りない。予告した
   名前と実際に出来る名前が違うほうが、冊数がずれるより害が大きい）
2. 7z も同じ。7z は py7zr で実際に展開できるので、実処理と突き合わせる
3. 入れ子。フォルダの奥にある RAR / 7z と、ZIP の中の RAR / 7z、7z の中の ZIP
4. 目次を読めない RAR / 7z は ``AnalysisStep.error`` を持ち、解析ジョブの
   ``result.unreadable`` に載ること（「本が 0 冊」として黙って通さない）
5. 目次を読むのに外部ツール（unrar / 7z）を一切起動しないこと

**5 が一番外しやすい。** ``archive_handler`` は展開のために 7-Zip の実行ファイルを
探し、見つかれば ``rarfile.UNRAR_TOOL`` に差す。展開と目次読みで要るものが違う
ことを知らずに実装すると、開発機（7-Zip が入っている）では動き、この
コンテナと CI では落ちる。実測での確認は次の通り。

- ``rarfile`` は ``RAR3Parser`` / ``RAR5Parser`` を自前で持ち、``RarFile.__init__``
  は ``UNRAR_TOOL`` に触らない。外部ツールが要るのは**展開**と**コメントの復号**
- ``py7zr`` は純 Python
- このコンテナには ``unrar`` / ``unar`` / ``bsdtar`` / ``7z`` / ``7zz`` が無い

素材の作り方も実測に基づく。RAR を**作れる**道具はこの環境に無いので、

- 読める RAR は無圧縮（method 0x30）の RAR3 をここで組み立てる。``rarfile`` の
  ネイティブ解析器がそのまま読む
- コメント付き RAR だけは本物を置く（``tests/fixtures/rar/``）。
  ``rarfile.rar3_decompress`` は無圧縮コメントを外部ツール無しで返してしまい、
  自作では「読めてしまう」ため実例の代わりにならない
- 本物の RAR5 も 1 つ置く。自作の RAR3 しか読めない実装を弾く錨

画面側の「目次を読めません」バッジは ``result.unreadable`` から作られる
（``OrganizePanel`` → ``PlanList`` の ``ISSUE_LABELS``）。その繋がりは
``test_analysis_progress.py`` と ``apps/desktop/e2e/plan-list.spec.ts`` が
既に押さえているので、ここでは ``unreadable`` に載るところまでを見る。
"""

import errno
import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import py7zr
import rarfile
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.analysis_job import analysis_work  # noqa: E402
from manga_core import toc_analyzer  # noqa: E402
from manga_core.file_organizer import FileOrganizer, ProcessResult  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"

# 本物の RAR。出所と選んだ理由は fixtures/rar/README.md
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rar"
REAL_RAR5 = FIXTURES / "rar5-subdirs.rar"
REAL_RAR3_WITH_COMMENT = FIXTURES / "rar3-comment-plain.rar"


def page() -> bytes:
    """テスト用のページ画像。実処理と突き合わせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def pages(prefix: str = "", count: int = 2) -> dict[str, bytes]:
    """アーカイブに入れるページの並び。prefix でフォルダの中に置ける"""
    return {f"{prefix}{index:03d}.jpg": page() for index in range(1, count + 1)}


def zip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の ZIP を作る"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def sevenzip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の 7z を作る。py7zr は純 Python なので外部ツールは要らない"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with py7zr.SevenZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writef(io.BytesIO(data), name)
    return path


# --- RAR3 を組み立てる（無圧縮） ---------------------------------------------
#
# この環境には RAR を作れる道具が無い。目次に載るのは名前だけで、圧縮方式は
# 目次の読み方に影響しないため、無圧縮（store）の RAR3 を自前で書き出す。
# 組み上がったものは rarfile のネイティブ解析器がそのまま読む（実測済み）。
# 形式は rarfile の RAR3Parser が読む並びに合わせてある。

RAR3_MARKER = b"Rar!\x1a\x07\x00"
# 共通ブロックヘッダ: CRC16・種別・フラグ・ヘッダ長
RAR3_BLOCK = struct.Struct("<HBHH")
# ファイルヘッダの固定部: 格納長・元の長さ・OS・CRC32・時刻・版・方式・名前長・属性
RAR3_FILE_FIELDS = struct.Struct("<LLBLLBBHL")

RAR3_TYPE_MAIN = 0x73
RAR3_TYPE_FILE = 0x74
RAR3_TYPE_ENDARC = 0x7B

RAR3_FLAG_LONG_BLOCK = 0x8000
RAR3_FLAG_UNICODE_NAME = 0x0200
RAR3_FLAG_SKIP_IF_UNKNOWN = 0x4000
# 書庫全体の印
RAR3_MAIN_VOLUME = 0x0001
RAR3_MAIN_NEW_NUMBERING = 0x0010
# ファイルの印
RAR3_FILE_SPLIT_BEFORE = 0x0001

RAR3_METHOD_STORE = 0x30
# 実際には圧縮していないが、目次にだけ「圧縮されている」と書く。rarfile は
# 中身を読む段になって初めて外部ツールを要求するので、「目次は読めるが
# 中身は取り出せない」実世界の RAR を、道具を持たないこの環境で再現できる
RAR3_METHOD_COMPRESSED = 0x33

RAR3_HOST_OS_UNIX = 3
RAR3_VERSION = 20
RAR3_ATTR_ARCHIVE = 0x20
# DOS 形式の時刻。中身は問われないので固定値にして、素材を毎回同じ byte 列にする
RAR3_DOS_TIME = ((2020 - 1980) << 25) | (1 << 21) | (1 << 16)


def _rar3_block(block_type: int, flags: int, body: bytes, crc_end: int | None) -> bytes:
    """ブロック 1 つ分。CRC16 はヘッダの 3 byte 目から crc_end までに掛かる"""
    size = RAR3_BLOCK.size + len(body)
    header = RAR3_BLOCK.pack(0, block_type, flags, size) + body
    crc = zlib.crc32(header[2:crc_end] if crc_end else header[2:]) & 0xFFFF
    return RAR3_BLOCK.pack(crc, block_type, flags, size) + body


def rar_with(
    path: Path,
    entries: dict[str, bytes],
    *,
    main_flags: int = 0,
    file_flags: int = 0,
    tool_only: tuple[str, ...] = (),
) -> Path:
    """指定した中身の RAR3 を作る。

    ``tool_only`` に挙げた名前は「圧縮されている」ことにする。目次には載るが、
    中身を取り出すには外部ツールが要る状態になる。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    out = bytearray(RAR3_MARKER)
    # 書庫ヘッダは 13 byte 固定（共通 7 + 予約 6）で、CRC もそこまで
    out += _rar3_block(RAR3_TYPE_MAIN, main_flags, b"\0" * 6, crc_end=13)
    for name, data in entries.items():
        encoded = name.encode("utf-8")
        stored = name not in tool_only
        method = RAR3_METHOD_STORE if stored else RAR3_METHOD_COMPRESSED
        body = (
            RAR3_FILE_FIELDS.pack(
                len(data),
                len(data),
                RAR3_HOST_OS_UNIX,
                zlib.crc32(data) & 0xFFFFFFFF,
                RAR3_DOS_TIME,
                RAR3_VERSION,
                method,
                len(encoded),
                RAR3_ATTR_ARCHIVE,
            )
            + encoded
        )
        flags = RAR3_FLAG_LONG_BLOCK | RAR3_FLAG_UNICODE_NAME | file_flags
        out += _rar3_block(RAR3_TYPE_FILE, flags, body, crc_end=None)
        out += data
    out += _rar3_block(RAR3_TYPE_ENDARC, RAR3_FLAG_SKIP_IF_UNKNOWN, b"", crc_end=None)
    path.write_bytes(bytes(out))
    return path


@contextmanager
def without_archive_tools():
    """外部ツールが 1 台も入っていない機械を再現し、起動しかけた記録を返す。

    開発機には 7-Zip が入っていることがあり、そこでは外部ツールに頼る実装でも
    通ってしまう。落ちるのはツールの無いこのコンテナと CI、そして利用者の
    環境なので、どの機械で走らせても同じ結果になるよう道具を取り上げる。

    起動を**禁止**するのではなく**失敗**させるのは、``rarfile`` が道具の有無を
    調べるだけで 1 度起動しに行くため。禁止にすると「道具が無いと分かった」と
    「道具に頼った」を区別できない。代わりに起動しかけた記録を返し、
    「起動が 0 回であること」を要る場所だけで見る。

    ``rarfile`` は ``from subprocess import Popen`` で取り込むため、
    ``subprocess`` 側だけを塞いでも素通りする。両方を塞ぐ。
    """
    attempts: list[object] = []

    def missing_tool(*args, **kwargs):
        attempts.append(args[0] if args else kwargs.get("args"))
        # 実行ファイルが無いときと同じ形。rarfile はこれを RarCannotExec に直す
        raise FileNotFoundError(errno.ENOENT, "No such file or directory")

    missing = str(Path(tempfile.gettempdir()) / "no-such-archive-tool")
    with (
        mock.patch.object(rarfile, "UNRAR_TOOL", missing),
        mock.patch.object(rarfile, "UNAR_TOOL", missing),
        mock.patch.object(rarfile, "BSDTAR_TOOL", missing),
        mock.patch.object(rarfile, "SEVENZIP_TOOL", missing),
        mock.patch.object(rarfile, "SEVENZIP2_TOOL", missing),
        # 一度見つけた道具は覚えられている。忘れさせないと取り上げた意味が無い
        mock.patch.object(rarfile, "CURRENT_SETUP", None),
        mock.patch.object(rarfile, "Popen", missing_tool),
        mock.patch.object(subprocess, "Popen", missing_tool),
        mock.patch.object(subprocess, "run", missing_tool),
        mock.patch.object(subprocess, "call", missing_tool),
        mock.patch.object(subprocess, "check_output", missing_tool),
        mock.patch.object(os, "system", missing_tool),
    ):
        yield attempts


def tree_snapshot(root: Path) -> list[tuple[str, int]]:
    """フォルダの中身を名前と大きさで写し取る。展開物が置かれていないかを見る"""
    found: list[tuple[str, int]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        found.append((relative, path.stat().st_size if path.is_file() else -1))
    return found


class TocFormatTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def analyze(self, root: Path) -> list:
        """出来上がる本を並べる。投入は利用者と同じくフォルダ 1 つ"""
        return list(toc_analyzer.analyze_inputs([root], author=AUTHOR, title=TITLE))

    def steps(self, root: Path) -> dict[Path, toc_analyzer.AnalysisStep]:
        """入れ物ごとの結果。目次を読めたかどうか（``error``）を見るのに使う"""
        stream = toc_analyzer.analyze_stream([root], author=AUTHOR, title=TITLE)
        return {
            Path(event.container): event
            for event in stream
            if isinstance(event, toc_analyzer.AnalysisStep)
        }

    def shape(self, books: list) -> list[tuple[str, str, int | None, tuple[str, ...]]]:
        """本の並びを (中の位置, 出来る名前, 巻数, 印) で写す。

        元のパスは形式ごとに違う（``raw_04.rar`` と ``raw_04.zip``）ので外す。
        それ以外は 1 つでも違えば予告として食い違っている。
        """
        return [
            (book.entry, book.output_name, book.volume, tuple(book.issues))
            for book in books
        ]

    def fixture(self, name: str, source: Path) -> Path:
        """本物の RAR を、作業フォルダへ漫画らしい名前で置き直す"""
        target = self.work_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return target


class RarTocParityTest(TocFormatTestBase):
    """1. RAR の目次から、同じ中身の ZIP と同じ本が出ること

    冊数だけを比べると、違う本や違う巻数を見つけた実装でも通る。名前・巻数・
    中の位置・印まで並びごと突き合わせる。
    """

    def test_a_flat_rar_yields_the_same_book_as_the_equivalent_zip(self):
        # Arrange - 中身が同じ RAR と ZIP。名前の衝突で `_1` が付かないよう、
        # 別々のフォルダに置いて別々に解析する。巻数は連番の 1 と一致しない 04
        rar_root = self.work_dir / "rar" / "蔵書" / "2020"
        zip_root = self.work_dir / "zip" / "蔵書" / "2020"
        rar_with(rar_root / "raw_04.rar", pages())
        zip_with(zip_root / "raw_04.zip", pages())

        # Act
        from_rar = self.analyze(self.work_dir / "rar")
        from_zip = self.analyze(self.work_dir / "zip")

        # Assert - まず ZIP 側が期待の 1 冊であること。ここを置かないと
        # 「どちらも 0 冊」で一致してしまい、比較が何も見張らない
        self.assertEqual(
            [("", "[著者] 作品 第004巻.zip", 4, ())],
            self.shape(from_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(from_zip)}",
        )

        # Assert - RAR も同じ本になる
        self.assertEqual(
            self.shape(from_zip),
            self.shape(from_rar),
            "RAR の予告が、同じ中身の ZIP と食い違う",
        )
        self.assertEqual(
            [rar_root / "raw_04.rar"],
            [Path(book.source) for book in from_rar],
            "どの RAR から出来る本かが違う",
        )

    def test_volume_folders_in_a_rar_yield_the_same_books_as_the_equivalent_zip(self):
        # Arrange - 1 つの書庫の中で巻ごとにフォルダが分かれている。3 と 7 に
        # して、並び順（1, 2）を巻数にする実装を弾く。さらに RAR には
        # 第7巻 を先に格納する。格納順そのままに並べる実装では ZIP と
        # 順序が食い違い、`_1` の付き方までずれる
        rar_root = self.work_dir / "rar" / "蔵書"
        zip_root = self.work_dir / "zip" / "蔵書"
        rar_with(rar_root / "分冊.rar", {**pages("第7巻/"), **pages("第3巻/")})
        zip_with(zip_root / "分冊.zip", {**pages("第3巻/"), **pages("第7巻/")})

        # Act
        from_rar = self.analyze(self.work_dir / "rar")
        from_zip = self.analyze(self.work_dir / "zip")

        # Assert - ZIP 側の基準
        self.assertEqual(
            [
                ("第3巻", "[著者] 作品 第003巻.zip", 3, ()),
                ("第7巻", "[著者] 作品 第007巻.zip", 7, ()),
            ],
            self.shape(from_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(from_zip)}",
        )

        # Assert - RAR も同じ 2 冊が同じ順で並ぶ
        self.assertEqual(
            self.shape(from_zip),
            self.shape(from_rar),
            "RAR の巻フォルダから出来る本が、同じ中身の ZIP と食い違う",
        )


class SevenZipTocParityTest(TocFormatTestBase):
    """2. 7z の目次から、同じ中身の ZIP と同じ本が出ること

    素材は py7zr で作るが、py7zr は既定でヘッダ自体を LZMA で圧縮して書く
    （次ヘッダの種別が kEncodedHeader = 0x17）。7-Zip 本体の既定と同じで、
    目次が生のまま転がっている素材にはならない。この前提が崩れると
    「目次を読めた」ことの意味が変わるので、素材の側も確かめる。
    """

    def assert_header_is_compressed(self, archive: Path) -> None:
        """7z の目次自体が圧縮されていること（素材の確認）"""
        data = archive.read_bytes()
        offset, size, _crc = struct.unpack("<QQI", data[12:32])
        header_kind = data[32 + offset]
        self.assertEqual(
            0x17,
            header_kind,
            "素材の 7z の目次が圧縮されていない。"
            f"生の目次なら読めて当たり前で、検証にならない: {hex(header_kind)}",
        )

    def test_a_flat_7z_yields_the_same_book_as_the_equivalent_zip(self):
        # Arrange
        seven_root = self.work_dir / "7z" / "蔵書" / "2020"
        zip_root = self.work_dir / "zip" / "蔵書" / "2020"
        archive = sevenzip_with(seven_root / "raw_04.7z", pages())
        zip_with(zip_root / "raw_04.zip", pages())
        self.assert_header_is_compressed(archive)

        # Act
        from_7z = self.analyze(self.work_dir / "7z")
        from_zip = self.analyze(self.work_dir / "zip")

        # Assert - ZIP 側の基準。両方 0 冊での一致を防ぐ
        self.assertEqual(
            [("", "[著者] 作品 第004巻.zip", 4, ())],
            self.shape(from_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(from_zip)}",
        )

        # Assert - 7z も同じ本になる
        self.assertEqual(
            self.shape(from_zip),
            self.shape(from_7z),
            "7z の予告が、同じ中身の ZIP と食い違う",
        )
        self.assertEqual(
            [archive],
            [Path(book.source) for book in from_7z],
            "どの 7z から出来る本かが違う",
        )

    def test_volume_folders_in_a_7z_yield_the_same_books_as_the_equivalent_zip(self):
        # Arrange - RAR と同じく、7z には 第7巻 を先に格納する
        seven_root = self.work_dir / "7z" / "蔵書"
        zip_root = self.work_dir / "zip" / "蔵書"
        sevenzip_with(seven_root / "分冊.7z", {**pages("第7巻/"), **pages("第3巻/")})
        zip_with(zip_root / "分冊.zip", {**pages("第3巻/"), **pages("第7巻/")})

        # Act
        from_7z = self.analyze(self.work_dir / "7z")
        from_zip = self.analyze(self.work_dir / "zip")

        # Assert
        self.assertEqual(
            [
                ("第3巻", "[著者] 作品 第003巻.zip", 3, ()),
                ("第7巻", "[著者] 作品 第007巻.zip", 7, ()),
            ],
            self.shape(from_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(from_zip)}",
        )
        self.assertEqual(
            self.shape(from_zip),
            self.shape(from_7z),
            "7z の巻フォルダから出来る本が、同じ中身の ZIP と食い違う",
        )

    def test_planned_names_match_the_files_a_7z_organize_run_actually_creates(self):
        """予告した名前と、実際に整理して出来るファイル名が一致すること。

        RAR は外部ツールが無いとこの環境で展開できないが、7z は py7zr が
        純 Python で展開する。つまり 7z だけは「予告 = 実際」を実測できる。
        解析の存在理由そのものなので、出来る場所で必ず確かめておく。
        """
        # Arrange - 名前がぶつかる形（第007巻 が 2 つ）を混ぜる。`_1` の付き方は
        # 目次だけでは決まらない部分で、解析と実処理でいちばん食い違いやすい
        root = self.work_dir / "蔵書"
        sevenzip_with(root / "分冊.7z", {**pages("第3巻/"), **pages("第7巻/")})
        sevenzip_with(root / "frieren_07.7z", pages())
        sevenzip_with(root / "おまけ.7z", pages())
        output = self.work_dir / "out"

        # Act - 利用者と同じ順番。先に予告し、そのあと実際に整理する
        planned = self.analyze(root)
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results: list[ProcessResult] = []
        for archive in expand_inputs([root]):
            results.extend(organizer.process_single_archive(archive))

        # Assert - 実処理が成功している。0 冊同士の一致では意味が無い
        self.assertEqual(
            [r.error_message for r in results if not r.success],
            [],
            "7z の実処理が失敗した",
        )
        produced = [r.output_path.name for r in results if r.output_path]
        self.assertEqual(4, len(produced), f"実処理の冊数が想定と違う: {produced}")

        # Assert - 同名がぶつかる形を実際に通っている。通っていなければ
        # この検証は `_1` の食い違いを見張れていない
        self.assertTrue(
            [name for name in produced if "_1" in name],
            f"同名がぶつかる形になっていない: {produced}",
        )

        # Assert - 予告と実際が一致する
        self.assertEqual(
            sorted(produced),
            sorted(book.output_name for book in planned),
            "7z の予告した名前と、実際に出来るファイル名が違う",
        )


class NestedRarAndSevenZipTest(TocFormatTestBase):
    """3. 入れ子。ZIP の再帰がそのまま広がるかを、形式ごとに確かめる

    実測で分かっていること。

    - ``rarfile.RarFile`` も ``py7zr.SevenZipFile`` もファイルオブジェクトを
      受けるので、**ZIP の中の RAR / 7z** は目次を読める
    - ``py7zr`` は中身の取り出しも純 Python なので、**7z の中の ZIP** も読める
    - **RAR の中のアーカイブは一般には読めない。** 圧縮された要素を取り出すには
      外部ツールが要る（無圧縮の要素だけは ``rarfile`` が自前で読む）。
      よって「RAR の中の ZIP から本が出ること」は求めない。求めるのは、
      取り出せない要素があっても RAR 自身の本を落とさないこと
    """

    def test_a_rar_and_a_7z_deep_in_a_folder_tree_are_found(self):
        # Arrange - 投入されるのは根のフォルダだけ。実物は数階層下にある
        root = self.work_dir / "蔵書"
        rar_with(root / "作品A" / "2019" / "raw_04.rar", pages())
        sevenzip_with(root / "作品B" / "2021" / "raw_09.7z", pages())

        # Act
        books = self.analyze(root)

        # Assert - どちらも 1 冊ずつ。巻数はファイル名から取る
        self.assertEqual(
            [
                (root / "作品A" / "2019" / "raw_04.rar", 4),
                (root / "作品B" / "2021" / "raw_09.7z", 9),
            ],
            [(Path(book.source), book.volume) for book in books],
            f"フォルダの奥の RAR / 7z が拾えていない: {self.shape(books)}",
        )
        self.assertEqual(
            ["[著者] 作品 第004巻.zip", "[著者] 作品 第009巻.zip"],
            [book.output_name for book in books],
        )

    def test_a_rar_inside_a_zip_is_read_without_extracting_it(self):
        # Arrange - 外側 ZIP の中に RAR。比較用に、同じ形で中身が ZIP のものも
        # 作る。実処理は入れ子を `_extracted_内_05_rar` へ展開し、その名前から
        # 巻数を読むので、05 ではなく並び順の 1 になる（#74 の既知の欠陥）
        inner_rar = rar_with(self.work_dir / "素材" / "内_05.rar", pages())
        inner_zip = zip_with(self.work_dir / "素材" / "内_05.zip", pages())
        rar_root = self.work_dir / "rar" / "蔵書"
        zip_root = self.work_dir / "zip" / "蔵書"
        zip_with(
            rar_root / "外_00.zip",
            {"内_05.rar": inner_rar.read_bytes(), **pages("表紙/")},
        )
        zip_with(
            zip_root / "外_00.zip",
            {"内_05.zip": inner_zip.read_bytes(), **pages("表紙/")},
        )

        # Act
        with_rar = self.analyze(self.work_dir / "rar")
        with_zip = self.analyze(self.work_dir / "zip")

        # Assert - ZIP 側の基準。中の ZIP と外の 表紙 で 2 冊
        self.assertEqual(
            [
                ("内_05.zip", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",)),
                ("表紙", "[著者] 作品 第002巻.zip", 2, ("volume-uncertain",)),
            ],
            self.shape(with_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(with_zip)}",
        )

        # Assert - 中身が RAR でも同じ 2 冊。位置だけが拡張子ぶん違う
        self.assertEqual(
            [("内_05.rar", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",))]
            + self.shape(with_zip)[1:],
            self.shape(with_rar),
            "ZIP の中の RAR から出来る本が、ZIP の中の ZIP と食い違う",
        )

    def test_a_7z_inside_a_zip_is_read_without_extracting_it(self):
        # Arrange
        inner_7z = sevenzip_with(self.work_dir / "素材" / "内_05.7z", pages())
        inner_zip = zip_with(self.work_dir / "素材" / "内_05.zip", pages())
        seven_root = self.work_dir / "7z" / "蔵書"
        zip_root = self.work_dir / "zip" / "蔵書"
        zip_with(
            seven_root / "外_00.zip",
            {"内_05.7z": inner_7z.read_bytes(), **pages("表紙/")},
        )
        zip_with(
            zip_root / "外_00.zip",
            {"内_05.zip": inner_zip.read_bytes(), **pages("表紙/")},
        )

        # Act
        with_7z = self.analyze(self.work_dir / "7z")
        with_zip = self.analyze(self.work_dir / "zip")

        # Assert - ZIP 側の基準
        self.assertEqual(
            [
                ("内_05.zip", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",)),
                ("表紙", "[著者] 作品 第002巻.zip", 2, ("volume-uncertain",)),
            ],
            self.shape(with_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(with_zip)}",
        )

        # Assert
        self.assertEqual(
            [("内_05.7z", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",))]
            + self.shape(with_zip)[1:],
            self.shape(with_7z),
            "ZIP の中の 7z から出来る本が、ZIP の中の ZIP と食い違う",
        )

    def test_a_zip_inside_a_7z_is_read_without_extracting_it(self):
        # Arrange - 向きを逆にする。py7zr は中身の取り出しも純 Python なので、
        # 7z の中のアーカイブは外部ツール無しで目次まで辿れる
        inner = zip_with(self.work_dir / "素材" / "内_05.zip", pages())
        seven_root = self.work_dir / "7z" / "蔵書"
        zip_root = self.work_dir / "zip" / "蔵書"
        sevenzip_with(
            seven_root / "外_00.7z",
            {"内_05.zip": inner.read_bytes(), **pages("表紙/")},
        )
        zip_with(
            zip_root / "外_00.zip",
            {"内_05.zip": inner.read_bytes(), **pages("表紙/")},
        )

        # Act
        from_7z = self.analyze(self.work_dir / "7z")
        from_zip = self.analyze(self.work_dir / "zip")

        # Assert - ZIP 側の基準
        self.assertEqual(
            [
                ("内_05.zip", "[著者] 作品 第001巻.zip", 1, ("volume-uncertain",)),
                ("表紙", "[著者] 作品 第002巻.zip", 2, ("volume-uncertain",)),
            ],
            self.shape(from_zip),
            f"比較の基準になる ZIP 側が想定と違う: {self.shape(from_zip)}",
        )

        # Assert - 外側が 7z でも同じ 2 冊
        self.assertEqual(
            self.shape(from_zip),
            self.shape(from_7z),
            "7z の中の ZIP から出来る本が、ZIP の中の ZIP と食い違う",
        )

    def test_a_rar_member_that_needs_the_external_tool_keeps_the_rars_own_book(self):
        """圧縮された要素を持つ RAR でも、その RAR 自身の本は落ちないこと。

        RAR の中の要素を取り出すには外部ツールが要る（無圧縮のときだけ
        ``rarfile`` が自前で読む）。入れ子を辿ろうとして素直に読みに行くと、
        実世界の（圧縮された）RAR では ``RarCannotExec`` が上がり、目次は
        読めていたのに書庫まるごと「目次を読めません」になる。ページと
        入れ子アーカイブが同居する RAR は珍しくないので、実害が大きい。
        """
        # Arrange - ページと、外部ツールでしか取り出せない 内_05.zip が同居する
        inner = zip_with(self.work_dir / "素材" / "内_05.zip", pages())
        root = self.work_dir / "蔵書"
        archive = rar_with(
            root / "混在_04.rar",
            {**pages("表紙/"), "内_05.zip": inner.read_bytes()},
            tool_only=("内_05.zip",),
        )

        # Arrange - 下準備の確認。目次は読めるが、その要素は取り出せない
        with without_archive_tools(), rarfile.RarFile(archive) as opened:
            self.assertIn("内_05.zip", opened.namelist())
            with self.assertRaises(rarfile.RarCannotExec):
                opened.read("内_05.zip")

        # Act
        with without_archive_tools() as attempts:
            steps = self.steps(root)

        # Assert - 取り出せない要素を前にしても、外部ツールを探しに行かない。
        # 探しに行った時点で、7-Zip の入った開発機とこの環境で挙動が分かれる
        self.assertEqual([], attempts, f"外部ツールを起動しにいった: {attempts}")

        # Assert - 目次は読めている。読めない扱いにはしない
        step = steps[archive]
        self.assertIsNone(
            step.error,
            f"目次は読めているのに読めなかった扱いになっている: {step.error}",
        )

        # Assert - 表紙 の 1 冊は必ず残る。取り出せない要素があることを理由に
        # RAR 自身の本まで消してはいけない。
        #
        # ここで名前と巻数まで決め打たないのは、入れ子から本が出るかどうかで
        # 冊数が変わり、冊数が変わると巻数の優先順位も変わるため
        # （``resolve_volume`` は 1 冊ならアーカイブ名、複数なら並び順）。
        # 入れ子を読めるかは形式の制約次第なので、ここでは問わない。
        # 名前と巻数の一致は RarTocParityTest が押さえている
        self.assertIn(
            "表紙",
            [book.entry for book in step.books],
            f"RAR 自身の本が落ちている: {self.shape(list(step.books))}",
        )


class UnreadableRarAndSevenZipTest(TocFormatTestBase):
    """4. 目次を読めない RAR / 7z を、黙って「本が 0 冊」として通さない

    どのテストも**読める書庫を同じ解析に必ず混ぜる**。混ぜないと、RAR を
    全部「読めない」と印を付ける実装でも通ってしまう。
    """

    def readable_rar(self, root: Path) -> Path:
        """同じ解析に混ぜる、素直に読める RAR"""
        return rar_with(root / "普通_04.rar", pages())

    def assert_only_unreadable(self, root: Path, broken: Path, healthy: Path) -> None:
        """``broken`` だけが読めず、``healthy`` からは本が出ること"""
        steps = self.steps(root)
        self.assertTrue(
            steps[broken].error,
            f"読めない書庫に理由が付いていない: {steps[broken]}",
        )
        self.assertEqual(
            (),
            steps[broken].books,
            f"読めない書庫から本が出ている: {steps[broken].books}",
        )
        self.assertIsNone(
            steps[healthy].error,
            f"読める書庫まで読めない扱いになっている: {steps[healthy].error}",
        )
        self.assertEqual(
            ["[著者] 作品 第004巻.zip"],
            [book.output_name for book in steps[healthy].books],
            f"読める書庫から本が出ていない: {steps[healthy].books}",
        )

    def test_a_comment_bearing_rar_is_unreadable_while_a_plain_rar_is_not(self):
        # Arrange - 本物のコメント付き RAR3。コメントの復号にだけ外部ツールが
        # 要るため、目次に辿り着けない。同じフォルダに素直な RAR も置く
        root = self.work_dir / "蔵書"
        commented = self.fixture("蔵書/コメント付き_02.rar", REAL_RAR3_WITH_COMMENT)
        healthy = self.readable_rar(root)

        # Arrange - 下準備の確認。本当に開けないことを先に見る
        with without_archive_tools(), self.assertRaises(rarfile.RarCannotExec):
            rarfile.RarFile(commented)

        # Act / Assert
        with without_archive_tools():
            self.assert_only_unreadable(root, commented, healthy)

    def test_a_split_volume_part_is_unreadable_while_a_whole_rar_is_not(self):
        # Arrange - 分割ボリュームの 2 つ目。「分割の一部」かつ「先頭ではない」
        # （RAR3_MAIN_FIRST_VOLUME = 0x0100 を立てない）ので、1 つ目から始めない
        # 限り開けない（``NeedFirstVolume``）。本物の rar3-vols.part2.rar は
        # 100 KB あるので置かず、同じ例外になるヘッダをここで組み立てる。
        # 実物 2 つ（RAR3 / RAR5）が同じ例外を上げることは照合済み
        root = self.work_dir / "蔵書"
        part2 = rar_with(
            root / "分割_08.part2.rar",
            pages(),
            main_flags=RAR3_MAIN_VOLUME | RAR3_MAIN_NEW_NUMBERING,
            file_flags=RAR3_FILE_SPLIT_BEFORE,
        )
        healthy = self.readable_rar(root)

        # Arrange - 下準備の確認
        with without_archive_tools(), self.assertRaises(rarfile.NeedFirstVolume):
            rarfile.RarFile(part2)

        # Act / Assert
        with without_archive_tools():
            self.assert_only_unreadable(root, part2, healthy)

    def test_a_real_rar5_is_readable_while_a_broken_rar_is_not(self):
        # Arrange - 本物の RAR5（下位フォルダと Unicode 名を含む）と、RAR の
        # 名前をした RAR ではないファイル。自作の RAR3 しか読めない実装や、
        # 壊れたものを黙って 0 冊として通す実装を弾く
        root = self.work_dir / "蔵書"
        real = self.fixture("蔵書/本物_06.rar", REAL_RAR5)
        broken = root / "壊れている_07.rar"
        broken.write_bytes(b"\x00\x01 not a rar at all \x02\x03" * 16)
        self.readable_rar(root)

        # Act
        with without_archive_tools():
            steps = self.steps(root)

        # Assert - 壊れたものだけが読めない。本物の RAR5 は読めた側
        self.assertEqual(
            [broken],
            [path for path, step in steps.items() if step.error],
            f"読めなかった書庫の挙げ方が違う: "
            f"{[(str(p), s.error) for p, s in steps.items()]}",
        )
        self.assertTrue(steps[broken].error, "読めなかった理由が入っていない")

        # Assert - 本物の RAR5 は「読めたうえで本が無い」。中身は .txt だけ
        # なので冊数は 0 でよいが、読めなかった扱いにしてはいけない
        self.assertEqual((), steps[real].books)

        # Assert - 素直な RAR からは本が出る。これが無いと「壊れたものだけを
        # 読めない印にして、あとは全部 0 冊」の実装でも通ってしまう
        self.assertEqual(
            ["[著者] 作品 第004巻.zip"],
            [book.output_name for book in steps[root / "普通_04.rar"].books],
            f"読める RAR から本が出ていない: {steps[root / '普通_04.rar'].books}",
        )

    def test_a_header_encrypted_7z_is_unreadable_while_a_plain_7z_is_not(self):
        # Arrange - 目次ごと暗号化された 7z（7-Zip の -mhe=on 相当）。鍵が無い
        # 以上どうやっても目次は読めないので、0 冊ではなく読めなかったとして
        # 扱う。素直な 7z も同じフォルダに置く
        root = self.work_dir / "蔵書"
        root.mkdir(parents=True, exist_ok=True)
        locked = root / "施錠_02.7z"
        with py7zr.SevenZipFile(
            locked, "w", password="secret", header_encryption=True
        ) as archive:
            archive.writef(io.BytesIO(page()), "001.jpg")
        healthy = sevenzip_with(root / "普通_04.7z", pages())

        # Arrange - 下準備の確認
        with self.assertRaises(py7zr.exceptions.PasswordRequired):
            py7zr.SevenZipFile(locked, "r")

        # Act / Assert
        self.assert_only_unreadable(root, locked, healthy)

    def test_the_analysis_job_reports_unreadable_rars_and_keeps_the_books(self):
        """解析ジョブの ``result.unreadable`` まで届くこと。

        画面の「目次を読めません」バッジはこの一覧から作られる
        （``OrganizePanel`` → ``PlanList``）。``AnalysisStep.error`` を持つ
        だけでは、利用者には何も伝わらない。
        """
        # Arrange - 読めない 2 つと、読める 1 つ
        root = self.work_dir / "蔵書"
        commented = self.fixture("蔵書/コメント付き_02.rar", REAL_RAR3_WITH_COMMENT)
        part2 = rar_with(
            root / "分割_08.part2.rar",
            pages(),
            main_flags=RAR3_MAIN_VOLUME | RAR3_MAIN_NEW_NUMBERING,
            file_flags=RAR3_FILE_SPLIT_BEFORE,
        )
        healthy = self.readable_rar(root)

        # Act - 経路は POST /api/jobs/analyze と同じ中身
        work = analysis_work([root], AUTHOR, TITLE, lambda path: True)
        with without_archive_tools():
            result = work(lambda **kwargs: None)

        # Assert - 読めなかった 2 つだけが挙がり、理由も入る
        self.assertEqual(
            sorted([str(commented), str(part2)]),
            sorted(item["source"] for item in result["unreadable"]),
            f"読めなかった書庫の挙げ方が違う: {result['unreadable']}",
        )
        self.assertTrue(
            all(item["reason"] for item in result["unreadable"]),
            f"読めなかった理由が入っていない: {result['unreadable']}",
        )

        # Assert - 行としては 3 つとも残る。読めなくても既定で選ばれ、
        # 実行時に展開して初めて分かる結果に委ねる（第 4 段階の約束）
        self.assertEqual(
            sorted([str(commented), str(part2), str(healthy)]),
            sorted(result["containers"]),
            f"走査の一覧から抜けている: {result['containers']}",
        )

        # Assert - 読める 1 つからは本が出る。全部を読めない扱いにする実装を弾く
        self.assertEqual(
            [(str(healthy), "[著者] 作品 第004巻.zip")],
            [(book["source"], book["output_name"]) for book in result["books"]],
            f"読める RAR から本が出ていない: {result['books']}",
        )


class NoExternalToolTest(TocFormatTestBase):
    """5. 目次を読むのに外部ツールを起動しないこと

    ``archive_handler`` は**展開**のために 7-Zip を探して ``rarfile.UNRAR_TOOL``
    へ差す。同じ道具が目次にも要ると思って実装すると、7-Zip の入った開発機では
    通り、このコンテナと CI では落ちる。取り上げても同じ本が出ることを見る。
    """

    def library(self, root: Path) -> Path:
        """RAR・7z・ZIP・入れ子を一通り含む投入"""
        inner_rar = rar_with(self.work_dir / "素材" / "内_05.rar", pages())
        inner_7z = sevenzip_with(self.work_dir / "素材" / "内_09.7z", pages())
        rar_with(root / "raw_04.rar", pages())
        sevenzip_with(root / "分冊.7z", {**pages("第3巻/"), **pages("第7巻/")})
        zip_with(
            root / "外_00.zip",
            {"内_05.rar": inner_rar.read_bytes(), "内_09.7z": inner_7z.read_bytes()},
        )
        return root

    def test_the_table_of_contents_is_read_without_running_any_external_tool(self):
        # Arrange
        root = self.library(self.work_dir / "蔵書")

        # Act - 道具を取り上げた状態で解析する
        with without_archive_tools() as attempts:
            books = self.analyze(root)

        # Assert - 外部ツールを 1 度も起動しにいっていない。起動を試みる実装は、
        # 7-Zip の入った開発機で通り、この環境と CI と利用者の機械で落ちる
        self.assertEqual([], attempts, f"外部ツールを起動しにいった: {attempts}")

        # Assert - 道具が無くても本は出る。0 冊で「起動しなかった」では意味が無い
        self.assertEqual(
            [
                "[著者] 作品 第001巻.zip",
                "[著者] 作品 第002巻.zip",
                "[著者] 作品 第003巻.zip",
                "[著者] 作品 第004巻.zip",
                "[著者] 作品 第007巻.zip",
            ],
            sorted(book.output_name for book in books),
            f"外部ツール無しで目次を読み切れていない: {self.shape(books)}",
        )

        # Assert - 対照。取り上げていない状態でも同じ結果になる。片方だけで
        # 通る実装（道具の有無で挙動が変わる）を弾く
        self.assertEqual(
            self.shape(books),
            self.shape(self.analyze(root)),
            "外部ツールの有無で解析の結果が変わる",
        )

    def test_reading_rar_and_7z_tables_of_contents_writes_nothing_to_disk(self):
        # Arrange - 一時領域を読み取り専用のフォルダへ向ける。書こうとした
        # 時点で失敗するので、後片付けの上手い実装でもすり抜けられない。
        # rarfile は展開のとき一時 RAR を書き出すので、そこへ落ちたら分かる
        root = self.library(self.work_dir / "蔵書")
        temp_root = self.work_dir / "temp-root"
        temp_root.mkdir()
        temp_root.chmod(0o500)
        self.addCleanup(temp_root.chmod, 0o700)
        before = tree_snapshot(root)

        # Act
        with (
            mock.patch.object(tempfile, "tempdir", str(temp_root)),
            without_archive_tools(),
        ):
            books = self.analyze(root)

        # Assert - 解析はできている
        self.assertEqual(5, len(books), f"解析できていない: {self.shape(books)}")

        # Assert - 入力にも一時領域にも何も増えていない
        self.assertEqual(before, tree_snapshot(root), "入力フォルダに展開物が出来た")
        self.assertEqual([], tree_snapshot(temp_root), "一時領域に展開物が出来た")


if __name__ == "__main__":
    unittest.main()
