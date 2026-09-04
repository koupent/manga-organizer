"""展開せずに ZIP の目次を読み、出来上がる本を実行前に推定する（#70 第 2 段階）。

利用者の要望は「最終的にできる ZIP はこれ、みたいなので明示してあって、こういう
ファイルができるよ、というのがユーザーに見えるようになっているといい」。第 1 段階
でフォルダを丸ごと受け取れるようになったので、次は**実行前に**何冊出来るかと
その名前を確定させる。

解析は中央ディレクトリ（目次）だけを読む。判定に要るのは「そのフォルダに画像が
あるか」「何巻か」「出来上がる名前」の 3 つで、どれも目次で分かる。展開まで
やると数百 GB のライブラリで展開が 2 回になる。

ここで求める公開契約は次の形とする。

    from manga_core import toc_analyzer
    books = toc_analyzer.analyze_inputs([folder], author="著者", title="作品")

戻り値の各項目（本 1 冊）が持つもの。

- ``source``      : 元になったディスク上のパス（アーカイブか裸の画像フォルダ）
- ``entry``       : アーカイブ内での位置。アーカイブ全体が 1 冊なら空文字
- ``output_name`` : 出来上がるファイル名（``[著者] 作品 第NNN巻.zip``）
- ``volume``      : 巻数。読めなければ None
- ``issues``      : 実行前に利用者へ見せる印。``VOLUME_UNKNOWN`` / ``VOLUME_UNCERTAIN``

RAR / 7z（第 5 段階）と、画面側の 3 階層リスト・チェックボックス（第 3 段階）は
範囲外。ここでは ZIP と裸の画像フォルダだけを見る。
"""

import io
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 解析の本体はこれから作る（第 2 段階）。モジュールごと取り込むのは、
# 名指しで取り込むと未実装の間だけ ruff の並べ替えが別の順序を要求するため
from manga_core import toc_analyzer  # noqa: E402
from manga_core.archive_handler import ArchiveHandler  # noqa: E402
from manga_core.file_organizer import FileOrganizer, ProcessResult  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"


