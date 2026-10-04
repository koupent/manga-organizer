"""見開きを割る 2 つのジョブを、画面から叩ける形にする（#58 段階 2）。

段階 1 で ``manga_core.page_splitter`` が「走査して行を組む」「行ぜんぶを
受け取って 1 回で書き直す」を持った。画面（段階 3）はそれを直接は呼べない。
走査は数百枚の ZIP を 1 枚ずつ開くので要求の中では終わらず、確定は ZIP を
丸ごと書き直す。整理・解析と同じくジョブにして、受け付けだけを即返す。


公開契約（このテストが前提とする形。実装はこれに合わせる）
------------------------------------------------------------------
POST /api/jobs/split-scan
    {"archive": 絶対パス}
  → 202 {"id": "..."}
  → 400 許可の外 / 開けない（ジョブを作る前に、その場で断る）
  → 401 トークンが無い

GET /api/jobs/{id}
    kind    "split-scan"
    total   ページ数
    current 見終えたページ数
    result  {
      "archive":   絶対パス,
      "page_count": ページ数,
      "token":     いま並んでいるページ名と大きさから作る印,
      "rows": [{
        "names":    [ページ名, ...]  # 割った対は 2 つ（先に読む方が先）,
        "width":    int,
        "height":   int,
        "source":   "page" | "original",
        "is_spread": bool,
        "split":    {"x": int} | null
      }, ...]
    }

POST /api/jobs/split
    {"archive": 絶対パス, "token": 走査が返した印,
     "rows": [{"names": [...], "split": {"x": int} | null}, ...]}
  → 202 {"id": "..."}
  → 400 許可の外 / 印が古い / 行の名前を並べたものが今のページ順と違う
  → 401 トークンが無い

GET /api/jobs/{id}
    kind    "split"
    result  {"changed": bool, "page_count": int,
             "split_count": int, "restored_count": int, "adjusted_count": int}


なぜこの形か
------------------------------------------------------------------
**行は差分ではなく全部を送る。** 確定は連番を振り直すので、どのみち ZIP を
丸ごと書き直す。全部あれば「行の名前を並べたもの＝いまのページ順」を
サイドカーが照合できる。差分では、走査と確定の間に別のタブが同じ本を
書き換えたことを検出できず、名指しされた 2 枚目に無関係なページが入った
まま書き直しに入る。

**画面が送るのは意図だけ。** 名前と割る位置の 2 つきり。寸法も出どころも
送り返させない。送り返させると、画面が持っている古い寸法で切られる余地が
残る。ZIP と同梱の記録だけを正とする。

**token は走査と確定の間に本が動いたことの検出。** 中央ディレクトリから
読めるページ名と大きさだけで作るので安い。食い違えば 400 で断る。ここが
無いと、別のタブで割った直後の古い画面から確定が通り、行が指す名前が
別のページを指したまま書き直される。

**画像の経路は増やさない。** 畳まれた行は既存の
``GET /api/original?archive=&name=<先に読む方>`` で割る前の絵が出る。
畳まれていない行は ``/api/image``。画面は ``source`` で選ぶ。

画面側（段階 3）は別途。
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api import thumbnails  # noqa: E402
from manga_api.app import create_app  # noqa: E402
from manga_core.cover_editor import is_spread  # noqa: E402

# 左右で色を変え、割る位置に細い帯を立てる。枚数だけでは「割った」ことと
# 「同じ絵を 2 回書いた」ことを見分けられない
RED = "#ff2020"
BLUE = "#2020ff"
GREEN = "#20ff20"

# 割る位置を中央（1200）からずらす。中央のままだと、位置を無視して常に
# 真ん中で割る実装も、左右を取り違えた実装も、同じ寸法を出して通ってしまう
SPREAD_WIDTH = 2400
SPREAD_HEIGHT = 1800
SPLIT_X = 1600
STRIPE_WIDTH = 8

# 見開きに届かない横長。1380 / 1200 は 1.15 倍で、判定の閾値 1.2 に届かない。
# 「全部 True」で通る実装を落とすのはこの 1 枚だけなので、外さないこと
NEAR_WIDTH = 1380
NEAR_HEIGHT = 1200

PAGE_WIDTH = 1200
PAGE_HEIGHT = 1800

# 走査が返す 1 行の形。鍵が欠けると画面は「割れない行」と「載せ忘れ」を
# 区別できないので、集合ごと固定する
ROW_KEYS = {"names", "width", "height", "source", "is_spread", "split", "displaced"}
SCAN_KEYS = {"archive", "page_count", "token", "rows"}
CONFIRM_KEYS = {
    "changed",
    "page_count",
    "split_count",
    "restored_count",
    "adjusted_count",
    "joined_count",
}

THUMBNAIL_WIDTH = 240


def spread_bytes(
    width: int = SPREAD_WIDTH,
    height: int = SPREAD_HEIGHT,
    stripe_x: int | None = SPLIT_X,
) -> bytes:
    """左半分を赤、右半分を青に塗り、割る位置に緑の帯を立てた見開き。

    PNG にするのは、JPEG だと境目の色がにじんで画素の比較が当てにならず、
    「割れたかどうか」を色で確かめられなくなるため。
    """
    image = Image.new("RGB", (width, height), RED)
    right = Image.new("RGB", (width - width // 2, height), BLUE)
    image.paste(right, (width // 2, 0))
    if stripe_x is not None:
        image.paste(Image.new("RGB", (STRIPE_WIDTH, height), GREEN), (stripe_x, 0))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def tall_bytes(
    colour: str, width: int = PAGE_WIDTH, height: int = PAGE_HEIGHT
) -> bytes:
    """見開きではない単ページ。色を変えて中身で見分けられるようにする"""
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()


def build_archive(path: Path, entries: dict[str, bytes]) -> Path:
    """テスト用の ZIP を作る"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


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


