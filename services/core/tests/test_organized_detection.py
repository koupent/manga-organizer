"""整理済みのアーカイブを判定し、その判定を API に載せる（#73 第 1・2 段階）。

利用者の困りごとは「一度整理した蔵書をもう一度投入すると、既に完成している
本まで作り直される」こと。作り直しても得るものは無く、失うもの（加工前の
画像、ファイルの時刻、手を入れた並び）はある。

**定義**: 整理済み = その本が既に「この道具が作る物そのもの」であり、
整理しても利用者は何も得られず、失うことしかない状態。

条件はすべて「作る側と同じ関数で期待値を作り直し、等しいか比べる」形で見る。
「整っているように見える名前」を正規表現で探すのではなく往復させる。これが
実処理から離れない唯一の定義で、調整の余地（閾値）を持たない。

判定の単位は「1 冊だけを出し、その ``entry`` が空である入れ物」。合本の中の
1 冊は決して整理済みにならない。この道具の成果物は**ファイル**であって、
その中身ではないため。

| # | 条件 | 期待値を作る関数 |
|---|---|---|
| 0 | 入れ物から出る本が 1 冊で ``entry`` が空 | ``locate_books`` |
| 1 | 拡張子が ``.zip`` | ``create_archive`` は ZIP しか書かない |
| 2 | 名前 == ``format_volume_name(a, t, v) + ".zip"`` | ``VolumeDetector`` |
| 3 | ページ名が順に ``sequential_name(i, N, 拡張子)`` | ``viewer_contract`` |
| 4 | 目次にそのページ以外が無い（同梱物だけ許す） | ``original_store`` |
| 5 | 親フォルダ名 == ``[著者] 作品`` | ``FileOrganizer`` |

条件 4 の許可一覧は手心ではなく安全条件。#96 で分かったとおり、表紙を
切り抜いた本は ``.manga-organizer/`` を抱える。許可しないと、加工した本が
すべて「未整理」と判定され、既定で作り直されて加工前の画像を失う。

``True`` は必ず「肯定的な事実の積」。読めない目次・未対応の形式・親が無い・
名前を読めないといった「分からない」はすべて ``False`` に落ちる。

第 2 段階で ``PlannedBook`` / ``PlannedBookView`` に 4 つの欄が増える
（``organized`` / ``author`` / ``title`` / ``organized_reason``）。欄は
``analysis_job.snapshot()`` の ``unreadable`` と同じく決して省かない。
``organized`` を ``issues`` に入れないのは、``issues`` が画面で警告バッジに
なり、``keptIssueCounts`` が**残した**本の印しか数えないため。除外された本の
印は永久に 0 と表示される。整理済みは問題ではなく状態。

整理済みの本の ``output_name`` は ``source.name``。

第 3 段階（画面に見せる）と第 4 段階（既定で外す）はここに含めない。定義が
実際の蔵書に当たってから、整理する対象を変える。
"""

import shutil
import sys
import tempfile
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方は既存のテストと共有する。同じ物を別々に書くと、片方を直した
# ときに「同じ入力のはず」の 2 つが静かに食い違う
from test_toc_analysis import page, pages, tree_snapshot, zip_with  # noqa: E402
from test_toc_rar_7z import rar_with  # noqa: E402

from manga_api.analysis_job import analysis_work  # noqa: E402
from manga_core import toc_analyzer  # noqa: E402
from manga_core.file_organizer import FileOrganizer, ProcessResult  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402
from manga_core.organized_detector import judge_organized  # noqa: E402
from manga_core.original_store import MANIFEST_ENTRY, ORIGINALS_PREFIX  # noqa: E402
from manga_core.page_splitter import apply_rows, scan_rows  # noqa: E402

# 蔵書に入っている本の著者・作品名・巻数
AUTHOR = "著者"
TITLE = "作品"
VOLUME = 3
PAGE_COUNT = 3

# 依頼に載せる著者・作品名。蔵書の中身と**わざと違える**。整理済みの判定が
# 依頼の値をそのまま返しているだけなら、ここで必ず食い違う
OTHER_AUTHOR = "別人"
OTHER_TITLE = "別作品"

