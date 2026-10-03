"""整理済みの蔵書を、そのまま辞書へ取り込む経路（#73 段階 6）。

一度整理し終えた蔵書は、それ自体が「作品名 → 著者」の対応表になっている。
段階 1・2 でサイドカーは本ごとに「これは既にこの道具が作った物そのものか」を
判定し、段階 4a でその本の作品名と著者を名前から読み取って返すようになった。
その対をまとめて辞書へ入れられれば、以降の整理では著者欄が勝手に埋まる。

## 判定は辞書を読まない（逆流させない）

ここで足すのは「判定 → 辞書」の一方向だけである。逆向き（辞書を見て整理済みと
判定する）は入れない。名前から作品名も著者も読めるので引く必要が無いうえ、
辞書は PC ごとに違う可変の状態なので、同じ蔵書が機械によって違う判定になる。
さらに、往復しない名前でも辞書に当たれば整理済みと見なす抜け道になる。

## なぜ新しい経路が要るのか

既にある ``POST /api/library/entries`` は ``ON CONFLICT(title) DO UPDATE SET
author`` で**上書きする**。整理の実行時に、そのときの対を残すための経路だから
である。取り込みで同じ経路を使うと、名前の解釈をたまたま通っただけの 1 件が、
利用者が手で直した著者を永久に潰す。しかもその表は、以降のすべての整理で
著者欄を自動で埋める表である。

画面側で「読んでから、無いものだけ書く」と合成することもできない。
``GET /api/library/entries`` が返すのは新しい順 200 件（絞り込み時は 50 件）
までで、それを超える辞書では**在るものが「無い」と見える**。その誤認のまま
上書きする経路を叩けば、上の事故がそのまま起きる。辞書ダイアログでの保存と
競合もする。有無の確認と書き込みは、辞書の全体が見える側で 1 つの操作として
行わなければならない。

## この経路が守ること

- 辞書に**無い**作品名だけを足す（``get_author_by_title`` が None のものだけ）
- 既にある作品名は、著者が違っても**絶対に上書きしない**。黙って捨てず、
  利用者に「辞書は A、蔵書は B」と伝える
- 同じ著者で既にあるものは衝突ではない。ただ既に在るだけ

契約（実装者が満たすもの）:

- 経路 ``POST /api/library/import``（``dependencies=guarded``）
- 依頼 ``{"entries": [{"title": ..., "author": ...}]}``
- 応答 ``{"imported": [対], "unchanged": [対],
  "conflicts": [{"title": ..., "kept_author": 文字列か null,
  "incoming_authors": [文字列]}]}``

``incoming_authors`` を配列にしてあるのは、蔵書の側で同じ作品名に違う著者が
付いている場合（``kept_author`` が null になる場合）も同じ形で言えるようにする
ため。画面はこの 3 つの配列だけで「何を入れたか・何をそのままにしたか」を
言える。
"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_api.app import create_app  # noqa: E402
from manga_core.manga_database import MangaDatabase  # noqa: E402

IMPORT_PATH = "/api/library/import"


def pairs_of(items: list[dict]) -> set[tuple[str, str]]:
    """応答の対の並びを、突き合わせやすい形にする"""
    return {(item["title"], item["author"]) for item in items}


def conflicts_of(payload: dict) -> dict[str, tuple[str | None, tuple[str, ...]]]:
    """衝突を作品名で引ける形にする。残した著者と、蔵書から来た著者"""
    return {
        item["title"]: (item["kept_author"], tuple(item["incoming_authors"]))
        for item in payload["conflicts"]
    }


class LibraryImportTestBase(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self, params: dict | None = None) -> dict:
        return {"token": self.app.state.token, **(params or {})}

    def stored(self) -> dict[str, str]:
        """いま辞書に入っている全部。作品名 → 著者。

        件数ではなく中身で見る。件数だけを数えると「どの作品名にどの著者が
        入ったか」は何も確かめられず、入れ替わっていても通ってしまう。
        """
        database = MangaDatabase(Path(self.app.state.database_path))
        try:
            return {title: author for title, author, *_ in database.get_all_manga()}
        finally:
            database.close()

    def seed(self, title: str, author: str) -> None:
        """既にある辞書の中身を、既存の経路で仕込む。

        仕込んだつもりで入っていなければ、その後の「上書きしていない」は
        何も確かめていないことになる。仕込みの成否をここで固定する。
        """
        response = self.client.post(
            "/api/library/entries",
            params=self.auth(),
            json={"title": title, "author": author},
        )
        self.assertEqual(
            200, response.status_code, f"仕込みが失敗した: {response.text}"
        )
        self.assertEqual(
            author, self.stored().get(title), "仕込んだはずの対が辞書に入っていない"
        )

    def bring_in(self, pairs: list[tuple[str, str]]):
        return self.client.post(
            IMPORT_PATH,
            params=self.auth(),
            json={"entries": [{"title": t, "author": a} for t, a in pairs]},
        )

    def imported(self, pairs: list[tuple[str, str]]) -> dict:
        response = self.bring_in(pairs)
        self.assertEqual(
            200, response.status_code, f"取り込みが断られた: {response.text}"
        )
        return response.json()


class LibraryImportTest(LibraryImportTestBase):
    """整理済みの対を辞書へ入れる。無いものだけを足し、在るものは触らない"""

    def test_only_titles_the_dictionary_does_not_have_are_written(self):
        """辞書に無い作品名だけが足される。

        空の辞書に入れると「上書きしない」は言うまでもなく成り立つので、
        辞書には先に **食い違う 1 件**（同じ作品名・違う著者）と
        **一致する 1 件**（同じ作品名・同じ著者）を仕込んでおく。
        そのうえで、足りるはずの 1 件が実際に入ったことも同じテストで見る。
        入っていなければ「何も上書きしていない」は、そもそも取り込みが
        走っていないだけかもしれない。
        """
        # Arrange
        self.seed("棚の作品", "別人")
        self.seed("同じ作品", "同じ著者")

        # Act
        payload = self.imported(
            [
                ("棚の作品", "棚の著者"),
                ("同じ作品", "同じ著者"),
                ("新しい作品", "新しい著者"),
            ]
        )

        # Assert - 辞書の中身を作品名ごとに見る
        self.assertEqual(
            {
                "棚の作品": "別人",
                "同じ作品": "同じ著者",
                "新しい作品": "新しい著者",
            },
            self.stored(),
            "辞書に入ったものが違う。無いものだけを足し、在るものは触らない",
        )

        # Assert - 応答も同じことを言う。書けていないのに書けたと言う応答は、
        # 画面に「入れました」と出させてしまう
        self.assertEqual(
            {("新しい作品", "新しい著者")},
            pairs_of(payload["imported"]),
            "入れた対の報告が、実際に書いたものと合っていない",
        )

    def test_a_different_author_is_kept_and_the_user_is_told(self):
        """既にある作品名は上書きされず、食い違いが利用者に伝わる。

        黙って捨てるのは駄目である。利用者から見ると「押したのに変わって
        いない」だけになり、辞書と蔵書のどちらが正しいのか確かめる手立てが
        無くなる。だから残した著者と蔵書の著者の両方を返させる。

        取り込みが走ったことは、同じ呼び出しで足りた 1 件で示す。走って
        いなければ「上書きされていない」は当たり前に成り立つ。
        """
        # Arrange - 利用者が手で直した著者だとする
        self.seed("棚の作品", "別人")

        # Act
        payload = self.imported(
            [("棚の作品", "棚の著者"), ("新しい作品", "新しい著者")]
        )

        # Assert - 上書きされていない
        self.assertEqual(
            "別人",
            self.stored().get("棚の作品"),
            "辞書にある著者が蔵書の著者で上書きされた。"
            "以降の整理はこの表から著者欄を埋めるので、直した覚えが消える",
        )
        # Assert - 取り込み自体は走っている（対照）
        self.assertEqual(
            "新しい著者",
            self.stored().get("新しい作品"),
            "取り込みそのものが走っていない。上の主張は空振りしている",
        )

        # Assert - 何と食い違ったのかが言える形で返る
        self.assertEqual(
            {"棚の作品": ("別人", ("棚の著者",))},
            conflicts_of(payload),
            "衝突の報告に、辞書に残した著者と蔵書の著者の両方が入っていない",
        )
        # Assert - 入れたものとして数えない。押した数と入った数がずれる
        self.assertNotIn(
            "棚の作品",
            {item["title"] for item in payload["imported"]},
            "書いていない対を「入れました」と報告している",
        )
        self.assertNotIn(
            "棚の作品",
            {item["title"] for item in payload["unchanged"]},
            "食い違ったものを「既に在るだけ」に混ぜている。利用者に伝わらない",
        )

    def test_the_same_author_is_not_a_conflict(self):
        """同じ著者で既にあるものは、衝突ではなく「既に在るだけ」。

        ここを衝突として数えると、一度整理した蔵書を入れ直すたびに、
        直すところが何も無いのに「N 件が食い違います」と出る。警告が
        意味を失い、本当の食い違いが埋もれる。
        """
        # Arrange
        self.seed("同じ作品", "同じ著者")

        # Act
        payload = self.imported(
            [("同じ作品", "同じ著者"), ("新しい作品", "新しい著者")]
        )

        # Assert
        self.assertEqual(
            [], payload["conflicts"], "同じ著者を食い違いとして報告している"
        )
        self.assertEqual(
            {("同じ作品", "同じ著者")},
            pairs_of(payload["unchanged"]),
            "既に同じ著者で在るものが「既に在る」として報告されていない",
        )
        self.assertEqual(
            {("新しい作品", "新しい著者")},
            pairs_of(payload["imported"]),
            "取り込みが走っていない。上の主張は空振りしている",
        )
        self.assertEqual(
            {"同じ作品": "同じ著者", "新しい作品": "新しい著者"},
            self.stored(),
            "辞書の中身が変わっている",
        )

    def test_importing_twice_changes_nothing_the_second_time(self):
        """2 回目は何も変わらない。

        「何も入らなかった」は取り込みが走らなくても成り立つので、1 回目に
        実際に入ったことを同じテストで押さえる。辞書には食い違う 1 件を
        仕込んでおき、2 回目でも上書きされないことまで見る。
        """
        # Arrange
        self.seed("棚の作品", "別人")
        pairs = [
            ("棚の作品", "棚の著者"),
            ("別の作品", "別の著者"),
            ("第三の作品", "第三の著者"),
        ]
        expected = {
            "棚の作品": "別人",
            "別の作品": "別の著者",
            "第三の作品": "第三の著者",
        }

        # Act - 1 回目
        first = self.imported(pairs)

        # Assert - 1 回目は実際に入っている（2 回目の主張の土台）
        self.assertEqual(
            {("別の作品", "別の著者"), ("第三の作品", "第三の著者")},
            pairs_of(first["imported"]),
            "1 回目で入るはずの対が入っていない",
        )
        self.assertEqual(expected, self.stored(), "1 回目の辞書の中身が違う")

        # Act - 2 回目。同じものをそのまま押し直す
        second = self.imported(pairs)

        # Assert
        self.assertEqual([], second["imported"], "2 回目に同じ対をもう一度書いている")
        self.assertEqual(
            {("別の作品", "別の著者"), ("第三の作品", "第三の著者")},
            pairs_of(second["unchanged"]),
            "2 回目に「既に在る」と報告されていない",
        )
        self.assertEqual(
            {"棚の作品": ("別人", ("棚の著者",))},
            conflicts_of(second),
            "2 回目の食い違いの報告が 1 回目と変わっている",
        )
        self.assertEqual(
            expected,
            self.stored(),
            "2 回目で辞書の中身が変わった。押すたびに結果が動く",
        )

    def test_the_same_pair_many_times_is_written_once(self):
        """同じ対が何度来ても 1 件。巻数のぶんだけ同じ対が来る。

        整理済みの本は 1 冊 1 ファイルなので、5 巻ある作品は同じ
        「作品名・著者」を 5 回よこす。ここで素朴に 1 件ずつ書くと、
        2 件目以降は**自分が今書いた行**に当たり、「辞書に既にあります」と
        報告される。利用者から見ると、押した覚えのない相手との食い違いが
        出ることになる。
        """
        # Act - 1 作品 3 巻ぶんと、別の作品 1 巻ぶん
        payload = self.imported(
            [
                ("棚の作品", "棚の著者"),
                ("棚の作品", "棚の著者"),
                ("棚の作品", "棚の著者"),
                ("別の作品", "別の著者"),
            ]
        )

        # Assert
        self.assertEqual(
            [], payload["conflicts"], "自分が書いた行を食い違いとして報告している"
        )
        self.assertEqual(
            [], payload["unchanged"], "自分が書いた行を「既に在る」と報告している"
        )
        self.assertEqual(
            {("棚の作品", "棚の著者"), ("別の作品", "別の著者")},
            pairs_of(payload["imported"]),
            "同じ対が重複して報告されている。押した数と件数が合わなくなる",
        )
        self.assertEqual(
            {"棚の作品": "棚の著者", "別の作品": "別の著者"},
            self.stored(),
            "辞書の中身が違う",
        )

    def test_a_title_with_two_authors_in_one_request_is_not_written(self):
        """蔵書の中で著者が食い違う作品名は、どちらも書かない。

        ``[著者A] X`` と ``[著者B] X`` が同じ蔵書に居ることはある。ここで
        先に来たほうを採ると、道具が黙って勝者を決めることになる。以降の
        整理はその著者で埋まり続けるのに、利用者は選んだ覚えが無い。
        辞書に無いのだから上書きは起きないが、**書かない**ことが要る。

        書かなかったことが「取り込みが走らなかった」ではないことは、同じ
        呼び出しで確かに入った 1 件で示す。
        """
        # Act
        payload = self.imported(
            [
                ("曖昧な作品", "著者A"),
                ("曖昧な作品", "著者B"),
                ("確かな作品", "確かな著者"),
            ]
        )

        # Assert - どちらの著者でも書かれていない
        self.assertEqual(
            {"確かな作品": "確かな著者"},
            self.stored(),
            "蔵書の中で著者が食い違う作品名を、道具が勝手に選んで書いた",
        )
        # Assert - 黙って落とさず、食い違いとして伝える
        self.assertEqual(
            {"曖昧な作品": (None, ("著者A", "著者B"))},
            conflicts_of(payload),
            "蔵書の中の食い違いが、両方の著者ごと伝わっていない",
        )
        self.assertEqual(
            {("確かな作品", "確かな著者")},
            pairs_of(payload["imported"]),
            "取り込みが走っていない。上の主張は空振りしている",
        )

    def test_blank_titles_and_authors_are_never_written(self):
        """作品名か著者が空の対は書かない。

        著者が空のまま入ると、その作品名を打つたびに著者欄が「辞書由来」と
        して空で埋まる。利用者は補完が効いたと思い、空のまま整理してしまう。
        作品名が空の行は、どの作品にも当たる行として辞書に居座る。
        """
        # Act
        payload = self.imported(
            [
                ("", "著者だけの対"),
                ("   ", "著者だけの対"),
                ("作品名だけの対", ""),
                ("空白だけの著者", "   "),
                ("良い作品", "良い著者"),
            ]
        )

        # Assert - 良い 1 件だけが入る（取り込みは走っている）
        self.assertEqual(
            {"良い作品": "良い著者"},
            self.stored(),
            "作品名か著者が空の対が辞書に入った",
        )
        self.assertEqual(
            {("良い作品", "良い著者")},
            pairs_of(payload["imported"]),
            "入れた対の報告が、実際に書いたものと合っていない",
        )

    def test_import_requires_the_token(self):
        """トークン無しでは取り込めない。

        辞書を書き換える経路なので、同じ PC の他プロセスから叩かれては困る。
        他の経路と同じ扱いにする。断られることだけを見ると、経路が無くても
        通ってしまうので、トークン付きで通ることを同じテストで押さえる。
        """
        # Act / Assert - トークン無しは断られる
        refused = self.client.post(
            IMPORT_PATH, json={"entries": [{"title": "作品", "author": "著者"}]}
        )
        self.assertEqual(
            401, refused.status_code, f"トークン無しで取り込めてしまう: {refused.text}"
        )
        self.assertEqual({}, self.stored(), "断ったのに辞書へ書き込んでいる")

        # Act / Assert - トークン付きなら通る（対照）
        self.assertEqual(200, self.bring_in([("作品", "著者")]).status_code)
        self.assertEqual({"作品": "著者"}, self.stored())


if __name__ == "__main__":
    unittest.main()