def leans_red(data: bytes) -> bool:
    """縮小した絵の左寄りが赤いか。

    サムネイルは JPEG に焼き直されるので色は完全には一致しない。赤と青の
    どちらに寄っているかだけを見る。
    """
    with Image.open(io.BytesIO(data)) as opened:
        red, _green, blue = opened.convert("RGB").getpixel((30, opened.height // 2))
    return red > blue


class SplitApiTestBase(unittest.TestCase):
    """走査と確定の 2 経路を、画面と同じようにトークン付きで叩く土台"""

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

        # 許可された場所を実際に絞る。絞らないと根の検証が意味を持たない
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.archive = self.build_book(self.work_dir / "volume.zip")

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.token, **(params or {})}

    def build_book(self, path: Path) -> Path:
        """縦・見開き・見開きに届かない横長・縦、の 4 ページ。

        単ページの色を変えるのは、同じ中身だとハッシュが重なり、記録の
        突き合わせで別のページを指しても気づけないため。
        """
        return build_archive(
            path,
            {
                "001.png": tall_bytes("#101010"),
                "002.png": spread_bytes(),
                "003.png": spread_bytes(NEAR_WIDTH, NEAR_HEIGHT, stripe_x=None),
                "004.png": tall_bytes("#404040"),
            },
        )

    def job(self, job_id: str) -> dict:
        """ジョブ 1 件の今の状態"""
        response = self.client.get(f"/api/jobs/{job_id}", params=self.auth())
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def submit_scan(self, archive: Path | str, params: dict | None = None):
        """走査を投入する。受け付けたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/split-scan",
            params=self.auth() if params is None else params,
            json={"archive": str(archive)},
        )

    def scan_job(self, archive: Path | str) -> dict:
        """走査を投入し、終わったジョブを返す"""
        accepted = self.submit_scan(archive)
        self.assertEqual(
            202, accepted.status_code, f"走査の投入が受け付けられない: {accepted.text}"
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job

    def scan(self, archive: Path | str) -> dict:
        """走査の結果（archive / page_count / token / rows）"""
        return self.scan_job(archive)["result"]

    def rows_for(self, result: dict, changes: dict[int, dict | None] | None = None):
        """走査が返した行を、確定の依頼に載る形へ落とす。

        載せるのは名前と割る位置だけ。寸法や出どころまで送り返す形にすると、
        画面が持っている古い寸法で切られる余地が残る。
        """
        wanted = changes or {}
        return [
            {
                "names": row["names"],
                "split": wanted[index] if index in wanted else row["split"],
            }
            for index, row in enumerate(result["rows"])
        ]

    def submit_confirm(
        self,
        archive: Path | str,
        token: str,
        rows: list[dict],
        params: dict | None = None,
    ):
        """確定を投入する。受け付けたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/split",
            params=self.auth() if params is None else params,
            json={"archive": str(archive), "token": token, "rows": rows},
        )

    def confirm_job(self, archive: Path | str, token: str, rows: list[dict]) -> dict:
        """確定を投入し、終わったジョブを返す"""
        accepted = self.submit_confirm(archive, token, rows)
        self.assertEqual(
            202, accepted.status_code, f"確定の投入が受け付けられない: {accepted.text}"
        )
        return self.job(accepted.json()["id"])

    def confirmed(self, archive: Path | str, token: str, rows: list[dict]) -> dict:
        """確定が成功したことを確かめ、その結果を返す"""
        job = self.confirm_job(archive, token, rows)
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job["result"]

    def split_the_spread(self, archive: Path | None = None, x: int = SPLIT_X) -> dict:
        """見開きの行（2 行目）を x で割る。他の行はそのまま送り返す"""
        target = archive or self.archive
        scanned = self.scan(target)
        return self.confirmed(
            target, scanned["token"], self.rows_for(scanned, {1: {"x": x}})
        )


