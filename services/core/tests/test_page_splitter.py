"""見開き 1 枚を 2 ページへ割る仕組みを検証する（#58 Stage 1）。

漫画の ZIP には、見開きを横長の画像 1 枚として持つものがある。viewer は
それを 1 ページとして描くので、単ページの間に横長が挟まって読みづらい。
右綴じなので、先に読むのは右半分になる。

割った後も利用者に「元画像」と「2 枚の半分」の区別は見せない。開き直せば
また 1 行の見開きとして現れ、割る位置を動かしたり、割る前へ戻したりできる。
そのために、割る前の画像は #66 の仕組みで同じ ZIP に残す。


公開契約（このテストが前提とする形。実装はこれに合わせる）
------------------------------------------------------------------
manga_core.page_splitter （新設。分割の幾何と畳み込みはここに閉じる）

    split_halves(image: Image.Image, x: int) -> tuple[Image, Image]
        x で縦に割り、(先に読む方, 後に読む方) を返す。右綴じなので
        先に読む方は右半分 crop((x, 0, W, H))、後は左半分 crop((0, 0, x, H))

    @dataclass(frozen=True) SplitPosition
        x: int
            割る位置。行の width / height と同じ座標系で持つ

    @dataclass(frozen=True) SplitRow
        names: tuple[str, ...]
            この行が占める、いま存在するページ名。割る前は 1 つ、
            割った後の対は 2 つ（先に読む方、後に読む方の順）
        source: str
            行の画素の出どころ。"page" ならページそのもの、
            "original" なら #66 で同梱された割る前の画像
        width: int
        height: int
            source の画像の寸法。割る位置はこの座標で解釈する
        is_spread: bool
            見開きらしい横長か。画面の既定のチェックを決めるだけで、
            割れるかどうかは決めない
        split: SplitPosition | None
            いま割られている位置。割られていなければ None

    scan_rows(archive_path: Path, progress=None) -> tuple[SplitRow, ...]
        ページ順に行を組み立てる。割った対は 1 行へ畳む

    apply_rows(archive_path: Path, rows, progress=None)
        行ぜんぶを受け取り、split の変化から
        「割る」「位置を変える」「割る前へ戻す」を 1 回の書き直しで適用する

        名前を 2 つ持つ行は、書き直す前に下の畳み込みの規則で確かめ直す。
        行は画面から戻ってくるので、走査と確定の間にアーカイブが変われば
        古い名前を指しうる。1 枚目だけを見て書くと、2 枚目に指名された
        無関係なページが「落とすページ」として黙って消える

manga_core.original_store

    @dataclass(frozen=True) Derivation
        produced: bytes
        operations: tuple[Operation, ...]

    plan_manifest(archive_path, source, source_name, derivations, superseded=())
        manifest を 1 度だけ読み、superseded の記録を落としてから
        derivations を書き足す。1 枚から 2 枚が出る分割では、記録ごとに
        読み直す plan_record では片方が消える

    Operation("split", {"side": "left"|"right", "x": int, "width": int})
        位置まで記録する。width は座標系の照合用で、読む側は自分が見ている
        画像の幅と食い違ったら描かずに断る。#58 より前に書かれた本には
        "side" しか無いので、x が無いときは floor(width / 2) へ落とす


畳み込みの規則（この 6 つが全部そろったときだけ 1 行にする）
------------------------------------------------------------------
1. 隣り合っている
2. 両方の find_original が成功し、ref.hash が同じ
3. ref.operations がちょうど 1 つで、kind が "split"
4. 前が side=="right"、後ろが side=="left"
5. 両方の x が同じ
6. どちらもまだ他の行に取られていない

1 つでも欠けたら、それぞれ普通の 1 行として扱う。緩めると、たまたま同じ
元から出た無関係な 2 枚が 1 行にまとめられ、片方を割り直したつもりで
もう片方が消える。

例外は、左右が互いに同じバイト列になった対（一色の見開きを中央で割った
場合など）。記録の鍵は中身のハッシュなので、同じバイト列の 2 枚には記録を
1 件しか持てず、4 と 5 は確かめようがない。隣り合う 2 枚が互いに同じ
バイト列で、同じ元から出た同じ 1 件の split の記録に行き着くときに限り、
その記録の x で畳む。ここを塞いだままにすると、真っ白な見開きだけが
二度と割り位置を直せない。
"""

import io
import json
import sys
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.cover_editor import is_spread  # noqa: E402
from manga_core.original_store import (  # noqa: E402
    MANIFEST_ENTRY,
    content_hash,
)
from manga_core.page_reorder import ZipPageEditor  # noqa: E402
from manga_core.viewer_contract import is_viewer_page  # noqa: E402


def load_splitter():
    """manga_core.page_splitter を読み込む。

    実装が入るまでは ModuleNotFoundError で落ちる。モジュールの先頭で import
    すると、この 1 行でファイル全体が収集エラーになり、どのテストが何を
    要求しているのかが出力から読めなくなる。要る所だけで読み込む。
    """
    import manga_core.page_splitter as module

    return module


PAGE_DATE_TIME = (2019, 5, 4, 12, 30, 0)

# 左右で色を変え、割る位置に細い帯を立てる。枚数だけでは「割った」ことと
# 「同じ絵を 2 回書いた」ことを見分けられない
RED = "#ff2020"
BLUE = "#2020ff"
GREEN = "#20ff20"

