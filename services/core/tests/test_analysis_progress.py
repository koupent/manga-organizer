"""解析を、途中経過の見えるジョブにする（#70 第 4 段階）。

第 3 段階の ``POST /api/analyze`` は、全部読み終わるまで応答を返さない。利用者の
要望は

    「解析中: 走査で行が先に全部並び、目次を読めた順に本の行が生えます。
      主操作は解析完了まで無効。チェックは解析中も付けられます」

なので、解析も整理と同じジョブにして、育っていく結果を取りに行けるようにする。

ここで求める公開契約は次の形とする。

    POST /api/jobs/analyze
        {"archives": [...絶対パス], "title": "作品", "author": "著者"}
      → 202 {"id": "..."}
      → 400 投入されたパスが無い / 許可の外（ジョブを作る前に、その場で断る）
      → 401 トークンが無い

    GET /api/jobs/{id}
        kind    "analyze"
        total   走査で見つかった入れ物の数（走査が終わるまでは 0）
        current 目次を読み終えた入れ物の数
        result  {
          "scanned":    走査が終わったか,
          "containers": [入れ物の絶対パス, ...]  # 処理する順,
          "books":      [{source, entry, output_name, volume, issues}, ...],
          "unreadable": [{"source": 絶対パス, "reason": 理由}, ...]
        }

``scanned`` を別に持つのは、``containers`` が空のときに「走査がまだ終わって
いない」と「1 件も見つからなかった」を画面から区別するため。

400 は投入の時点で返す。ジョブを作ってから失敗させると、許可の外を指した
ことが「失敗したジョブ」としてしか残らず、画面は投入できたと思ってしまう。

画面側（走査だけの状態で行が並ぶ・解析中もチェックが付く）は
``apps/desktop/e2e/analyze-progress.spec.ts``。
"""

import io
import os
import sys
import threading
import time
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_core import toc_analyzer  # noqa: E402
from manga_core.input_expander import expand_inputs  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"

# 本 1 冊として返す項目。PlannedBookView と同じ形。後半 4 つは整理済みかどうかの
# 判定（#73 第 2 段階）で、整理済みでない本にも必ず載る
BOOK_KEYS = {
    "source",
    "entry",
    "output_name",
    "volume",
    "volume_origin",
    "volume_source_name",
    "issues",
    "organized",
    "author",
    "title",
    "organized_reason",
    "organized_detail",
}

# 1 つの ZIP に 2 冊分が入っている状態。アーカイブの件数（2）と冊数（3）を
# 食い違わせ、total が本を数えている実装で通らないようにする
COMPOUND_ENTRIES = (
    "第01巻/001.jpg",
    "第01巻/002.jpg",
    "第02巻/001.jpg",
    "第02巻/002.jpg",
)


