"""整理を通しても、同梱された加工前の画像が残ることを検証する（#96）。

サムネイル作成（#66）とページ分割（#58）は、加工前の画像とその紐づけを
同じ ZIP の中へ隠しフォルダで残す。

    .manga-organizer/
      originals/<中身のハッシュ>.jpg   加工前の画像そのもの
      manifest.json                    加工後のハッシュ -> 元 + 施した加工

これがあるから、開き直したときに切り抜きを広げる方向へ戻せるし、割った対を
1 つの見開きへ畳み直せる。逆に言えば、これを落とした本は二度と戻せない。
加工後の画素は既に捨てられているので、後から作り直す手立ては無い。

整理は本を作り直す操作なので、ここで落ちると利用者は失ったことにすら
気づかない。出来上がった本は正しく開けて、ページも揃っている。失われたのは
「戻せる」という性質だけで、それは次にサムネイル作成を開いた日に分かる。


公開契約（このテストが前提とする形）
------------------------------------------------------------------
整理（FileOrganizer.process_single_archive → ArchiveHandler.create_archive）は、
入力の本に `.manga-organizer/` 配下のエントリがあれば、出力の本へ同じ名前・
同じ中身で持ち越す。

    - 元画像のエントリ名は変えない。名前は中身のハッシュで決まっており、
      manifest の originals がその名前を指している
    - manifest の中身も変えない。ページ名は連番へ振り直されるが、紐づけは
      名前ではなく中身のハッシュで持つので、振り直しでは切れない
    - 持ち越したエントリはページとして数えない。数えると連番へ巻き込まれ、
      別の形で失われる

`.manga-organizer/` を持たない本の出力は、いままでと 1 バイトも変わらない。
"""

import io
import sys
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core import original_store as store  # noqa: E402
from manga_core import page_splitter as splitter  # noqa: E402
from manga_core.cover_editor import CoverTransform, apply_to_archive  # noqa: E402
from manga_core.file_organizer import FileOrganizer  # noqa: E402
from manga_core.viewer_contract import is_viewer_page, sequential_name  # noqa: E402

AUTHOR = "作者"
TITLE = "作品"

# ページごとに違う色を塗り、名前が変わっても中身で追えるようにする。
# 連番でない名前にして、整理が連番へ振り直したことも見えるようにする
PAGES = (
    ("page-1.jpg", "red"),
    ("page-2.jpg", "lime"),
    ("page-3.jpg", "blue"),
    ("page-4.jpg", "yellow"),
)
PAGE_SIZE = (800, 1200)

# 加工後（400x600）と元（800x1200）が寸法で見分けられる切り抜き。
# 何も削らない切り抜きにすると「元が残っている」ことを確かめたつもりで、
# 実は加工後の画像を見ているだけ、という通り方をしてしまう
CROP = (100, 150, 500, 750)
CROPPED_SIZE = (400, 600)

# 見開きは左右で色を変え、割る位置に帯を立てる。中央（1200）からずらすのは、
# 位置を無視して常に真ん中で割る実装と見分けるため
RED = "#ff2020"
BLUE = "#2020ff"
GREEN = "#20ff20"
SPREAD_SIZE = (2400, 1800)
SPLIT_X = 1600
STRIPE_WIDTH = 8


def page_bytes(color: str, size: tuple[int, int] = PAGE_SIZE) -> bytes:
    """テスト用のページ画像。色ごとにバイト列が変わる"""
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