# 割る位置を中央（1200）からずらす。中央のままだと、位置を無視して常に
# 真ん中で割る実装も、左右を取り違えた実装も、同じ結果を出して通ってしまう
SPREAD_WIDTH = 2400
SPREAD_HEIGHT = 1800
SPLIT_X = 1600
STRIPE_WIDTH = 8


def spread_bytes(
    width: int = SPREAD_WIDTH,
    height: int = SPREAD_HEIGHT,
    stripe_x: int | None = SPLIT_X,
    fmt: str = "PNG",
) -> bytes:
    """左半分を赤、右半分を青に塗り、割る位置に緑の帯を立てた見開き。

    PNG にするのは、JPEG だと境目の色がにじんで画素の比較が当てにならず、
    「割れたかどうか」を色で確かめられなくなるため。

    fmt を変えるのは、書き込んだバイト列の形式が拡張子と食い違わないかを
    見るときだけ。どちらも可逆なので、画素の比較は PNG と同じように使える。
    """
    image = Image.new("RGB", (width, height), RED)
    right = Image.new("RGB", (width - width // 2, height), BLUE)
    image.paste(right, (width // 2, 0))
    if stripe_x is not None:
        image.paste(Image.new("RGB", (STRIPE_WIDTH, height), GREEN), (stripe_x, 0))
    buffer = io.BytesIO()
    image.save(buffer, fmt)
    return buffer.getvalue()


def tall_bytes(colour: str) -> bytes:
    """見開きではない単ページ。色を変えて中身で見分けられるようにする"""
    buffer = io.BytesIO()
    Image.new("RGB", (1200, 1800), colour).save(buffer, "PNG")
    return buffer.getvalue()


def build_archive(path: Path, entries: dict[str, bytes]) -> None:
    """テスト用の ZIP を作る"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name, date_time=PAGE_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)


def page_names(path: Path) -> list[str]:
    """viewer がページとして読むエントリを、viewer と同じ辞書順で返す"""
    with zipfile.ZipFile(path) as archive:
        return sorted(n for n in archive.namelist() if is_viewer_page(n))


def entry_data(path: Path, name: str) -> bytes:
    """ZIP 内の 1 エントリの生バイト列"""
    with zipfile.ZipFile(path) as archive:
        return archive.read(name)


def size_of(data: bytes) -> tuple[int, int]:
    """画像の寸法"""
    with Image.open(io.BytesIO(data)) as image:
        return image.size


def colour_at(data: bytes, x: int, y: int) -> str:
    """画像の 1 点の色。割れたかどうかは寸法ではなく色でしか分からない"""
    with Image.open(io.BytesIO(data)) as opened:
        red, green, blue = opened.convert("RGB").getpixel((x, y))
    return f"#{red:02x}{green:02x}{blue:02x}"


def manifest_of(path: Path) -> dict:
    """同梱された記録（#66）。無ければ空として扱う"""
    with zipfile.ZipFile(path) as archive:
        if MANIFEST_ENTRY not in archive.namelist():
            return {}
        return json.loads(archive.read(MANIFEST_ENTRY).decode("utf-8"))


def originals_of(path: Path) -> dict:
    """割る前の画像の一覧（ハッシュ -> エントリ名）"""
    return manifest_of(path).get("originals", {})


def derived_of(path: Path) -> dict:
    """加工後の記録（加工後のハッシュ -> 元 + 施した加工）"""
    return manifest_of(path).get("derived", {})


class SplitFixture(unittest.TestCase):
    """1 冊分の ZIP を用意する"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.archive_path = self.work_dir / "volume.zip"
        self.splitter = load_splitter()

    def build_spread_and_page(self, path: Path | None = None) -> Path:
        """見開き 1 枚と単ページ 1 枚だけの、いちばん小さい本"""
        target = path or self.archive_path
        build_archive(
            target, {"p1.png": spread_bytes(), "p2.png": tall_bytes("#808080")}
        )
        return target

    def build_four_pages(self, path: Path | None = None) -> Path:
        """縦・見開き・縦・縦。見開き以外を畳まないことも見えるようにする。

        単ページの色を全部変えるのは、同じ中身だとハッシュが重なり、
        記録の突き合わせで別のページを指しても気づけないため。
        """
        target = path or self.archive_path
        build_archive(
            target,
            {
                "p1.png": tall_bytes("#101010"),
                "p2.png": spread_bytes(),
                "p3.png": tall_bytes("#303030"),
                "p4.png": tall_bytes("#404040"),
            },
        )
        return target

    def split_row(self, path: Path, index: int, x: int) -> None:
        """index 行目を x で割る。他の行はそのまま送り返す"""
        rows = list(self.splitter.scan_rows(path))
        position = self.splitter.SplitPosition(x=x)
        self.splitter.apply_rows(
            path,
            [
                replace(row, split=position) if number == index else row
                for number, row in enumerate(rows)
            ],
        )


class SplitsIntoTwoPagesTest(SplitFixture):
    """割った結果が、複製ではなく切断であること"""

    def test_splitting_cuts_the_image_instead_of_duplicating_it(self):
        # Arrange
        self.build_spread_and_page()

        # Act
        self.split_row(self.archive_path, 0, SPLIT_X)

        # Assert - 枚数が 1 増えただけなら、同じ絵を 2 回書いた実装も通る。
        # 右綴じなので先に読むのは右半分（青）、後が左半分（赤）。
        # 両方を見ることで、左右を取り違えた実装もここで落ちる
        names = page_names(self.archive_path)
        self.assertEqual(3, len(names))
        earlier = entry_data(self.archive_path, names[0])
        later = entry_data(self.archive_path, names[1])
        self.assertEqual(BLUE, colour_at(earlier, 400, 900))
        self.assertEqual(RED, colour_at(later, 400, 900))

        # Assert - 切れ目は緑の帯の所。先に読む方の左端が緑で、
        # 後に読む方の右端には緑が残らない
        self.assertEqual(GREEN, colour_at(earlier, 0, 900))
        self.assertEqual(BLUE, colour_at(later, size_of(later)[0] - 1, 900))

    def test_the_chosen_split_position_is_honoured(self):
        # Arrange - 2400 幅を 1600 で割る。中央（1200）で割ると 1200/1200 に
        # なるので、左右非対称にしておけば「常に中央」も「左右あべこべ」も
        # 寸法だけで見分けられる
        self.build_spread_and_page()

        # Act
        self.split_row(self.archive_path, 0, SPLIT_X)

        # Assert
        names = page_names(self.archive_path)
        earlier = entry_data(self.archive_path, names[0])
        later = entry_data(self.archive_path, names[1])
        self.assertEqual((SPREAD_WIDTH - SPLIT_X, SPREAD_HEIGHT), size_of(earlier))
        self.assertEqual((SPLIT_X, SPREAD_HEIGHT), size_of(later))

    def test_a_page_that_is_not_a_spread_can_still_be_split(self):
        # Arrange - 1380x1200 は 1.15 倍で、見開き判定の閾値 1.2 に届かない。
        # 判定は画面の既定のチェックを決めるだけで、割れるかどうかは決めない。
        # 断ると、実際には見開きなのに閾値に届かない本を利用者が直せなくなる
        self.assertFalse(is_spread(1380, 1200))
        build_archive(
            self.archive_path,
            {
                "p1.png": spread_bytes(1380, 1200, stripe_x=None),
                "p2.png": tall_bytes("#808080"),
            },
        )
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.assertFalse(rows[0].is_spread)

        # Act
        self.split_row(self.archive_path, 0, 700)

        # Assert
        names = page_names(self.archive_path)
        self.assertEqual(3, len(names))
        self.assertEqual((680, 1200), size_of(entry_data(self.archive_path, names[0])))
        self.assertEqual((700, 1200), size_of(entry_data(self.archive_path, names[1])))


class FoldsBackIntoOneRowTest(SplitFixture):
    """開き直したとき、割った対だけが 1 行に戻ること"""

    def test_reopening_folds_the_pair_and_only_the_pair(self):
        # Arrange - 縦・見開き・縦・縦。見開きを割ると 5 ページになる
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        self.assertEqual(5, len(page_names(self.archive_path)))

        # Act
        rows = list(self.splitter.scan_rows(self.archive_path))

        # Assert - 割った 2 枚が 1 行に戻り、利用者からは元の 4 行に見える
        self.assertEqual(4, len(rows))
        pair = rows[1]
        self.assertEqual(2, len(pair.names))
        # 位置を動かす対象は保存済みの半分ではなく、割る前の画像。
        # 半分を対象にすると、動かすたびに前回捨てた画素が戻らない
        self.assertEqual("original", pair.source)
        self.assertEqual(SPREAD_WIDTH, pair.width)
        self.assertIsNotNone(pair.split)
        self.assertEqual(SPLIT_X, pair.split.x)

        # Assert - 隣り合う 2 枚を無条件に畳む実装は、ここで落ちる。
        # 畳まれると、割っていないページが勝手に対にされ、片方が消える
        for index in (0, 2, 3):
            self.assertEqual(
                1,
                len(rows[index].names),
                f"{index} 行目（割っていないページ）が畳まれています",
            )

    def test_halves_that_were_separated_do_not_fold(self):
        # Arrange
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        # 畳む材料が確かにあることを先に確かめる。記録が空の本で
        # 「畳まれていない」と言っても、何も検証していない
        self.assertEqual(2, len(derived_of(self.archive_path)))

        # Arrange - 後に読む方（左半分）を末尾へ動かす
        editor = ZipPageEditor(self.archive_path)
        names = [page.name for page in editor.pages]
        editor.apply_order([names[0], names[1], names[3], names[4], names[2]])
        editor.close()
        # 紐づけは中身のハッシュなので、連番の振り直しでは切れない
        self.assertEqual(2, len(derived_of(self.archive_path)))

        # Act
        rows = list(self.splitter.scan_rows(self.archive_path))

        # Assert - 離れた 2 枚は対ではない。畳むと、間のページを挟んだまま
        # 1 行として扱われ、割り直しで無関係なページが消える
        self.assertEqual(5, len(rows))
        for index, row in enumerate(rows):
            self.assertEqual(1, len(row.names), f"{index} 行目が畳まれています")

    def test_halves_in_the_wrong_order_do_not_fold(self):
        # Arrange
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        self.assertEqual(2, len(derived_of(self.archive_path)))

        # Arrange - 左半分と右半分を入れ替える。隣り合ってはいるが、
        # 右綴じの並び（右 -> 左）ではない
        editor = ZipPageEditor(self.archive_path)
        names = [page.name for page in editor.pages]
        editor.apply_order([names[0], names[2], names[1], names[3], names[4]])
        editor.close()
        self.assertEqual(2, len(derived_of(self.archive_path)))

        # Act
        rows = list(self.splitter.scan_rows(self.archive_path))

        # Assert - 順序が逆なら、利用者が意図して入れ替えたということ。
        # 畳むと、その入れ替えが次の書き込みで黙って戻る
        self.assertEqual(5, len(rows))
        for index, row in enumerate(rows):
            self.assertEqual(1, len(row.names), f"{index} 行目が畳まれています")


class AdjustsWithoutAccumulatingTest(SplitFixture):
    """割る位置を動かしても、記録も劣化も積み上がらないこと"""

    def assert_manifest_tracks_only_the_pair(
        self, expected_widths: tuple[int, int]
    ) -> None:
        """いまの 2 枚だけが記録され、割る前の画像が 1 枚だけ残っていること。

        「1 枚だけ」を数で見ると、一度も書いていない場合も、2 度目が黙って
        何もしなかった場合も通ってしまう。中身が本当に割る前の見開きかを
        寸法とハッシュで確かめる。
        """
        names = page_names(self.archive_path)
        self.assertEqual(5, len(names))
        earlier = entry_data(self.archive_path, names[1])
        later = entry_data(self.archive_path, names[2])
        self.assertEqual(expected_widths[0], size_of(earlier)[0])
        self.assertEqual(expected_widths[1], size_of(later)[0])

        originals = originals_of(self.archive_path)
        self.assertEqual(1, len(originals))
        ((digest, entry),) = originals.items()
        stored = entry_data(self.archive_path, entry)
        self.assertEqual(digest, content_hash(stored))
        # 動かすたびに半分を割り直すと、ここが半分の寸法になる
        self.assertEqual((SPREAD_WIDTH, SPREAD_HEIGHT), size_of(stored))

        # 古い記録が残っても、新しい記録が書かれなくても落ちる。
        # 残ると、開き直すたびに前回の位置で畳まれて動かせなくなる
        self.assertEqual(
            {content_hash(earlier), content_hash(later)},
            set(derived_of(self.archive_path)),
        )

    def test_moving_the_split_does_not_accumulate_originals_or_records(self):
        # Arrange
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        self.assert_manifest_tracks_only_the_pair((800, 1600))

        # Act - 開き直して、割る位置だけを動かす
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.splitter.apply_rows(
            self.archive_path,
            [
                replace(row, split=self.splitter.SplitPosition(x=1000))
                if index == 1
                else row
                for index, row in enumerate(rows)
            ],
        )

        # Assert - ページ数は変わらず、寸法だけが新しい位置に従う
        self.assert_manifest_tracks_only_the_pair((1400, 1000))


class RestoresTheOriginalTest(SplitFixture):
    """割る前へ戻すと、割る前のバイト列がそのまま戻ること"""

    def test_restoring_writes_back_the_original_bytes(self):
        # Arrange
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        names = page_names(self.archive_path)
        halves = {
            content_hash(entry_data(self.archive_path, names[1])),
            content_hash(entry_data(self.archive_path, names[2])),
        }
        self.assertEqual(halves, set(derived_of(self.archive_path)))

        # Act - 行の split を外して送る
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.splitter.apply_rows(
            self.archive_path,
            [
                replace(row, split=None) if index == 1 else row
                for index, row in enumerate(rows)
            ],
        )

        # Assert - 元の 4 ページに戻る
        restored_names = page_names(self.archive_path)
        self.assertEqual(4, len(restored_names))

        # Assert - 寸法だけを見ると、2 枚を貼り合わせた絵でも通る。PNG なら
        # 画素までほぼ一致する。バイト列が同じであることだけが
        # 「割る前のものをそのまま戻した」ことの証拠になる
        originals = originals_of(self.archive_path)
        self.assertEqual(1, len(originals))
        ((_, entry),) = originals.items()
        stored = entry_data(self.archive_path, entry)
        restored = entry_data(self.archive_path, restored_names[1])
        self.assertEqual(stored, restored)

        # Assert - 半分の記録は消える。残ると、戻したはずのページが
        # 次に開いたときまた対として畳まれる
        derived = derived_of(self.archive_path)
        for digest in halves:
            self.assertNotIn(digest, derived)

        # Assert - 割る前の画像そのものは残す。消すと、戻した直後に
        # もう一度割ったとき、元の画素をもう引けない
        self.assertEqual(1, len(originals_of(self.archive_path)))


class SplitsSeveralSpreadsAtOnceTest(SplitFixture):
    """1 回の確定で見開きを 2 つ割る。

    画面は変えた行だけでなく全行を送り返すので、1 回の書き直しで複数の
    見開きが割られる。記録はアーカイブの中の 1 つの manifest に集まるため、
    1 枚ぶんずつ独立に組み立てると、後の 1 枚が前の 1 枚の記録を消す。

    消えた側は開き直しても対として畳まれず、ただの 2 ページになる。
    利用者から見ると、割った覚えのある見開きの片方だけが、二度と
    位置を直せなくなる。
    """

    def build_two_spreads(self) -> None:
        """見開き・縦・見開き。間に縦を挟み、隣接だけで畳んでいないことも見る"""
        build_archive(
            self.archive_path,
            {
                "p1.png": spread_bytes(),
                "p2.png": tall_bytes("#202020"),
                "p3.png": spread_bytes(width=1200, height=900, stripe_x=700),
            },
        )

    def test_records_every_spread_split_in_the_same_save(self):
        # Arrange
        self.build_two_spreads()
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.assertEqual(3, len(rows))
        # 対照 - 2 枚とも見開きとして拾えている。ここが 1 枚だと
        # 「まとめて割る」状況そのものが作れていない
        self.assertEqual(
            [True, False, True], [row.is_spread for row in rows], f"素材が違う: {rows}"
        )

        # Act - 2 つとも、別々の位置で割って 1 回で確定する
        positions = {0: SPLIT_X, 2: 700}
        self.splitter.apply_rows(
            self.archive_path,
            [
                replace(row, split=self.splitter.SplitPosition(x=positions[index]))
                if index in positions
                else row
                for index, row in enumerate(rows)
            ],
        )

        # Assert - 3 ページが 5 ページになる
        names = page_names(self.archive_path)
        self.assertEqual(5, len(names), f"ページ数が合わない: {names}")

        # Assert - 割った 4 枚ぶんの記録が全部残っている。個数ではなく
        # 中身のハッシュで見る。個数だけだと、片方の記録が消えて別の
        # 何かが増えても釣り合ってしまう
        halves = {
            content_hash(entry_data(self.archive_path, names[index]))
            for index in (0, 1, 3, 4)
        }
        self.assertEqual(
            halves,
            set(derived_of(self.archive_path)),
            "同じ保存で割った見開きの、片方の記録が失われている",
        )

        # Assert - 元画像は見開きの数だけ。2 枚とも遡れる
        self.assertEqual(2, len(originals_of(self.archive_path)))

        # Assert - 開き直すと、どちらも対として畳まれる。これが
        # 利用者に見える結果で、記録が欠けた側はここでただの 2 ページになる
        reopened = list(self.splitter.scan_rows(self.archive_path))
        self.assertEqual(
            [2, 1, 2],
            [len(row.names) for row in reopened],
            f"畳まれ方が違う: {[row.names for row in reopened]}",
        )
        self.assertEqual(
            [SPLIT_X, None, 700],
            [row.split.x if row.split else None for row in reopened],
        )


# 拡張子ごとに、その名前を名乗る以上こうであるべき形式。名前ではなく
# 中身を開いて突き合わせるために使う。BMP は viewer が読めないので、
# 書き上がったページの拡張子として現れてはいけない
FORMAT_BY_SUFFIX = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".webp": "WEBP",
    ".gif": "GIF",
    ".avif": "AVIF",
}

# build_four_pages が置く単ページの色。どのページが残ったかを中身で見る
TALL_COLOURS = ("#101010", "#303030", "#404040")


def format_of(data: bytes) -> str:
    """バイト列そのものが名乗る画像形式。名前は一切見ない。

    拡張子と中身が食い違っていても、名前を眺めるだけでは分からない。
    中身を開いて形式を聞くことでしか、貼り違いは見つけられない。
    """
    with Image.open(io.BytesIO(data)) as image:
        return image.format


def flat_spread_bytes(colour: str = "#f0f0f0") -> bytes:
    """一色だけの見開き。中央で割ると左右がまったく同じバイト列になる。

    真っ白な章扉や左右対称の見返しは実在する。作り物の特殊な入力ではない。
    """
    buffer = io.BytesIO()
    Image.new("RGB", (SPREAD_WIDTH, SPREAD_HEIGHT), colour).save(buffer, "PNG")
    return buffer.getvalue()


def page_row(splitter, path: Path, name: str):
    """まだ割られていない 1 ページとして、画面が送り返してくる形の行"""
    width, height = size_of(entry_data(path, name))
    return splitter.SplitRow(
        names=(name,),
        source=splitter.SOURCE_PAGE,
        width=width,
        height=height,
        is_spread=is_spread(width, height),
        split=None,
    )


def pair_row(splitter, names, width: int, height: int, split):
    """割った対として、画面が送り返してくる形の行。

    走査を通さずに組み立てるのが要点。画面から戻る行は、走査した時点の
    アーカイブしか映していない。確定までに中身が変われば、こうして
    「もう正しくない行」がそのまま届く。Stage 2 の API も行を素通しする。
    """
    return splitter.SplitRow(
        names=tuple(names),
        source=splitter.SOURCE_ORIGINAL,
        width=width,
        height=height,
        is_spread=is_spread(width, height),
        split=split,
    )


class RevalidatesThePairBeforeRewritingTest(SplitFixture):
    """名前を 2 つ持つ行を、書き直す前に本物の対として確かめること。

    行は画面から戻ってくる。走査と確定の間に別のタブが同じ本を書き換えれば、
    行が指す名前は古いままになる。1 枚目だけを見て 2 枚目を確かめずに書くと、
    2 枚目に指名された無関係なページが「落とすページ」として黙って消える。
    apply_pages は名指しされた落としを通すので、止められるのはここだけ。

    どの試験も、断ることと、同じ操作が本物の対では通ることを対にして見る。
    断る側だけでは「何でも断る」実装が通ってしまう。
    """

    def build_split_spread(self) -> list[str]:
        """縦・見開き・縦・縦のうち、見開きだけを割った本を用意する"""
        self.build_four_pages()
        self.split_row(self.archive_path, 1, SPLIT_X)
        names = page_names(self.archive_path)
        self.assertEqual(5, len(names), f"素材が違う: {names}")
        return names

    def build_two_split_spreads(self, path: Path) -> list[str]:
        """大きさの違う見開きを 2 つ用意し、両方を割る。

        寸法を変えるのは、どの半分がどちらの見開きから出たのかを、
        記録ではなく画像そのものから確かめられるようにするため。
        """
        build_archive(
            path,
            {
                "p1.png": spread_bytes(),
                "p2.png": spread_bytes(width=1200, height=900, stripe_x=700),
            },
        )
        rows = list(self.splitter.scan_rows(path))
        self.splitter.apply_rows(
            path,
            [
                replace(row, split=self.splitter.SplitPosition(x=x))
                for row, x in zip(rows, (SPLIT_X, 700), strict=True)
            ],
        )
        return page_names(path)

    def test_refuses_a_pair_whose_second_page_was_never_split(self):
        # Arrange - 対照。2 枚目に指名するのは、割った跡が無いただのページ。
        # ここが半分だと、この試験は別の理由で断られるだけになる
        names = self.build_split_spread()
        self.assertEqual(
            TALL_COLOURS[1],
            colour_at(entry_data(self.archive_path, names[3]), 10, 10),
            "2 枚目に指名する相手が、割った跡の無いページになっていない",
        )
        before = self.archive_path.read_bytes()
        rows = [
            page_row(self.splitter, self.archive_path, names[0]),
            page_row(self.splitter, self.archive_path, names[1]),
            pair_row(
                self.splitter, (names[2], names[3]), SPREAD_WIDTH, SPREAD_HEIGHT, None
            ),
            page_row(self.splitter, self.archive_path, names[4]),
        ]

        # Act / Assert - 断る。通すと、割った覚えのないページが
        # 「割る前へ戻す」の巻き添えで本から消える
        with self.assertRaises(self.splitter.PageSplitError):
            self.splitter.apply_rows(self.archive_path, rows)
        self.assertEqual(
            before, self.archive_path.read_bytes(), "断ったのに本が書き換わっている"
        )

        # Act - 同じ「割る前へ戻す」でも、走査が畳んだ本物の対なら通る
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.assertEqual(2, len(rows[1].names), f"対として畳めていない: {rows}")
        self.splitter.apply_rows(
            self.archive_path,
            [
                replace(row, split=None) if index == 1 else row
                for index, row in enumerate(rows)
            ],
        )

        # Assert - 見開きが戻り、ほかのページは 1 枚も欠けていない
        restored = page_names(self.archive_path)
        self.assertEqual(4, len(restored))
        self.assertEqual(
            (SPREAD_WIDTH, SPREAD_HEIGHT),
            size_of(entry_data(self.archive_path, restored[1])),
        )
        self.assertEqual(
            list(TALL_COLOURS),
            [
                colour_at(entry_data(self.archive_path, restored[index]), 10, 10)
                for index in (0, 2, 3)
            ],
        )

    def test_refuses_a_pair_whose_halves_came_from_different_spreads(self):
        # Arrange - 別々の見開きから出た半分を、右・左の順で隣り合わせる。
        # 隣接も向きも合っているので、元をたどらないと見分けが付かない
        names = self.build_two_split_spreads(self.archive_path)
        editor = ZipPageEditor(self.archive_path)
        editor.apply_order([names[0], names[3], names[1], names[2]])
        editor.close()
        names = page_names(self.archive_path)

        # Arrange - 対照。1 枚目は大きい見開きの右半分、2 枚目は小さい見開きの
        # 左半分。寸法が違うので、同じ見開きの対でないことは記録抜きで分かる
        self.assertEqual(
            [(SPREAD_WIDTH - SPLIT_X, SPREAD_HEIGHT), (700, 900)],
            [size_of(entry_data(self.archive_path, name)) for name in names[:2]],
        )
        # 対照 - どちらも元をたどれる。断る理由が「記録が無い」ではない
        self.assertEqual(4, len(derived_of(self.archive_path)))
        before = self.archive_path.read_bytes()
        rows = [
            pair_row(self.splitter, names[:2], SPREAD_WIDTH, SPREAD_HEIGHT, None),
            page_row(self.splitter, self.archive_path, names[2]),
            page_row(self.splitter, self.archive_path, names[3]),
        ]

        # Act / Assert - 断る。通すと、1 枚目の見開きを戻す操作で、
        # 別の見開きの左半分が消える
        with self.assertRaises(self.splitter.PageSplitError):
            self.splitter.apply_rows(self.archive_path, rows)
        self.assertEqual(
            before, self.archive_path.read_bytes(), "断ったのに本が書き換わっている"
        )

        # Act - 同じ操作を、同じ元から出た本物の対で行う。並べ替えた本には
        # もう対が残っていないので、同じ手順で作り直す
        other = self.work_dir / "other.zip"
        self.build_two_split_spreads(other)
        rows = list(self.splitter.scan_rows(other))
        self.assertEqual([2, 2], [len(row.names) for row in rows])
        self.splitter.apply_rows(other, [replace(rows[0], split=None), rows[1]])

        # Assert - 戻した見開きが 1 行に、もう 1 つの対はそのまま
        restored = page_names(other)
        self.assertEqual(3, len(restored))
        self.assertEqual(
            (SPREAD_WIDTH, SPREAD_HEIGHT), size_of(entry_data(other, restored[0]))
        )

    def test_refuses_a_pair_whose_halves_are_no_longer_adjacent(self):
        # Arrange - まず、隣り合っている本物の対なら位置を動かせることを見る
        names = self.build_split_spread()
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.splitter.apply_rows(
            self.archive_path,
            [
                replace(row, split=self.splitter.SplitPosition(x=1000))
                if index == 1
                else row
                for index, row in enumerate(rows)
            ],
        )
        names = page_names(self.archive_path)
        self.assertEqual(
            [(1400, SPREAD_HEIGHT), (1000, SPREAD_HEIGHT)],
            [size_of(entry_data(self.archive_path, name)) for name in names[1:3]],
        )

        # Arrange - 利用者が、後に読む方（左半分）を末尾へ動かす
        editor = ZipPageEditor(self.archive_path)
        editor.apply_order([names[0], names[1], names[3], names[4], names[2]])
        editor.close()
        names = page_names(self.archive_path)

        # Arrange - 対照。動かした 2 枚は、いまも同じ見開きから出た右と左で、
        # 記録もそろっている。断る理由が「別の元」でも「記録が無い」でもない
        self.assertEqual(
            [(1400, SPREAD_HEIGHT), (1000, SPREAD_HEIGHT)],
            [
                size_of(entry_data(self.archive_path, name))
                for name in (names[1], names[4])
            ],
        )
        self.assertEqual(2, len(derived_of(self.archive_path)))
        # 対照 - 走査は離れた 2 枚を畳まない。この行は動かす前の画面から来た
        self.assertEqual(
            [1, 1, 1, 1, 1],
            [len(row.names) for row in self.splitter.scan_rows(self.archive_path)],
        )
        before = self.archive_path.read_bytes()
        rows = [
            page_row(self.splitter, self.archive_path, names[0]),
            pair_row(
                self.splitter,
                (names[1], names[4]),
                SPREAD_WIDTH,
                SPREAD_HEIGHT,
                self.splitter.SplitPosition(x=1200),
            ),
            page_row(self.splitter, self.archive_path, names[2]),
            page_row(self.splitter, self.archive_path, names[3]),
        ]

        # Act / Assert - 断る。通すと、利用者が意図して動かした並びが
        # 割り直しの巻き添えで黙って元へ戻る
        with self.assertRaises(self.splitter.PageSplitError):
            self.splitter.apply_rows(self.archive_path, rows)
        self.assertEqual(
            before, self.archive_path.read_bytes(), "断ったのに本が書き換わっている"
        )


class IdenticalHalvesTest(SplitFixture):
    """左右が同じバイト列になる見開きも、開き直して直せること。

    一色の章扉や左右対称の見返しを中央で割ると、左右がまったく同じ
    バイト列になる。記録の鍵は中身のハッシュなので、この 2 枚には記録を
    1 件しか持てず、後から書いた側が前を上書きする。両方が同じ side を
    指す記録に行き着き、右・左の順という条件が満たせない。

    畳めなければ、その見開きは 2 枚のページとしてしか見えなくなり、
    利用者は割り位置を二度と直せない。ページは残るので、壊れたようには
    見えないぶん気づけない。
    """

    TWIN_COLOUR = "#303030"

    def build_blank_spread(self) -> None:
        """一色の見開きと、互いに同じ中身の単ページ 2 枚。

        単ページを同じ中身にするのは、「隣り合う同じバイト列なら畳む」と
        だけ緩めた実装を落とすため。割った跡の無い 2 枚は対ではない。
        """
        build_archive(
            self.archive_path,
            {
                "p1.png": flat_spread_bytes(),
                "p2.png": tall_bytes(self.TWIN_COLOUR),
                "p3.png": tall_bytes(self.TWIN_COLOUR),
            },
        )

    def test_a_centred_split_of_identical_halves_folds_and_can_be_adjusted(self):
        # Arrange
        self.build_blank_spread()
        centre = SPREAD_WIDTH // 2

        # Act
        self.split_row(self.archive_path, 0, centre)

        # Assert - 対照。左右が本当に同じバイト列になっている。ここが違えば、
        # 記録が 1 件に潰れる状況そのものを作れておらず、以下は何も見ていない
        names = page_names(self.archive_path)
        self.assertEqual(4, len(names))
        earlier = entry_data(self.archive_path, names[0])
        later = entry_data(self.archive_path, names[1])
        self.assertEqual(earlier, later, "左右が同じバイト列になっていない")
        self.assertEqual((centre, SPREAD_HEIGHT), size_of(earlier))
        # 記録は 1 件しか持てない。鍵が中身のハッシュである以上、同じ
        # バイト列の 2 枚を別々に記録する場所が無い（形式は変えない）
        self.assertEqual(1, len(derived_of(self.archive_path)))

        # Act
        rows = list(self.splitter.scan_rows(self.archive_path))

        # Assert - 割った対は 1 行に畳まれ、位置も元の寸法も戻る
        self.assertEqual(3, len(rows), f"畳まれ方が違う: {[row.names for row in rows]}")
        pair = rows[0]
        self.assertEqual((names[0], names[1]), pair.names)
        self.assertEqual(self.splitter.SOURCE_ORIGINAL, pair.source)
        self.assertEqual((SPREAD_WIDTH, SPREAD_HEIGHT), (pair.width, pair.height))
        self.assertIsNotNone(pair.split)
        self.assertEqual(centre, pair.split.x)

        # Assert - 対照。中身が同じで隣り合うだけの 2 枚は畳まない。
        # 割った跡の無い 2 枚を対にすると、片方を割ったときもう片方が消える
        self.assertEqual(
            entry_data(self.archive_path, names[2]),
            entry_data(self.archive_path, names[3]),
            "単ページ 2 枚が同じ中身になっていない",
        )
        self.assertEqual([1, 1], [len(row.names) for row in rows[1:]])

        # Act - 畳めるだけでなく、動かせること
        self.splitter.apply_rows(
            self.archive_path,
            [replace(pair, split=self.splitter.SplitPosition(x=1000)), *rows[1:]],
        )

        # Assert - 新しい位置で割り直され、記録も 2 件に戻る
        moved = page_names(self.archive_path)
        self.assertEqual(4, len(moved))
        self.assertEqual(
            [(SPREAD_WIDTH - 1000, SPREAD_HEIGHT), (1000, SPREAD_HEIGHT)],
            [size_of(entry_data(self.archive_path, name)) for name in moved[:2]],
        )
        self.assertEqual(2, len(derived_of(self.archive_path)))
        reopened = list(self.splitter.scan_rows(self.archive_path))
        self.assertEqual(2, len(reopened[0].names))
        self.assertEqual(1000, reopened[0].split.x)


class EncodedBytesMatchTheEntryNameTest(SplitFixture):
    """書き込んだバイト列の形式が、そのエントリの拡張子と一致すること。

    中身が PNG なのに名前が .gif のファイルは、拡張子で復号器を選ぶ読み手に
    弾かれる。suzume-viewer が読めても、利用者が本を渡した先の別の読み手や
    サムネイル生成が読めない。中身と名前の食い違いは開くまで分からない。
    """

    # 小さめの見開き。BMP は無圧縮で、大きいと書庫が無用に膨れる
    WIDTH = 800
    HEIGHT = 600
    SPLIT_AT = 500

    def small_spread(self, fmt: str) -> bytes:
        return spread_bytes(
            width=self.WIDTH, height=self.HEIGHT, stripe_x=self.SPLIT_AT, fmt=fmt
        )

    def assert_pages_match_their_suffix(self) -> None:
        """ページとして残った全エントリの、名前と中身の形式を突き合わせる"""
        for name in page_names(self.archive_path):
            suffix = Path(name).suffix.lower()
            expected = FORMAT_BY_SUFFIX.get(suffix)
            self.assertIsNotNone(expected, f"viewer が読めない拡張子です: {name}")
            self.assertEqual(
                expected,
                format_of(entry_data(self.archive_path, name)),
                f"{name} の中身は拡張子どおりの形式ではありません",
            )

    def test_splitting_a_gif_page_writes_bytes_that_match_the_name(self):
        # Arrange
        build_archive(
            self.archive_path,
            {"p1.gif": self.small_spread("GIF"), "p2.png": tall_bytes("#808080")},
        )

        # Act
        self.split_row(self.archive_path, 0, self.SPLIT_AT)

        # Assert - 対照。左右非対称に本当に割れている。割れていない本で
        # 形式だけ突き合わせても、何も確かめたことにならない
        names = page_names(self.archive_path)
        self.assertEqual(3, len(names))
        self.assertEqual(
            [
                (self.WIDTH - self.SPLIT_AT, self.HEIGHT),
                (self.SPLIT_AT, self.HEIGHT),
            ],
            [size_of(entry_data(self.archive_path, name)) for name in names[:2]],
        )

        # Assert
        self.assert_pages_match_their_suffix()

    def test_restoring_a_bmp_original_writes_bytes_that_match_the_name(self):
        # Arrange - viewer が読めない BMP は、割った時点で .png になる
        build_archive(
            self.archive_path,
            {"p1.bmp": self.small_spread("BMP"), "p2.png": tall_bytes("#808080")},
        )
        self.split_row(self.archive_path, 0, self.SPLIT_AT)
        self.assertEqual(
            [".png", ".png", ".png"],
            [Path(name).suffix for name in page_names(self.archive_path)],
        )
        rows = list(self.splitter.scan_rows(self.archive_path))
        self.assertEqual(2, len(rows[0].names), f"対として畳めていない: {rows}")

        # Act - 割る前へ戻す。同梱されている元画像は BMP のまま
        self.splitter.apply_rows(
            self.archive_path, [replace(rows[0], split=None), rows[1]]
        )

        # Assert - 対照。割る前の見開きが画素として戻っている
        names = page_names(self.archive_path)
        self.assertEqual(2, len(names))
        restored = entry_data(self.archive_path, names[0])
        self.assertEqual((self.WIDTH, self.HEIGHT), size_of(restored))
        self.assertEqual(RED, colour_at(restored, 100, 300))
        self.assertEqual(BLUE, colour_at(restored, self.WIDTH - 1, 300))

        # Assert - 戻したページの名前は .png。中身も PNG でなければ、
        # 拡張子で復号器を選ぶ読み手はこのページを開けない
        self.assert_pages_match_their_suffix()


if __name__ == "__main__":
    unittest.main()
