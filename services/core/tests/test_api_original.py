"""画面が「本当の元画像」を引く経路を検証する（#66 画面側）。

いまサムネイル作成画面が開くのは、保存済みの（＝すでに切り抜かれた）画像なので、
範囲を縮めることしかできない。元画像が ZIP に同梱されているなら、そちらを対象に
すれば枠を広げる方向へも戻せる。そのために画面は次の 2 つを取れる必要がある。

    GET /api/cover   -> いま見ている 1 枚に対応する元画像の寸法と、施した加工
    GET /api/original -> その元画像そのもののバイト列（画面が表示する絵）

``/api/cover`` に相乗りさせるのは、画面が「この 1 枚をどう見せるか」を決めるのに
寸法・見開き判定と元画像の有無を必ず同時に要るため。別の入口に分けると、
2 回問い合わせる間に片方だけ古い値を見た状態が作れてしまう。

バイト列だけは別の入口にする。画像は JSON に載らないうえ、``/api/cover`` は
画面の描き直しのたびに引かれる軽い経路であってほしい。

元画像の ZIP 内エントリ名は返さない。返すと、書き換えられた manifest を使って
画面からアーカイブ内の任意のエントリを読ませる道ができる。画面が要るのは
「いま見ている 1 枚の元画像」だけなので、その 1 枚を指す入口だけを開ける。
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

from manga_api.app import create_app  # noqa: E402
from manga_core.original_store import ORIGINALS_PREFIX  # noqa: E402

# 加工前のページの寸法。切り抜き後と必ず食い違う大きさにする
PAGE_SIZE = (800, 1200)

# 1 回目の切り抜き。中央でも端でもない範囲にして、
# 「たまたま既定の値と一致した」で通らないようにする
FIRST_CROP = [100, 150, 500, 750]
FIRST_CROP_SIZE = (400, 600)

# 2 回目の切り抜き。1 回目の結果（400×600）の中の範囲
SECOND_CROP = [0, 0, 200, 300]
SECOND_CROP_SIZE = (200, 300)

PAGES = (("page-a.jpg", "red"), ("page-b.jpg", "lime"), ("page-c.jpg", "blue"))


def make_page(color: str, size: tuple[int, int] = PAGE_SIZE) -> bytes:
    """検証用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "JPEG", quality=90)
    return buffer.getvalue()