def page() -> bytes:
    """テスト用のページ画像。実処理まで走らせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def wait_until(predicate, timeout: float = 10.0) -> bool:
    """条件が満たされるまで短く待つ。test_jobs.py と同じ待ち方"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class AnalysisJobTestBase(unittest.TestCase):
    """解析ジョブの入口を叩く土台。

    ``inline`` を False にすると、ジョブはワーカースレッドで走る。途中経過を
    見るテストは、走っている最中に別の要求を投げる必要があるのでそちらを使う。
    """

    inline = True

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

        # 許可された場所を実際に絞る。絞らないと根の検証が意味を持たない
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=self.inline,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.token, **(params or {})}

    def write_archive(self, path: Path, entries: tuple[str, ...] = ("001.jpg",)):
        """指定の中身の ZIP を作る。途中のディレクトリも掘る"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in entries:
                archive.writestr(name, page())
        return path

    def make_folder(self, name: str) -> Path:
        """2 つのアーカイブから 3 冊出るフォルダ。件数と冊数を食い違わせる"""
        folder = self.work_dir / name
        self.write_archive(folder / "合本.zip", COMPOUND_ENTRIES)
        self.write_archive(folder / "単体_03.zip", ("001.jpg", "002.jpg"))
        return folder

    def submit_analysis(self, targets: list[Path], title=TITLE, author=AUTHOR):
        """解析ジョブを投入する。受け付けたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/analyze",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "title": title,
                "author": author,
            },
        )

    def accepted_id(self, targets: list[Path]) -> str:
        """投入が受け付けられたことを確かめ、ジョブ番号を返す"""
        accepted = self.submit_analysis(targets)
        self.assertEqual(
            202, accepted.status_code, f"解析の投入が受け付けられない: {accepted.text}"
        )
        return accepted.json()["id"]

    def job(self, job_id: str) -> dict:
        """ジョブ 1 件の今の状態"""
        response = self.client.get(f"/api/jobs/{job_id}", params=self.auth())
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def finished(self, targets: list[Path]) -> dict:
        """投入から完了までを済ませたジョブ（inline 用）"""
        job = self.job(self.accepted_id(targets))
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job

    def expected_books(self, targets: list[Path]) -> list[dict]:
        """コア層がまとめて出す本の一覧。第 3 段階までの解析結果そのもの。

        ``POST /api/analyze`` はこれを写しているだけなので、これと一致すれば
        「今までと同じものが返っている」ことになる。
        """
        planned = toc_analyzer.analyze_inputs(
            [target.resolve() for target in targets], author=AUTHOR, title=TITLE
        )
        return [
            {
                "source": str(book.source),
                "entry": book.entry,
                "output_name": book.output_name,
                "volume": book.volume,
                "volume_origin": book.volume_origin,
                "volume_source_name": book.volume_source_name,
                "issues": list(book.issues),
                "organized": book.organized,
                "author": book.author,
                "title": book.title,
                "organized_reason": book.organized_reason,
                "organized_detail": book.organized_detail,
            }
            for book in planned
        ]

    def spy_on_locate_books(self, blocked: Path | None = None):
        """目次を読みに行った先を控える。blocked を指定するとそこで止まる。

        「途中まで返している」ことは返り値だけでは確かめられない。どの
        アーカイブをいつ開いたかを控えて、境目をその場で捉える。
        """
        opened: list[Path] = []
        gate = threading.Event()
        original = toc_analyzer.locate_books

        def spy(archive_path: Path, *args, **kwargs):
            opened.append(archive_path)
            if blocked is not None and archive_path == blocked:
                gate.wait(10)
            return original(archive_path, *args, **kwargs)

        patcher = mock.patch.object(toc_analyzer, "locate_books", spy)
        patcher.start()
        # 止めたまま片付けに入るとワーカースレッドが残るので、必ず解放する
        self.addCleanup(patcher.stop)
        self.addCleanup(gate.set)
        return opened, gate