class SplitScanTest(SplitApiTestBase):
    """1. 走査が、画面に並べるとおりの行を返す"""

    def test_lists_every_page_in_order_and_flags_only_the_spread(self):
        # Arrange - 3 枚目は 1.15 倍で閾値に届かない。この 1 枚が無いと、
        # 「全部に印を付ける」実装でも下の並びを通せてしまう
        self.assertFalse(is_spread(NEAR_WIDTH, NEAR_HEIGHT), "下準備が想定と違う")

        # Act
        result = self.scan(self.archive)

        # Assert - 行の形は鍵ごと固定する。欠けると画面は「割れない行」と
        # 「載せ忘れ」を区別できない
        self.assertEqual(
            SCAN_KEYS, set(result), f"走査の結果の形が契約と違う: {result}"
        )
        self.assertEqual(str(self.archive), result["archive"])
        self.assertEqual(4, result["page_count"], result)
        self.assertEqual(ROW_KEYS, set(result["rows"][0]), result["rows"][0])

        # Assert - ページ順そのまま。1 行 1 ページで、まだ何も畳まれない
        self.assertEqual(
            [["001.png"], ["002.png"], ["003.png"], ["004.png"]],
            [row["names"] for row in result["rows"]],
            f"行がページ順に並んでいない: {result['rows']}",
        )

        # Assert - 印が付くのは見開きだけ。3 枚目に付くなら閾値を見ていない
        self.assertEqual(
            [False, True, False, False],
            [row["is_spread"] for row in result["rows"]],
            f"見開きの印が閾値どおりでない: {result['rows']}",
        )

        # Assert - 割る位置はこの寸法で解釈する。まだ割っていないので
        # 出どころはページそのもので、位置は空
        spread = result["rows"][1]
        self.assertEqual(
            (SPREAD_WIDTH, SPREAD_HEIGHT), (spread["width"], spread["height"])
        )
        self.assertEqual("page", spread["source"], spread)
        self.assertIsNone(spread["split"], spread)

    def test_the_scan_reports_a_determinate_progress(self):
        # Act
        job = self.scan_job(self.archive)

        # Assert - 分母はページ数。0 や 1 だと「進んでいる」ことを画面が
        # 見せられず、利用者は固まったのか読み込み中なのか分からない
        self.assertEqual("split-scan", job["kind"], job)
        self.assertEqual(4, job["total"], f"分母がページ数になっていない: {job}")
        self.assertNotIn(job["total"], (0, 1), f"分母が動かない値になっている: {job}")

        # Assert - 終わった時点では見終えた数が分母に届いている。状態だけを
        # 見ても進捗の証明にはならず、途中の値はポーリングでは捕まえられない
        self.assertEqual(
            job["total"], job["current"], f"見終えた数が分母に届いていない: {job}"
        )
        self.assertEqual(job["result"]["page_count"], job["total"], job)


