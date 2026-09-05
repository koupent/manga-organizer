"""加工前の元画像を ZIP の中に残す仕組みを検証する（#66）。

サムネイル作成で切り抜くと元の画素が失われ、範囲を広げる方向に戻せない。
加工前の画像を ZIP に同梱し、加工後の画像の「中身」から引けるようにする。

    .manga-organizer/
      originals/
        <content hash>.jpg   加工前の画像そのもの
      manifest.json          加工後のハッシュ -> 元 + 施した加工

名前ではなく中身のハッシュで紐づけるのが要点。サムネイル作成もページ並べ替えも
整理もエントリ名を変えるが、画像の中身は変えない。名前で紐づけると連番の
振り直しで即座に切れる。


公開契約（このテストが前提とする形。実装はこれに合わせる）
------------------------------------------------------------------
manga_core.original_store

    ORIGINALS_PREFIX: str
        ".manga-organizer/originals/"。元画像を置く場所
    MANIFEST_ENTRY: str
        ".manga-organizer/manifest.json"。紐づけの記録

    content_hash(data: bytes) -> str
        画像の中身そのものの SHA-256（16 進小文字）。名前は一切混ぜない。
        画面側（TypeScript / Rust）も同じ値を出せる必要があるため、
        アルゴリズムまで契約に含める

    元画像のエントリ名
        ORIGINALS_PREFIX + content_hash(元画像) + 元の拡張子（小文字）

    @dataclass(frozen=True) Operation
        kind: str
            "crop" | "rotate"（#58 の見開き分割で "split" が加わる）
        params: Mapping[str, object]
            crop   -> {"box": [left, upper, right, lower]}
            rotate -> {"degrees": int}

    @dataclass(frozen=True) OriginalRef
        hash: str
            元画像の content_hash
        entry: str
            ZIP 内のエントリ名（ORIGINALS_PREFIX 配下）
        operations: tuple[Operation, ...]
            元画像から、問い合わせた画像に至るまでに施した加工を適用順に並べたもの。
            2 回加工した画像なら 2 つ入る。切り抜きを広げる方向へ戻すとき、
            画面はこれを見て前回の枠を復元する

    find_original(archive_path: Path, image: bytes) -> OriginalRef | None
        加工後の画像の中身から、遡れる限り遡った「本当の元画像」を返す。
        記録がなければ None

    read_original(archive_path: Path, ref: OriginalRef) -> bytes
        元画像そのもののバイト列

manga_core.cover_editor.apply_to_archive
    加工を確定するとき、加工前の画像を ORIGINALS_PREFIX 配下へ保存し、
    manifest に「加工後のハッシュ -> 元 + 施した加工」を書き足す。
    元画像は 1 枚ごとに残して上書きしない。中身が同じものは 1 つにまとまる

manga_core.viewer_contract
    パスのどの要素がドットで始まっていても、ページから除外する。
    直さないと元画像がページ扱いされ、並べ替えで 001.jpg へ改名されて失われる


将来の共有（#58 見開きページの分割）
------------------------------------------------------------------
manifest は「加工後 -> 元 + 施した加工」を持つ。1 つの元から複数の加工後が出る
形（分割は 2 枚）も、加工後のハッシュを鍵にすれば、複数の記録が同じ元を指すだけ
で表せる。加工の種類は Operation.kind を増やせば足りる。
"""

import hashlib
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.cover_editor import CoverTransform, apply_to_archive  # noqa: E402
from manga_core.page_reorder import ZipPageEditor, is_image_name  # noqa: E402
from manga_core.viewer_contract import (  # noqa: E402
    is_page_source,
    is_viewer_page,
    needs_conversion,
    sequential_name,
)


def load_store():
    """manga_core.original_store を読み込む。

    実装が入るまでは ModuleNotFoundError で落ちる。モジュール先頭で import すると
    viewer_contract だけを見るテスト（ドット配下の除外）まで巻き添えで落ち、
    どちらが原因なのか分からなくなるため、必要とするテストの中だけで読み込む。
    """
    import manga_core.original_store as module

    return module