class AnalysisJobParityTest(AnalysisJobTestBase):
    """1. ジョブにしても、返る本は今までと同じ"""

    def test_the_job_returns_the_same_books_as_the_whole_run(self):
        # Arrange
        folder = self.make_folder("同一")

        # Act
        job = self.finished([folder])

        # Assert - 走査の結果と本が、決まった形でそろっている
        result = job["result"]
        self.assertEqual("analyze", job["kind"], job)
        self.assertIs(True, result["scanned"], f"走査の終わりが分からない: {result}")
        self.assertEqual(
            [str(path) for path in expand_inputs([folder])],
            result["containers"],
            f"入れ物の一覧が処理順になっていない: {result}",
        )
        self.assertEqual([], result["unreadable"], f"読めた分まで挙げている: {result}")

        # Assert - 本は 1 件ずつ、まとめて解析した結果と同じ
        self.assertEqual(
            self.expected_books([folder]),
            result["books"],
            f"ジョブにしたら解析結果が変わった: {result['books']}",
        )
        self.assertEqual(
            BOOK_KEYS,
            set(result["books"][0]),
            f"本 1 冊の形が契約と違う: {result['books'][0]}",
        )

    def test_the_total_counts_containers_not_books(self):
        # Arrange - アーカイブ 2 つから本が 3 冊出る。数が違うので取り違えが出る
        folder = self.make_folder("件数")

        # Act
        job = self.finished([folder])

        # Assert - 進捗の分母は「目次を読む回数」。本を数えると、走査が
        # 終わった時点で分母が決まらず、進捗が伸び縮みする
        self.assertEqual(3, len(job["result"]["books"]), job["result"])
        self.assertEqual(2, job["total"], f"総数が入れ物の数になっていない: {job}")
        self.assertEqual(2, job["current"], f"読み終えた数が合わない: {job}")

    def test_an_unreadable_container_is_reported_without_failing_the_job(self):
        """読めなかった 1 つを挙げ、残りは最後まで解析する。

        壊れた ZIP では確かめられない。``locate_books`` は ``BadZipFile`` と
        ``OSError`` を自分で握りつぶして空を返すので、壊れた ZIP は今の実装の
        まま素通りしてしまう。握りつぶしていない ``MemoryError`` を使う。
        """
        # Arrange
        folder = self.work_dir / "読めない"
        broken = self.write_archive(folder / "a_01.zip")
        healthy = self.write_archive(folder / "b_02.zip")
        original = toc_analyzer.locate_books

        def explode(archive_path: Path, *args, **kwargs):
            if archive_path == broken:
                raise MemoryError("目次が大きすぎます")
            return original(archive_path, *args, **kwargs)

        # Act
        with mock.patch.object(toc_analyzer, "locate_books", explode):
            job = self.finished([folder])

        # Assert - 読めなかったものは理由付きで残り、ジョブ自体は成功で終わる
        result = job["result"]
        self.assertEqual(
            [str(broken)],
            [item["source"] for item in result["unreadable"]],
            f"読めなかったアーカイブが挙がっていない: {result}",
        )
        self.assertTrue(result["unreadable"][0]["reason"], result["unreadable"][0])

        # Assert - 後ろのアーカイブは解析される。1 つ読めないだけで全部を
        # 諦める実装だと、利用者は原因の分からない空の一覧を見る
        self.assertEqual(
            [str(healthy)],
            [book["source"] for book in result["books"]],
            f"読めない 1 つで解析が止まっている: {result}",
        )

        # Assert - 読めなかったことは経過にも 1 行残る。進捗の message は
        # 上書きされるので、ポーリングの間隔次第で見落とす
        self.assertTrue(
            any(broken.name in line for line in job["log"]),
            f"読めなかったことが経過に残っていない: {job['log']}",
        )