class SplitConfirmTest(SplitApiTestBase):
    """2. 確定が実際に割り、開き直すと 1 行に畳まれて戻る"""

    def test_splitting_a_spread_adds_one_page_and_folds_back_into_one_row(self):
        # Act
        result = self.split_the_spread()

        # Assert - 数え方が 3 つに分かれているのは、画面が「割った」「戻した」
        # 「位置を動かした」を言い分けるため。まとめると報告が嘘になる
        self.assertEqual(
            CONFIRM_KEYS, set(result), f"確定の結果の形が契約と違う: {result}"
        )
        self.assertIs(True, result["changed"], result)
        self.assertEqual(
            5, result["page_count"], f"ページが 1 枚増えていない: {result}"
        )
        self.assertEqual(1, result["split_count"], result)
        self.assertEqual(0, result["restored_count"], result)
        self.assertEqual(0, result["adjusted_count"], result)

        # Assert - 枚数だけでは「同じ絵を 2 回書いた」実装も通る。右綴じなので
        # 先に読むのは右半分（青）、後が左半分（赤）。両方を見ることで
        # 左右を取り違えた実装もここで落ちる
        after = self.scan(self.archive)
        self.assertEqual(5, after["page_count"], after)
        self.assertEqual(4, len(after["rows"]), f"行が増減している: {after['rows']}")
        folded = after["rows"][1]
        self.assertEqual(
            2, len(folded["names"]), f"対が 1 行に畳まれていない: {folded}"
        )
        earlier = entry_data(self.archive, folded["names"][0])
        later = entry_data(self.archive, folded["names"][1])
        self.assertEqual((SPREAD_WIDTH - SPLIT_X, SPREAD_HEIGHT), size_of(earlier))
        self.assertEqual((SPLIT_X, SPREAD_HEIGHT), size_of(later))
        self.assertEqual(BLUE, colour_at(earlier, 400, 900), "先に読む方が右半分でない")
        self.assertEqual(RED, colour_at(later, 400, 900), "後に読む方が左半分でない")

        # Assert - 畳まれた行は割る前の絵を指す。ここが割った後の半分だと、
        # 画面は 800 幅の絵の上に 1600 の位置を置くことになり、二度と
        # 割り位置を直せない
        self.assertEqual("original", folded["source"], folded)
        self.assertEqual(
            (SPREAD_WIDTH, SPREAD_HEIGHT), (folded["width"], folded["height"])
        )
        self.assertEqual(
            {"x": SPLIT_X}, folded["split"], f"割った位置が戻らない: {folded}"
        )
        self.assertIs(True, folded["is_spread"], folded)

        # Assert - 割っていない行は巻き添えにならない
        self.assertEqual(
            [["001.png"], ["004.png"], ["005.png"]],
            [row["names"] for index, row in enumerate(after["rows"]) if index != 1],
            f"割っていない行まで動いている: {after['rows']}",
        )