# ページごとに違う色を塗り、加工や並べ替えの後も中身で見分けられるようにする。
# 連番でない名前にして、振り直しが起きたかどうかも見えるようにする
PAGES = (
    ("page-1.jpg", "red"),
    ("page-2.jpg", "lime"),
    ("page-3.jpg", "blue"),
    ("page-4.jpg", "yellow"),
)
PAGE_SIZE = (800, 1200)
# 加工後（400x600）と元（800x1200）が寸法で見分けられる切り抜き
CROP = (100, 150, 500, 750)


def page_bytes(color: str, size: tuple[int, int] = PAGE_SIZE) -> bytes:
    """テスト用のページ画像。色ごとにバイト列が変わる"""
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


def build_archive(path: Path, entries: tuple[tuple[str, bytes], ...]) -> Path:
    """指定した中身で ZIP を作る"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("ComicInfo.xml", b"<ComicInfo/>")
        for name, data in entries:
            archive.writestr(name, data)
    return path


def entry_names(archive_path: Path) -> list[str]:
    """ZIP に入っている全エントリ名"""
    with zipfile.ZipFile(archive_path) as archive:
        return archive.namelist()


def read_entry(archive_path: Path, name: str) -> bytes:
    """エントリ 1 つ分の生バイト列"""
    with zipfile.ZipFile(archive_path) as archive:
        return archive.read(name)


def viewer_page_names(archive_path: Path) -> list[str]:
    """viewer がページとして読むエントリ名を、viewer と同じ辞書順で返す"""
    return sorted(name for name in entry_names(archive_path) if is_viewer_page(name))


def page_with_content(archive_path: Path, data: bytes) -> str | None:
    """同じ中身を持つページのエントリ名。名前が変わっても絵を追える"""
    with zipfile.ZipFile(archive_path) as archive:
        for name in sorted(archive.namelist()):
            if is_viewer_page(name) and archive.read(name) == data:
                return name
    return None


def stored_originals(archive_path: Path) -> list[str]:
    """元画像として保存されたエントリ名"""
    prefix = load_store().ORIGINALS_PREFIX
    with zipfile.ZipFile(archive_path) as archive:
        return sorted(name for name in archive.namelist() if name.startswith(prefix))


def image_size(data: bytes) -> tuple[int, int]:
    """画像の寸法"""
    with Image.open(io.BytesIO(data)) as image:
        return image.size


class DotPathExclusionTest(unittest.TestCase):
    """パスのどの要素がドットで始まっていても、ページとして扱わない。

    ベース名しか見ない現在の実装では `.manga-organizer/originals/a3f2.jpg` が
    ページになる。表示がずれるだけでは済まず、ページ並べ替えで `001.jpg` へ
    改名され、隠しておいた元画像が本文に混ざったうえ失われる。
    """

    HIDDEN = (
        ".manga-organizer/originals/a3f2.jpg",
        "book/.cache/001.jpg",
        ".a/b/c.jpg",
        "book/.thumbnails/sub/002.png",
        ".DS_Store",
        "pages/._001.jpg",
    )

    VISIBLE = (
        "001.jpg",
        "book/001.jpg",
        "volume01/002.png",
        # 途中にドットがあるだけのフォルダは隠しフォルダではない
        "book/v.1/003.jpg",
    )

    def test_excludes_images_under_a_dot_folder(self):
        for name in self.HIDDEN:
            with self.subTest(name=name):
                self.assertFalse(is_viewer_page(name), "viewer がページとして描く")
                self.assertFalse(is_page_source(name), "書き換えの対象になる")

    def test_keeps_images_that_are_not_hidden(self):
        for name in self.VISIBLE:
            with self.subTest(name=name):
                self.assertTrue(is_viewer_page(name))
                self.assertTrue(is_page_source(name))

    def test_does_not_convert_an_unreadable_format_under_a_dot_folder(self):
        # 変換すると拡張子まで変わり、保存した元画像が元画像でなくなる
        hidden_bmp = ".manga-organizer/originals/a3f2.bmp"
        self.assertFalse(needs_conversion(hidden_bmp))
        self.assertFalse(is_page_source(hidden_bmp))
        self.assertTrue(needs_conversion("book/001.bmp"), "本文の BMP は変換する")

    def test_page_reorder_agrees_with_the_viewer_contract(self):
        # 連番の振り直しは is_image_name で対象を決める。ここがずれると改名される
        for name in self.HIDDEN:
            with self.subTest(name=name):
                self.assertFalse(is_image_name(name))
        for name in self.VISIBLE:
            with self.subTest(name=name):
                self.assertTrue(is_image_name(name))


class ContentHashTest(unittest.TestCase):
    """紐づけの鍵。画面側も同じ値を出せる必要がある"""

    def test_is_the_sha256_of_the_bytes(self):
        # Arrange
        data = page_bytes("red")

        # Act / Assert
        self.assertEqual(
            hashlib.sha256(data).hexdigest(), load_store().content_hash(data)
        )

    def test_differs_for_different_images(self):
        store = load_store()
        self.assertNotEqual(
            store.content_hash(page_bytes("red")),
            store.content_hash(page_bytes("lime")),
        )


class ArchiveFixture(unittest.TestCase):
    """4 ページのアーカイブを 1 つ用意する"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive = build_archive(
            self.work_dir / "volume.zip",
            tuple((name, page_bytes(color)) for name, color in PAGES),
        )

    def reorder(self, ordered: list[str]) -> None:
        """ページ並べ替えを実行する。エントリ名が連番へ振り直される"""
        editor = ZipPageEditor(self.archive)
        try:
            editor.apply_order(tuple(ordered))
        finally:
            editor.close()

    def page_names(self) -> list[str]:
        editor = ZipPageEditor(self.archive)
        try:
            return [page.name for page in editor.pages]
        finally:
            editor.close()