class AnalysisJobSecurityTest(AnalysisJobTestBase):
    """2. 第 3 段階で ``/api/analyze`` に付けた守りを、そのまま持ち越す"""

    def test_requires_a_token(self):
        # Arrange - 解析はディスクを読む。トークン無しで叩けてはいけない
        folder = self.work_dir / "無認可"
        self.write_archive(folder / "raw_01.zip")

        # Act
        response = self.client.post(
            "/api/jobs/analyze",
            json={"archives": [str(folder)], "title": TITLE, "author": AUTHOR},
        )

        # Assert
        self.assertEqual(401, response.status_code, response.text)

    def test_refuses_a_folder_outside_the_allowed_roots(self):
        # Arrange - 許可の外と中に、同じ形のフォルダを用意する
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = Path(outside_temp.name).resolve() / "許可の外"
        self.write_archive(outside / "raw_01.zip")

        inside = self.work_dir / "許可の中"
        self.write_archive(inside / "raw_01.zip")

        # Act
        refused = self.submit_analysis([outside])

        # Assert - 投入そのものを断る。ジョブを作って失敗させると、画面は
        # 「受け付けられた」と思ったまま後から失敗を知ることになる
        self.assertEqual(400, refused.status_code, refused.text)
        self.assertIn(
            "対象外",
            refused.json().get("detail", ""),
            f"許可の外だから拒んだ、とは読めない: {refused.text}",
        )

        # Act / Assert - 同じ形でも許可の中なら解析する。これが無いと
        # 「何でも拒む」実装でも上の検証を通せる
        job = self.finished([inside])
        self.assertEqual(
            [f"[{AUTHOR}] {TITLE} 第001巻.zip"],
            [book["output_name"] for book in job["result"]["books"]],
            job["result"],
        )

    def test_names_each_refused_path(self):
        # Arrange - 許可の中・許可の外・存在しないパスを 1 度に投げる。
        # 1 件でも断ると投入全体が通らないので、画面はどれを外せばよいかを
        # 知る必要がある（#107）
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        outside = Path(outside_temp.name).resolve() / "許可の外"
        self.write_archive(outside / "raw_01.zip")
        inside = self.make_folder("許可の中")
        missing = self.work_dir / "消えた.zip"

        # Act
        refused = self.submit_analysis([inside, outside, missing])

        # Assert - 断ったパスだけを、理由と一緒に名指しする
        self.assertEqual(400, refused.status_code, refused.text)
        body = refused.json()
        self.assertEqual(
            [str(outside), str(missing)],
            [item["path"] for item in body.get("refused", [])],
            refused.text,
        )
        reasons = [item["reason"] for item in body["refused"]]
        self.assertIn("対象外", reasons[0])
        self.assertIn("見つかりません", reasons[1])
        # detail は従来どおり文字列。読む側の互換を崩さない
        self.assertIsInstance(body.get("detail"), str, refused.text)

    def test_leaves_out_files_that_point_outside_through_a_link(self):
        # Arrange - 許可の中のフォルダに、外を指すリンクを置く。名前のままでは
        # 中に見えて、開くと外を読む
        outside_temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(outside_temp.cleanup)
        secret = self.write_archive(Path(outside_temp.name).resolve() / "外.zip")

        folder = self.work_dir / "リンク入り"
        allowed = self.write_archive(folder / "許可_01.zip")
        link = folder / "外_09.zip"
        link.symlink_to(secret)

        # Act
        result = self.finished([folder])["result"]

        # Assert - 許可の中のものだけが本になる。リンクの先は読まない
        sources = {Path(book["source"]).resolve() for book in result["books"]}
        self.assertNotIn(
            secret.resolve(), sources, f"許可の外のアーカイブを解析している: {result}"
        )
        self.assertEqual({allowed.resolve()}, sources, f"解析の対象が違う: {result}")

        # Assert - 走査の一覧にも出さない。行が出れば画面はチェックを付け、
        # 整理の投入に載ってしまう
        self.assertNotIn(
            str(secret.resolve()),
            [str(Path(path).resolve()) for path in result["containers"]],
            f"許可の外が走査の一覧に出ている: {result['containers']}",
        )


