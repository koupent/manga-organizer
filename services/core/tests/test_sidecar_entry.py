"""サイドカーの起動口が、起動した親と一緒に終わることを検証する。

Tauri シェルはサイドカーの stdin を pipe にして書き込み側を持ち続ける。
アプリが閉じても落ちても強制終了されても OS がその口を閉じるので、
サイドカーは EOF を見て自分で終わる。シェルが READY を受け取る前に
閉じられた場合も、止める相手を知らないまま終わる親に頼らずに済む。
"""

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.__main__ import parse_args, watch_parent  # noqa: E402


class WatchParentTest(unittest.TestCase):
    def test_stops_once_the_parent_closes_the_pipe(self):
        calls = []

        watch_parent(io.BytesIO(b""), lambda: calls.append("stop"))

        self.assertEqual(["stop"], calls)

    def test_reads_whatever_arrives_until_the_pipe_closes(self):
        stream = io.BytesIO(b"anything the parent happens to write")
        calls = []

        watch_parent(stream, lambda: calls.append(stream.tell()))

        self.assertEqual([len(stream.getvalue())], calls, "EOF の前に止めている")


class ExitWithParentFlagTest(unittest.TestCase):
    def test_is_off_unless_asked(self):
        # 開発で手で起こすときは stdin が端末になる。読みに行くと止まる
        self.assertFalse(parse_args([]).exit_with_parent)

    def test_can_be_turned_on(self):
        self.assertTrue(parse_args(["--exit-with-parent"]).exit_with_parent)


if __name__ == "__main__":
    unittest.main()