class SplitTokenTest(SplitApiTestBase):
    """3. 走査と確定の間に本が動いたら断る"""

    def test_a_token_from_another_archive_is_refused_but_its_own_is_accepted(self):
        # Arrange - ページ名も枚数も同じで、絵の大きさだけが違う本を並べる。
        # 名前しか見ない印だと 2 冊が同じ値になり、古い画面からの確定が通る
        other = build_archive(
            self.work_dir / "other.zip",
            {
                "001.png": tall_bytes("#101010", 900, 1400),
                "002.png": spread_bytes(1800, 1300),
                "003.png": spread_bytes(1000, 900, stripe_x=None),
                "004.png": tall_bytes("#404040", 900, 1400),
            },
        )
        mine = self.scan(self.archive)
        theirs = self.scan(other)
        self.assertEqual(
            [row["names"] for row in mine["rows"]],
            [row["names"] for row in theirs["rows"]],
            "下準備が想定と違う: 2 冊のページ名がそろっていない",
        )
        self.assertNotEqual(
            mine["token"],
            theirs["token"],
            "並んでいるものが違うのに印が同じ。これでは本が動いたことを見分けられない",
        )
        before = self.archive.read_bytes()

        # Act - 自分の行に、他人の印を添えて確定する
        refused = self.submit_confirm(
            self.archive, theirs["token"], self.rows_for(mine, {1: {"x": SPLIT_X}})
        )

        # Assert - ジョブを作って失敗させるのではなく、その場で断る。作って
        # しまうと画面は受け付けられたと思い、割れたつもりで先へ進む
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertTrue(refused.json().get("detail"), refused.text)
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")

        # Act / Assert - 同じ行でも自分の印なら通る。これが無いと
        # 「印が何であれ断る」実装でも上の検証を通せる
        result = self.confirmed(
            self.archive, mine["token"], self.rows_for(mine, {1: {"x": SPLIT_X}})
        )
        self.assertEqual(1, result["split_count"], result)
        self.assertEqual(5, result["page_count"], result)

    def test_a_page_swapped_for_the_same_size_is_still_caught(self):
        """大きさが同じままでも、絵が変わったら断る。

        名前と展開後のバイト数だけを見る印では、同じ大きさに収まる別の絵に
        差し替えられたことが分からない。別のタブで表紙を切ったり並べ替えた
        直後の画面から確定すると、印が一致してしまい、**利用者が見ていない
        ページが割られる**。
        """
        # Arrange
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned, {1: {"x": SPLIT_X}})

        # Arrange - 1 枚目だけを、同じ寸法・別の色の絵に差し替える。
        # 単色の PNG は色が違ってもバイト数がそろうので、「大きさは同じまま
        # 中身だけ変わった」を、絵として壊さずに作れる
        with zipfile.ZipFile(self.archive) as archive:
            kept = {
                item.filename: archive.read(item.filename)
                for item in archive.infolist()
            }
        target = sorted(kept)[0]
        swapped = tall_bytes("#a0a0a0")
        self.assertEqual(
            len(kept[target]), len(swapped), "下準備が想定と違う: 大きさがそろわない"
        )
        self.assertNotEqual(kept[target], swapped, "下準備が想定と違う: 中身が同じ")
        kept[target] = swapped
        build_archive(self.archive, kept)

        # Arrange（対照）- 名前も枚数も展開後の大きさも、走査したときのまま。
        # ここが変わっていると、大きさで気づいただけの実装でも通ってしまう
        with zipfile.ZipFile(self.archive) as archive:
            now = [(item.filename, item.file_size) for item in archive.infolist()]
        self.assertEqual(
            [(name, len(data)) for name, data in sorted(kept.items())],
            sorted(now),
            "下準備が想定と違う: 大きさが変わっている",
        )
        before = self.archive.read_bytes()

        # Act
        refused = self.submit_confirm(self.archive, scanned["token"], rows)

        # Assert - 中身が変わったことを見分けて断る
        self.assertEqual(
            400,
            refused.status_code,
            f"絵が差し替わったのに通してしまう: {refused.text}",
        )
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")

        # Act / Assert - 差し替え後に走査し直した印なら通る。これが無いと
        # 「印が何であれ断る」実装でも上の検証を通せる
        fresh = self.scan(self.archive)
        result = self.confirmed(
            self.archive, fresh["token"], self.rows_for(fresh, {1: {"x": SPLIT_X}})
        )
        self.assertEqual(1, result["split_count"], result)