# 整理が作るフォルダ名と本の名前。``build_organized`` が実処理の出力と
# 突き合わせるので、書き写しではなく検証済みの値になる
SERIES_DIR = f"[{AUTHOR}] {TITLE}"
ORGANIZED_NAME = f"{SERIES_DIR} 第{VOLUME:03d}巻.zip"

# 整理済みでない理由。画面がそのまま読む文字列なので、値そのものが契約
MULTIPLE_BOOKS = "multiple-books"
NOT_ZIP = "not-zip"
NAME_MISMATCH = "name-mismatch"
PAGES_MISMATCH = "pages-mismatch"
EXTRA_ENTRIES = "extra-entries"
FOLDER_MISMATCH = "folder-mismatch"


class OrganizedTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

    def build_organized(self, output: Path) -> Path:
        """整理そのものに「整理済みの本」を作らせる。

        判定は「この道具が作る物と同じか」なので、比べる相手を手で組み立てると
        定義そのものを書き写すことになる。実処理に作らせれば、名前の作り方や
        連番の付け方が変わっても素材は自動で追随する。
        """
        source = zip_with(
            self.work_dir / "素材" / f"素材_{VOLUME:02d}.zip", pages(count=PAGE_COUNT)
        )
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results = organizer.process_single_archive(source)
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "整理が失敗した"
        )
        built = results[0].output_path
        self.assertIsNotNone(built)
        # 素材が本当に「整理が作る物」であることをここで固定する。名前の作り方が
        # 変わればこの行が落ち、以降のテストが黙って別物を試すことがなくなる
        self.assertEqual(ORGANIZED_NAME, built.name, "整理の出力名が想定と違う")
        self.assertEqual(SERIES_DIR, built.parent.name, "整理の出力先が想定と違う")
        return built

    def copy_into(self, book: Path, root: Path, folder: str, name: str = "") -> Path:
        """整理済みの本を、別の場所・別の名前へ置き直す"""
        target = root / folder / (name or book.name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(book, target)
        return target

    def add_entries(self, book: Path, extras: dict[str, bytes]) -> Path:
        """本に余計なエントリを足す。ページの並びには手を触れない。

        後ろへ足すので、ページだけを見る実装からは何も変わって見えない。
        目次そのものを見ていなければ気づけない形にするための順序。
        """
        with zipfile.ZipFile(book, "a", zipfile.ZIP_DEFLATED) as archive:
            for name, data in extras.items():
                archive.writestr(name, data)
        return book

    def analyze(
        self, root: Path, author: str = OTHER_AUTHOR, title: str = OTHER_TITLE
    ) -> list:
        """解析を走らせる。既定では蔵書の中身と違う著者・作品名で頼む"""
        return list(toc_analyzer.analyze_inputs([root], author=author, title=title))

    def organize(self, root: Path, output: Path) -> list[ProcessResult]:
        """実際の整理を走らせる。経路は manga_api の整理ジョブと同じにする"""
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results: list[ProcessResult] = []
        for archive in expand_inputs([root]):
            results.extend(organizer.process_single_archive(archive))
        return results

    def only_book(self, books: list, source: Path | None = None):
        """1 冊だけ取り出す。source を渡すとその入れ物から出た本に絞る"""
        matched = [
            book for book in books if source is None or Path(book.source) == source
        ]
        self.assertEqual(
            1,
            len(matched),
            f"本が 1 冊でない: {[(str(b.source), b.entry) for b in matched]}",
        )
        return matched[0]

    def assert_organized(self, book) -> None:
        """整理済みと判定されていること"""
        self.assertIs(
            True,
            book.organized,
            f"整理済みと判定されない: {book.source} ({book.organized_reason})",
        )
        self.assertIsNone(
            book.organized_reason, f"整理済みなのに理由が付く: {book.organized_reason}"
        )

    def assert_not_organized(self, book, reason: str) -> None:
        """整理済みでないと判定され、理由がその 1 つであること"""
        self.assertIs(False, book.organized, f"整理済みと判定された: {book.source}")
        self.assertEqual(
            reason,
            book.organized_reason,
            f"整理済みでない理由が違う: {book.source}",
        )
        # 状態を問題として並べない。issues は画面で警告バッジになり、
        # keptIssueCounts は残した本の印しか数えないため、除外された本の印は
        # 永久に 0 と表示される
        self.assertNotIn(
            reason, tuple(book.issues), f"判定が issues に混ざる: {book.issues}"
        )


class OrganizedShapeTest(OrganizedTestBase):
    """出来上がりと同じ物か、条件ごとに往復して確かめる"""

    def test_a_book_the_organizer_just_built_is_organized(self):
        # Arrange - 整理そのものに作らせた本を、もう一度投入する
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)

        # Act - 依頼の著者・作品名は蔵書の中身とわざと違える
        books = self.analyze(library)

        # Assert - 整理済み
        book = self.only_book(books, built)
        self.assert_organized(book)

        # Assert - 著者・作品名・巻数は**本の名前から**読めている。依頼の値
        # （別人 / 別作品）とも、決め打ちの定数とも違う値になる
        self.assertEqual(AUTHOR, book.author, "著者が本の名前から読めていない")
        self.assertEqual(TITLE, book.title, "作品名が本の名前から読めていない")
        self.assertEqual(VOLUME, book.volume)

        # Assert - 状態を問題として並べない
        self.assertEqual((), tuple(book.issues), f"要らない印が付く: {book.issues}")

    def test_a_loosely_numbered_name_is_not_organized(self):
        # Arrange - 整理済みの本と、0 詰めだけが違う名前。フォルダも中身も同じ
        library = self.work_dir / "蔵書"
        built = self.build_organized(self.work_dir / "整理済み")
        loose = self.copy_into(
            built, library, SERIES_DIR, f"{SERIES_DIR} 第{VOLUME}巻.zip"
        )

        # Act
        books = self.analyze(library)

        # Assert - 名前を作り直すと 第003巻 になる。見た目が整っていることと、
        # この道具が作る名前であることは別
        self.assert_not_organized(self.only_book(books, loose), NAME_MISMATCH)

    def test_a_gap_in_the_page_numbers_is_not_organized(self):
        # Arrange - ページは 3 枚あるが 003 が抜けて 004 が居る。枚数は合うので、
        # 数を数えるだけの実装では通ってしまう
        library = self.work_dir / "蔵書"
        gapped = zip_with(
            library / SERIES_DIR / ORGANIZED_NAME,
            {"001.jpg": page(), "002.jpg": page(), "004.jpg": page()},
        )

        # Act
        books = self.analyze(library)

        # Assert
        self.assert_not_organized(self.only_book(books, gapped), PAGES_MISMATCH)

    def test_a_folder_not_named_after_the_series_is_not_organized(self):
        # Arrange - 本そのものは整理済みだが、置かれているフォルダが `作品`。
        # 整理は `[著者] 作品` にしか書き出さない
        library = self.work_dir / "蔵書"
        built = self.build_organized(self.work_dir / "整理済み")
        misplaced = self.copy_into(built, library, TITLE)

        # Act
        books = self.analyze(library)

        # Assert
        book = self.only_book(books, misplaced)
        self.assert_not_organized(book, FOLDER_MISMATCH)
        # 何が違うのかを、いまの名前と整理の形の両方で言う（#126）
        self.assertEqual(
            f"いまのフォルダは {TITLE}（整理の形なら {SERIES_DIR}）",
            book.organized_detail,
        )

    def test_a_stray_book_in_the_series_folder_is_judged_on_its_own(self):
        # Arrange - 同じフォルダに、整理済みの本と名前だけ違う本を並べる。
        # 中身はどちらも整理の出力と同じ形にして、違いを名前だけにする
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        stray = zip_with(library / SERIES_DIR / "raw_09.zip", pages(count=PAGE_COUNT))

        # Act
        books = self.analyze(library)

        # Assert - 2 冊とも、どちらの本かを名指しで確かめる。片方が整理済みで
        # なければ通る、という数え方では入れ替わりを見逃す
        self.assert_organized(self.only_book(books, built))
        self.assert_not_organized(self.only_book(books, stray), NAME_MISMATCH)

    def test_a_compound_archive_is_not_organized(self):
        # Arrange - 1 つの ZIP に 2 冊。名前とフォルダは整理済みの形にして、
        # 「1 冊だけを出す入れ物か」以外の条件を満たさせる
        library = self.work_dir / "蔵書"
        compound = zip_with(
            library / SERIES_DIR / ORGANIZED_NAME,
            {**pages("第01巻/"), **pages("第02巻/")},
        )

        # Act
        books = self.analyze(library)

        # Assert - 2 冊とも整理済みでない。この道具の成果物はファイルであって、
        # その中身ではない。合本の中の 1 冊は決して「出来上がり」にならない
        inside = [book for book in books if Path(book.source) == compound]
        self.assertEqual(2, len(inside), f"合本から 2 冊出ない: {inside}")
        for book in inside:
            self.assert_not_organized(book, MULTIPLE_BOOKS)

    def test_a_bare_image_folder_is_not_organized(self):
        # Arrange - 名前もフォルダもページも整理済みの形。ZIP でないことだけが違う
        library = self.work_dir / "蔵書"
        bare = library / SERIES_DIR / f"{SERIES_DIR} 第{VOLUME:03d}巻"
        bare.mkdir(parents=True)
        for name, data in pages(count=PAGE_COUNT).items():
            (bare / name).write_bytes(data)

        # Act
        books = self.analyze(library)

        # Assert
        self.assert_not_organized(self.only_book(books, bare), NOT_ZIP)

    def test_a_rar_with_ideal_contents_is_not_organized(self):
        # Arrange - 中身も名前もフォルダも整理済みの形にした RAR。整理は ZIP しか
        # 書かないので、拡張子だけで整理済みにならない。ほかの条件を崩した RAR で
        # 確かめると、別の理由で落ちているだけかもしれない
        library = self.work_dir / "蔵書"
        archive = rar_with(
            library / SERIES_DIR / f"{SERIES_DIR} 第{VOLUME:03d}巻.rar",
            pages(count=PAGE_COUNT),
        )

        # Act
        books = self.analyze(library)

        # Assert - 理由は「ZIP でない」ただ 1 つ
        self.assert_not_organized(self.only_book(books, archive), NOT_ZIP)

    def test_a_book_whose_volume_cannot_be_read_is_not_organized(self):
        # Arrange - `[著者] 作品 Unknown.zip` は format_volume_name(a, t, None) の
        # 出力そのもの。往復だけを見ると等しくなってしまうが、巻数の分からない本は
        # 出来上がりではない。整理し直せば巻数が付くかもしれない
        library = self.work_dir / "蔵書"
        unknown = zip_with(
            library / SERIES_DIR / f"{SERIES_DIR} Unknown.zip", pages(count=PAGE_COUNT)
        )

        # Act
        books = self.analyze(library)

        # Assert
        book = self.only_book(books, unknown)
        self.assertIsNone(book.volume)
        self.assert_not_organized(book, NAME_MISMATCH)