class GrowingAnalysisResultTest(AnalysisJobTestBase):
    """3. 走査が先に出て、本が後から生える"""

    inline = False

    def test_the_scan_is_visible_before_any_book(self):
        # Arrange - 2 つ目の目次を読む手前で止め、その瞬間を見る
        folder = self.make_folder("途中経過")
        containers = expand_inputs([folder])
        self.assertEqual(2, len(containers), f"下準備が想定と違う: {containers}")
        # 止める前に控える。控えるほうで locate_books を呼ぶと記録が濁る
        first_names = [
            book.output_name
            for book in toc_analyzer.analyze_inputs(
                [containers[0]], author=AUTHOR, title=TITLE
            )
        ]
        all_names = [book["output_name"] for book in self.expected_books([folder])]
        opened, gate = self.spy_on_locate_books(blocked=containers[1])

        # Act
        job_id = self.accepted_id([folder])
        self.assertTrue(
            wait_until(lambda: len(opened) == 2),
            f"2 つ目の目次を読み始めない: {opened}",
        )
        snapshot = self.job(job_id)

        # Assert - まだ走っている
        self.assertEqual("running", snapshot["state"], snapshot)

        # Assert - 走査は終わっていて、入れ物は全部そろっている。行が先に
        # 全部並ぶという振る舞いは、ここが揃っていないと出来ない
        result = snapshot["result"]
        self.assertIs(True, result["scanned"], f"走査の終わりが分からない: {result}")
        self.assertEqual(
            [str(path) for path in containers],
            result["containers"],
            f"入れ物が出そろっていない: {result}",
        )
        self.assertEqual(len(containers), snapshot["total"], snapshot)
        self.assertEqual(1, snapshot["current"], f"読み終えた数が合わない: {snapshot}")

        # Assert - 読めているうちは経過に行を残さない。1 万件のアーカイブで
        # 1 件ずつ行を出すと、上限（MAX_LOG_LINES）を溢れて本当に困っている
        # 報告――読めなかったアーカイブ――が流れて消える
        self.assertEqual("", snapshot["message"], f"順調な報告に文言が出る: {snapshot}")
        self.assertEqual([], snapshot["log"], f"読めた分まで経過に残す: {snapshot}")

        # Assert - 本は 1 つ目のアーカイブのぶんだけ。冊数の大小で見ると、
        # 境目が 1 冊ずれた実装でも通ってしまうので名前で見る
        self.assertEqual(
            first_names,
            [book["output_name"] for book in result["books"]],
            f"読めた分と一致しない: {result['books']}",
        )

        # Act / Assert - 解放すれば最後まで走る
        gate.set()
        self.assertTrue(
            wait_until(lambda: self.job(job_id)["state"] == "succeeded"),
            f"解放しても終わらない: {self.job(job_id)}",
        )
        self.assertEqual(
            all_names,
            [book["output_name"] for book in self.job(job_id)["result"]["books"]],
            "最後まで走ったのに本が足りない",
        )

    def test_cancelling_stops_reading_the_remaining_containers(self):
        # Arrange - アーカイブ 3 つ。2 つ目で止めてからキャンセルする
        folder = self.work_dir / "打ち切り"
        self.write_archive(folder / "a_01.zip")
        self.write_archive(folder / "b_02.zip")
        self.write_archive(folder / "c_03.zip")
        containers = expand_inputs([folder])
        self.assertEqual(3, len(containers), f"下準備が想定と違う: {containers}")
        first_names = [
            book.output_name
            for book in toc_analyzer.analyze_inputs(
                [containers[0]], author=AUTHOR, title=TITLE
            )
        ]
        opened, gate = self.spy_on_locate_books(blocked=containers[1])

        # Act
        job_id = self.accepted_id([folder])
        self.assertTrue(wait_until(lambda: len(opened) == 2), f"止まらない: {opened}")
        cancelled = self.client.post(
            f"/api/jobs/{job_id}/cancel", params=self.auth(), json={}
        )
        self.assertEqual(202, cancelled.status_code, cancelled.text)
        gate.set()

        # Assert - 3 つ目は読まない。state だけを見ると、JobStore.cancel が
        # 無条件に書くのでワーカーが気づかなくても "cancelled" になる。
        # 実際に読むのをやめたかは、開きに行った先でしか分からない
        self.assertFalse(
            wait_until(lambda: len(opened) > 2, timeout=2.0),
            f"キャンセルしたのに次のアーカイブを読んでいる: {opened}",
        )
        self.assertEqual(containers[:2], opened, f"読んだ先が想定と違う: {opened}")
        self.assertEqual("cancelled", self.job(job_id)["state"], self.job(job_id))

        # Assert - 打ち切りまでに読めた分は残る。途中まで見えていた一覧が
        # 中断で白紙に戻ると、何が終わっていたのか分からなくなる
        self.assertEqual(
            first_names,
            [book["output_name"] for book in self.job(job_id)["result"]["books"]],
            "打ち切りで途中経過ごと消えている",
        )

        # Assert - 対照。止めなければ 3 つとも読む。spy が呼ばれていない・
        # パスが合っていないだけの実装でも、上の「読んでいない」は通る
        opened.clear()
        again = self.accepted_id([folder])
        self.assertTrue(
            wait_until(lambda: self.job(again)["state"] == "succeeded"),
            f"対照の実行が終わらない: {self.job(again)}",
        )
        self.assertEqual(containers, opened, f"対照でも読み切っていない: {opened}")