class SubmittedRowsCoverTheArchiveTest(SplitApiTestBase):
    """4. 行の名前を並べたものが、いまのページ順と 1 つも違わないこと"""

    def test_rows_that_leave_out_a_page_are_refused(self):
        # Arrange
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned)[:-1]
        before = self.archive.read_bytes()

        # Act
        refused = self.submit_confirm(self.archive, scanned["token"], rows)

        # Assert - 落としたいのか組み立て損ねたのかは、送られた側には
        # 区別が付かない。通すと、行を 1 つ作り損ねただけでページが消える
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")

    def test_rows_in_a_different_order_are_refused(self):
        # Arrange - 1 枚も欠けていないが、並びが今のページ順と違う
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned)
        rows[0], rows[2] = rows[2], rows[0]
        before = self.archive.read_bytes()

        # Act
        refused = self.submit_confirm(self.archive, scanned["token"], rows)

        # Assert - 並べ替えは別の経路の仕事。ここで受けると、割る画面を
        # 開いていた間に別のタブで動かした並びが黙って元へ戻る
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")

    def test_the_matching_rows_are_accepted(self):
        # Arrange - 上の 2 つと同じ本、同じ印。これが無いと「行が何であれ
        # 断る」実装でも上の 2 つを通せる
        scanned = self.scan(self.archive)

        # Act
        result = self.confirmed(
            self.archive, scanned["token"], self.rows_for(scanned, {1: {"x": SPLIT_X}})
        )

        # Assert
        self.assertIs(True, result["changed"], result)
        self.assertEqual(5, result["page_count"], result)


class SplitRestoreTest(SplitApiTestBase):
    """5. 割る前へ戻せること"""

    def test_restoring_a_pair_brings_back_the_single_wide_page(self):
        # Arrange - 一度割ってから開き直す。畳まれた 1 行が戻す対象
        self.split_the_spread()
        scanned = self.scan(self.archive)
        self.assertEqual(2, len(scanned["rows"][1]["names"]), scanned["rows"][1])

        # Act - その行の割る位置を空にして送り返す
        result = self.confirmed(
            self.archive, scanned["token"], self.rows_for(scanned, {1: None})
        )

        # Assert - 減った 1 枚は「戻した」として数える。割った数と同じ欄で
        # 数えると、画面は何が起きたのか言えない
        self.assertIs(True, result["changed"], result)
        self.assertEqual(4, result["page_count"], f"ページ数が戻っていない: {result}")
        self.assertEqual(1, result["restored_count"], result)
        self.assertEqual(0, result["split_count"], result)
        self.assertEqual(0, result["adjusted_count"], result)

        # Assert - 開き直すと、また普通の 1 行になる
        after = self.scan(self.archive)
        self.assertEqual(4, after["page_count"], after)
        restored = after["rows"][1]
        self.assertEqual(1, len(restored["names"]), f"対が残っている: {restored}")
        self.assertEqual("page", restored["source"], restored)
        self.assertIsNone(restored["split"], restored)
        self.assertEqual(
            (SPREAD_WIDTH, SPREAD_HEIGHT), (restored["width"], restored["height"])
        )

        # Assert - 枚数と寸法だけでは、片方の半分を引き伸ばした絵も通る。
        # 左が赤・右が青の 1 枚に戻っていることまで見る
        page = entry_data(self.archive, restored["names"][0])
        self.assertEqual((SPREAD_WIDTH, SPREAD_HEIGHT), size_of(page))
        self.assertEqual(RED, colour_at(page, 400, 900), "左半分が戻っていない")
        self.assertEqual(BLUE, colour_at(page, 2300, 900), "右半分が戻っていない")