class OrganizedEntryWhitelistTest(OrganizedTestBase):
    """目次に何が載っているかを、ページの一覧ではなく目次そのもので見ること。

    ページの一覧（``is_viewer_page`` を通ったもの）だけを見る実装は、
    ``__MACOSX/`` もドットフォルダも**除外済み**なので何も気づけない。
    """

    def prepare(self, extras: dict[str, bytes]) -> tuple[Path, list]:
        """整理済みの本に余計なエントリを足して解析する"""
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        self.add_entries(built, extras)
        return built, self.analyze(library)

    def test_a_stray_file_at_the_root_is_not_organized(self):
        # Arrange - ページの後ろに readme.txt。ページの並びは 1 文字も変わらない
        book, books = self.prepare({"readme.txt": b"hello"})

        # Assert
        self.assert_not_organized(self.only_book(books, book), EXTRA_ENTRIES)

    def test_macosx_metadata_is_not_organized(self):
        # Arrange - `__MACOSX/` は viewer_contract が**積極的に除外する**ので、
        # ページの一覧からは消える。目次を見ていなければ絶対に気づけない
        book, books = self.prepare({"__MACOSX/._001.jpg": page()})

        # Assert
        self.assert_not_organized(self.only_book(books, book), EXTRA_ENTRIES)

    def test_pre_edit_images_kept_by_the_app_stay_organized(self):
        # Arrange - 表紙を切り抜いた本が持つ同梱物（#66 / #96）。名前は
        # original_store の定数から作る。置き場が変わればここも一緒に動く
        book, books = self.prepare(
            {
                MANIFEST_ENTRY: b'{"version": 1, "originals": {}, "derived": {}}',
                f"{ORIGINALS_PREFIX}ab.jpg": page(),
            }
        )

        # Assert - 加工した本を「未整理」にすると、既定で作り直されて加工前の
        # 画像を失う。許すのは手心ではなく安全条件
        self.assert_organized(self.only_book(books, book))

    def test_a_thumbnail_folder_is_not_organized(self):
        # Arrange - ドットで始まるが、この道具が置いた物ではない
        book, books = self.prepare({".thumbnails/001.jpg": page()})

        # Assert - 「ドットで始まる物は見逃す」では通ってしまう。許可するのは
        # `.manga-organizer/` 配下だけ、という先頭一致の一覧が要る
        found = self.only_book(books, book)
        self.assert_not_organized(found, EXTRA_ENTRIES)
        # どのファイルが余計なのかを名前で言う（#126）
        self.assertEqual(".thumbnails/001.jpg", found.organized_detail)

    def test_deleting_and_restoring_pages_keeps_the_book_organized(self):
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        apply_rows(
            built,
            [replace(row, deleted=i == 1) for i, row in enumerate(scan_rows(built))],
        )
        found = self.only_book(self.analyze(library), built)
        self.assert_organized(found)
        self.assertEqual((AUTHOR, TITLE), (found.author, found.title))
        self.assertEqual(built.name, found.output_name)
        self.assertEqual(PAGE_COUNT - 1, found.image_count)
        # 再整理で退避画像や編集記録を失わず、元の本をそのまま残す。
        before = built.read_bytes()
        organizer = FileOrganizer(output_directory=library, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results = organizer.process_single_archive(built)
        self.assertEqual([], results)
        self.assertEqual(before, built.read_bytes())

        apply_rows(built, [replace(row, deleted=False) for row in scan_rows(built)])
        restored = self.only_book(self.analyze(library), built)
        self.assert_organized(restored)
        self.assertEqual(PAGE_COUNT, restored.image_count)

    def test_unrecognized_deleted_entries_are_not_allowed(self):
        for entry in (
            ".manga-organizer/deleted/002/page.jpg",
            ".manga-organizer/deleted/000/.page.jpg",
            ".manga-organizer/deleted/002/.page.txt",
        ):
            with self.subTest(entry=entry):
                # 同じ本に足し続けず、各ケースの理由を個別に検証する。
                verdict = judge_organized(
                    Path(SERIES_DIR) / ORGANIZED_NAME,
                    "",
                    1,
                    ["001.jpg", entry],
                )
                self.assertFalse(verdict.organized)
                self.assertEqual(EXTRA_ENTRIES, verdict.reason)


class OrganizedPageSequenceTest(OrganizedTestBase):
    """連番の桁が総ページ数に従うこと。

    ``sequential_name`` は総数に合わせて桁を広げる（1000 ページなら ``0001``）。
    桁を 3 に決め打ちした判定は、1000 ページの本を丸ごと「未整理」にする。
    実物の 1000 枚 ZIP を作ると数秒かかるので、名前の並びだけを直接渡す。
    """

    def judge(self, names: list[str]) -> bool:
        from manga_core import organized_detector

        return organized_detector.pages_are_sequential(names)

    def test_the_page_digits_follow_the_total_page_count(self):
        # Assert - 1000 ページなら 4 桁。3 桁決め打ちの実装が落ちる
        self.assertIs(
            True,
            self.judge([f"{index:04d}.jpg" for index in range(1, 1001)]),
            "1000 ページの 4 桁を整理済みと見ない",
        )
        self.assertIs(
            False,
            self.judge([f"{index:03d}.jpg" for index in range(1, 1001)]),
            "1000 ページなのに 3 桁を整理済みと見る",
        )

        # Assert - 999 ページなら 3 桁。4 桁決め打ちの実装も落ちる
        self.assertIs(
            True,
            self.judge([f"{index:03d}.jpg" for index in range(1, 1000)]),
            "999 ページの 3 桁を整理済みと見ない",
        )
        self.assertIs(
            False,
            self.judge([f"{index:04d}.jpg" for index in range(1, 1000)]),
            "999 ページなのに 4 桁を整理済みと見る",
        )

    def test_the_page_names_keep_each_original_extension(self):
        # Assert - 拡張子はページごとにそのまま残る
        self.assertIs(True, self.judge(["001.jpg", "002.png", "003.webp"]))

        # Assert - viewer が読めない形式は PNG へ変換されて出る。bmp のまま
        # 残っている本は、この道具が作った物ではない
        self.assertIs(False, self.judge(["001.bmp"]), "変換前の拡張子を見逃す")

    def test_the_page_names_must_be_present(self):
        # Assert - 抜けた番号は出来上がりと違う
        self.assertIs(False, self.judge(["001.jpg", "003.jpg"]), "番号が抜けている")

        # Assert - 分からないものは False へ落ちる。空の一覧を「等しい」と
        # したくなるが、この道具は 0 ページの本を作らない
        self.assertIs(False, self.judge([]), "ページの無い本を整理済みと見る")

    def test_the_storage_order_does_not_matter(self):
        """格納順だけが違う本は整理済み（#126）。

        viewer は格納順ではなく名前の辞書順で並べるので、読み手から見た本は
        同じ。格納順まで求めると、後から別のツールでページを足し引きした本に
        「連番が違う」が出て、利用者には違いが見つからない。
        """
        self.assertIs(True, self.judge(["002.jpg", "001.jpg", "003.jpg"]))

    def test_the_mismatch_names_the_first_page_that_differs(self):
        """どのページが何と違うかを 1 文で言う（#126）"""
        from manga_core import organized_detector

        # Assert - 抜けた番号は、そこに来るはずの名前と一緒に出る
        self.assertEqual(
            "2 枚目が 003.jpg（連番なら 002.jpg）",
            organized_detector.page_mismatch(["001.jpg", "003.jpg"]),
        )
        # Assert - 連番でない名前は先頭から出る
        self.assertEqual(
            "1 枚目が p001.jpg（連番なら 001.jpg）",
            organized_detector.page_mismatch(["p001.jpg", "p002.jpg"]),
        )
        self.assertIsNone(organized_detector.page_mismatch(["001.jpg", "002.png"]))


class OrganizedFailSafeTest(OrganizedTestBase):
    """分からないものが ``True`` に落ちないこと。片方の失敗が全体を巻き込まないこと"""

    def test_an_unreadable_container_does_not_poison_its_neighbours(self):
        # Arrange - 名前もフォルダも整理済みの形をしているが、中身が壊れた ZIP。
        # 名前だけを見る実装なら整理済みに見える
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        broken = library / SERIES_DIR / f"{SERIES_DIR} 第004巻.zip"
        broken.write_bytes(b"PK\x03\x04 this is not a zip")

        # Act
        events = list(
            toc_analyzer.analyze_stream(
                [library], author=OTHER_AUTHOR, title=OTHER_TITLE
            )
        )
        steps = {
            step.container: step
            for step in events
            if isinstance(step, toc_analyzer.AnalysisStep)
        }

        # Assert - 読めなかった入れ物からは本が出ない。目次を読まずに名前だけで
        # 本を仕立てる実装を弾く
        self.assertIn(broken, steps, f"壊れた ZIP が一覧に無い: {list(steps)}")
        self.assertTrue(steps[broken].error, "読めなかったことが残らない")
        self.assertEqual((), steps[broken].books, "読めない入れ物から本が出た")

        # Assert - 隣は今までどおり整理済み。1 つ読めないだけで全部を False へ
        # 倒す実装（「分からないから安全側」の一律適用）を弾く
        self.assert_organized(self.only_book(list(steps[built].books), built))

    def test_judging_writes_nothing_to_disk(self):
        # Arrange - 一時領域を読み取り専用にする。展開しようとした時点で失敗
        # するので、後片付けの上手い実装でもすり抜けられない
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        loose = self.copy_into(
            built, library, SERIES_DIR, f"{SERIES_DIR} 第{VOLUME}巻.zip"
        )
        noisy = self.copy_into(built, library, SERIES_DIR, f"{SERIES_DIR} 第005巻.zip")
        self.add_entries(noisy, {"readme.txt": b"hello"})
        temp_root = self.work_dir / "temp-root"
        temp_root.mkdir()
        temp_root.chmod(0o500)
        self.addCleanup(temp_root.chmod, 0o700)
        before = tree_snapshot(library)

        # Act
        with mock.patch.object(tempfile, "tempdir", str(temp_root)):
            books = self.analyze(library)

        # Assert - 判定はできている。何もしない実装なら「何も書かない」は当然
        # 満たされるので、同じテストの中で判定まで見る
        self.assertEqual(3, len(books), f"判定できていない: {books}")
        self.assert_organized(self.only_book(books, built))
        self.assert_not_organized(self.only_book(books, loose), NAME_MISMATCH)
        # 第005巻 は名前を巻数に合わせてあるので、落ちる条件は目次だけ
        self.assert_not_organized(self.only_book(books, noisy), EXTRA_ENTRIES)

        # Assert - 蔵書にも一時領域にも何も増えていない
        self.assertEqual(before, tree_snapshot(library), "蔵書に展開物が出来た")
        self.assertEqual([], tree_snapshot(temp_root), "一時領域に展開物が出来た")


class OrganizedApiSurfaceTest(OrganizedTestBase):
    """判定が画面まで、決まった形で届くこと（第 2 段階）"""

    def test_an_organized_book_keeps_its_own_name(self):
        # Arrange - 依頼の著者・作品名は蔵書の中身とわざと違える
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)

        # Act
        books = self.analyze(library)

        # Assert - 出来上がりの名前は自分自身。依頼の値で名前を作り直すと、
        # 画面には「作り直したら別人名義になる」という嘘の予告が並ぶ
        book = self.only_book(books, built)
        self.assert_organized(book)
        self.assertEqual(built.name, book.output_name)
        self.assertNotIn(
            OTHER_TITLE, book.output_name, f"依頼の作品名が混ざる: {book.output_name}"
        )

    def test_the_four_fields_are_present_on_a_book_that_is_not_organized(self):
        # Arrange - 整理済みでない本 1 冊。欄を省く実装でも `.get()` を使う
        # テストなら通ってしまうので、鍵そのものを見る
        library = self.work_dir / "蔵書"
        zip_with(library / SERIES_DIR / "raw_09.zip", pages(count=PAGE_COUNT))

        # Act - 解析ジョブが画面へ返す形そのもの
        work = analysis_work([library], OTHER_AUTHOR, OTHER_TITLE, lambda path: True)
        result = work(lambda **kwargs: None)

        # Assert
        self.assertEqual(1, len(result["books"]), result["books"])
        view = result["books"][0]
        for key in ("organized", "author", "title", "organized_reason"):
            self.assertIn(key, view, f"欄が省かれている: {sorted(view)}")
        self.assertIs(False, view["organized"])
        self.assertEqual(NAME_MISMATCH, view["organized_reason"])
        self.assertNotIn(
            NAME_MISMATCH, view["issues"], f"判定が issues に混ざる: {view}"
        )