class StoresOriginalTest(ArchiveFixture):
    """加工を確定すると、加工前の画像が ZIP の中に残る"""

    def test_stores_the_pre_edit_image_when_a_crop_is_confirmed(self):
        # Arrange
        store = load_store()
        before = read_entry(self.archive, "page-3.jpg")

        # Act
        apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )

        # Assert - 加工前のバイト列がそのまま残る。
        # 寸法だけを見ると、再エンコードで劣化した画像を保存していても気づけない
        stored = stored_originals(self.archive)
        self.assertEqual(
            1, len(stored), f"元画像が保存されていない: {entry_names(self.archive)}"
        )
        saved = read_entry(self.archive, stored[0])
        self.assertEqual(before, saved, "保存された元画像が加工前の中身と違う")
        self.assertEqual(PAGE_SIZE, image_size(saved), "加工後の画像を保存している")

        # 名前は中身のハッシュで決まる
        self.assertEqual(
            f"{store.ORIGINALS_PREFIX}{store.content_hash(before)}.jpg", stored[0]
        )

    def test_writes_the_manifest_as_readable_json(self):
        # Arrange - 画面側や別のツールが読む。壊れた形で書かない
        store = load_store()

        # Act
        apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )

        # Assert
        self.assertIn(store.MANIFEST_ENTRY, entry_names(self.archive))
        document = json.loads(read_entry(self.archive, store.MANIFEST_ENTRY).decode())
        self.assertIsInstance(document, dict)
        self.assertIn("version", document, "形式が変わったときに見分けられない")

    def test_the_stored_original_is_not_counted_as_a_page(self):
        # Arrange
        store = load_store()
        expected = [
            sequential_name(position, len(PAGES), ".jpg")
            for position in range(1, len(PAGES) + 1)
        ]

        # Act
        apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )

        # Assert - ページ数は増えず、連番にも割り込まない
        self.assertEqual(
            expected, viewer_page_names(self.archive), "元画像がページに混ざっている"
        )
        self.assertEqual(len(PAGES), len(self.page_names()))
        self.assertEqual(
            [],
            [
                name
                for name in self.page_names()
                if name.startswith(store.ORIGINALS_PREFIX)
            ],
        )

    def test_reordering_does_not_renumber_the_stored_original(self):
        # Arrange
        before = read_entry(self.archive, "page-3.jpg")
        apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )
        stored = stored_originals(self.archive)

        # Act - 並べ替えは全ページの名前を振り直す
        self.reorder(list(reversed(self.page_names())))

        # Assert - 元画像は改名も欠落もしない
        self.assertEqual(stored, stored_originals(self.archive), "元画像が改名された")
        self.assertEqual(before, read_entry(self.archive, stored[0]))
        self.assertEqual(len(PAGES), len(viewer_page_names(self.archive)))


