"""蔵書一覧が、開いた辞書の接続を自分で閉じることを確かめる（#90）。

`GET /api/library/entries`（`list_entries`）は `MangaDatabase` を開くが閉じて
いない。同じファイルの `save_entry` と `delete_entry` は、どちらも `finally`
で閉じている。辞書ダイアログを開くたびに呼ばれる経路なので、開くたびに 1 本
ずつ接続が積み上がる。

## なぜ応答を見ても分からないか

漏れは HTTP の応答には出ない。それどころか、素朴に「辞書ファイルを開いたまま
の数」を数えても 0 になり、テストは素通りする。`MangaDatabase.__del__` が
`close()` を呼ぶため、要求を抜けて局所変数が消えた瞬間に、CPython の参照
カウントがたまたま後始末してくれるからである（実測で確認した）。

## 終了処理任せで済まない理由

- 終了処理は走る保証がない。例外の履歴や循環参照に掴まれて要求より長生き
  すれば、その間ずっと開いたままになる。
- 別のスレッドで走ると、そこで閉じ損ねる。実際に計測中、要求を処理した
  スレッドと違うスレッドで `__del__` が動き、sqlite3 が
  「SQLite objects created in a thread can only be used in that same thread」
  を投げた。`__del__` の中の例外は握り潰されるので、誰にも気づかれないまま
  接続はプロセスが終わるまで残る。
- Windows では、開いたままの辞書ファイルは掴まれたままになる。

だからここで確かめるのは「いつの間にか閉じていたか」ではなく「経路が自分で
閉じたか」である。`save_entry` と `delete_entry` は同じ計測器で「自分で
閉じた」と見えるので、計測器が何にでも赤を出すわけではないことも示せる。

## 計測器

`sqlite3.connect` を差し替え、辞書ファイルへの接続だけを記録する
`sqlite3.Connection` の派生に差し替える。閉じられた時点の呼び出し履歴に
`__del__` があるかどうかで、終了処理任せか、経路が自分で閉じたかを見分ける。

`manga_api` のどのモジュールが `MangaDatabase` を持つかに依らない形にして
ある。`app.py` の分割はまだ続くので、経路の引っ越しでこのテストが壊れない
ようにするため。
"""

import os
import sqlite3
import sys
import traceback
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_core.manga_database import MangaDatabase  # noqa: E402

# 開いたままのファイルを OS 側から数えるための入口。Linux にしか無い
PROC_FD = Path("/proc/self/fd")


class Closing(list):
    """辞書の接続が閉じられた跡。1 要素が 1 回の close()。

    中身は閉じた時点の呼び出し履歴（関数名の並び）。数えるだけでなく履歴を
    残すのは、落ちたときに「誰が閉じたのか」をそのまま読めるようにするため。
    """

    def by_the_endpoint(self) -> list[list[str]]:
        """経路が自分で閉じた分"""
        return [stack for stack in self if "__del__" not in stack]

    def by_the_finalizer(self) -> list[list[str]]:
        """終了処理（__del__）に任せた分"""
        return [stack for stack in self if "__del__" in stack]

    def describe(self) -> str:
        """落ちたときに読む用の要約"""
        if not self:
            return "一度も閉じられていない"
        return "; ".join("→".join(stack[-4:]) for stack in self)


class LibraryConnectionTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.database_path = Path(self.app.state.database_path)

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.app.state.token, **(params or {})}

    def save(self, title: str = "ワンピース", author: str = "尾田栄一郎"):
        return self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": title, "author": author},
        )

    def delete(self, title: str = "ワンピース"):
        return self.client.request(
            "DELETE", "/api/library/entries", params=self.auth({"title": title})
        )

    def listing(self):
        return self.client.get("/api/library/entries", params=self.auth())

    def bring_in(self, title: str = "ワンピース", author: str = "尾田栄一郎"):
        """整理済みの対をまとめて辞書へ入れる（#73 段階 6）"""
        return self.client.post(
            "/api/library/import",
            params=self.auth(),
            json={"entries": [{"title": title, "author": author}]},
        )

    def watch_the_connection(self, keep_open: bool = False) -> Closing:
        """辞書ファイルへの接続が閉じられた跡を控える。

        ``keep_open`` を立てると、控えた接続を掴んだまま離さず、あわせて
        `MangaDatabase.__del__` を何もしない形に差し替える。これは終了処理が
        走らなかった場合（参照が長生きした、別スレッドで走って例外になった）
        の再現で、経路が自分で閉じない限り接続が残ることを OS 側から確かめる
        ためのもの。掴むだけでは足りない。掴んでいても終了処理は動き、その中
        の `close()` が接続を閉じてしまうので、漏れが見えなくなる。
        """
        closing = Closing()
        wanted = str(self.database_path)
        held: list[sqlite3.Connection] = []
        # 掴んだままテストを抜けると記述子が次のテストへ漏れる。手放せば
        # sqlite3 の後始末が閉じてくれる
        self.addCleanup(held.clear)
        if keep_open:
            finalizer = mock.patch.object(MangaDatabase, "__del__", lambda self: None)
            finalizer.start()
            self.addCleanup(finalizer.stop)

        class Recording(sqlite3.Connection):
            def close(self):
                closing.append([frame.name for frame in traceback.extract_stack()])
                super().close()

        original = sqlite3.connect

        def spy(database, *args, **kwargs):
            # 辞書以外（ジョブの控えなど）は素通しする。数えると、何を見て
            # いるのか分からなくなる
            if str(database) == wanted:
                kwargs.setdefault("factory", Recording)
            connection = original(database, *args, **kwargs)
            if str(database) == wanted and keep_open:
                held.append(connection)
            return connection

        patcher = mock.patch.object(sqlite3, "connect", spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return closing

    def count_open_handles(self) -> int:
        """OS から見て、辞書ファイルを開いたままの数"""
        wanted = str(self.database_path)
        found = 0
        for name in os.listdir(PROC_FD):
            try:
                if os.readlink(str(PROC_FD / name)) == wanted:
                    found += 1
            except OSError:
                # 数えている最中に閉じた記述子。数えられないだけで害はない
                continue
        return found


class LibraryConnectionTest(LibraryConnectionTestBase):
    """辞書を開いた経路が、その接続を自分で手放すこと"""

    def test_saving_and_deleting_close_the_connection_themselves(self):
        """対照群。計測器が「自分で閉じた」を見分けられることの証明。

        これが緑にならないまま一覧の側だけ赤くても、それは計測器が何にでも
        赤を出しているだけかもしれない。
        """
        # Arrange
        closing = self.watch_the_connection()

        # Act
        self.assertEqual(200, self.save().status_code)
        self.assertEqual(200, self.delete().status_code)

        # Assert - 2 回開いて、2 回とも経路が自分で閉じている
        self.assertEqual(
            2, len(closing), f"開いた数と閉じた数が合わない: {closing.describe()}"
        )
        self.assertEqual(
            2,
            len(closing.by_the_endpoint()),
            f"終了処理任せで閉じられている: {closing.describe()}",
        )

    def test_listing_the_library_closes_the_connection_itself(self):
        """本題。一覧も、開いた辞書を自分で閉じること"""
        # Arrange
        closing = self.watch_the_connection()

        # Act - 先に記録の経路を通し、計測器が動いていることを確かめてから
        # 一覧を見る。ここが赤いなら、続く判定は信用できない
        self.assertEqual(200, self.save().status_code)
        self.assertEqual(
            1,
            len(closing.by_the_endpoint()),
            "計測器が壊れている。save_entry の close を拾えていない: "
            f"{closing.describe()}",
        )
        closing.clear()
        self.assertEqual(200, self.listing().status_code)

        # Assert
        self.assertEqual(
            1,
            len(closing.by_the_endpoint()),
            "一覧が辞書の接続を自分で閉じていない。"
            f"閉じた跡: {closing.describe() or 'なし'}",
        )
        self.assertEqual(
            [],
            closing.by_the_finalizer(),
            "接続の後始末を終了処理（__del__）に任せている。"
            "参照が残れば走らず、別スレッドで走れば sqlite3 が例外を投げて"
            "閉じ損ねる。辞書ダイアログを開くたびに 1 本ずつ積み上がる",
        )

    def test_importing_into_the_library_closes_the_connection_itself(self):
        """まとめて取り込む経路も、開いた辞書を自分で閉じること（#73 段階 6）。

        辞書を開く 4 つ目の経路になる。1 件ずつの経路と違い、押すのは
        利用者の操作 1 回だが、開くのは同じ 1 本である。ここで閉じ忘れると、
        Windows では辞書ファイルが掴まれたまま残る。
        """
        # Arrange
        closing = self.watch_the_connection()

        # Act - 先に記録の経路を通し、計測器が動いていることを確かめる
        self.assertEqual(200, self.save().status_code)
        self.assertEqual(
            1,
            len(closing.by_the_endpoint()),
            f"計測器が壊れている: {closing.describe()}",
        )
        closing.clear()
        self.assertEqual(200, self.bring_in().status_code)

        # Assert
        self.assertEqual(
            1,
            len(closing.by_the_endpoint()),
            "取り込みが辞書の接続を自分で閉じていない。"
            f"閉じた跡: {closing.describe() or 'なし'}",
        )
        self.assertEqual(
            [],
            closing.by_the_finalizer(),
            "接続の後始末を終了処理（__del__）に任せている",
        )

    @unittest.skipUnless(PROC_FD.is_dir(), "開いたままの記述子を数えられない環境")
    def test_listing_the_library_leaves_the_database_file_open(self):
        """終了処理が間に合わなかったとき、辞書ファイルが開いたまま残ること。

        直前のテストは「誰が閉じたか」を見る。こちらは OS 側から「本当に
        開いたままか」を見る。参照を掴んで終了処理を働かせないことで、
        参照が長生きした場合に実際に起きることを再現している。
        """
        # Arrange - 接続を掴んだまま離さない
        self.watch_the_connection(keep_open=True)

        # Act / Assert - まず記録の経路。掴んだままでも 0 に戻る。
        # つまりこの数え方は「掴んでいるから 1 になる」ものではない
        self.assertEqual(200, self.save().status_code)
        self.assertEqual(
            0,
            self.count_open_handles(),
            "計測器が壊れている。save_entry は閉じているのに開いたままに見える",
        )

        # Act / Assert - 一覧も同じく 0 に戻ること
        self.assertEqual(200, self.listing().status_code)
        self.assertEqual(
            0,
            self.count_open_handles(),
            "一覧のあと、辞書ファイルが開いたまま残っている。"
            "Windows ではこのファイルが掴まれたままになる",
        )


if __name__ == "__main__":
    unittest.main()
