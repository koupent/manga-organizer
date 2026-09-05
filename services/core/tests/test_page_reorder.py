"""ZIP のページ並び替えが中身とメタ情報を壊さないことを検証する"""

import io
import os
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.page_reorder import (  # noqa: E402
    PageReorderError,
    ZipPageEditor,
)

PAGE_DATE_TIME = (2019, 5, 4, 12, 30, 0)
COMIC_INFO = b"<ComicInfo><Series>Test</Series></ComicInfo>"


def load_output_page():
    """manga_core.page_reorder.OutputPage を読み込む（#58）。

    実装が入るまでは ImportError で落ちる。モジュールの先頭で import すると
    このファイル全体が収集エラーになり、既存の検証（並び替えが何を拒むか）
    まで巻き添えで落ちる。緩和が並び替えの経路へ漏れていないことを
    確かめられなくなるので、要る所だけで読み込む。
    """
    from manga_core.page_reorder import OutputPage

    return OutputPage


def build_archive(path: Path, names, extra_entries=None) -> dict[str, bytes]:
    """テスト用 ZIP を作り、エントリ名から中身への対応表を返す"""
    payloads = {name: f"payload-{name}".encode() for name in names}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in payloads.items():
            info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
        for name, data in (extra_entries or {}).items():
            archive.writestr(zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME), data)
    return payloads


class ZipPageEditorTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"

    def test_lists_pages_in_natural_order(self):
        # Arrange
        build_archive(self.archive_path, ["p10.jpg", "p2.jpg", "p1.jpg"])

        # Act
        pages = ZipPageEditor(self.archive_path).pages

        # Assert
        self.assertEqual(["p1.jpg", "p2.jpg", "p10.jpg"], [p.name for p in pages])

    def test_applies_new_order_as_sequential_names(self):
        # Arrange
        payloads = build_archive(self.archive_path, ["a.jpg", "b.png", "c.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        result = editor.apply_order(["c.jpg", "a.jpg", "b.png"])

        # Assert
        self.assertTrue(result.changed)
        self.assertEqual(3, result.page_count)
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.png"], archive.namelist())
            self.assertEqual(payloads["c.jpg"], archive.read("001.jpg"))
            self.assertEqual(payloads["a.jpg"], archive.read("002.jpg"))
            self.assertEqual(payloads["b.png"], archive.read("003.png"))

    def test_preserves_entry_timestamps_and_compression(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            for info in archive.infolist():
                self.assertEqual(PAGE_DATE_TIME, info.date_time)
                self.assertEqual(zipfile.ZIP_DEFLATED, info.compress_type)

    def test_preserves_archive_file_modification_time(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        past = 1_000_000_000
        os.utime(self.archive_path, (past, past))
        editor = ZipPageEditor(self.archive_path)

        # Act
        result = editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        self.assertTrue(result.times_restored)
        self.assertEqual(past, int(self.archive_path.stat().st_mtime))

    def test_keeps_non_image_entries(self):
        # Arrange
        build_archive(
            self.archive_path,
            ["a.jpg", "b.jpg"],
            extra_entries={"ComicInfo.xml": COMIC_INFO},
        )
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(COMIC_INFO, archive.read("ComicInfo.xml"))
            self.assertEqual(
                ["ComicInfo.xml", "001.jpg", "002.jpg"], archive.namelist()
            )
            self.assertEqual(PAGE_DATE_TIME, archive.getinfo("ComicInfo.xml").date_time)

    def test_flattens_pages_stored_in_subdirectories(self):
        # Arrange
        payloads = build_archive(self.archive_path, ["vol/02.jpg", "vol/01.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["vol/02.jpg", "vol/01.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg"], archive.namelist())
            self.assertEqual(payloads["vol/02.jpg"], archive.read("001.jpg"))

    def test_uses_four_digits_when_page_count_exceeds_999(self):
        # Arrange
        names = [f"p{index}.jpg" for index in range(1, 1001)]
        build_archive(self.archive_path, names)
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order([page.name for page in editor.pages])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual("0001.jpg", archive.namelist()[0])
            self.assertEqual("1000.jpg", archive.namelist()[-1])

    def test_reports_no_change_when_order_already_sequential(self):
        # Arrange
        build_archive(self.archive_path, ["001.jpg", "002.jpg"])
        editor = ZipPageEditor(self.archive_path)
        before = self.archive_path.read_bytes()

        # Act
        result = editor.apply_order(["001.jpg", "002.jpg"])

        # Assert
        self.assertFalse(result.changed)
        self.assertEqual(before, self.archive_path.read_bytes())

    def test_rejects_order_that_does_not_match_page_list(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act / Assert
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg"])
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg", "a.jpg"])
        with self.assertRaises(PageReorderError):
            editor.apply_order(["a.jpg", "zzz.jpg"])

    def test_rejects_collision_with_non_image_entry(self):
        # Arrange
        build_archive(
            self.archive_path, ["a.jpg", "b.jpg"], extra_entries={"001.jpg.txt": b"x"}
        )
        build_archive(
            self.archive_path, ["a.jpg", "b.jpg"], extra_entries={"001.txt": b"x"}
        )
        editor = ZipPageEditor(self.archive_path)
        renamed = self.work_dir / "collide.zip"
        with zipfile.ZipFile(self.archive_path) as source:
            with zipfile.ZipFile(renamed, "w") as destination:
                for info in source.infolist():
                    name = "001.jpg" if info.filename == "001.txt" else info.filename
                    destination.writestr(name, source.read(info))
        editor = ZipPageEditor(renamed)

        # Act / Assert
        with self.assertRaises(PageReorderError):
            editor.apply_order(["b.jpg", "a.jpg"])

    def test_leaves_archive_untouched_when_write_fails(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)
        before = self.archive_path.read_bytes()

        def explode(current, total):
            raise OSError("disk full")

        # Act / Assert
        with self.assertRaises(OSError):
            editor.apply_order(["b.jpg", "a.jpg"], progress=explode)
        self.assertEqual(before, self.archive_path.read_bytes())
        self.assertEqual([], list(self.work_dir.glob("*.reorder-tmp")))

    def test_rejects_unsupported_archive_format(self):
        # Arrange
        rar_path = self.work_dir / "volume.rar"
        rar_path.write_bytes(b"not a zip")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(rar_path)

    def test_rejects_archive_without_images(self):
        # Arrange
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("readme.txt", b"hello")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(self.archive_path)


class ArchiveIntegrityTest(unittest.TestCase):
    """壊れたら戻らないデータを守るための検証"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"

    def test_rejects_archive_with_duplicate_image_names(self):
        # Arrange - ZIP 形式は同名エントリを許すが、
        # 名前でページを指す API では区別できない
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("a.jpg", b"first")
            archive.writestr("a.jpg", b"second")

        # Act / Assert
        with self.assertRaises(PageReorderError):
            ZipPageEditor(self.archive_path)

    def test_preserves_extra_fields_of_entries(self):
        # Arrange - Info-ZIP の UT フィールド（高精度タイムスタンプ）
        unix_time_extra = b"\x55\x54\x05\x00\x01\x40\xe2\x01\x00"
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            for name in ("b.jpg", "a.jpg"):
                info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
                info.extra = unix_time_extra
                archive.writestr(info, b"payload")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            for info in archive.infolist():
                self.assertIn(b"\x55\x54", info.extra)

    def test_keeps_directory_entries_used_by_retained_files(self):
        # Arrange
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            archive.writestr("meta/", b"")
            archive.writestr("meta/ComicInfo.xml", COMIC_INFO)
            archive.writestr("pages/", b"")
            archive.writestr("pages/b.jpg", b"second")
            archive.writestr("pages/a.jpg", b"first")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["pages/b.jpg", "pages/a.jpg"])

        # Assert - 非画像が残る meta/ は保持、画像が抜けた pages/ は残さない
        with zipfile.ZipFile(self.archive_path) as archive:
            names = archive.namelist()
        self.assertIn("meta/", names)
        self.assertIn("meta/ComicInfo.xml", names)
        self.assertNotIn("pages/", names)
        images = [n for n in names if n.endswith(".jpg")]
        self.assertEqual(["001.jpg", "002.jpg"], images)

    def test_detects_corrupted_member_data_before_replacing(self):
        # Arrange - 書き出した ZIP の中身が壊れていたら、元を捨てる前に気づく
        with zipfile.ZipFile(self.archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("a.jpg", "b.jpg"):
                info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, bytes(range(256)) * 40)
        editor = ZipPageEditor(self.archive_path)
        before = self.archive_path.read_bytes()
        original_verify = editor._verify_written

        def corrupt_then_verify(temp_path, ordered, renames):
            with zipfile.ZipFile(temp_path) as written:
                first = written.infolist()[0]
            data = bytearray(temp_path.read_bytes())
            # ローカルヘッダ(30 バイト + 名前 + extra)の直後が圧縮データ
            offset = first.header_offset + 30 + len(first.filename) + 64
            data[offset] ^= 0xFF
            temp_path.write_bytes(bytes(data))
            return original_verify(temp_path, ordered, renames)

        editor._verify_written = corrupt_then_verify

        # Act / Assert - 壊れた ZIP で元を置き換えない
        with self.assertRaises(PageReorderError):
            editor.apply_order(["b.jpg", "a.jpg"])
        self.assertEqual(before, self.archive_path.read_bytes())

    def test_does_not_leave_temporary_files_behind(self):
        # Arrange
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        leftovers = [p.name for p in self.work_dir.iterdir() if p.name != "volume.zip"]
        self.assertEqual([], leftovers)

    def test_does_not_truncate_a_pre_existing_file_at_the_temp_path(self):
        # Arrange - 固定名の一時ファイルを使うと既存ファイルを壊しうる
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        squatter = self.work_dir / "volume.zip.reorder-tmp"
        squatter.write_bytes(b"important")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert
        self.assertEqual(b"important", squatter.read_bytes())


class ViewerContractTest(unittest.TestCase):
    """出力が suzume-viewer の解釈と一致することを検証する"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"

    def test_excludes_macos_metadata_from_pages(self):
        # Arrange - AppleDouble は拡張子が .jpg でも画像ではない
        build_archive(self.archive_path, ["001.jpg", "002.jpg"])
        with zipfile.ZipFile(self.archive_path, "a") as archive:
            archive.writestr("__MACOSX/._001.jpg", b"\x00\x05\x16\x07")
            archive.writestr(".DS_Store", b"junk")
        editor = ZipPageEditor(self.archive_path)

        # Act / Assert
        self.assertEqual(["001.jpg", "002.jpg"], [p.name for p in editor.pages])

    def test_keeps_excluded_entries_without_renaming_them(self):
        # Arrange
        build_archive(self.archive_path, ["b.jpg", "a.jpg"])
        with zipfile.ZipFile(self.archive_path, "a") as archive:
            archive.writestr("__MACOSX/._a.jpg", b"\x00\x05\x16\x07")
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["b.jpg", "a.jpg"])

        # Assert - 連番に組み込まれず、そのまま残る
        with zipfile.ZipFile(self.archive_path) as archive:
            names = archive.namelist()
        self.assertIn("__MACOSX/._a.jpg", names)
        pages = sorted(n for n in names if "/" not in n)
        self.assertEqual(["001.jpg", "002.jpg"], pages)

    def test_output_order_matches_lexicographic_sort(self):
        # Arrange - viewer は辞書順で並べる
        names = [f"p{i}.jpg" for i in range(1, 1002)]
        build_archive(self.archive_path, names)
        editor = ZipPageEditor(self.archive_path)
        ordered = [f"p{i}.jpg" for i in range(1, 1002)]

        # Act
        editor.apply_order(ordered)

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            written = archive.namelist()
        self.assertEqual(written, sorted(written))
        self.assertEqual("0001.jpg", written[0])
        self.assertEqual("1001.jpg", written[-1])

    def test_converts_bmp_pages_to_png(self):
        # Arrange
        with zipfile.ZipFile(self.archive_path, "w") as archive:
            for name in ("b.bmp", "a.jpg"):
                buffer = io.BytesIO()
                fmt = "BMP" if name.endswith(".bmp") else "JPEG"
                Image.new("RGB", (40, 60), "navy").save(buffer, fmt)
                archive.writestr(name, buffer.getvalue())
        editor = ZipPageEditor(self.archive_path)

        # Act
        editor.apply_order(["a.jpg", "b.bmp"])

        # Assert - viewer の対応形式だけになる
        with zipfile.ZipFile(self.archive_path) as archive:
            names = archive.namelist()
            self.assertEqual(["001.jpg", "002.png"], names)
            with Image.open(io.BytesIO(archive.read("002.png"))) as converted:
                self.assertEqual("PNG", converted.format)
                self.assertEqual((40, 60), converted.size)


class ApplyPagesTest(unittest.TestCase):
    """出力ページの列を受け取る入口を検証する（#58）。

    apply_order は「並べ替え」なので、ページ数もページの集合も変わらない。
    見開きの分割は 1 枚から 2 枚を出し、割る前へ戻すと 2 枚が 1 枚に減る。
    そこで apply_pages という別の単位の入口を足す。apply_order を緩めるのでは
    なく、緩い側を別に置くのが要点。緩めてしまうと、ページ修正画面から来た
    ただの並べ替えでも、名前を 1 つ書き間違えただけでページが消える。

    緩めた分だけ、別の検証を置く。

    - すべての source が、いま存在するページであること
    - いま存在するページはすべて、どれかの source になるか dropped にあること
    - 同じ source を 2 回以上使えるのは、その出力すべてが content を持つときだけ
    - dropped と source が重ならないこと
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"
        self.payloads = build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        self.OutputPage = load_output_page()
        self.editor = ZipPageEditor(self.archive_path)
        self.addCleanup(self.editor.close)

    def page_names(self) -> list[str]:
        with zipfile.ZipFile(self.archive_path) as archive:
            return archive.namelist()

    def test_rejects_an_unknown_source_and_accepts_a_known_one(self):
        # Act / Assert - 無い名前を source にすると断る。黙って読み飛ばすと、
        # 名前を書き間違えただけでそのページが本から消える
        with self.assertRaises(PageReorderError):
            self.editor.apply_pages(
                [
                    self.OutputPage("a.jpg", None),
                    self.OutputPage("b.jpg", None),
                    self.OutputPage("zzz.jpg", None),
                ]
            )

        # Act / Assert - 同じ形で名前だけ正しいものは通る。無条件に投げる
        # 検査は、ここで落ちる
        self.editor.apply_pages(
            [self.OutputPage("a.jpg", None), self.OutputPage("b.jpg", None)]
        )
        self.assertEqual(["001.jpg", "002.jpg"], self.page_names())

    def test_a_source_used_twice_must_supply_content_for_every_output(self):
        # Arrange - 1 枚から 2 枚を出すのは分割だけ。どちらの出力も切った後の
        # 中身を持つ。content が無い出力が混ざるのは、同じページをそのまま
        # 2 箇所へ複製する形で、本の中に同じ絵が二重に並ぶ
        right, left = b"right-half", b"left-half"

        # Act / Assert - 違いは 2 つ目の content だけ。ほかの規則には
        # 触れていないので、この規則が無ければ通ってしまう
        with self.assertRaises(PageReorderError):
            self.editor.apply_pages(
                [
                    self.OutputPage("a.jpg", right),
                    self.OutputPage("a.jpg", None),
                    self.OutputPage("b.jpg", None),
                ]
            )

        # Act
        self.editor.apply_pages(
            [
                self.OutputPage("a.jpg", right),
                self.OutputPage("a.jpg", left),
                self.OutputPage("b.jpg", None),
            ]
        )

        # Assert
        self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], self.page_names())
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(right, archive.read("001.jpg"))
            self.assertEqual(left, archive.read("002.jpg"))
            self.assertEqual(self.payloads["b.jpg"], archive.read("003.jpg"))

    def test_refuses_to_drop_a_page_that_was_not_named(self):
        # Act / Assert - 出力に出てこないページは、消したいのか書き忘れたのか
        # 区別が付かない。黙って落とすと、行を 1 つ組み立て損ねただけで
        # ページが失われる
        with self.assertRaises(PageReorderError):
            self.editor.apply_pages([self.OutputPage("a.jpg", None)])

        # Act - 同じ出力でも、落とすと名指しすれば通る
        self.editor.apply_pages([self.OutputPage("a.jpg", None)], dropped=("b.jpg",))

        # Assert
        self.assertEqual(["001.jpg"], self.page_names())
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(self.payloads["a.jpg"], archive.read("001.jpg"))

    def test_refuses_a_page_that_is_both_dropped_and_used(self):
        # Act / Assert - 落とすと言いながら出力にも使うのは、呼び出し側の
        # 取り違え。どちらかを黙って優先すると、消えるはずのページが残るか、
        # 残るはずのページが消える
        with self.assertRaises(PageReorderError):
            self.editor.apply_pages(
                [self.OutputPage("a.jpg", None), self.OutputPage("b.jpg", None)],
                dropped=("b.jpg",),
            )


class ReplacementIntegrityTest(unittest.TestCase):
    """差し替えたページが、渡したとおりの中身で書けているか（#58）。

    大きさだけを突き合わせると、同じ長さの別の絵が書かれても通る。差し替えは
    元の画素を捨てる操作なので、通った時点で利用者は「加工した」つもりのまま
    別の絵を掴み、元は戻らない。ZIP の中央ディレクトリには各エントリの CRC-32
    が既に入っているので、中身を読み直さずに突き合わせられる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"
        build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        self.editor = ZipPageEditor(self.archive_path)
        self.addCleanup(self.editor.close)

    def writer_that_emits(self, editor, name, body):
        """差し替えの中身だけを body に取り替えて書かせる細工。

        検証側には呼び出し元が渡した本来の中身がそのまま届くので、
        「書かれたもの」と「期待するもの」が食い違う状況を、ほかは
        何も変えずに作れる。
        """
        original_write = editor._write_reordered

        def write(
            temp_path,
            ordered,
            renames,
            progress=None,
            replacements=None,
            extras=None,
        ):
            swapped = dict(replacements or {})
            swapped[name] = body
            return original_write(
                temp_path, ordered, renames, progress, swapped, extras
            )

        return write

    def test_accepts_a_replacement_that_was_written_as_asked(self):
        # Arrange - 細工そのものが書き込みを壊していないことの対照。これが
        # 無いと、次のテストは「細工のせいで別の検証が落ちた」だけでも通る
        intended = b"A" * 512
        self.editor._write_reordered = self.writer_that_emits(
            self.editor, "a.jpg", intended
        )

        # Act
        self.editor.apply_order(["a.jpg", "b.jpg"], replacements={"a.jpg": intended})

        # Assert
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(intended, archive.read("001.jpg"))

    def test_rejects_a_replacement_of_the_same_size_but_different_content(self):
        # Arrange - 長さは同じで中身が違う。大きさだけの照合はここを見逃す
        intended = b"A" * 512
        decoy = b"B" * 512
        self.assertEqual(len(intended), len(decoy))
        before = self.archive_path.read_bytes()
        self.editor._write_reordered = self.writer_that_emits(
            self.editor, "a.jpg", decoy
        )

        # Act / Assert - 元を捨てる前に気づいて断る
        with self.assertRaises(PageReorderError):
            self.editor.apply_order(
                ["a.jpg", "b.jpg"], replacements={"a.jpg": intended}
            )
        self.assertEqual(before, self.archive_path.read_bytes())


class CarriedPageIntegrityTest(unittest.TestCase):
    """中身を指定せず運ぶだけのページが、本当にそのページの中身で書けているか。

    _verify_written が見るのは、書き上がった ZIP のページ名の集合と、
    CRC としての整合だけ。「どの名前にどのページの中身が入ったか」は見ていない。
    _verify_replacements は content を渡した出力にしか効かない。

    落として連番を振り直す書き直しで、落とすはずのページの中身が残るページの
    名前に入っても、名前・整合・差し替え・余りの検査は全部通る。その後の
    os.replace で元のアーカイブは消え、取り返しがつかない。

    利用者から見ると、消したはずのページが別の番号で残り、残るはずのページが
    消える。ページ数も名前も期待どおりなので、開いて眺めるまで気づけない。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"
        self.OutputPage = load_output_page()

    def writer_that_reroutes(self, editor, mapping):
        """書き込む位置ごとに、中身の出どころだけを付け替える細工。

        検証側には呼び出し元が組み立てた出力がそのまま届くので、「書かれた
        中身」と「約束した中身」だけが食い違う状況を、名前も枚数も変えずに
        作れる。mapping が空なら何も付け替えない（細工の器そのものの対照）。
        """
        original_write = editor._write_reordered

        def write(
            temp_path,
            outputs,
            names,
            progress=None,
            replacements=None,
            extras=None,
        ):
            rerouted = tuple(
                self.OutputPage(
                    mapping.get(output.source, output.source), output.content
                )
                for output in outputs
            )
            return original_write(
                temp_path, rerouted, names, progress, replacements, extras
            )

        return write

    def test_detects_a_dropped_pages_bytes_written_under_a_retained_name(self):
        # Arrange - 対照。細工の器そのものは書き込みを壊さない。何も付け替え
        # なければ、落として連番を振り直す書き直しは通り、中身も期待どおり。
        # これが無いと、次の Assert は「細工のせいで別の検査が落ちた」だけでも
        # 通ってしまう
        payloads = build_archive(self.archive_path, ["a.jpg", "b.jpg", "c.jpg"])
        editor = ZipPageEditor(self.archive_path)
        self.addCleanup(editor.close)
        editor._write_reordered = self.writer_that_reroutes(editor, {})
        editor.apply_pages(
            [self.OutputPage("a.jpg", None), self.OutputPage("c.jpg", None)],
            dropped=("b.jpg",),
        )
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(["001.jpg", "002.jpg"], archive.namelist())
            self.assertEqual(payloads["c.jpg"], archive.read("002.jpg"))

        # Arrange - 同じ書き直しを、2 枚目だけ「落とすはずのページ」の中身に
        # すり替えて書かせる。長さは同じなので、大きさの照合では見抜けない
        other = self.work_dir / "other.zip"
        build_archive(other, ["a.jpg", "b.jpg", "c.jpg"])
        self.assertEqual(len(payloads["b.jpg"]), len(payloads["c.jpg"]))
        before = other.read_bytes()
        faulty = ZipPageEditor(other)
        self.addCleanup(faulty.close)
        faulty._write_reordered = self.writer_that_reroutes(faulty, {"c.jpg": "b.jpg"})

        # Act / Assert - 元を捨てる前に気づいて断る
        with self.assertRaises(PageReorderError):
            faulty.apply_pages(
                [self.OutputPage("a.jpg", None), self.OutputPage("c.jpg", None)],
                dropped=("b.jpg",),
            )
        self.assertEqual(before, other.read_bytes())

    def test_detects_two_carried_pages_whose_bytes_were_swapped(self):
        # Arrange - 対照。付け替えない細工なら並べ替えは通り、中身も期待どおり
        payloads = build_archive(self.archive_path, ["a.jpg", "b.jpg"])
        editor = ZipPageEditor(self.archive_path)
        self.addCleanup(editor.close)
        editor._write_reordered = self.writer_that_reroutes(editor, {})
        editor.apply_order(["b.jpg", "a.jpg"])
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertEqual(payloads["b.jpg"], archive.read("001.jpg"))

        # Arrange - 2 枚の中身だけを入れ替えて書かせる。名前も枚数も注文どおり
        # なので、名前の集合と整合の検査は全部通る。長さも同じ
        other = self.work_dir / "other.zip"
        build_archive(other, ["a.jpg", "b.jpg"])
        self.assertEqual(len(payloads["a.jpg"]), len(payloads["b.jpg"]))
        before = other.read_bytes()
        faulty = ZipPageEditor(other)
        self.addCleanup(faulty.close)
        faulty._write_reordered = self.writer_that_reroutes(
            faulty, {"a.jpg": "b.jpg", "b.jpg": "a.jpg"}
        )

        # Act / Assert - 利用者が指定した並びと逆の本ができあがる。
        # ページ数も名前も合っているので、断らなければ誰も気づかない
        with self.assertRaises(PageReorderError):
            faulty.apply_order(["a.jpg", "b.jpg"])
        self.assertEqual(before, other.read_bytes())


if __name__ == "__main__":
    unittest.main()