class SilentlySkippedArchiveTest(AnalysisJobTestBase):
    """4. 本を 1 冊も持たないアーカイブを、黙って落とさない（意図した振る舞いの変更）"""

    def files_under(self, root: Path) -> list[str]:
        if not root.exists():
            return []
        return sorted(path.name for path in root.rglob("*") if path.is_file())

    def write_bookless_archive(self, path: Path) -> Path:
        """壊れてはいないが、画像を 1 枚も含まない ZIP。

        ``CorruptArchiveIsNotSilentTest`` にも同じものがある。あちらは「壊れた
        ものと、画像が無いだけのものを区別する」ために使い、こちらは「本が
        0 冊でも行として残る」ために使う。目的が違うので別々に置いてある。
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("おまけ/memo.txt", "画像は 1 枚も入っていません")
        return path

    def test_an_archive_with_no_readable_books_is_still_organized(self):
        """本が 1 冊も出ないアーカイブも、走査の行として残して整理へ渡す。

        **これは意図した振る舞いの変更**。いままで画面の行は本
        （``book.source``）からしか生えなかった。本を 1 冊も出さない
        アーカイブは行を持たず、`selectedBooks` にも載らず、``app.py`` の
        整理投入が ``archives`` ごと外していた。利用者から見ると
        「チェックを外していないのに、黙って整理されない」。

        第 4 段階では走査（``containers``）が行を作るので、既定で選ばれ、
        実際に整理へ渡る。ここではその新しい前提――走査は本の出ない入れ物も
        必ず挙げ、選べば整理の対象数に入る――を固定する。
        """
        # Arrange - 2 冊出る ZIP と、読めるが画像が 1 枚も無い ZIP。後者は
        # 目次を読めるので ``unreadable`` ではなく、ただ本が 0 冊
        folder = self.work_dir / "黙って落ちる"
        folder.mkdir(parents=True)
        self.write_archive(folder / "合本.zip", COMPOUND_ENTRIES)
        bookless = self.write_bookless_archive(folder / "画像なし_05.zip")
        self.assertEqual(
            [],
            toc_analyzer.locate_books(bookless),
            "下準備の ZIP から本が読めている",
        )

        # Act
        result = self.finished([folder])["result"]

        # Assert - 本は出ないが、走査の一覧には必ず出る。ここが無いと画面に
        # 行が作れず、外した覚えのないアーカイブが黙って消える
        self.assertNotIn(
            str(bookless),
            [book["source"] for book in result["books"]],
            f"本が無いはずの ZIP から本が出ている: {result['books']}",
        )
        self.assertIn(
            str(bookless),
            result["containers"],
            f"本が出ない入れ物が走査の一覧から抜けている: {result['containers']}",
        )
        # Assert - 読めてはいる。読めなかった扱いにすると、画像が無いだけの
        # アーカイブにまで「目次を読めません」の印が出る
        self.assertEqual(
            [],
            [item["source"] for item in result["unreadable"]],
            f"読めている ZIP が読めなかった扱いになっている: {result['unreadable']}",
        )

        # Act - 画面が既定で選ぶのと同じ形。本の行に加えて、本を持たない
        # 入れ物そのものを位置なしで指す
        output = self.work_dir / "out-黙って落ちる"
        chosen = [
            {"source": book["source"], "entry": book["entry"]}
            for book in result["books"]
        ]
        chosen.append({"source": str(bookless), "entry": ""})
        accepted = self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(folder)],
                "output_directory": str(output),
                "title": TITLE,
                "author": AUTHOR,
                "keep_originals": True,
                "books": chosen,
            },
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert - 本を持たない入れ物も整理の対象数に入り、実際に処理される。
        # ``app.py`` の ``_wanted_entries`` が外していれば総数は 1 になり、
        # 経過にも名前が残らない。ここが黙って落ちることの正体
        self.assertEqual(2, job["total"], f"整理の対象数が違う: {job}")
        self.assertTrue(
            any(bookless.name in line for line in job["log"]),
            f"本を持たない入れ物が整理へ渡っていない: {job['log']}",
        )

        # Assert - 本の出るほうは今までどおり出来上がる
        self.assertEqual(
            [
                f"[{AUTHOR}] {TITLE} 第001巻.zip",
                f"[{AUTHOR}] {TITLE} 第002巻.zip",
            ],
            self.files_under(output),
            "本を持たない入れ物を混ぜたせいで、他の本まで出来なくなっている",
        )


class ScanCancellationTest(AnalysisJobTestBase):
    """5. 走っている最中の走査も、打ち切れる

    解析をジョブにしたのは途中経過のためだけではない。投入を編集するたびに
    解析は走り直し、前のものは打ち切られる。打ち切りが効かないと、蔵書を
    歩くだけのワーカーが編集の回数だけ溜まり、画面が見ている経路まで詰まる
    （``analysis_job`` の冒頭に書かれている、ジョブにした理由そのもの）。

    ところが打ち切りを投げるのは ``JobStore._report`` だけで、走査
    （``expand_inputs``）はその手前で最後まで走り切る。数百 GB の蔵書では
    ここが数分あり、その間の打ち切りは何も止めない。

    ここで求める契約は「走査も折々で打ち切りを見に行く」。1 件ごとである
    必要は無い。1 パスごとにロックと確定を取ると走査そのものが重くなるので、
    確かめるのは「全部を歩き切る前に止まる」ことにしてある。
    """

    inline = False

    # 走査だけで通り抜けるフォルダの数。見張りの間隔がどうであれ「途中で
    # 止まった」と言えるだけの数を置く
    TREE_WIDTH = 2000

    def build_walk_only_tree(self, name: str) -> tuple[Path, list[Path]]:
        """アーカイブを 1 つも置かないフォルダの木。

        目次読みが 1 件も無いので、ここで起きることは走査だけになる。
        「目次を読み始める前に止まったか」を、他の仕事と混ぜずに見られる。
        """
        root = self.work_dir / name
        folders = [root / f"{index:04d}" for index in range(self.TREE_WIDTH)]
        for folder in folders:
            folder.mkdir(parents=True)
        return root, folders

    def spy_on_the_walk(self, root: Path, pause_after: int | None = None):
        """木を歩いた跡を控える。指定の件数まで来たら、そこで待たせる。

        状態が "cancelled" になったことを見ても、打ち切りが効いた証拠には
        ならない。``JobStore.cancel`` はワーカーが気づくかどうかに関わらず
        その状態を書く。実際に歩くのをやめたかは、歩いた跡でしか分からない。

        見張るのは ``os.scandir``。``os.walk`` も中でこれを呼ぶので、走査を
        ``os.walk`` で書いても ``os.scandir`` で書いても同じ 1 つの見張りで
        数えられる。
        """
        visited: list[str] = []
        reached = threading.Event()
        released = threading.Event()
        pause = [pause_after]
        original = os.scandir
        prefix = str(root)

        def spy(path=".", *args, **kwargs):
            if str(path).startswith(prefix):
                visited.append(str(path))
                if pause[0] is not None and len(visited) == pause[0]:
                    reached.set()
                    released.wait(15)
            return original(path, *args, **kwargs)

        def disarm():
            pause[0] = None

        patcher = mock.patch.object(os, "scandir", spy)
        patcher.start()
        # 止めたまま片付けに入るとワーカースレッドが残るので、必ず解放する
        self.addCleanup(patcher.stop)
        self.addCleanup(released.set)
        return visited, reached, released, disarm

    def test_cancelling_during_the_scan_stops_the_walk(self):
        # Arrange - 目次を読むものが 1 つも無い木。仕事は走査だけになる
        root, folders = self.build_walk_only_tree("走査の打ち切り")
        visited, reached, released, disarm = self.spy_on_the_walk(root, pause_after=10)

        # Act - 走査の入口あたりで止め、まだ 1 つも目次を読んでいない時点で
        # 打ち切りを頼む
        job_id = self.accepted_id([root])
        self.assertTrue(reached.wait(15), f"走査が始まらない: {visited}")
        cancelled = self.client.post(
            f"/api/jobs/{job_id}/cancel", params=self.auth(), json={}
        )
        self.assertEqual(202, cancelled.status_code, cancelled.text)
        released.set()

        # Assert - 残りを歩き切らずに止まる。「ちょうど 10 件目で止まる」
        # ことは求めない（1 パスごとの見張りは重すぎる）。求めるのは、
        # 木の半分にも届かないうちに止まること
        limit = len(folders) // 2
        self.assertFalse(
            wait_until(lambda: len(visited) > limit, timeout=5.0),
            f"打ち切ったのに走査が続いている: {len(visited)} / {len(folders)} 件",
        )

        # Assert - 対照。止めなければ木を最後まで歩く。見張りが呼ばれて
        # いない・パスが合っていないだけの実装でも、上の「歩いていない」は
        # 通ってしまう
        disarm()
        visited.clear()
        again = self.accepted_id([root])
        self.assertTrue(
            wait_until(lambda: self.job(again)["state"] == "succeeded", timeout=30.0),
            f"対照の実行が終わらない: {self.job(again)}",
        )
        self.assertEqual(
            set(),
            {str(folder) for folder in folders} - set(visited),
            f"対照でも木を歩き切っていない: {len(visited)} / {len(folders)} 件",
        )


class CorruptArchiveIsNotSilentTest(AnalysisJobTestBase):
    """6. 壊れたアーカイブを、印も付けずに整理へ通さない

    第 4 段階から、本を 1 冊も持たない入れ物も走査の行として残り、既定で
    選ばれてそのまま整理される（``SilentlySkippedArchiveTest``）。裏を返せば、
    壊れたアーカイブも黙って整理の投入に載る。実行して失敗するまで、利用者に
    伝わる手掛かりが 1 つも無い。

    ``locate_books`` は ``BadZipFile`` と ``OSError`` を自分で握りつぶして空を
    返すので、壊れたアーカイブは「読めたが 1 冊も無い」として届き、
    ``unreadable`` に載らない。載らなければ画面の行に「目次を読めません」の
    印も出ない（``PlanList`` の ``ISSUE_LABELS``）。
    """

    def write_corrupt_archive(self, path: Path) -> Path:
        """ZIP の名前をした、ZIP ではないファイル"""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x00\x01 not a zip at all \x02\x03" * 16)
        with self.assertRaises(zipfile.BadZipFile):
            # 下準備の確認。本当に壊れていなければ、以下の検証に意味が無い
            zipfile.ZipFile(path)
        return path

    def write_bookless_archive(self, path: Path) -> Path:
        """壊れてはいないが、画像を 1 枚も含まない ZIP"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("おまけ/memo.txt", "画像は 1 枚も入っていません")
        return path

    def test_a_corrupt_archive_is_reported_but_an_empty_one_is_not(self):
        # Arrange - 壊れたもの・画像の無いもの・読めるもの
        folder = self.work_dir / "壊れている"
        corrupt = self.write_corrupt_archive(folder / "a_01.zip")
        self.write_bookless_archive(folder / "b_02.zip")
        healthy = self.write_archive(folder / "c_03.zip")

        # Act
        job = self.finished([folder])
        result = job["result"]

        # Assert - 挙がるのは壊れたものだけ。画像が無いだけの ZIP まで挙げる
        # 実装（「本が 0 冊なら読めなかったことにする」）では通らない
        self.assertEqual(
            [str(corrupt)],
            [item["source"] for item in result["unreadable"]],
            f"読めなかったアーカイブの挙げ方が違う: {result['unreadable']}",
        )
        self.assertTrue(
            result["unreadable"][0]["reason"],
            f"読めなかった理由が入っていない: {result['unreadable'][0]}",
        )

        # Assert - 行としては残る。既定で選ばれ、実行時に展開して初めて
        # 分かる結果に委ねる。印だけを先に出す
        self.assertIn(
            str(corrupt),
            result["containers"],
            f"壊れたアーカイブが走査の一覧から抜けている: {result['containers']}",
        )

        # Assert - 壊れた 1 つで解析は止まらない
        self.assertEqual(
            [str(healthy)],
            [book["source"] for book in result["books"]],
            f"壊れた 1 つで解析が止まっている: {result['books']}",
        )

        # Assert - 経過にも 1 行残る。進捗の message は上書きされるので、
        # ポーリングの間隔次第で見落とす
        self.assertTrue(
            any(corrupt.name in line for line in job["log"]),
            f"読めなかったことが経過に残っていない: {job['log']}",
        )


if __name__ == "__main__":
    unittest.main()