class FindOriginalTest(ArchiveFixture):
    """加工後の画像の中身から元画像を引く"""

    def test_finds_the_original_from_the_edited_image(self):
        # Arrange
        store = load_store()
        before = read_entry(self.archive, "page-3.jpg")

        # Act
        result = apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )
        edited = read_entry(self.archive, result.name)
        ref = store.find_original(self.archive, edited)

        # Assert
        self.assertIsNotNone(ref, "加工後の画像から元画像を引けない")
        self.assertEqual(store.content_hash(before), ref.hash)
        self.assertEqual(stored_originals(self.archive)[0], ref.entry)

        restored = store.read_original(self.archive, ref)
        self.assertEqual(before, restored)
        self.assertEqual(
            PAGE_SIZE, image_size(restored), "切り抜く前の画素まで戻れていない"
        )

        # 前回の切り抜き枠が残っていないと、広げる方向へ戻す操作を組み立てられない
        self.assertEqual(["crop"], [op.kind for op in ref.operations])
        self.assertEqual(CROP, tuple(ref.operations[0].params["box"]))

    def test_returns_none_when_nothing_was_edited(self):
        store = load_store()
        untouched = read_entry(self.archive, "page-1.jpg")
        self.assertIsNone(store.find_original(self.archive, untouched))

    def test_returns_none_for_a_page_that_was_never_edited(self):
        # Arrange
        store = load_store()
        untouched = read_entry(self.archive, "page-1.jpg")

        # Act - 別のページだけ加工する
        apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )

        # Assert - 加工していないページに元画像はない
        self.assertIsNotNone(page_with_content(self.archive, untouched))
        self.assertIsNone(store.find_original(self.archive, untouched))

    def test_keeps_the_first_original_when_another_page_is_edited(self):
        # Arrange - 役割（表紙の元画像）で名付けると、ここで上書きされて消える
        store = load_store()
        first_before = read_entry(self.archive, "page-3.jpg")
        second_before = read_entry(self.archive, "page-4.jpg")

        # Act - 1 回目
        first = apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )
        first_edited = read_entry(self.archive, first.name)

        # Act - 2 回目は別の画像。連番が振り直されているので中身で選び直す
        second_name = page_with_content(self.archive, second_before)
        self.assertIsNotNone(second_name, "2 回目の対象が並べ替えで見失われた")
        apply_to_archive(
            self.archive,
            second_name,
            CoverTransform(crop=(0, 0, 400, 600)),
            make_first=True,
        )

        # Assert - 1 枚ごとに残り、上書きされない
        saved = {
            read_entry(self.archive, name) for name in stored_originals(self.archive)
        }
        self.assertIn(first_before, saved, "1 回目の元画像が 2 回目の加工で消えた")
        self.assertIn(second_before, saved, "2 回目の元画像が保存されていない")
        self.assertEqual(2, len(saved))

        ref = store.find_original(self.archive, first_edited)
        self.assertIsNotNone(ref, "1 回目の加工結果から元画像を引けなくなった")
        self.assertEqual(first_before, store.read_original(self.archive, ref))

    def test_the_link_survives_a_page_rename(self):
        # Arrange - 名前で紐づける実装をここで弾く
        store = load_store()
        before = read_entry(self.archive, "page-3.jpg")
        result = apply_to_archive(
            self.archive, "page-3.jpg", CoverTransform(crop=CROP), make_first=True
        )
        edited = read_entry(self.archive, result.name)

        # Act - 加工した 1 枚を 3 番目へ動かす。全ページの名前が変わる
        names = self.page_names()
        self.reorder(names[1:3] + [names[0]] + names[3:])

        # Assert
        moved = page_with_content(self.archive, edited)
        self.assertIsNotNone(moved, "加工した 1 枚が並べ替えで失われた")
        self.assertNotEqual(
            result.name, moved, "名前が変わっておらず、この検証が意味をなさない"
        )

        ref = store.find_original(self.archive, edited)
        self.assertIsNotNone(ref, "名前で紐づけているため、改名で切れた")
        self.assertEqual(store.content_hash(before), ref.hash)
        self.assertEqual(before, store.read_original(self.archive, ref))

    def test_traces_back_to_the_true_original_after_two_edits(self):
        # Arrange
        store = load_store()
        root = read_entry(self.archive, "page-3.jpg")

        # Act - 1 回目
        first = apply_to_archive(
            self.archive,
            "page-3.jpg",
            CoverTransform(crop=(100, 100, 700, 1100)),
            make_first=True,
        )
        first_edited = read_entry(self.archive, first.name)

        # Act - 2 回目。この「元」は 1 回目の加工結果になる
        second = apply_to_archive(
            self.archive,
            first.name,
            CoverTransform(crop=(50, 50, 400, 700)),
            make_first=True,
        )
        second_edited = read_entry(self.archive, second.name)

        # Assert - 辿った先は 1 回目の加工結果ではなく、最初の元画像
        self.assertNotEqual(root, first_edited)
        ref = store.find_original(self.archive, second_edited)
        self.assertIsNotNone(ref)
        self.assertEqual(
            store.content_hash(root),
            ref.hash,
            "2 回目の元（1 回目の加工結果）で止まっている",
        )
        restored = store.read_original(self.archive, ref)
        self.assertEqual(root, restored)
        self.assertEqual(PAGE_SIZE, image_size(restored), "元の画素まで遡れていない")

        # 施した加工が順に残る。広げる方向へ戻すときに必要
        self.assertEqual(["crop", "crop"], [op.kind for op in ref.operations])
        self.assertEqual((100, 100, 700, 1100), tuple(ref.operations[0].params["box"]))
        self.assertEqual((50, 50, 400, 700), tuple(ref.operations[1].params["box"]))

        # 1 回目の加工結果からも同じ元へ辿れる
        middle = store.find_original(self.archive, first_edited)
        self.assertIsNotNone(middle)
        self.assertEqual(store.content_hash(root), middle.hash)