def spread_bytes() -> bytes:
    """左右で色が違う見開き。PNG なのは境目がにじむと色で確かめられないため"""
    width, height = SPREAD_SIZE
    image = Image.new("RGB", (width, height), RED)
    image.paste(Image.new("RGB", (width - width // 2, height), BLUE), (width // 2, 0))
    image.paste(Image.new("RGB", (STRIPE_WIDTH, height), GREEN), (SPLIT_X, 0))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def tall_bytes(color: str) -> bytes:
    """見開きではない単ページ"""
    buffer = io.BytesIO()
    Image.new("RGB", (1200, 1800), color).save(buffer, "PNG")
    return buffer.getvalue()


def build_archive(path: Path, entries: tuple[tuple[str, bytes], ...]) -> Path:
    """指定した中身で ZIP を作る"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return path


def entry_names(path: Path) -> list[str]:
    """ZIP に入っている全エントリ名"""
    with zipfile.ZipFile(path) as archive:
        return archive.namelist()


def read_entry(path: Path, name: str) -> bytes:
    """エントリ 1 つ分の生バイト列"""
    with zipfile.ZipFile(path) as archive:
        return archive.read(name)


def viewer_page_names(path: Path) -> list[str]:
    """viewer がページとして読むエントリ名を、viewer と同じ辞書順で返す"""
    return sorted(name for name in entry_names(path) if is_viewer_page(name))


def sidecar_names(path: Path) -> list[str]:
    """同梱された元画像と記録のエントリ名"""
    with zipfile.ZipFile(path) as archive:
        return sorted(
            name for name in archive.namelist() if name.startswith(".manga-organizer/")
        )


def stored_originals(path: Path) -> list[str]:
    """元画像として保存されたエントリ名"""
    with zipfile.ZipFile(path) as archive:
        return sorted(
            name
            for name in archive.namelist()
            if name.startswith(store.ORIGINALS_PREFIX)
        )


def image_size(data: bytes) -> tuple[int, int]:
    """画像の寸法"""
    with Image.open(io.BytesIO(data)) as image:
        return image.size


def colour_at(data: bytes, x: int, y: int) -> str:
    """画像の 1 点の色。割れたかどうかは寸法ではなく色でしか分からない"""
    with Image.open(io.BytesIO(data)) as opened:
        red, green, blue = opened.convert("RGB").getpixel((x, y))
    return f"#{red:02x}{green:02x}{blue:02x}"


class OrganizeFixture(unittest.TestCase):
    """整理を実際に走らせる土台。作り物の経路では防げているのに本物で落ちる"""

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        self.archive = self.work_dir / "book.zip"
        self.output_dir = self.work_dir / "out"
        self.output_dir.mkdir()

    def organize(self, archive_path: Path | None = None) -> Path:
        """整理を 1 冊ぶん走らせ、出来上がった本の場所を返す。

        keep_originals は「元のアーカイブファイルを消さない」という別の話。
        ここで守りたい元画像（#66）とは関係がないので、既定のまま消さない側に
        しておき、入力を後から読み直せるようにする。
        """
        source = archive_path or self.archive
        organizer = FileOrganizer(self.output_dir, keep_originals=True)
        organizer.set_manga_info(AUTHOR, TITLE)
        results = organizer.process_single_archive(source)

        self.assertEqual(1, len(results), f"1 冊ぶんにならなかった: {results}")
        result = results[0]
        self.assertTrue(result.success, f"整理に失敗した: {result.error_message}")
        self.assertIsNotNone(result.output_path)
        return Path(result.output_path)


class OrganizeKeepsCoverOriginalTest(OrganizeFixture):
    """表紙を切り抜いた本を整理しても、切り抜く前の画像が残る"""

    def setUp(self):
        super().setUp()
        build_archive(
            self.archive, tuple((name, page_bytes(color)) for name, color in PAGES)
        )
        # 加工は本物の経路で起こす。手で `.manga-organizer/` を書いた本では、
        # 実際の加工が作る形と食い違っていても気づけない
        self.before = read_entry(self.archive, "page-1.jpg")
        result = apply_to_archive(self.archive, "page-1.jpg", CoverTransform(crop=CROP))
        self.edited = read_entry(self.archive, result.name)
        self.original_hash = store.content_hash(self.before)

        # 切り抜きが本当に効いていること。何も削らない加工だと、加工前と
        # 加工後が同じ画像になり、「元が残った」の確認が空振りになる
        self.assertEqual(PAGE_SIZE, image_size(self.before))
        self.assertEqual(
            CROPPED_SIZE, image_size(self.edited), "切り抜きが効いていない"
        )
        self.assertNotEqual(self.before, self.edited)

        # 整理する前の状態を押さえる。これが無いと「消えた」のか
        # 「そもそも入っていなかった」のかを、後の表明が言い分けられない
        self.assertEqual(
            [store.original_entry_name(self.original_hash, "page-1.jpg")],
            stored_originals(self.archive),
            "加工前の画像がそもそも同梱されていない",
        )

    def test_the_pre_edit_image_survives_organizing(self):
        # Arrange - 整理前に入っていた元画像の名前と中身
        entry = stored_originals(self.archive)[0]

        # Act
        organized = self.organize()

        # Assert - 名前が残っているだけでは、中身が別物にすり替わっていても
        # 通る。整理前のバイト列そのものであることまで見る
        self.assertIn(
            entry,
            entry_names(organized),
            f"加工前の画像が落ちた: {entry_names(organized)}",
        )
        self.assertEqual(self.before, read_entry(organized, entry))
        self.assertEqual(
            self.original_hash,
            store.content_hash(read_entry(organized, entry)),
            "名前だけ同じで中身が別の画像になっている",
        )

    def test_the_original_can_still_be_read_back_after_organizing(self):
        # Arrange - 加工後の画素は整理を通しても書き換わらない。
        # 紐づけは中身のハッシュで引くので、ここが変わると前提が崩れる
        organized = self.organize()
        page = sequential_name(1, len(PAGES), ".jpg")
        self.assertEqual(
            self.edited, read_entry(organized, page), "加工後のページが書き換わった"
        )

        # Act - 画面が切り抜きを広げるときと同じ引き方をする
        ref = store.find_original(organized, self.edited)

        # Assert - 引けて、読めて、元の寸法で開ける。エントリの有無だけでは
        # 記録が失われて引けなくなった状態を見逃す
        self.assertIsNotNone(ref, "整理後の本から加工前の画像を引けない")
        self.assertEqual(self.original_hash, ref.hash)
        recovered = store.read_original(organized, ref)
        self.assertEqual(self.before, recovered)
        self.assertEqual(PAGE_SIZE, image_size(recovered), "元の画素まで戻れない")

        # 前回の枠が復元できないと、広げる方向へは戻せない
        self.assertEqual(
            [("crop", [100, 150, 500, 750])],
            [(op.kind, list(op.params["box"])) for op in ref.operations],
        )

    def test_pages_are_renumbered_and_the_sidecar_stays_out_of_them(self):
        # Arrange - 整理はページを連番へ振り直す。持ち越しの実装が
        # `.manga-organizer/` をページとして拾うと、元画像が本文に混ざり、
        # 001.jpg へ改名されて別の形で失われる
        expected = [
            sequential_name(position, len(PAGES), ".jpg")
            for position in range(1, len(PAGES) + 1)
        ]

        # Act
        organized = self.organize()

        # Assert - ページはちょうどこの並び。枚数だけを数えると、
        # 元画像が 1 枚割り込んで別のページが 1 枚落ちた形も通る
        self.assertEqual(expected, viewer_page_names(organized))
        self.assertEqual(
            [
                store.MANIFEST_ENTRY,
                store.original_entry_name(self.original_hash, "page-1.jpg"),
            ],
            sidecar_names(organized),
            "同梱物の名前が変わっている",
        )


class OrganizeKeepsSplitOriginalTest(OrganizeFixture):
    """見開きを割った本を整理しても、割る前の見開きへ戻せる（#58）"""

    def setUp(self):
        super().setUp()
        build_archive(
            self.archive,
            (("p1.png", spread_bytes()), ("p2.png", tall_bytes("#808080"))),
        )
        # 分割も本物の経路で起こす
        self.spread = read_entry(self.archive, "p1.png")
        self.spread_hash = store.content_hash(self.spread)
        rows = list(splitter.scan_rows(self.archive))
        splitter.apply_rows(
            self.archive,
            [replace(rows[0], split=splitter.SplitPosition(x=SPLIT_X)), rows[1]],
        )

        # 整理前は、割った対が 1 行の見開きへ畳まって見える。この状態を
        # 押さえないと、後の表明は「整理で失われた」と「そもそも割れて
        # いなかった」を言い分けられない
        folded = splitter.scan_rows(self.archive)
        self.assertEqual(2, len(folded), f"割った対が畳まっていない: {folded}")
        self.assertEqual(2, len(folded[0].names))
        self.assertEqual(SPLIT_X, folded[0].split.x)

    def test_the_split_pair_still_folds_back_into_one_spread(self):
        # Act
        organized = self.organize()

        # Assert - 画面が開いたときに見えるもの。3 行に割れて見えたら、
        # 利用者は割る位置を動かすことも、割る前へ戻すこともできない
        rows = splitter.scan_rows(organized)
        self.assertEqual(2, len(rows), f"見開きへ畳み直せない: {rows}")
        self.assertEqual(2, len(rows[0].names), "割った対が別々の行になっている")
        self.assertEqual(SPREAD_SIZE, (rows[0].width, rows[0].height))
        self.assertIsNotNone(rows[0].split)
        self.assertEqual(SPLIT_X, rows[0].split.x, "割った位置が失われている")

    def test_the_spread_before_the_split_can_still_be_read_back(self):
        # Arrange - 先に読む方（右半分）の画素から引く
        organized = self.organize()
        earlier = read_entry(organized, viewer_page_names(organized)[0])
        self.assertEqual(BLUE, colour_at(earlier, 400, 900), "割った半分ではない")

        # Act
        ref = store.find_original(organized, earlier)

        # Assert - 割る前の見開きそのものへ戻れる。寸法と、割った位置に
        # 立てた帯の色まで見て、別の画像へ差し替わっていないことを確かめる
        self.assertIsNotNone(ref, "整理後の本から割る前の見開きを引けない")
        self.assertEqual(self.spread_hash, ref.hash)
        recovered = store.read_original(organized, ref)
        self.assertEqual(self.spread, recovered)
        self.assertEqual(SPREAD_SIZE, image_size(recovered))
        self.assertEqual(GREEN, colour_at(recovered, SPLIT_X, 900))


class OrganizeWithoutSidecarTest(OrganizeFixture):
    """加工していない本の整理は、いままでと同じ結果になる"""

    def test_a_book_without_a_sidecar_is_organized_as_before(self):
        # Arrange - 同梱物を持たない、ごく普通の本
        build_archive(
            self.archive, tuple((name, page_bytes(color)) for name, color in PAGES)
        )
        expected = [
            sequential_name(position, len(PAGES), ".jpg")
            for position in range(1, len(PAGES) + 1)
        ]

        # Act
        organized = self.organize()

        # Assert - 連番のページだけ。持ち越しの実装が空の
        # `.manga-organizer/` を作ると、加工していない本まで中身が変わる
        self.assertEqual(expected, entry_names(organized))
        self.assertEqual([], sidecar_names(organized))

        # 中身も入力のページそのまま。名前の並びだけでは、別の画像が
        # 同じ名前で入っていても通る
        for position, (name, _color) in enumerate(PAGES, 1):
            self.assertEqual(
                read_entry(self.archive, name),
                read_entry(organized, sequential_name(position, len(PAGES), ".jpg")),
            )


if __name__ == "__main__":
    unittest.main()