class OrganizedFidelityTest(OrganizedTestBase):
    """判定を足しても、予告した名前と実際に出来る名前が一致し続けること。

    第 1・2 段階では既定を変えない。整理済みと判定された本も、いままでどおり
    作られる。判定だけを足して振る舞いを変えないことが、第 3・4 段階を
    実際の蔵書に当ててから決めるための土台になる。
    """

    def test_a_book_judged_organized_is_still_built_by_an_organize_run(self):
        # Arrange - 整理済みの本を、同じ著者・作品名でもう一度投入する
        library = self.work_dir / "蔵書"
        built = self.build_organized(library)
        output = self.work_dir / "再出力"

        # Act - 利用者と同じ順番。実行前に解析し、そのあとで整理する
        planned = self.analyze(library, author=AUTHOR, title=TITLE)
        results = self.organize(library, output)

        # Assert - 判定は整理済み。予告の名前は自分自身
        book = self.only_book(planned, built)
        self.assert_organized(book)
        self.assertEqual(built.name, book.output_name)

        # Assert - それでも作られる。出来たファイルの**名前**を出力先から
        # 読み出して突き合わせる。冊数だけでは名前の食い違いを見張れない
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "整理が失敗した"
        )
        self.assertEqual(
            [book.output_name],
            sorted(path.name for path in (output / SERIES_DIR).glob("*.zip")),
            "予告した名前のファイルが出力先に無い",
        )


if __name__ == "__main__":
    unittest.main()
