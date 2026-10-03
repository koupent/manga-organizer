"""サイドカー API を検証する。

127.0.0.1 でのみ待ち受け、起動ごとの使い捨てトークンを必須にする
（#16 の page_editor_server の設計を踏襲）。
"""

import inspect
import io
import re
import sys
import unittest
import zipfile
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import NamedTuple
from unittest import mock

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_core.api_client import AniListClient  # noqa: E402
from manga_core.viewer_contract import is_viewer_page  # noqa: E402


def make_page(color: str = "navy") -> bytes:
    """テスト用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", (800, 1200), color).save(buffer, "JPEG")
    return buffer.getvalue()


# いま公開している /api/ の経路数。経路を app.routes から数え直すテストが
# 「1 つも見つからないまま合格」する空振りに落ちないための下限。経路を
# 増やしたらここも上げる
PUBLISHED_API_ROUTE_COUNT = 22

# パスらしい引数を名前で見分ける手がかり。名前で拾う以上、これに当たらない
# 名前を付けられれば見落とすので、拾いすぎる側に倒してある
PATH_NAME_HINTS = (
    "archive",
    "path",
    "dir",
    "file",
    "source",
    "folder",
    "target",
    "root",
)

# ドロップされたファイルの「名前」であってパスではない。許可された場所の
# 中から探すための手がかりなので、これ自体が外を指すことはない
NOT_A_FILESYSTEM_PATH = frozenset({("POST", "/api/resolve", "files")})

# 許可の外を「断る」のではなく、利用者が選んだ場所として「受け取る」経路。
# 書き出す先の許可はここでしか増えないので、外を指したときに 400 を期待する
# guarded_cases() の表には入れられない（入れると、この経路の存在意義である
# 「許可の外を選べる」ことを禁じるテストになる）。断る側の確かめは
# test_output_directory_guard.py が受け持つ
CHOOSES_A_PATH = frozenset({("POST", "/api/output-roots", "directory")})


class GuardedCase(NamedTuple):
    """許可の外を断る経路 1 つと、その確かめ方。

    ``expected`` は許可の中を指したときに返る状態。断り（400）と必ず違う値に
    する。同じにすると「何を渡しても断る」実装でも表が通ってしまう。
    """

    method: str
    path: str
    parameter: str
    build: Callable[[dict], dict]
    shape: str
    expected: int


def api_routes(app) -> list[APIRoute]:
    """/api/ 配下の経路を、宣言された場所によらず集める。

    /openapi.json と /docs は APIRoute ですらなく /api/ でもないので、この
    絞り込みだけで自然に外れる。除外の一覧を持たずに済ませるための形。
    """
    return [
        route
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/api/")
    ]


def flattened_dependencies(dependant):
    """依存を入れ子ごと平らに辿り、呼ばれるものを並べる。

    FastAPI 0.141 には get_flat_dependant が無く、あっても私用の API なので
    自前で辿る。経路と router のどちらに付けられていても同じように見つかる。
    """
    for sub in dependant.dependencies:
        yield sub.call
        yield from flattened_dependencies(sub)


def discover_path_parameters(schema: dict) -> set[tuple[str, str, str]]:
    """公開しているスキーマから、パスらしい引数を取る経路を数え上げる。

    手で並べた一覧だけで見ていると、後から足した経路が誰にも見られないまま
    通ってしまう。スキーマ側から数えれば、経路を足した人は「表に足す」か
    「パスではないと言い切る」かのどちらかを選ばされる。

    見るのはクエリと要求本体の直下だけで、入れ子のモデルの中までは辿らない。
    """
    schemas = schema.get("components", {}).get("schemas", {})
    found: set[tuple[str, str, str]] = set()
    for path, operations in schema["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, operation in operations.items():
            names = [parameter["name"] for parameter in operation.get("parameters", [])]
            body = (
                operation.get("requestBody", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
            )
            reference = body.get("$ref")
            if reference:
                model = schemas.get(reference.rsplit("/", 1)[-1], {})
                names += list(model.get("properties", {}))
            found.update(
                (method.upper(), path, name)
                for name in names
                if any(hint in name.lower() for hint in PATH_NAME_HINTS)
            )
    return found


class ApiTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        self.archive = self.work_dir / "volume.zip"
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("002.jpg", "001.jpg", "003.jpg"):
                archive.writestr(name, make_page())

        # allowed_roots を渡さないと任意のファイルを読めてしまう。
        # シェルは必ず渡す前提なので、テストでも実際に制限を効かせる
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self, params: dict | None = None) -> dict:
        """トークン付きのクエリを組み立てる"""
        return {"token": self.token, **(params or {})}


class AuthorizationTest(ApiTestBase):
    def test_every_route_requires_a_token(self):
        """トークンを必須にし忘れた経路を、宣言された場所によらず見つける。

        手で並べた 5 経路だけを見ていたときは、一覧に足し忘れた経路が誰にも
        見られないまま公開されていた。app.routes から数え直せば、どこに
        書かれていても漏れない。
        """
        # Arrange
        routes = api_routes(self.app)
        self.assertGreaterEqual(
            len(routes),
            PUBLISHED_API_ROUTE_COUNT,
            "/api/ の経路が見つからない、または減っている。"
            "経路を数えられずに空振りしていないか確かめること",
        )

        # Act / Assert
        for route in routes:
            with self.subTest(route=f"{sorted(route.methods)} {route.path}"):
                called = {
                    getattr(call, "__name__", "")
                    for call in flattened_dependencies(route.dependant)
                }
                self.assertIn(
                    "require_token",
                    called,
                    f"{route.path} がトークン無しで呼べる。"
                    "dependencies=guarded を付けること",
                )

    def test_every_route_rejects_a_missing_token(self):
        """付け忘れの結果、つまり 401 が返ることまで確かめる。

        依存が並んでいても、検証が実際に走らなければ意味がない。
        """
        # Act / Assert - 経路変数の値は何でもよい。トークンの検証は先に走る
        for route in api_routes(self.app):
            path = re.sub(r"\{[^}]+\}", "unused", route.path)
            for method in sorted(route.methods):
                with self.subTest(route=f"{method} {path}"):
                    response = self.client.request(method, path, json={})
                    self.assertEqual(401, response.status_code)

    def test_rejects_a_wrong_token(self):
        # Act / Assert
        response = self.client.get("/api/health", params={"token": "wrong"})
        self.assertEqual(401, response.status_code)

    def test_accepts_the_issued_token(self):
        # Act
        response = self.client.get("/api/health", params=self.auth())

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("ok", response.json()["status"])


class OpenApiTest(ApiTestBase):
    def test_publishes_a_schema_for_type_generation(self):
        # Act - フロントの型生成に使うため認証なしで取得できる
        response = self.client.get("/openapi.json")

        # Assert
        self.assertEqual(200, response.status_code)
        schema = response.json()
        self.assertIn("/api/jobs/organize", schema["paths"])
        self.assertIn("/api/pages", schema["paths"])
        # 見開きを割る 2 つ（#58 段階 2）。画面はここから生成した型で叩くので、
        # 載っていないと経路があっても画面から呼べない
        self.assertIn("/api/jobs/split-scan", schema["paths"])
        self.assertIn("/api/jobs/split", schema["paths"])


class EventLoopTest(ApiTestBase):
    def test_no_api_endpoint_is_a_coroutine(self):
        """/api/ の処理を async def にしない。

        同期の関数なら Starlette がスレッドプールへ逃がすが、async def に
        すると同じイベントループの上で走る。ZIP の読み書きと PIL の変換は
        止まっている時間が長いので、1 本の重い要求がループを占有し、
        サイドカーへの他の要求が全部その後ろに並ぶ。数百ページの本を開いた
        まま別の操作をすると画面が固まる、という形で表に出る。

        この取り違えはスキーマにも既存のテストにも現れない。async を付けても
        openapi.json は 1 バイトも変わらず、1 本ずつ叩くテストは詰まらない。
        """
        # Act
        coroutines = [
            route.path
            for route in api_routes(self.app)
            if inspect.iscoroutinefunction(route.endpoint)
        ]

        # Assert
        self.assertEqual(
            [],
            coroutines,
            "async def にすると ZIP と PIL の処理がイベントループを塞ぐ。"
            "同期のまま書き、重い処理はジョブへ回すこと",
        )


class AllowedRootsTest(ApiTestBase):
    """許可された場所の外を指されたら、開く前に断ることを経路ごとに見る。

    openapi.json の比較では見つけられない。refuse_outside の呼び出しが 1 つ
    抜け落ちても、公開しているスキーマは 1 バイトも変わらないため、ここが
    唯一の網になる。
    """

    def setUp(self):
        super().setUp()
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        self.outside = Path(outside_temp.name).resolve()
        self.outside_archive = self.outside / "外.zip"
        with zipfile.ZipFile(
            self.outside_archive, "w", zipfile.ZIP_DEFLATED
        ) as archive:
            for name in ("001.jpg", "002.jpg", "003.jpg"):
                archive.writestr(name, make_page())

    def scanned_rows(self, archive: str) -> tuple[str, list[dict]]:
        """割る画面を開いたときと同じ印と行を、走査から取る。

        許可の外は走査そのものが断られる。その場合は印の無いまま送るが、
        確定は印を見るより先に場所で断るので、確かめたいことは変わらない。
        """
        accepted = self.client.request(
            "POST",
            "/api/jobs/split-scan",
            params=self.auth(),
            json={"archive": archive},
        )
        if accepted.status_code != 202:
            return "", []
        job = self.client.get(
            f"/api/jobs/{accepted.json()['id']}", params=self.auth()
        ).json()
        result = job["result"]
        return result["token"], [
            {"names": row["names"], "split": None} for row in result["rows"]
        ]

    def guarded_cases(self) -> list[GuardedCase]:
        """許可の外を断る経路を、確かめ方とともに並べる。

        /api/original だけ許可の中でも 404 なのは、加工していないページには
        元画像の記録が無いため。場所の検査そのものは通過している。
        """

        def query(**extra):
            return lambda target: {"params": self.auth({**extra, **target})}

        def body(**extra):
            return lambda target: {"params": self.auth(), "json": {**extra, **target}}

        def split_body(target):
            token, rows = self.scanned_rows(target["archive"])
            return {
                "params": self.auth(),
                "json": {"archive": target["archive"], "token": token, "rows": rows},
            }

        page = {"name": "001.jpg"}
        return [
            GuardedCase("GET", "/api/pages", "archive", query(), "archive", 200),
            GuardedCase("GET", "/api/thumb", "archive", query(**page), "archive", 200),
            GuardedCase("GET", "/api/image", "archive", query(**page), "archive", 200),
            GuardedCase(
                "GET", "/api/original", "archive", query(**page), "archive", 404
            ),
            GuardedCase("GET", "/api/cover", "archive", query(), "archive", 200),
            GuardedCase("GET", "/api/browse", "path", query(), "directory", 200),
            GuardedCase(
                "POST", "/api/jobs/cover", "archive", body(**page), "archive", 202
            ),
            GuardedCase(
                "POST",
                "/api/jobs/reorder",
                "archive",
                body(order=["001.jpg", "002.jpg", "003.jpg"]),
                "archive",
                202,
            ),
            GuardedCase(
                "POST", "/api/jobs/split-scan", "archive", body(), "archive", 202
            ),
            GuardedCase(
                "POST", "/api/jobs/split", "archive", split_body, "archive", 202
            ),
            GuardedCase(
                "POST", "/api/jobs/analyze", "archives", body(), "archive_list", 202
            ),
            GuardedCase(
                "POST",
                "/api/jobs/organize",
                "archives",
                body(output_directory=str(self.work_dir / "出力")),
                "archive_list",
                202,
            ),
            # 書き出す側。読む側と同じく、許可の中を指したときだけ通る。
            # 許可の外へ書き出したい利用者は、その場所を選んだと伝えてから
            # 投入する（test_output_directory_guard.py）。ここは選ぶ前の姿
            GuardedCase(
                "POST",
                "/api/jobs/organize",
                "output_directory",
                body(archives=[str(self.archive)]),
                "output_directory",
                202,
            ),
        ]

    def targets(self, shape: str, inside: bool) -> dict:
        """経路が受け取る形に合わせて、許可の中／外を指す値を組み立てる"""
        directory = self.work_dir if inside else self.outside
        archive = self.archive if inside else self.outside_archive
        if shape == "directory":
            return {"path": str(directory)}
        if shape == "archive_list":
            return {"archives": [str(archive)]}
        if shape == "output_directory":
            return {"output_directory": str(directory / "出力")}
        return {"archive": str(archive)}

    def test_covers_every_route_that_takes_a_path(self):
        """公開しているスキーマ側から数え直し、表の見落としを表に出す"""
        # Act
        discovered = discover_path_parameters(self.app.openapi())
        classified = (
            {(case.method, case.path, case.parameter) for case in self.guarded_cases()}
            | NOT_A_FILESYSTEM_PATH
            | CHOOSES_A_PATH
        )

        # Assert
        self.assertEqual(
            classified,
            discovered,
            "パスを受け取る経路が増減している。guarded_cases() に足すか、"
            "パスではないと言い切って集合へ足すこと",
        )

    def test_refuses_a_target_outside_the_allowed_roots(self):
        """経路ごとに、外は断り・中は通ることを対で見る。

        断りだけを見ると「何を渡しても断る」実装が合格してしまうので、
        必ず許可の中を指した場合と組にする。
        """
        # Act / Assert
        for case in self.guarded_cases():
            with self.subTest(
                route=f"{case.method} {case.path}", parameter=case.parameter
            ):
                refused = self.client.request(
                    case.method,
                    case.path,
                    **case.build(self.targets(case.shape, inside=False)),
                )
                self.assertEqual(
                    400,
                    refused.status_code,
                    f"{case.method} {case.path} の {case.parameter} が"
                    "許可の外を開こうとしている",
                )
                accepted = self.client.request(
                    case.method,
                    case.path,
                    **case.build(self.targets(case.shape, inside=True)),
                )
                self.assertEqual(
                    case.expected,
                    accepted.status_code,
                    f"{case.method} {case.path} が許可の中まで断っている",
                )


class PagesTest(ApiTestBase):
    def test_lists_pages_in_lexicographic_order(self):
        # Act - viewer と同じ並び
        response = self.client.get(
            "/api/pages", params=self.auth({"archive": str(self.archive)})
        )

        # Assert
        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual(
            ["001.jpg", "002.jpg", "003.jpg"], [p["name"] for p in payload["pages"]]
        )

    def test_serves_a_thumbnail(self):
        # Act
        response = self.client.get(
            "/api/thumb",
            params=self.auth(
                {"archive": str(self.archive), "name": "001.jpg", "width": 160}
            ),
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("image/jpeg", response.headers["content-type"])
        with Image.open(io.BytesIO(response.content)) as thumbnail:
            self.assertEqual(160, thumbnail.width)

    def test_serves_the_full_size_image(self):
        # Act - 原寸表示に使う
        response = self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "001.jpg"}),
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertEqual("image/jpeg", response.headers["content-type"])
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual((800, 1200), image.size)

    def test_rejects_a_full_size_request_for_an_unknown_page(self):
        # Act / Assert
        response = self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "../secret.jpg"}),
        )
        self.assertEqual(404, response.status_code)

    def test_rejects_an_archive_outside_the_allowed_roots(self):
        # Act / Assert - 任意のファイルを読ませない
        response = self.client.get(
            "/api/pages", params=self.auth({"archive": "/etc/passwd"})
        )
        self.assertEqual(400, response.status_code)

    def test_rejects_a_page_that_is_not_in_the_archive(self):
        # Act / Assert
        response = self.client.get(
            "/api/thumb",
            params=self.auth({"archive": str(self.archive), "name": "../secret.jpg"}),
        )
        self.assertEqual(404, response.status_code)


class ImageFreshnessTest(ApiTestBase):
    """加工でページの中身が変わったら、同じ URL でも古い絵を出させない。

    加工しても名前は変わらないことがあるので、URL は加工の前後で同じになる。
    日持ちさせて返すと、ブラウザは取りに行かず加工前の絵を描き続ける。
    ファイルの日時は加工が元に戻すため、日時では変わったことを見分けられない。
    """

    def image(self, headers: dict | None = None):
        return self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "001.jpg"}),
            headers=headers or {},
        )

    def crop_first_page(self) -> None:
        """画面と同じ経路で 1 枚を切り抜く。名前は 001.jpg のまま変わらない"""
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={
                "archive": str(self.archive),
                "name": "001.jpg",
                "crop": [0, 0, 400, 600],
            },
        )
        self.assertEqual(202, submitted.status_code, submitted.text)
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))

    def test_asks_the_browser_to_check_before_reusing_an_image(self):
        # Act
        response = self.image()

        # Assert - 「使う前に必ず確かめる」。日持ちさせない
        self.assertEqual(200, response.status_code)
        self.assertEqual("no-cache", response.headers["cache-control"])
        self.assertTrue(response.headers.get("etag"), response.headers)

    def test_serves_the_new_image_after_an_edit_at_the_same_url(self):
        # Arrange - 加工前の版を持っている状態
        before = self.image()
        self.crop_first_page()

        # Act - ブラウザが持っている版を添えて、同じ URL を引き直す
        after = self.image({"If-None-Match": before.headers["etag"]})

        # Assert - 取り直しになり、届くのは加工後の 1 枚
        self.assertEqual(200, after.status_code)
        self.assertNotEqual(before.headers["etag"], after.headers["etag"])
        with Image.open(io.BytesIO(after.content)) as image:
            self.assertEqual((400, 600), image.size)

    def test_answers_304_while_the_image_is_unchanged(self):
        # Arrange
        first = self.image()

        # Act - 何も加工していないので、持っている版がそのまま使える
        again = self.image({"If-None-Match": first.headers["etag"]})

        # Assert - 中身を送り直さない。日持ちを外しても転送量は増えない
        self.assertEqual(304, again.status_code)
        self.assertEqual(b"", again.content)


class ConditionalRequestTest(ApiTestBase):
    """ブラウザが送ってくる If-None-Match の書き方を、規格どおりに読む。

    /api/image と /api/original は同じ判定を通る。ここが厳しすぎると、
    ブラウザは同じ画像を何度でも丸ごと受け取り直す。200 ページの本を
    開き直すたびに全ページが再送されるので、no-cache にした前提が崩れる。

    規格（RFC 9110 13.1.2）で決まっているのは 3 つ。

        W/"..."   弱い検証子。If-None-Match は弱い比較で照合する
        *         版を問わず、表現があるなら一致とみなす
        a, b, c   どれか 1 つに当たれば一致

    どれもブラウザが実際に送る形で、こちらが選べるものではない。
    """

    def image(self, headers: dict | None = None):
        return self.client.get(
            "/api/image",
            params=self.auth({"archive": str(self.archive), "name": "001.jpg"}),
            headers=headers or {},
        )

    def current_tag(self) -> str:
        """いま届く版の目印。中身そのもののハッシュから決まる"""
        first = self.image()
        self.assertEqual(200, first.status_code, first.text)
        return first.headers["etag"]

    def assert_not_modified(self, header: str) -> None:
        response = self.image({"If-None-Match": header})
        self.assertEqual(
            304, response.status_code, f"{header} を持っているのに送り直している"
        )
        self.assertEqual(b"", response.content)

    def assert_sends_the_image(self, header: str) -> None:
        """持っていない版を名乗ったときは中身が届く。常に 304 では困る"""
        response = self.image({"If-None-Match": header})
        self.assertEqual(200, response.status_code, f"{header} で送ってこない")
        self.assertTrue(response.content)

    def test_accepts_a_weak_validator_for_the_current_version(self):
        # Arrange - 同じ版を弱い検証子として名乗る。中身は 1 バイトも変えない
        tag = self.current_tag()

        # Act / Assert
        self.assert_not_modified(f"W/{tag}")

        # Assert - 別の版を名乗れば届く。いつでも 304 では中身が古いままになる
        # （ヘッダは ASCII しか通らないので、名乗る版は英字で書く）
        self.assert_sends_the_image('W/"other-version"')

    def test_accepts_the_wildcard(self):
        # Arrange - 版を問わない書き方。表現がある限り一致する
        self.current_tag()

        # Act / Assert
        self.assert_not_modified("*")

    def test_accepts_a_list_that_contains_the_current_version(self):
        # Arrange - 複数の版を並べて送ってくる。当たりは弱い検証子で混ざる
        tag = self.current_tag()

        # Act / Assert
        self.assert_not_modified(f'"other-version", W/{tag}, "yet-another"')

        # Assert - 並べても当たりが無ければ届く
        self.assert_sends_the_image('"other-version", W/"yet-another"')


class JobTest(ApiTestBase):
    def test_job_detail_carries_the_processing_log(self):
        # Arrange - 整理を 1 件走らせる
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(self.archive)],
                "output_directory": str(self.work_dir / "out"),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )
        job_id = accepted.json()["id"]

        # Act
        detail = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

        # Assert - 経過が行として残る
        self.assertIsInstance(detail["log"], list)
        self.assertTrue(detail["log"], "ログが 1 行も残っていない")

    def test_submits_a_reorder_job_and_reports_completion(self):
        # Act
        submitted = self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={
                "archive": str(self.archive),
                "order": ["003.jpg", "001.jpg", "002.jpg"],
            },
        )

        # Assert
        self.assertEqual(202, submitted.status_code)
        job_id = submitted.json()["id"]

        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(["001.jpg", "002.jpg", "003.jpg"], archive.namelist())

    def test_reports_a_failed_job_without_crashing(self):
        # Act - ページ数が合わない並び順
        submitted = self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={"archive": str(self.archive), "order": ["001.jpg"]},
        )
        job_id = submitted.json()["id"]

        # Assert
        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()
        self.assertEqual("failed", job["state"])
        self.assertIsNotNone(job["error"])

    def test_lists_submitted_jobs(self):
        # Arrange
        self.client.post(
            "/api/jobs/reorder",
            params=self.auth(),
            json={
                "archive": str(self.archive),
                "order": ["001.jpg", "002.jpg", "003.jpg"],
            },
        )

        # Act
        listed = self.client.get("/api/jobs", params=self.auth()).json()

        # Assert
        self.assertEqual(1, len(listed["jobs"]))
        self.assertEqual("reorder", listed["jobs"][0]["kind"])

    def test_reports_an_unknown_job(self):
        # Act / Assert
        response = self.client.get("/api/jobs/missing", params=self.auth())
        self.assertEqual(404, response.status_code)

    def test_job_list_omits_the_log_instead_of_faking_an_empty_one(self):
        # Arrange - ログが確実に残る整理ジョブを 1 件走らせる
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(self.archive)],
                "output_directory": str(self.work_dir / "out"),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )
        job_id = accepted.json()["id"]

        # Act
        listed = self.client.get("/api/jobs", params=self.auth()).json()
        detail = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

        # Assert - 「ログが無い」と「一覧では取らない」を取り違えさせない
        self.assertNotIn("log", listed["jobs"][0])
        self.assertIn("log", detail)
        self.assertTrue(detail["log"], "詳細にはログが残っているはず")


class CoverEditTest(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.spread = self.work_dir / "spread.zip"
        canvas = Image.new("RGB", (1600, 1200), "red")
        canvas.paste(Image.new("RGB", (800, 1200), "blue"), (800, 0))
        buffer = io.BytesIO()
        canvas.save(buffer, "JPEG", quality=95)
        with zipfile.ZipFile(self.spread, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("001.jpg", buffer.getvalue())
            archive.writestr("002.jpg", make_page())

    def test_reports_that_the_cover_is_a_spread(self):
        # Act
        response = self.client.get(
            "/api/cover", params=self.auth({"archive": str(self.spread)})
        )

        # Assert
        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual("001.jpg", payload["name"])
        self.assertTrue(payload["is_spread"])
        self.assertEqual(1600, payload["width"])

    def test_splits_the_cover_through_a_job(self):
        # Act
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={"archive": str(self.spread), "name": "001.jpg", "split": "right"},
        )

        # Assert
        self.assertEqual(202, submitted.status_code)
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()
        self.assertEqual("succeeded", job["state"], job.get("error"))
        with zipfile.ZipFile(self.spread) as archive:
            with Image.open(io.BytesIO(archive.read("001.jpg"))) as cover:
                self.assertEqual((800, 1200), cover.size)

    def test_reports_a_rejected_transform(self):
        # Act - 90 度単位でない回転
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={"archive": str(self.spread), "name": "001.jpg", "rotate": 45},
        )
        job = self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()

        # Assert
        self.assertEqual("failed", job["state"])
        self.assertIn("90", job["error"])


# サムネイル移動の検証用。ページごとに違う色を塗り、移動後も中身で見分ける。
# 連番でない名前にして、先頭移動に伴う振り直しが起きたかどうかも見えるようにする
THUMBNAIL_PAGES = (
    ("page-a.jpg", "red"),
    ("page-b.jpg", "lime"),
    ("page-c.jpg", "blue"),
)

_COLOR_SAMPLES = {"red": (255, 0, 0), "lime": (0, 255, 0), "blue": (0, 0, 255)}


def closest_color_name(pixel: tuple[int, int, int]) -> str:
    """画素に最も近い色名を返す。JPEG の劣化があっても見分けられるようにする"""

    def squared_distance(name: str) -> int:
        sample = _COLOR_SAMPLES[name]
        return sum((pixel[index] - sample[index]) ** 2 for index in range(3))

    return min(_COLOR_SAMPLES, key=squared_distance)


def viewer_pages(archive_path: Path) -> list[str]:
    """viewer がページとして読むエントリ名を、viewer と同じ辞書順で返す。

    ZIP には元画像や manifest（#66）などページ以外のエントリも入る。
    ページ数や並びを見るときに数へ入れると、加工の記録が増えただけで
    「ページが増えた」と読めてしまう。
    """
    with zipfile.ZipFile(archive_path) as archive:
        return sorted(name for name in archive.namelist() if is_viewer_page(name))


def page_colors(archive_path: Path) -> list[str]:
    """ページの色名を viewer と同じ辞書順で返す。どの絵が何ページ目かを見る"""
    names = viewer_pages(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        colors = []
        for name in names:
            with Image.open(io.BytesIO(archive.read(name))) as opened:
                image = opened.convert("RGB")
                colors.append(
                    closest_color_name(image.getpixel((image.width // 2, 10)))
                )
        return colors


def page_sizes(archive_path: Path) -> dict[str, tuple[int, int]]:
    """ページ名ごとの画像サイズ。加工が効いた 1 枚を見分ける"""
    names = viewer_pages(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        sizes = {}
        for name in names:
            with Image.open(io.BytesIO(archive.read(name))) as image:
                sizes[name] = image.size
        return sizes


class CoverMakeFirstTest(ApiTestBase):
    """選んだ 1 枚をサムネイル（先頭ページ）にする経路。

    viewer は辞書順の先頭を表紙として描くため、途中の絵をサムネイルにするには
    先頭へ移すしかない。その指示が API を素通りしていないことを確かめる。
    """

    def setUp(self):
        super().setUp()
        self.pages = self.work_dir / "pages.zip"
        with zipfile.ZipFile(self.pages, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, color in THUMBNAIL_PAGES:
                archive.writestr(name, make_page(color))

    def submit(self, payload: dict) -> dict:
        """加工ジョブを投げて、完了したジョブの内容を返す"""
        submitted = self.client.post(
            "/api/jobs/cover",
            params=self.auth(),
            json={"archive": str(self.pages)} | payload,
        )
        self.assertEqual(202, submitted.status_code, submitted.text)
        return self.client.get(
            f"/api/jobs/{submitted.json()['id']}", params=self.auth()
        ).json()

    def test_moves_the_chosen_page_to_the_front(self):
        # Act - 真ん中の page-b.jpg（lime）をサムネイルにする
        job = self.submit({"name": "page-b.jpg", "make_first": True})

        # Assert - 選んだ絵が先頭に来て、残りは元の順のまま続く
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(
            ["lime", "red", "blue"],
            page_colors(self.pages),
            "選んだ絵が先頭ページになっていない",
        )
        names = viewer_pages(self.pages)
        self.assertEqual(len(THUMBNAIL_PAGES), len(names), "ページ数が変わっている")
        self.assertEqual(
            ["001.jpg", "002.jpg", "003.jpg"], names, "連番へ振り直されていない"
        )
        self.assertEqual("001.jpg", job["result"]["name"])

    def test_applies_the_transform_to_the_page_it_moves(self):
        # Act - 切り抜きと先頭移動を同時に頼む
        job = self.submit(
            {"name": "page-b.jpg", "crop": [100, 150, 500, 750], "make_first": True}
        )

        # Assert - 先頭が切り抜き後の寸法で、色も選んだ 1 枚のもの
        self.assertEqual("succeeded", job["state"], job.get("error"))
        sizes = page_sizes(self.pages)
        self.assertEqual((400, 600), sizes["001.jpg"], "先頭が切り抜かれていない")
        self.assertEqual((800, 1200), sizes["002.jpg"], "他のページまで加工している")
        self.assertEqual(["lime", "red", "blue"], page_colors(self.pages))

    def test_replaces_in_place_when_make_first_is_omitted(self):
        # Act - make_first を省くと従来どおり同じ位置で差し替わる
        job = self.submit({"name": "page-b.jpg", "crop": [100, 150, 500, 750]})

        # Assert - 並びも名前も変わらず、加工されたのは指定した 1 枚だけ
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(["red", "lime", "blue"], page_colors(self.pages))
        sizes = page_sizes(self.pages)
        self.assertEqual(
            {"page-a.jpg", "page-b.jpg", "page-c.jpg"},
            set(sizes),
            "先頭移動を頼んでいないのに名前が変わっている",
        )
        self.assertEqual((400, 600), sizes["page-b.jpg"])
        self.assertEqual((800, 1200), sizes["page-a.jpg"])


class LibraryTest(ApiTestBase):
    """タイトル・著者の辞書。現行 Tkinter アプリの DB 編集画面の置き換え"""

    def test_starts_empty_and_records_a_pair(self):
        # Act
        created = self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "ワンピース", "author": "尾田栄一郎"},
        )

        # Assert
        self.assertEqual(200, created.status_code)
        listed = self.client.get("/api/library/entries", params=self.auth()).json()
        self.assertEqual(1, len(listed["entries"]))
        self.assertEqual("尾田栄一郎", listed["entries"][0]["author"])

    def test_looks_up_a_known_author_by_title(self):
        # Arrange
        self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "ワンピース", "author": "尾田栄一郎"},
        )

        # Act
        found = self.client.get(
            "/api/library/entries", params=self.auth({"query": "ワン"})
        ).json()

        # Assert
        self.assertEqual("ワンピース", found["entries"][0]["title"])

    def test_removes_an_entry(self):
        # Arrange
        self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": "消す作品", "author": "著者"},
        )

        # Act
        removed = self.client.request(
            "DELETE", "/api/library/entries", params=self.auth({"title": "消す作品"})
        )

        # Assert
        self.assertEqual(200, removed.status_code)
        listed = self.client.get("/api/library/entries", params=self.auth()).json()
        self.assertEqual([], listed["entries"])

    def test_allows_delete_from_the_webview_origin(self):
        # Arrange - WebView は別オリジンから呼ぶ。プリフライトが通らないと
        # 削除だけ失敗する
        response = self.client.options(
            "/api/library/entries",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "DELETE",
            },
        )

        # Assert
        self.assertEqual(200, response.status_code)
        self.assertIn("DELETE", response.headers["access-control-allow-methods"])

    def test_requires_a_token(self):
        self.assertEqual(401, self.client.get("/api/library/entries").status_code)


class AuthorSuggestTest(ApiTestBase):
    """作品名から著者を引く経路。ネットワークには出さず、応答の形だけ再現する"""

    def suggest(self, title: str):
        return self.client.post(
            "/api/library/suggest", params=self.auth(), json={"title": title}
        )

    def test_returns_the_author_name_not_the_source(self):
        # Arrange
        found = [
            {
                "title": "One Piece",
                "title_japanese": "ワンピース",
                "authors": ["尾田栄一郎"],
                "source": "AniList",
                "similarity": 1.0,
            }
        ]

        # Act
        with mock.patch.object(AniListClient, "search_manga", return_value=found):
            payload = self.suggest("ワンピース").json()

        # Assert - 提供元ではなく著者名が入る
        self.assertEqual("尾田栄一郎", payload["author"])

    def test_returns_close_candidates_in_order(self):
        # Arrange - 検索は近い順に複数返る
        found = [
            {
                "title": "近い作品",
                "title_japanese": "近い作品",
                "authors": ["著者A"],
                "source": "AniList",
                "similarity": 0.9,
            },
            {
                "title": "やや近い作品",
                "title_japanese": "やや近い作品",
                "authors": ["著者B", "著者C"],
                "source": "AniList",
                "similarity": 0.5,
            },
        ]

        # Act
        with mock.patch.object(AniListClient, "search_manga", return_value=found):
            payload = self.suggest("近い作品").json()

        # Assert - 先頭を既定にしつつ、残りも候補として渡す
        self.assertEqual("著者A", payload["author"])
        self.assertEqual(
            ["著者A", "著者B", "著者C"],
            [candidate["author"] for candidate in payload["candidates"]],
        )
        self.assertEqual("近い作品", payload["candidates"][0]["title"])

    def test_returns_nothing_when_search_finds_no_author(self):
        # Act
        with mock.patch.object(AniListClient, "search_manga", return_value=[]):
            payload = self.suggest("該当しない作品").json()

        # Assert
        self.assertIsNone(payload["author"])
        self.assertEqual([], payload["candidates"])

    def test_survives_a_failing_search(self):
        # Arrange - ネットワークは落ちうる。画面は止めない
        with mock.patch.object(
            AniListClient, "search_manga", side_effect=RuntimeError("圏外")
        ):
            payload = self.suggest("何か").json()

        # Assert
        self.assertIsNone(payload["author"])
        self.assertEqual([], payload["candidates"])

    def test_rejects_a_title_that_has_no_content(self):
        # Arrange - 空の作品名は検索にならない
        for title in ("", "   ", "\t\n"):
            with self.subTest(title=repr(title)):
                # Act
                with mock.patch.object(
                    AniListClient, "search_manga", return_value=[]
                ) as searched:
                    response = self.suggest(title)

                # Assert - 入口で断り、外部サービスにも問い合わせない
                self.assertEqual(422, response.status_code)
                searched.assert_not_called()


class BrowseTest(ApiTestBase):
    """ファイル選択。ブラウザは実パスを扱えないのでサーバー側で辿る"""

    def setUp(self):
        super().setUp()
        self.folder = self.work_dir / "shelf"
        (self.folder / "sub").mkdir(parents=True)
        for name in ("b.zip", "a.cbz", "memo.txt"):
            (self.folder / name).write_bytes(b"x")

    def test_lists_directories_and_archives(self):
        # Act
        listed = self.client.get(
            "/api/browse", params=self.auth({"path": str(self.folder)})
        ).json()

        # Assert - ディレクトリが先、アーカイブ以外は出さない
        self.assertEqual(str(self.folder), listed["path"])
        self.assertEqual(
            [("sub", True), ("a.cbz", False), ("b.zip", False)],
            [(e["name"], e["is_directory"]) for e in listed["entries"]],
        )

    def test_reports_the_parent_so_the_ui_can_go_up(self):
        # Act
        listed = self.client.get(
            "/api/browse", params=self.auth({"path": str(self.folder)})
        ).json()

        # Assert
        self.assertEqual(str(self.work_dir), listed["parent"])

    def test_defaults_to_the_allowed_root(self):
        # Act - path を省くと起点を返す
        listed = self.client.get("/api/browse", params=self.auth()).json()

        # Assert
        self.assertEqual(str(self.work_dir), listed["path"])
        self.assertIsNone(listed["parent"])

    def test_refuses_to_escape_the_allowed_roots(self):
        # Act / Assert
        response = self.client.get("/api/browse", params=self.auth({"path": "/etc"}))
        self.assertEqual(400, response.status_code)

    def test_requires_a_token(self):
        self.assertEqual(401, self.client.get("/api/browse").status_code)


class ResolveTest(ApiTestBase):
    """ドロップされたファイルを実パスに結びつける。

    ブラウザは実パスを渡さないが、名前とサイズは分かる。許可された場所の
    中から同じものを探せば、ドロップからでも対象を特定できる。
    """

    def setUp(self):
        super().setUp()
        self.shelf = self.work_dir / "shelf"
        (self.shelf / "深い場所").mkdir(parents=True)
        self.unique = self.shelf / "唯一.zip"
        self.unique.write_bytes(b"a" * 100)
        self.nested = self.shelf / "深い場所" / "奥.zip"
        self.nested.write_bytes(b"b" * 200)

    def test_resolves_by_name(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 100}]},
        ).json()

        # Assert
        self.assertEqual([str(self.unique)], found["resolved"])
        self.assertEqual([], found["unresolved"])

    def test_searches_subdirectories(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "奥.zip", "size": 200}]},
        ).json()

        # Assert
        self.assertEqual([str(self.nested)], found["resolved"])

    def test_reports_what_it_could_not_find(self):
        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "ない.zip", "size": 1}]},
        ).json()

        # Assert
        self.assertEqual([], found["resolved"])
        self.assertEqual(["ない.zip"], found["unresolved"])

    def test_uses_size_to_disambiguate_same_names(self):
        # Arrange - 同名が複数ある場合はサイズで絞る
        other = self.shelf / "深い場所" / "唯一.zip"
        other.write_bytes(b"c" * 999)

        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 999}]},
        ).json()

        # Assert
        self.assertEqual([str(other)], found["resolved"])

    def test_reports_ambiguous_matches_instead_of_guessing(self):
        # Arrange - 名前もサイズも同じものが 2 つ
        twin = self.shelf / "深い場所" / "唯一.zip"
        twin.write_bytes(b"a" * 100)

        # Act
        found = self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": "唯一.zip", "size": 100}]},
        ).json()

        # Assert - 勝手に選ばず、判断を返す
        self.assertEqual([], found["resolved"])
        self.assertEqual(["唯一.zip"], found["ambiguous"])

    def test_requires_a_token(self):
        self.assertEqual(
            401, self.client.post("/api/resolve", json={"files": []}).status_code
        )


class FixedTokenTest(unittest.TestCase):
    """開発中はトークンを固定できるようにする。

    再起動のたびに変わると、控えた URL がすぐ使えなくなる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

    def test_uses_the_given_token(self):
        # Arrange
        app = create_app(state_dir=self.work_dir / "state", token="固定トークン")

        # Act / Assert
        self.assertEqual("固定トークン", app.state.token)
        client = TestClient(app)
        self.addCleanup(client.close)
        self.assertEqual(
            200, client.get("/api/health", params={"token": "固定トークン"}).status_code
        )

    def test_generates_one_when_not_given(self):
        # Arrange
        first = create_app(state_dir=self.work_dir / "a").state.token
        second = create_app(state_dir=self.work_dir / "b").state.token

        # Assert - 既定では毎回異なる
        self.assertNotEqual(first, second)
        self.assertGreater(len(first), 20)