def page() -> bytes:
    """テスト用のページ画像。実処理と突き合わせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def pages(prefix: str = "", count: int = 2) -> dict[str, bytes]:
    """アーカイブに入れるページの並び。prefix でフォルダの中に置ける"""
    return {f"{prefix}{index:03d}.jpg": page() for index in range(1, count + 1)}


def zip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の ZIP を作る。途中のフォルダも掘る"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def tree_snapshot(root: Path) -> list[tuple[str, int]]:
    """フォルダの中身を、名前と大きさで写し取る。

    解析の前後で比べて、展開物が置かれていないことを見るために使う。
    """
    found: list[tuple[str, int]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        found.append((relative, path.stat().st_size if path.is_file() else -1))
    return found


class TocAnalysisTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def write_archive(
        self, path: Path, entries: dict[str, bytes] | None = None
    ) -> Path:
        """1 冊分のページが入った ZIP を作る"""
        return zip_with(path, entries if entries is not None else pages())

    def write_bare_folder(self, path: Path) -> Path:
        """ZIP に入っていない、画像が直接置かれたフォルダを作る"""
        path.mkdir(parents=True, exist_ok=True)
        for name, data in pages().items():
            (path / name).write_bytes(data)
        return path

    def analyze(self, root: Path) -> list:
        """解析を走らせる。投入するのは第 1 段階と同じくフォルダ 1 つ"""
        return list(toc_analyzer.analyze_inputs([root], author=AUTHOR, title=TITLE))

    def organize(self, root: Path, output: Path) -> list[ProcessResult]:
        """実際の整理を走らせる。経路は manga_api の整理ジョブと同じにする。

        解析と実処理を別々の入口で組み立てると、片方だけ直したときの食い違いを
        見逃す。ここでは app.py の submit_organize と同じ順序で回す。
        """
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results: list[ProcessResult] = []
        for archive in expand_inputs([root]):
            results.extend(organizer.process_single_archive(archive))
        return results

    def by_source(self, items: list[tuple[Path, str]]) -> dict[str, list[str]]:
        """(元のパス, 出来る名前) の並びを、元のパスごとにまとめる"""
        grouped: dict[str, list[str]] = {}
        for source, name in items:
            grouped.setdefault(str(source), []).append(name)
        return {source: sorted(names) for source, names in grouped.items()}

    def named(self, books: list) -> list[str]:
        return sorted(book.output_name for book in books)

    def only_book_of(self, books: list, source: Path):
        """指定のアーカイブから出来る本を 1 冊だけ取り出す"""
        matched = [book for book in books if Path(book.source) == source]
        self.assertEqual(1, len(matched), f"{source.name} から出来る本が 1 冊でない")
        return matched[0]


class TocAnalysisShapeTest(TocAnalysisTestBase):
    """目次から、何冊がどんな名前で出来るかを言い当てられること"""

    def test_reports_one_book_for_a_flat_archive(self):
        # Arrange - 画像だけが入った ZIP。巻数が連番の 1 と一致しない 04 にして、
        # 「並び順の番号を巻数にしただけ」の実装で通らないようにする
        root = self.work_dir / "単純"
        archive = self.write_archive(root / "raw_04.zip")

        # Act
        books = self.analyze(root)

        # Assert - 1 冊。名前も巻数も目次だけで確定する
        self.assertEqual(1, len(books), f"1 冊にならない: {self.named(books)}")
        book = books[0]
        self.assertEqual(archive, Path(book.source))
        self.assertEqual("", book.entry, "アーカイブ全体が 1 冊なら中の位置は空")
        self.assertEqual(4, book.volume)
        self.assertEqual("[著者] 作品 第004巻.zip", book.output_name)

        # Assert - 素直に読めたものに印は付かない
        self.assertEqual((), tuple(book.issues), f"要らない印が付く: {book.issues}")

    def test_reports_books_from_archives_nested_inside_archives(self):
        # Arrange - ZIP の中に ZIP。片方は内側だけ、もう片方は自分のページも持つ
        root = self.work_dir / "入れ子"
        material = self.work_dir / "素材"
        inner_5 = self.write_archive(material / "内_05.zip")
        inner_9 = self.write_archive(material / "内_09.zip")
        outer_only_nested = zip_with(
            root / "外_00.zip",
            {"内_05.zip": inner_5.read_bytes(), "内_09.zip": inner_9.read_bytes()},
        )
        outer_with_pages = zip_with(
            root / "外側_20.zip",
            {**pages("表紙/"), "内_05.zip": inner_5.read_bytes()},
        )

        # Act
        books = self.analyze(root)

        # Assert - 内側の ZIP を数え落とさない。外側 2 つで 4 冊
        self.assertEqual(4, len(books), f"入れ子の冊数が合わない: {self.named(books)}")
        self.assertEqual(
            {str(outer_only_nested): 2, str(outer_with_pages): 2},
            {
                str(source): len(names)
                for source, names in self.by_source(
                    [(Path(book.source), book.output_name) for book in books]
                ).items()
            },
            "どのアーカイブから何冊出来るかが合わない",
        )

        # Assert - 内側の ZIP から出来る本は、その位置が分かる。
        # 4 冊がどれも同じ場所を指しているようでは一覧に出せない
        positions = {(str(book.source), book.entry) for book in books}
        self.assertEqual(4, len(positions), f"位置が重なっている: {positions}")
        self.assertTrue(
            [
                book
                for book in books
                if Path(book.source) == outer_with_pages and "内_05.zip" in book.entry
            ],
            "外側_20.zip の中の 内_05.zip から出来る本が見当たらない",
        )

        # Assert - 名前も 4 つとも別々。同じ名前を 2 つ並べたら実行時にぶつかる
        self.assertEqual(4, len(set(self.named(books))), self.named(books))

    def test_reports_one_book_per_volume_directory_in_a_single_archive(self):
        # Arrange - 1 つの ZIP の中で巻ごとにフォルダが分かれている。
        # 3 と 7 にして、フォルダの並び順（1, 2）を巻数にする実装を弾く
        root = self.work_dir / "分冊"
        archive = zip_with(root / "分冊.zip", {**pages("第3巻/"), **pages("第7巻/")})

        # Act
        books = self.analyze(root)

        # Assert - フォルダごとに 1 冊。巻数はフォルダ名から取る
        self.assertEqual(2, len(books), f"巻ごとに分かれない: {self.named(books)}")
        self.assertEqual([3, 7], sorted(book.volume for book in books))
        self.assertEqual(
            ["[著者] 作品 第003巻.zip", "[著者] 作品 第007巻.zip"],
            self.named(books),
            "巻ディレクトリの名前から巻数を取れていない",
        )

        # Assert - どちらも同じ ZIP から出来る。中の位置は別々
        self.assertEqual({archive}, {Path(book.source) for book in books})
        self.assertEqual(2, len({book.entry for book in books}))

    def test_reports_a_bare_image_folder_as_one_book(self):
        # Arrange - ZIP に入っていない、画像が直接置かれたフォルダ（第 1 段階で対応）
        root = self.work_dir / "裸を含む"
        bare = self.write_bare_folder(root / "裸_12")

        # Act
        books = self.analyze(root)

        # Assert - フォルダも 1 冊として並ぶ。巻数はフォルダ名から
        self.assertEqual(1, len(books), f"裸のフォルダが 1 冊にならない: {books}")
        self.assertEqual(bare, Path(books[0].source))
        self.assertEqual(12, books[0].volume)
        self.assertEqual("[著者] 作品 第012巻.zip", books[0].output_name)


class TocAnalysisWithoutExtractionTest(TocAnalysisTestBase):
    """解析が展開を伴わないこと。これが「目次を読む」ことの証明になる。

    確かめ方は 2 通り置く。片方だけでは抜ける。

    1. 一時領域と入力フォルダに何も置かれないこと（後片付けの有無に関わらず、
       書き込もうとした時点で失敗するよう一時領域を読み取り専用にする）
    2. 展開の入口を塞いでも、塞ぐ前と同じ本が同じ名前で並ぶこと

    なお ZIP の中の ZIP は、内側の目次を読むために内側のバイト列を読む必要がある。
    メモリ上で読むことは禁じない。禁じるのはディスクへ展開することだけ。
    """

    def build_library(self) -> Path:
        """入れ子・巻ディレクトリ・裸のフォルダを含む、一通りの入力"""
        root = self.work_dir / "蔵書"
        inner = self.write_archive(self.work_dir / "素材" / "内_05.zip")
        self.write_archive(root / "raw_04.zip")
        zip_with(root / "分冊.zip", {**pages("第3巻/"), **pages("第7巻/")})
        zip_with(root / "外_00.zip", {"内_05.zip": inner.read_bytes()})
        self.write_bare_folder(root / "裸_12")
        return root

    def test_analysis_writes_nothing_to_disk(self):
        # Arrange - 一時領域を専用の読み取り専用フォルダに向ける。展開しようと
        # した時点で失敗するので、後片付けの上手い実装でもすり抜けられない
        root = self.build_library()
        temp_root = self.work_dir / "temp-root"
        temp_root.mkdir()
        temp_root.chmod(0o500)
        self.addCleanup(temp_root.chmod, 0o700)
        before = tree_snapshot(root)

        # Act
        with mock.patch.object(tempfile, "tempdir", str(temp_root)):
            books = self.analyze(root)

        # Assert - 解析はできている。0 冊で「何も書かなかった」では意味がない
        self.assertEqual(5, len(books), f"解析できていない: {self.named(books)}")

        # Assert - 入力フォルダにも一時領域にも何も増えていない
        self.assertEqual(before, tree_snapshot(root), "入力フォルダに展開物が出来た")
        self.assertEqual([], tree_snapshot(temp_root), "一時領域に展開物が出来た")

    def test_analysis_does_not_go_through_the_extraction_paths(self):
        # Arrange - 塞ぐ前の結果を控える。塞いだ結果と突き合わせるため
        root = self.build_library()
        baseline = self.analyze(root)
        self.assertTrue(baseline, "塞ぐ前の解析が空。比較にならない")

        def forbidden(*args, **kwargs):
            raise AssertionError("解析が展開を呼んだ。目次だけで済むはず")

        # Act - 展開の入口を塞ぐ。目次しか読まないなら結果は変わらない
        with (
            mock.patch.object(ArchiveHandler, "extract_archive", forbidden),
            mock.patch.object(ArchiveHandler, "process_archive", forbidden),
            mock.patch.object(zipfile.ZipFile, "extract", forbidden),
            mock.patch.object(zipfile.ZipFile, "extractall", forbidden),
            mock.patch.object(shutil, "unpack_archive", forbidden),
            mock.patch.object(tempfile, "mkdtemp", forbidden),
            mock.patch.object(tempfile, "TemporaryDirectory", forbidden),
        ):
            guarded = self.analyze(root)

        # Assert - 同じ本が同じ名前で並ぶ。例外を握り潰して減らす実装も弾く
        self.assertEqual(
            [(str(b.source), b.entry, b.output_name, b.volume) for b in baseline],
            [(str(b.source), b.entry, b.output_name, b.volume) for b in guarded],
            "展開を塞ぐと結果が変わる。目次だけで解析できていない",
        )


class TocAnalysisVolumeIssueTest(TocAnalysisTestBase):
    """巻数が読めない・読み違えているかもしれない本に、実行前の印が付くこと"""

    def test_marks_a_book_whose_volume_cannot_be_read(self):
        # Arrange - 名前に数字が無いものと、素直に読めるものを並べる
        root = self.work_dir / "巻数不明"
        nameless = self.write_archive(root / "おまけ.zip")
        readable = self.write_archive(root / "raw_04.zip")

        # Act
        books = self.analyze(root)

        # Assert - 巻数は None、名前は Unknown、印が付く
        unknown = self.only_book_of(books, nameless)
        self.assertIsNone(unknown.volume)
        self.assertEqual("[著者] 作品 Unknown.zip", unknown.output_name)
        self.assertIn(
            toc_analyzer.VOLUME_UNKNOWN,
            tuple(unknown.issues),
            f"巻数が読めないことが結果から分からない: {unknown.issues}",
        )

        # Assert - 読めたものには印が付かない。全部に印を付ける実装を弾く
        fine = self.only_book_of(books, readable)
        self.assertEqual(4, fine.volume)
        self.assertEqual((), tuple(fine.issues), f"要らない印が付く: {fine.issues}")

    def test_marks_a_book_whose_volume_may_have_been_misread(self):
        # Arrange - frieren_07_fix2.zip は名前の最後の数字（2）を巻数に採るため
        # 第002巻になる。実データで確認済みの現象。素直な frieren_07.zip も並べる
        root = self.work_dir / "誤読"
        ambiguous_path = self.write_archive(root / "frieren_07_fix2.zip")
        clean_path = self.write_archive(root / "frieren_07.zip")

        # Act
        books = self.analyze(root)

        # Assert - 誤読が起きるなら印が要る。将来 VolumeDetector が 7 と正しく
        # 読めるようになったら印は不要。どちらでも利用者は騙されない
        ambiguous = self.only_book_of(books, ambiguous_path)
        self.assertTrue(
            ambiguous.volume == 7
            or toc_analyzer.VOLUME_UNCERTAIN in tuple(ambiguous.issues),
            "frieren_07_fix2.zip の巻数が "
            f"{ambiguous.volume} なのに、誤読の可能性が伝わらない: {ambiguous.issues}",
        )

        # Assert - 表示名は巻数と揃っている。印だけ付けて別の名前を見せない
        expected = (
            f"[著者] 作品 第{ambiguous.volume:03d}巻.zip"
            if ambiguous.volume is not None
            else "[著者] 作品 Unknown.zip"
        )
        self.assertEqual(expected, ambiguous.output_name)

        # Assert - 紛れの無い名前には印を付けない。全件に印を付ける実装を弾く
        clean = self.only_book_of(books, clean_path)
        self.assertEqual(7, clean.volume)
        self.assertEqual((), tuple(clean.issues), f"要らない印が付く: {clean.issues}")


class TocAnalysisNoiseTest(TocAnalysisTestBase):
    """画像でないものが冊数に影響しないこと"""

    def test_ignores_metadata_dot_files_and_macosx_entries(self):
        # Arrange - ページのほかに ComicInfo.xml、__MACOSX/、ドットファイル、
        # そして画像が 1 枚も無いフォルダを混ぜる
        root = self.work_dir / "雑音"
        archive = zip_with(
            root / "book_08.zip",
            {
                **pages("第8巻/"),
                "第8巻/ComicInfo.xml": b"<ComicInfo/>",
                "第8巻/.DS_Store": b"junk",
                "__MACOSX/第8巻/._001.jpg": page(),
                "メタ/ComicInfo.xml": b"<ComicInfo/>",
            },
        )

        # Act
        books = self.analyze(root)

        # Assert - 1 冊のまま。__MACOSX やメタだけのフォルダを 1 冊に数えない
        self.assertEqual(
            1,
            len(books),
            f"画像以外を 1 冊として数えている: "
            f"{[(str(b.source), b.entry) for b in books]}",
        )
        self.assertEqual(archive, Path(books[0].source))
        self.assertEqual(8, books[0].volume)
        self.assertEqual("[著者] 作品 第008巻.zip", books[0].output_name)
        self.assertEqual((), tuple(books[0].issues))


class TocAnalysisFidelityTest(TocAnalysisTestBase):
    """解析が見せた名前と、実際に出来るファイル名が一致すること。

    ここが一番大事な検証。解析が嘘をつくと、利用者は実行前に見たものと違うものを
    受け取る。名前の組み立てを解析と実処理で別々に書くと、片方だけ直したときに
    食い違うため、同じ入力で両方を走らせて突き合わせる。
    """

    def test_planned_names_match_the_files_organizing_actually_creates(self):
        # Arrange - 名前がぶつかる形（Unknown が 2 つ、第007巻 が 2 つ）を必ず
        # 混ぜる。`_1` の付き方は目次だけでは決まらない部分で、食い違いやすい
        root = self.work_dir / "蔵書"
        inner_5 = self.write_archive(self.work_dir / "素材" / "内_05.zip")
        inner_9 = self.write_archive(self.work_dir / "素材" / "内_09.zip")
        self.write_archive(root / "raw_04.zip")
        zip_with(root / "分冊.zip", {**pages("第3巻/"), **pages("第7巻/")})
        self.write_archive(root / "frieren_07.zip")
        self.write_archive(root / "frieren_07_fix2.zip")
        self.write_archive(root / "おまけ.zip")
        self.write_archive(root / "別冊.zip")
        zip_with(
            root / "外_00.zip",
            {"内_05.zip": inner_5.read_bytes(), "内_09.zip": inner_9.read_bytes()},
        )
        zip_with(
            root / "book_08.zip",
            {**pages("第8巻/"), "__MACOSX/第8巻/._001.jpg": page()},
        )
        self.write_bare_folder(root / "裸_12")
        output = self.work_dir / "out"

        # Act - 実行前に解析し、そのあとで実際に整理する（利用者と同じ順番）
        planned = self.analyze(root)
        results = self.organize(root, output)

        # Assert - 実処理が失敗していない。0 冊同士で一致しても意味が無い
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "実処理が失敗した"
        )
        produced = [(r.original_path, r.output_path) for r in results if r.output_path]
        self.assertGreaterEqual(
            len(produced), 11, f"実処理の冊数が想定より少ない: {produced}"
        )
        for _, path in produced:
            self.assertTrue(path.is_file(), f"出来たはずのファイルが無い: {path}")

        # Assert - 名前がぶつかる場合を実際に通っている。通っていなければ
        # この検証は `_1` の食い違いを見張れていない
        produced_names = [path.name for _, path in produced]
        self.assertTrue(
            [name for name in produced_names if "_1" in name],
            f"同名がぶつかる形になっていない: {produced_names}",
        )

        # Assert - 出来上がる一覧が一致する
        self.assertEqual(
            sorted(produced_names),
            sorted(book.output_name for book in planned),
            "解析が見せる名前と、実際に出来るファイル名が違う",
        )

        # Assert - どのアーカイブから出来るかまで一致する。名前の集合だけ合って
        # いても、行と本の対応が入れ替わっていたら一覧として嘘になる
        self.assertEqual(
            self.by_source([(source, path.name) for source, path in produced]),
            self.by_source([(Path(book.source), book.output_name) for book in planned]),
            "どのアーカイブから何が出来るかが、解析と実処理で食い違う",
        )


if __name__ == "__main__":
    unittest.main()
