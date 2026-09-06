"""ドロップの解決が、走査の量に上限を持つことを確かめる（#91）。

`POST /api/resolve` は、許可されたすべての場所に対して `rglob("*")` を実行
する。件数にも深さにも上限が無い。Tauri シェルが許可する場所は利用者のホーム
なので、画面へファイルを 1 つ落とすたびにホーム全体を歩き切る。撮り溜めた
写真も、ビルドの中間物も、他人のアプリのキャッシュも、全部である。

## ここで決める上限

**1 回の要求で見るファイルシステムの項目数に上限を置く**（`RESOLVE_MAX_ENTRIES`）。
上限は許可された場所ごとではなく、要求ごとに 1 つ。許可が 2 つに増えたら
歩く量も 2 倍、では上限を置いた意味が無いため。

深さの上限は別に置かない。件数の上限があれば、深い方向へ潜り続けても項目数
を食い尽くした時点で止まるので、深さは自然に頭打ちになる。つまみは 1 つで
足りる。

代わりに、**浅いところから先に見る**ことを条件に加える。件数の上限だけを
足して今の深さ優先の走査に被せると、たまたま先に入った枝（`~/.cache` など）
だけで上限を使い切り、`~/ダウンロード` に落ちているファイルに一度も辿り
着かなくなる。利用者から見れば「ドロップが効かない」であり、上限を入れた
せいで機能そのものが壊れる。

「見つけたら即やめる」は採れない。同名が複数あるときにサイズで絞り、絞れ
なければ `ambiguous` として返す約束があるので、最初の 1 件で打ち切ると
`test_reports_ambiguous_matches_instead_of_guessing` が壊れる。勝手に選ぶ
実装になってしまう。

## 上限に達したときの応答

見つからなかったときと同じ扱い、つまり `unresolved` に入れる。応答に
「打ち切った」を伝える欄は足さない。足すと `services/core/openapi.json` が
動くうえ、画面側にも新しい分岐が要る。利用者から見た結果は
「そのファイルは特定できなかった（選び直してください）」で変わらない。

## 数え方

`os.scandir` を見張り、走査が実際に見た項目を数える。`test_analysis_progress.py`
が打ち切りを確かめるのに使っているのと同じ手。経過時間で測ると、機械の混み
具合で結果が変わって当てにならない。

見張りは並びも固定する。ファイルシステムが返す順は決まっていないので、
固定しないと「重い枝を先に歩いた場合」が運任せになり、同じテストが通ったり
落ちたりする。
"""

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api import app as api_app  # noqa: E402
from manga_api.app import create_app  # noqa: E402

# 走査の上限を公開する名前。実装はこの名前で読めるようにすること
BOUND_NAME = "RESOLVE_MAX_ENTRIES"

# 上限を探しに行く先。`app.py` の分割はまだ続くので、どのモジュールに置いた
# かでテストが壊れないよう、自分たちのパッケージの中を横断して探す
OUR_PACKAGES = ("manga_api", "manga_core")


def modules_declaring_the_bound() -> list:
    """上限を持っているモジュールを集める。

    `from ... import RESOLVE_MAX_ENTRIES` で持ち込まれた写しも含めて全部
    拾う。1 つだけ書き換えると、実際に読まれている方が元の値のまま残る。
    """
    return [
        module
        for name, module in sorted(sys.modules.items())
        if name.split(".")[0] in OUR_PACKAGES
        and module is not None
        and BOUND_NAME in vars(module)
    ]


def declared_bound():
    """公開されている上限。まだ無ければ None"""
    found = modules_declaring_the_bound()
    return getattr(found[0], BOUND_NAME) if found else None


# 上限として意味のある幅。下限は「実際に使える」ことを、上限は「名ばかりの
# 上限ではない」ことを守る。ホーム直下に数十万の項目がある機械でも、
# 落としたファイルが数階層下にあれば届く程度を想定している
MINIMUM_USEFUL_BOUND = 1_000
MAXIMUM_SANE_BOUND = 100_000

# 応答の形。ここに欄を足すと openapi.json が動く
RESOLVE_RESPONSE_KEYS = {"resolved", "unresolved", "ambiguous", "searched_roots"}


class WalkSpy:
    """走査が見た項目を数える。並びは名前順に固定する。

    `os.scandir` の返り値と同じように使えるだけの見た目を持たせてある
    （`with` で包まれても、そのまま回されても動く）。

    先に全部読んでから順に渡すが、数えるのは渡した時点。読み手が途中で
    やめれば、その先は数に入らない。上限を守ったかどうかを、読み手の側の
    振る舞いだけで測るため。
    """

    def __init__(self, entries: list, visited: list[str]):
        self._entries = entries
        self._visited = visited
        self._index = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc_info) -> bool:
        return False

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._entries):
            raise StopIteration
        entry = self._entries[self._index]
        self._index += 1
        self._visited.append(entry.path)
        return entry

    def close(self) -> None:
        return None


class ResolveScanTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)

    def build_app(self, roots: list[Path]):
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=roots,
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        return self.app

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.app.state.token, **(params or {})}

    def resolve(self, name: str, size: int) -> dict:
        return self.client.post(
            "/api/resolve",
            params=self.auth(),
            json={"files": [{"name": name, "size": size}]},
        ).json()

    def cap_the_scan(self, entries: int) -> None:
        """上限を小さくして試す。

        既定の上限どおりの木をテストで作ると、それだけで数万のファイルを
        並べることになる。名前がまだ無いときは `manga_api.app` に生やして
        差し替える（`create=True`）。名前が無いことだけで落ちると、走査の量を
        一度も見ないまま赤くなり、何が直っていないのか分からなくなるため。
        """
        targets = modules_declaring_the_bound() or [api_app]
        for module in targets:
            patcher = mock.patch.object(module, BOUND_NAME, entries, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def spy_on_the_walk(self, roots: list[Path]) -> list[str]:
        """走査が見た項目を控える。数えるのは許可された場所の中だけ"""
        visited: list[str] = []
        original = os.scandir
        prefixes = tuple(str(root) for root in roots)

        def spy(path=".", *args, **kwargs):
            try:
                inside = str(path).startswith(prefixes)
            except TypeError:  # 記述子など、パスでない呼ばれ方
                inside = False
            if not inside:
                return original(path, *args, **kwargs)
            with original(path, *args, **kwargs) as entries:
                # 先に読み切って並びを固定する。読み切ること自体は数に
                # 入らない（数えるのは読み手へ渡した時点）
                ordered = sorted(entries, key=lambda entry: entry.name)
            return WalkSpy(ordered, visited)

        patcher = mock.patch.object(os, "scandir", spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return visited

    def make_wide_tree(self, root: Path, folders: int, files: int) -> int:
        """幅で稼ぐ木。作った項目の数を返す"""
        made = 0
        for index in range(folders):
            folder = root / f"00_枝{index:02d}"
            folder.mkdir(parents=True)
            made += 1
            for number in range(files):
                (folder / f"{number:03d}.bin").write_bytes(b"x")
                made += 1
        return made

    def make_deep_chain(self, root: Path, depth: int) -> int:
        """深さで稼ぐ木。各段に 1 つファイルを置く。作った項目の数を返す"""
        current = root
        made = 0
        for level in range(depth):
            current = current / f"{level:03d}"
            current.mkdir(parents=True)
            (current / "詰め物.bin").write_bytes(b"x")
            made += 2
        return made


class ResolveScanBoundTest(ResolveScanTestBase):
    """走査に上限があること"""

    def test_publishes_a_bound_for_the_drop_scan(self):
        """上限そのものが、名前の付いた値として在ること。

        値の幅まで見るのは、`0` にして「歩かないから速い」（ドロップが常に
        効かない）ことや、`10**12` にして「上限はあります」と言うだけの逃げ
        道を塞ぐため。
        """
        # Act
        bound = declared_bound()

        # Assert
        self.assertIsNotNone(
            bound,
            f"{BOUND_NAME} がどこにも無い（探した先: {OUR_PACKAGES}）。"
            "1 回の要求で見るファイルシステムの項目数の上限を、"
            "差し替えられる名前として公開すること（manga_api.app を想定）",
        )
        self.assertIsInstance(bound, int, f"{BOUND_NAME} は項目数（整数）で持つこと")
        self.assertGreaterEqual(
            bound,
            MINIMUM_USEFUL_BOUND,
            f"{BOUND_NAME} が小さすぎる。数階層下に落ちているファイルに"
            "届かなくなり、ドロップが効かなくなる",
        )
        self.assertLessEqual(
            bound,
            MAXIMUM_SANE_BOUND,
            f"{BOUND_NAME} が大きすぎて上限の役をしていない。"
            "ホーム全体を歩き切るのと変わらない",
        )

    def test_stops_the_drop_scan_after_the_budget_is_spent(self):
        """上限を超えたら歩くのをやめること"""
        # Arrange - 上限のはるか外まで項目のある木
        budget = 25
        shelf = self.work_dir / "蔵書"
        shelf.mkdir()
        size = self.make_wide_tree(shelf, folders=20, files=30)
        self.assertGreater(
            size,
            budget * 8,
            "木が小さすぎる。上限を守っていなくても数が収まってしまい、"
            "このテストは何も確かめていないことになる",
        )
        self.build_app([self.work_dir])
        self.cap_the_scan(budget)
        visited = self.spy_on_the_walk([self.work_dir])

        # Act - 木の中に無い名前。探し切っても見つからない
        found = self.resolve("いない.zip", 1)

        # Assert - 上限のあたりで止まること。ぴったりの数は求めない
        # （実装が段ごとに数えるか 1 件ずつ数えるかで端数が変わる）
        seen = len(set(visited))
        self.assertEqual(["いない.zip"], found["unresolved"])
        self.assertLessEqual(
            seen,
            budget * 3,
            f"上限 {budget} を無視して {seen} 件を歩いた（木は {size} 件）。"
            "許可された場所がホームなら、ドロップのたびにホーム全体を歩く",
        )

    def test_the_budget_covers_the_whole_request_not_each_root(self):
        """上限は要求ごとに 1 つ。許可された場所の数だけ増えないこと"""
        # Arrange - 許可された場所が 2 つ
        budget = 25
        first = self.work_dir / "一つ目"
        second = self.work_dir / "二つ目"
        first.mkdir()
        second.mkdir()
        size = self.make_wide_tree(first, folders=15, files=20)
        size += self.make_wide_tree(second, folders=15, files=20)
        self.build_app([first, second])
        self.cap_the_scan(budget)
        visited = self.spy_on_the_walk([first, second])

        # Act
        self.resolve("いない.zip", 1)

        # Assert
        seen = len(set(visited))
        self.assertLessEqual(
            seen,
            budget * 3,
            f"許可された場所 2 つで {seen} 件を歩いた（木は {size} 件）。"
            "上限が場所ごとだと、許可が増えるほど歩く量も増えてしまう",
        )

    def test_reports_a_file_beyond_the_budget_as_unresolved(self):
        """上限に阻まれて届かなかったファイルの返し方。

        見つからなかったときと同じ形で返すこと。応答に欄を足して伝えるのは
        採らない（openapi.json が動く）。利用者から見た結果は
        「特定できなかった」で変わらない。
        """
        # Arrange - 入口だけで上限を使い切る木。奥のファイルには届かない
        budget = 20
        for index in range(40):
            (self.work_dir / f"00_枝{index:02d}").mkdir()
        buried = self.work_dir / "zz_奥" / "a" / "b" / "c" / "d"
        buried.mkdir(parents=True)
        target = buried / "落とした.zip"
        target.write_bytes(b"z" * 40)
        self.build_app([self.work_dir])
        self.cap_the_scan(budget)
        self.spy_on_the_walk([self.work_dir])

        # Act
        found = self.resolve("落とした.zip", 40)

        # Assert - 形は変わらず、届かなかったものは unresolved に入る
        self.assertEqual(
            RESOLVE_RESPONSE_KEYS,
            set(found),
            "応答の形が変わっている。欄を増やすと openapi.json が動く",
        )
        self.assertEqual(
            [],
            found["resolved"],
            "上限を超えた先まで歩いてファイルを見つけている。上限が効いていない",
        )
        self.assertEqual(["落とした.zip"], found["unresolved"])
        self.assertEqual([], found["ambiguous"])


class ResolveStillFindsTest(ResolveScanTestBase):
    """上限を入れても、落としたファイルが見つかること。

    このクラスは今も通る。上限の入れ方を縛るための備えで、素朴に
    「深さ優先の走査に件数の上限を足す」と赤くなる。
    """

    def test_finds_a_shallow_file_even_when_a_heavy_branch_comes_first(self):
        """重い枝を先に歩いても、浅いところのファイルには辿り着くこと。

        名前順に固定した並びで、深い枝（`00_深い`）が棚（`zz_棚`）より先に
        来るようにしてある。深さ優先で上限を足すと、深い枝だけで上限を使い
        切り、棚に一度も入らない。実機で言えば `~/.cache` を掘っている間に
        `~/ダウンロード` へ辿り着けない状態で、利用者にはドロップが効かなく
        なったようにしか見えない。
        """
        # Arrange
        budget = 60
        deep = self.work_dir / "00_深い"
        deep.mkdir()
        self.make_deep_chain(deep, depth=200)
        shelf = self.work_dir / "zz_棚" / "作品"
        shelf.mkdir(parents=True)
        target = shelf / "落とした.zip"
        target.write_bytes(b"z" * 30)
        self.build_app([self.work_dir])
        self.cap_the_scan(budget)
        self.spy_on_the_walk([self.work_dir])

        # Act
        found = self.resolve("落とした.zip", 30)

        # Assert
        self.assertEqual(
            [str(target)],
            found["resolved"],
            "浅いところに落ちているファイルを見つけられていない。"
            "重い枝を先に歩いて上限を使い切っている",
        )

    def test_finds_a_file_a_few_levels_down_with_the_real_bound(self):
        """既定の上限のまま、数階層下のファイルが見つかること。

        上限を小さくして辻褄を合わせる直し方を塞ぐ。手を入れないので、
        ここで見ているのは実際に配られる値そのもの。
        """
        # Arrange - 数百の項目に紛れた、5 階層下のファイル
        shelf = self.work_dir / "蔵書"
        shelf.mkdir()
        self.make_wide_tree(shelf, folders=10, files=30)
        nested = shelf / "作品" / "第 1 期" / "単行本" / "初版"
        nested.mkdir(parents=True)
        target = nested / "落とした.zip"
        target.write_bytes(b"z" * 50)
        self.build_app([self.work_dir])

        # Act
        found = self.resolve("落とした.zip", 50)

        # Assert
        self.assertEqual(
            [str(target)],
            found["resolved"],
            "既定の上限が小さすぎて、数階層下のファイルに届いていない",
        )


if __name__ == "__main__":
    unittest.main()