class SeparatedPairTest(SplitApiTestBase):
    """6. ページ並べ替えで離れた対を、割る画面から戻せること（#133）"""

    def separate_the_pair(self) -> None:
        """見開きを割ったあと、左半分（3 ページ目）を末尾へ動かす"""
        from manga_core.page_reorder import ZipPageEditor

        self.split_the_spread()
        editor = ZipPageEditor(self.archive)
        names = [page.name for page in editor.pages]
        editor.apply_order([names[0], names[1], names[3], names[4], names[2]])
        editor.close()

    def test_a_separated_pair_is_folded_and_can_be_restored(self):
        # Arrange
        self.separate_the_pair()

        # Act
        scanned = self.scan(self.archive)

        # Assert - 右半分の位置に 1 行で畳まれ、離れていることが画面に伝わる
        self.assertEqual(4, len(scanned["rows"]), scanned["rows"])
        pair = scanned["rows"][1]
        self.assertEqual(2, len(pair["names"]), pair)
        self.assertIs(True, pair["displaced"], pair)

        # Act - 走査の行をそのまま、割る前へ戻すだけ変えて送る。行の名前を
        # 並べたものはいまのページ順と違うが、違うのは対の 2 枚目だけ
        result = self.confirmed(
            self.archive, scanned["token"], self.rows_for(scanned, {1: None})
        )

        # Assert - 見開きが 2 ページ目に戻る
        self.assertEqual(1, result["restored_count"], result)
        self.assertEqual(4, result["page_count"], result)
        page = entry_data(self.archive, self.scan(self.archive)["rows"][1]["names"][0])
        self.assertEqual((SPREAD_WIDTH, SPREAD_HEIGHT), size_of(page))

    def test_other_reorderings_are_still_refused(self):
        # Arrange - 対を畳んだうえで、関係の無い行まで入れ替える
        self.separate_the_pair()
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned)
        rows[2], rows[3] = rows[3], rows[2]
        before = self.archive.read_bytes()

        # Act
        refused = self.submit_confirm(self.archive, scanned["token"], rows)

        # Assert - 寄せてよいのは対の 2 枚目だけ。ほかの並べ替えは別の経路の仕事
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")


class SplitScanSecurityTest(SplitApiTestBase):
    """6. 走査にも、他の経路と同じ守りを付ける"""

    def test_requires_a_token(self):
        # Act - 走査はディスクを読む。トークン無しで叩けてはいけない
        response = self.submit_scan(self.archive, params={})

        # Assert
        self.assertEqual(401, response.status_code, response.text)

        # Assert - トークンを添えれば通る。これが無いと「何でも断る」実装でも
        # 上の検証を通せる
        self.assertEqual(202, self.submit_scan(self.archive).status_code)

    def test_refuses_an_archive_outside_the_allowed_roots(self):
        # Arrange - 許可の外と中に、同じ形の本を用意する
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = self.build_book(Path(outside_temp.name).resolve() / "許可の外.zip")

        # Act
        refused = self.submit_scan(outside)

        # Assert - 投入そのものを断る。ジョブを作って失敗させると、画面は
        # 受け付けられたと思ったまま後から失敗を知ることになる
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertIn(
            "対象外",
            refused.json().get("detail", ""),
            f"許可の外だから拒んだ、とは読めない: {refused.text}",
        )

        # Act / Assert - 同じ形でも許可の中なら走査する
        self.assertEqual(4, self.scan(self.archive)["page_count"])


class SplitConfirmSecurityTest(SplitApiTestBase):
    """7. 確定にも、他の経路と同じ守りを付ける"""

    def test_requires_a_token(self):
        # Arrange
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned, {1: {"x": SPLIT_X}})

        # Act - 確定は ZIP を書き直す。トークン無しで叩けてはいけない
        response = self.submit_confirm(self.archive, scanned["token"], rows, params={})

        # Assert
        self.assertEqual(401, response.status_code, response.text)

        # Assert - トークンを添えれば通る。これが無いと「何でも断る」実装でも
        # 上の検証を通せる
        self.assertEqual(
            202, self.submit_confirm(self.archive, scanned["token"], rows).status_code
        )

    def test_refuses_an_archive_outside_the_allowed_roots(self):
        # Arrange - 許可の外に本を置く。走査すら断られる場所なので、行と印は
        # 許可の中の本のものを使う。パスの検証が先に立つことを見る
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = self.build_book(Path(outside_temp.name).resolve() / "許可の外.zip")
        scanned = self.scan(self.archive)
        rows = self.rows_for(scanned, {1: {"x": SPLIT_X}})
        before = outside.read_bytes()

        # Act
        refused = self.submit_confirm(outside, scanned["token"], rows)

        # Assert - 断るのは投入の時点。ジョブにしてから失敗させると、許可の
        # 外を指したことが「失敗したジョブ」としてしか残らない
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertIn(
            "対象外",
            refused.json().get("detail", ""),
            f"許可の外だから拒んだ、とは読めない: {refused.text}",
        )
        self.assertEqual(before, outside.read_bytes(), "許可の外を書き換えている")

        # Act / Assert - 同じ形でも許可の中なら書き直す
        self.assertEqual(
            5, self.confirmed(self.archive, scanned["token"], rows)["page_count"]
        )