class OriginalApiTestBase(unittest.TestCase):
    """加工済みの本と、一度も加工していない本を 1 冊ずつ用意する"""

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

        self.edited = self.write_archive("加工済み.zip")
        self.untouched = self.write_archive("未加工.zip")

        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def write_archive(self, name: str) -> Path:
        path = self.work_dir / name
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for entry, color in PAGES:
                archive.writestr(entry, make_page(color))
        return path

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.token, **(params or {})}

    def crop(self, archive: Path, name: str, box: list[int]) -> dict:
        """画面と同じ経路で 1 枚を切り抜いて確定する。

        画面は make_first を立てて確定するので、確定のたびにページは連番へ
        振り直される。名前で紐づける実装がここで落ちる。
        """
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={
                "archive": str(archive),
                "name": name,
                "crop": box,
                "make_first": True,
            },
        )
        self.assertEqual(202, submitted.status_code, submitted.text)
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job["result"]

    def cover(self, archive: Path) -> dict:
        """画面が開いたときに引くのと同じ内容"""
        response = self.client.get(
            "/api/cover", params=self.auth({"archive": str(archive)})
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def stored_original_bytes(self, archive: Path) -> bytes:
        """ZIP に同梱された元画像そのもの。応答と突き合わせる物差しにする"""
        with zipfile.ZipFile(archive) as opened:
            names = [n for n in opened.namelist() if n.startswith(ORIGINALS_PREFIX)]
            self.assertEqual(1, len(names), f"元画像の同梱が 1 枚ではない: {names}")
            return opened.read(names[0])


class CoverOriginalTest(OriginalApiTestBase):
    """いま見ている 1 枚に対応する元画像の情報を返す経路"""

    def test_reports_the_original_a_cropped_cover_came_from(self):
        # Arrange - 画面から 1 回切り抜いて確定する
        result = self.crop(self.edited, "page-a.jpg", FIRST_CROP)
        self.assertEqual(list(FIRST_CROP_SIZE), [result["width"], result["height"]])

        # Act - 開き直したときに画面が引く内容
        payload = self.cover(self.edited)

        # Assert - いま保存されているのは切り抜き後の 1 枚
        self.assertEqual("001.jpg", payload["name"])
        self.assertEqual(FIRST_CROP_SIZE, (payload["width"], payload["height"]))

        # Assert - 元画像の寸法が分かる。これが無いと枠を広げる先が無い
        self.assertIn("original", payload, f"元画像の情報が無い: {payload}")
        original = payload["original"]
        self.assertIsNotNone(original, f"元画像があるのに None: {payload}")
        self.assertEqual(
            PAGE_SIZE,
            (original["width"], original["height"]),
            f"切り抜き後の寸法をそのまま返している: {original}",
        )

        # Assert - 何をした結果いまの 1 枚になったかが分かる。
        # 画面はこれを読んで、前回の範囲を枠として置き直す
        self.assertEqual(
            [{"kind": "crop", "params": {"box": FIRST_CROP}}],
            original["operations"],
            f"施した加工が復元できない: {original}",
        )

    def test_reports_no_original_for_a_book_that_was_never_edited(self):
        # Act - 一度も加工していない本
        payload = self.cover(self.untouched)

        # Assert - 元画像が「無い」ことが分かる。キーごと省くと、無いのか
        # 数えていないのかを画面から区別できない
        self.assertIn("original", payload, f"元画像の有無が分からない: {payload}")
        self.assertIsNone(payload["original"], f"無いはずの元画像がある: {payload}")

        # Assert - 従来の内容は変わらない
        self.assertEqual("page-a.jpg", payload["name"])
        self.assertEqual(PAGE_SIZE, (payload["width"], payload["height"]))

    def test_keeps_pointing_at_the_first_original_after_editing_twice(self):
        # Arrange - 2 回続けて切り抜く。2 回目の対象は 1 回目の結果
        self.crop(self.edited, "page-a.jpg", FIRST_CROP)
        second = self.crop(self.edited, "001.jpg", SECOND_CROP)
        self.assertEqual(list(SECOND_CROP_SIZE), [second["width"], second["height"]])

        # Act
        payload = self.cover(self.edited)
        self.assertIn("original", payload, f"元画像の情報が無い: {payload}")
        original = payload["original"]

        # Assert - 遡る先は最初の 1 枚のまま。中間の 400×600 で止まると、
        # 加工を重ねるたびに戻せる範囲が痩せていく
        self.assertIsNotNone(original, "2 回加工したら元画像を見失った")
        self.assertEqual(
            PAGE_SIZE,
            (original["width"], original["height"]),
            f"中間結果を元画像として返している: {original}",
        )

        # Assert - 元画像から見た適用順で、2 回ぶんが並ぶ
        self.assertEqual(
            [
                {"kind": "crop", "params": {"box": FIRST_CROP}},
                {"kind": "crop", "params": {"box": SECOND_CROP}},
            ],
            original["operations"],
            f"加工の並びが元画像から見た順になっていない: {original}",
        )


class OriginalImageTest(OriginalApiTestBase):
    """元画像そのもののバイト列を返す経路"""

    def fetch(self, archive: Path, name: str):
        return self.client.get(
            "/api/original", params=self.auth({"archive": str(archive), "name": name})
        )

    def test_serves_the_original_bytes_and_reports_when_there_is_none(self):
        # Arrange
        self.crop(self.edited, "page-a.jpg", FIRST_CROP)

        # Act - 画面はいま見ている 1 枚の名前で元画像を求める
        response = self.fetch(self.edited, "001.jpg")

        # Assert - ZIP に同梱された元画像そのものが、1 バイトも変えずに返る
        self.assertEqual(200, response.status_code, response.text)
        self.assertTrue(
            response.headers["content-type"].startswith("image/"),
            response.headers["content-type"],
        )
        self.assertEqual(self.stored_original_bytes(self.edited), response.content)
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(PAGE_SIZE, image.size, "切り抜き後の画像を返している")

        # Assert - 元画像が無い本では、無いと分かる。同じ判定を 1 つの
        # テストで見るのは、経路そのものが無くても 404 になるため。
        # 「無い」側だけでは実装せずとも通ってしまう
        missing = self.fetch(self.untouched, "page-a.jpg")
        self.assertEqual(404, missing.status_code, missing.text)

    def test_requires_a_token(self):
        # Arrange
        self.crop(self.edited, "page-a.jpg", FIRST_CROP)

        # Act - トークンを付けずに取りに行く
        response = self.client.get(
            "/api/original",
            params={"archive": str(self.edited), "name": "001.jpg"},
        )

        # Assert - 同一 PC の他プロセスに元画像を渡さない
        self.assertEqual(401, response.status_code, response.text)

    def test_refuses_an_archive_outside_the_allowed_roots(self):
        # Act / Assert - 許可された場所の外は開かない
        response = self.client.get(
            "/api/original", params=self.auth({"archive": "/etc/passwd", "name": "x"})
        )
        self.assertEqual(400, response.status_code, response.text)


if __name__ == "__main__":
    unittest.main()