class DuplicateOriginalTest(unittest.TestCase):
    """中身が同じなら 1 つにまとまる。

    1 つの元画像から複数の加工後が出る形でもある。#58 の見開き分割は 1 枚から
    2 枚を作るため、manifest がこの形を表せないと作り直しになる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.twin = page_bytes("blue")
        self.archive = build_archive(
            self.work_dir / "twins.zip",
            (("a.jpg", self.twin), ("b.jpg", self.twin), ("c.jpg", page_bytes("red"))),
        )

    def test_stores_the_same_content_only_once(self):
        # Arrange
        store = load_store()

        # Act - 中身が同じ 2 枚を、別々の切り抜きで加工する
        apply_to_archive(self.archive, "a.jpg", CoverTransform(crop=(0, 0, 400, 600)))
        apply_to_archive(self.archive, "b.jpg", CoverTransform(crop=(0, 0, 500, 700)))

        # Assert - 元画像は 1 つ
        stored = stored_originals(self.archive)
        self.assertEqual(1, len(stored), f"同じ中身の元画像が重複している: {stored}")
        self.assertEqual(self.twin, read_entry(self.archive, stored[0]))

        # 加工の記録は 2 つとも別々に残り、どちらからも同じ元を指す
        refs = {
            name: store.find_original(self.archive, read_entry(self.archive, name))
            for name in ("a.jpg", "b.jpg")
        }
        for name, ref in refs.items():
            with self.subTest(name=name):
                self.assertIsNotNone(ref, "加工後から元画像を引けない")
                self.assertEqual(store.content_hash(self.twin), ref.hash)
        self.assertEqual(
            (0, 0, 400, 600), tuple(refs["a.jpg"].operations[-1].params["box"])
        )
        self.assertEqual(
            (0, 0, 500, 700),
            tuple(refs["b.jpg"].operations[-1].params["box"]),
            "2 枚分の加工が別々に記録されていない",
        )


if __name__ == "__main__":
    unittest.main()