class OrganizeProgressTest(ApiTestBase):
    """整理ジョブが実行中に何冊目かを示すことを見る（#65）。

    進捗の報告とログの出力は同じ報告経路を通る。ログが件数を 0 で
    上書きすると、実行中はずっと 0 / N が出続ける。実機（4 件）では
    処理中ずっと 0 / 4 のままだった。
    """

    def setUp(self):
        super().setUp()
        # 実機と同じ 4 冊。1 冊では「進んでいない」ことが見えない
        self.archives = [self.archive]
        for index in (2, 3, 4):
            path = self.work_dir / f"volume{index}.zip"
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                for name in ("001.jpg", "002.jpg"):
                    archive.writestr(name, make_page())
            self.archives.append(path)

    def visible_progress(self) -> tuple[int, int]:
        """実行中の進捗を、画面が読むのと同じ内容で覗く。

        ジョブは同期実行されるので、終わってから読むと最後の値しか見えない。
        HTTP を入れ子にすると止まるため、一覧が返すのと同じ値を直に取る。
        """
        organizing = [
            job for job in self.app.state.jobs.list_jobs() if job.kind == "organize"
        ]
        latest = organizing[0]
        return latest.current, latest.total

    def test_organize_job_counts_archives_while_running(self):
        # Arrange - 1 冊を処理し終えるたびに、そのときの進捗を控える。
        # 控える位置はその冊のログが出きった直後で、実機で 0 / 4 に
        # 見えていた瞬間と同じ
        from manga_core.file_organizer import FileOrganizer

        observed: list[tuple[int, int]] = []
        process_single_archive = FileOrganizer.process_single_archive

        # 選んだ本だけを作れるようになり、引数が 1 つ増えた（#70 第 3 段階）。
        # ここで見ているのは進捗であって呼び出しの形ではないので、そのまま通す
        def watched(organizer, archive_path, *args, **kwargs):
            results = process_single_archive(organizer, archive_path, *args, **kwargs)
            observed.append(self.visible_progress())
            return results

        # Act
        with mock.patch.object(FileOrganizer, "process_single_archive", watched):
            accepted = self.client.post(
                "/api/jobs/organize",
                params=self.auth(),
                json={
                    "archives": [str(archive) for archive in self.archives],
                    "output_directory": str(self.work_dir / "out-progress"),
                    "title": "作品",
                    "author": "著者",
                    "keep_originals": True,
                },
            )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job_id = accepted.json()["id"]
        job = self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

        # Assert - 4 冊とも処理された。途中を 4 回見られている前提を確かめる
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(4, len(observed), f"途中を 4 回観測できていない: {observed}")

        # Assert - 実行中の進捗が何冊目かを示す。ログで 0 に戻らない。
        # 「処理に入るとき」に報告しても「1 冊終えるごと」に報告しても、
        # この位置での見え方は同じ並びになる
        self.assertEqual(
            [(1, 4), (2, 4), (3, 4), (4, 4)],
            observed,
            f"実行中の進捗が何冊目を示していない: {observed}",
        )

        # Assert - 完了時に 4 / 4 になるだけでは足りないが、そこも崩さない
        self.assertEqual((4, 4), (job["current"], job["total"]), job)