class SplitThumbnailCacheTest(SplitApiTestBase):
    """8. 割った後に、古いサムネイルを出さないこと"""

    def thumb(self, name: str):
        """画面と同じ経路でサムネイルを引く"""
        response = self.client.get(
            "/api/thumb",
            params=self.auth(
                {
                    "archive": str(self.archive),
                    "name": name,
                    "width": THUMBNAIL_WIDTH,
                }
            ),
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.content

    def cache_holds(self, name: str) -> bool:
        """キャッシュにその 1 枚があるか。

        引き当てるだけで済ませ、無ければ今の中身から作り直して入れておく。
        調べたことでキャッシュの中身が嘘になると、後の検証が濁る。
        """
        called = False

        def make() -> bytes:
            nonlocal called
            called = True
            return thumbnails.render(entry_data(self.archive, name), THUMBNAIL_WIDTH)

        self.app.state.thumbnails.get_or_create(
            (str(self.archive), name, THUMBNAIL_WIDTH), make
        )
        return not called

    def test_forgets_the_thumbnails_of_the_archive_it_rewrote(self):
        # Arrange - まず貯める。貯まっていない状態で「空だ」と確かめても、
        # 捨てたことの証明にはならない
        self.thumb("002.png")
        self.assertTrue(
            self.cache_holds("002.png"), "下準備が想定と違う: サムネイルが貯まらない"
        )

        # Act
        self.split_the_spread()

        # Assert - 連番が振り直されるので、002.png はもう別の絵。残っていると
        # 画面は割る前の見開きを並べ続ける
        self.assertFalse(
            self.cache_holds("002.png"), "書き直した本のサムネイルを捨てていない"
        )

    def test_serves_the_new_picture_for_a_renumbered_page(self):
        # Arrange - 割る前の 002.png は見開き。左端は赤い
        before = self.thumb("002.png")
        self.assertTrue(leans_red(before), "下準備が想定と違う: 見開きの左が赤くない")

        # Act
        self.split_the_spread()

        # Assert - 割った後の 002.png は右半分（青）。赤いままなら、画面は
        # 存在しない絵を並べ続けている
        self.assertFalse(
            leans_red(self.thumb("002.png")),
            "割った後も、同じ URL で割る前の絵が返る",
        )


class SplitCoreRefusalTest(SplitApiTestBase):
    """9. コアが断った行は、失敗したジョブとして伝わること"""

    def test_a_row_the_core_refuses_fails_the_job_without_touching_the_archive(self):
        # Arrange - 2 つ名前を持つのに、割った対ではない行。名前を並べたものは
        # 今のページ順そのものなので、境界の照合は通り抜けてコアまで届く
        scanned = self.scan(self.archive)
        rows = [
            {"names": ["001.png", "002.png"], "split": None},
            {"names": ["003.png"], "split": None},
            {"names": ["004.png"], "split": None},
        ]
        before = self.archive.read_bytes()

        # Act
        accepted = self.submit_confirm(self.archive, scanned["token"], rows)

        # Assert - 受け付け自体は通る。500 で返すと、画面には原因の分からない
        # 「サーバーエラー」しか出ない
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job(accepted.json()["id"])
        self.assertEqual("failed", job["state"], job)

        # Assert - どの行で断られたのかが分かる形で残る。理由を落とすと、
        # 利用者は何を直せばいいのか分からない
        self.assertTrue(job["error"], job)
        self.assertIn("001.png", job["error"], f"断った行が分からない: {job['error']}")

        # Assert - 書き直しの計画を組む前に断るので、本は 1 バイトも変わらない
        self.assertEqual(before, self.archive.read_bytes(), "断ったのに書き換えている")


if __name__ == "__main__":
    unittest.main()