class OrganizeFolderExpansionTest(ApiTestBase):
    """フォルダを投入したときの、件数とリンクの扱いを見る（#70）。

    フォルダを 1 件のまま走らせると、進捗の総数が 1 のまま複数冊が出来上がる。
    また、再帰で辿る以上、許可された場所の中に置かれたリンクが外を指していれば
    外のファイルを読めてしまう。どちらも展開の仕方そのものの話なので、
    出来上がるファイル名だけでは確かめられない。
    """

    def make_archive(self, path: Path) -> Path:
        """巻数が名前から決まる ZIP を作る。どれが入ったかを名前で見分ける"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("001.jpg", make_page())
        return path

    def organize(self, targets: list[Path], output: Path) -> dict:
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "output_directory": str(output),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job_id = accepted.json()["id"]
        return self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

    def test_progress_counts_the_books_inside_a_submitted_folder(self):
        # Arrange - フォルダ 1 つの下に 3 冊
        folder = self.work_dir / "件数"
        for index in (1, 2, 3):
            self.make_archive(folder / f"raw_{index:02d}.zip")

        # Act - フォルダのパスだけを渡す
        job = self.organize([folder], self.work_dir / "out-count")

        # Assert - 総数は投入したパスの数（1）ではなく、中の冊数になる
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(3, job["total"], f"進捗の総数が冊数と合わない: {job}")
        self.assertEqual((3, 3), (job["current"], job["total"]), job)

    def test_skips_links_that_leave_the_allowed_roots(self):
        # Arrange - 許可の外に 1 冊置き、許可の中からリンクで指す
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = self.make_archive(Path(outside_temp.name).resolve() / "外_09.zip")

        folder = self.work_dir / "リンク入り"
        self.make_archive(folder / "本物_01.zip")
        try:
            (folder / "リンク_09.zip").symlink_to(outside)
        except OSError as error:  # 権限が要る環境ではリンクを作れない
            self.skipTest(f"リンクを作れない環境です: {error}")

        # Act
        job = self.organize([folder], self.work_dir / "out-link")

        # Assert - リンクの先は許可の外なので処理しない。名前で見分ける
        self.assertEqual("succeeded", job["state"], job.get("error"))
        names = sorted(Path(raw).name for raw in job["result"]["produced"])
        self.assertEqual(
            ["[著者] 作品 第001巻.zip"],
            names,
            f"リンクをたどって許可の外まで処理している: {names}",
        )
        # Assert - 除いたものを失敗として数えない。読ませない判断であって、
        # 利用者が直せる失敗ではない
        self.assertEqual([], job["result"]["failed"], job["result"])


class OrganizeFailureReportTest(ApiTestBase):
    """整理ジョブが失敗の内訳を返すことを見る（#62）。

    process_single_archive() は処理中の例外を握りつぶして success=False を
    返すため、ジョブ自体は最後まで走って succeeded で終わる。成功したものだけ
    集めていると、全件失敗しても「produced が空の成功」と見分けが付かない。
    走り切ったこと（state）と、何が出来たか（result）は別々に伝える必要がある。
    """

    def setUp(self):
        super().setUp()
        # 2 冊目。1 冊だけだと「全件失敗」と「1 件失敗」が同じ形になる
        self.second = self.work_dir / "volume2.zip"
        with zipfile.ZipFile(self.second, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("001.jpg", "002.jpg"):
                archive.writestr(name, make_page())

        # 中身が ZIP ではないファイル。resolve_archive() は実在するファイルとして
        # 通すので 400 にはならず、ジョブの実行中に展開で失敗する
        self.broken = self.work_dir / "壊れた.zip"
        self.broken.write_bytes(b"not a zip at all")

    def organize(self, archives: list[Path], output_directory: Path) -> dict:
        """整理ジョブを投入し、終わったジョブの詳細を返す"""
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(archive) for archive in archives],
                "output_directory": str(output_directory),
                "title": "作品",
                "author": "著者",
                "keep_originals": True,
            },
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job_id = accepted.json()["id"]
        return self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

    def failures(self, job: dict) -> list[dict]:
        """結果から失敗の内訳を取り出す。形が違えばそこで落とす"""
        result = job["result"]
        self.assertIn("failed", result, f"失敗の内訳が結果に無い: {result}")
        failed = result["failed"]
        self.assertIsInstance(failed, list, f"failed が一覧ではない: {failed}")
        for entry in failed:
            # どのファイルが、なぜ駄目だったのか。片方だけでは伝わらない
            self.assertIn("archive", entry, f"どのファイルか分からない: {entry}")
            self.assertIn("reason", entry, f"理由が無い: {entry}")
            self.assertTrue(str(entry["reason"]).strip(), f"理由が空: {entry}")
        return failed

    def test_reports_every_failure_when_nothing_was_organized(self):
        # Arrange - 出力先に既存のファイルを指定すると、作品のディレクトリを
        # 作る段で必ず失敗する（[Errno 20] Not a directory）
        occupied = self.work_dir / "占有ファイル"
        occupied.write_text("ディレクトリではない", encoding="utf-8")

        # Act
        job = self.organize([self.archive, self.second], occupied)

        # Assert - 走り切ったので状態は succeeded のまま
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual([], job["result"]["produced"])

        # Assert - 投入した 2 冊が、それぞれ理由付きで載る
        failed = self.failures(job)
        self.assertEqual(2, len(failed), f"失敗した 2 件が揃っていない: {failed}")
        reported = [str(entry["archive"]) for entry in failed]
        for archive in (self.archive, self.second):
            self.assertTrue(
                any(archive.name in name for name in reported),
                f"{archive.name} が失敗の内訳に無い: {reported}",
            )

    def test_reports_both_sides_when_only_some_archives_fail(self):
        # Arrange - 正常な 1 冊と、中身が ZIP ではない 1 冊
        output = self.work_dir / "out-partial"

        # Act
        job = self.organize([self.archive, self.broken], output)

        # Assert - 成功したぶんは今までどおり produced に出る
        self.assertEqual("succeeded", job["state"], job.get("error"))
        produced = job["result"]["produced"]
        self.assertEqual(1, len(produced), f"成功した 1 冊が出ていない: {produced}")
        self.assertTrue(produced[0].endswith(".zip"))
        self.assertNotIn(self.broken.name, produced[0])

        # Assert - 失敗したぶんだけが failed に出る。成功したものは混ざらない
        failed = self.failures(job)
        self.assertEqual(1, len(failed), f"失敗した 1 件だけのはず: {failed}")
        self.assertIn(self.broken.name, str(failed[0]["archive"]))
        self.assertNotIn(self.archive.name, str(failed[0]["archive"]))

    def test_reports_no_failures_when_every_archive_was_organized(self):
        # Arrange
        output = self.work_dir / "out-all-ok"

        # Act
        job = self.organize([self.archive, self.second], output)

        # Assert - 既存の挙動を壊さない
        self.assertEqual("succeeded", job["state"], job.get("error"))
        self.assertEqual(2, len(job["result"]["produced"]))

        # Assert - 「失敗が無い」ことも結果として言う。キーごと省くと、
        # 失敗が無いのか、失敗を数えていないのかを画面が区別できない
        self.assertEqual([], self.failures(job))


if __name__ == "__main__":
    unittest.main()
