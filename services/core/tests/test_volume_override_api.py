"""利用者が訂正した巻数を、API が受け取り、整理済みの本からは断ること（段階 C）。

段階 B で ``FileOrganizer.process_single_archive(..., volumes=...)`` が訂正を
受け取れるようになった。段階 C はその受け口を HTTP まで通す。

    POST /api/jobs/organize
        {..., "books": [{"source", "entry", "title", "author",
                         "volume": {"number": 7}}]}

**この段階は割れない。** 訂正を受け付ける口と、整理済みの本を守る門を同じ
変更に入れる。割ると「訂正は効くが整理済みを守らない」という一番危ない状態が
生まれる。整理済みの本は既にこの道具が作った物そのものなので、そこへ載った
訂正を通すと、利用者は自分の蔵書の名前を静かに書き換えられる。

## なぜ ``volume`` を包むのか（``int | None`` に潰さない理由）

``BookRef.volume`` を ``int | None`` にすると、``None`` に 2 つの意味が乗る。

| 送られてきた形 | ``int \\| None`` はどう読むか | 本当の意味 |
|---|---|---|
| ``volume`` の鍵が無い | ``None`` | 訂正していない |
| ``"volume": null`` | ``None`` | 訂正していない |
| ``"volume": {"number": null}`` | （表せない） | 巻数を外す |

画面（``plan.ts`` の ``selectedBooks``）は既に**全行へ** ``title`` / ``author`` の
``null`` を載せて送っている。同じ書き方を ``volume`` にも広げると、既定の依頼が
「全冊の巻数を消す」依頼になる。C2 がその形を丸ごと固定している。

``VolumeOverride.number`` は required にする。``{"volume": {}}`` を黙って
「巻数なし」と読むと、包んだ意味そのものが消える（C3）。

## ``number`` の下限が 0 である理由（実測）

体裁の話ではない。``format_volume_name`` と ``organized_detector`` を実際に
走らせて確かめた。

| 訂正 | 出来る名前 | ``_ORGANIZED_STEM`` | ``decide_volume`` が読み戻す値 |
|---|---|---|---|
| ``-1`` | ``[著者] 作品 第-01巻.zip`` | 一致しない | ``1``（origin=pattern） |
| ``0`` | ``[著者] 作品 第000巻.zip`` | 一致する | ``0``（往復する） |

``-1`` を通すと、その本は**二度と「整理済み」にならない**（``第(?P<volume>\\d+)巻``
に一致しない）ので、投入するたびに永久に作り直される。しかも同じ名前は
``第(\\d+)巻`` に拾われて**第 1 巻として読み戻される**ので、利用者は「-1 巻に
したはずの本が 1 巻になっている」ものを、作り直されるたびに受け取る。
``0`` は往復するので許す（C4）。

## 素材の自動判定（実測値）

訂正の値は自動判定と必ず違える。揃えた素材だと、訂正を丸ごと無視する実装が
そのまま通る。

| 素材 | ``entry`` | 自動判定 | この本に載せる訂正 |
|---|---|---|---|
| ``合本.zip`` の ``第01巻/`` | ``第01巻`` | 1 | （訂正しない） |
| ``合本.zip`` の ``第02巻/`` | ``第02巻`` | 2 | 7 |
| ``raw_09.zip`` | ``""`` | 9 | 7 / 0 / 4 |
| ``[著者] 作品 第003巻.zip``（整理済み） | ``""`` | 3 | 7（断られる） |

## 断ったことは、3 つの跡に残す

黙って無視するのは禁止。利用者から見た症状が「直したのに直らない」だけになり、
届かなかったのか断られたのかを切り分ける手がかりが無い。

1. ジョブの結果に ``refused``（``[{"archive", "entry", "reason"}]``）。``failed``
   と同じく**鍵ごと省かない**。省くと画面から見て「拒否が無い」のか
   「数えていない」のかを区別できない（C1 が空の側、C6 が入る側を固定する）
2. ``report(message=...)`` でログに 1 行。``jobs.py`` が ``job_logs`` に積み、
   ``OrganizePanel.tsx`` が ``job.log`` を読むので、画面を 1 行も直さずに見える
3. ``logger.warning``

``failed`` には混ぜない。あちらは「失敗した本」として画面に並ぶが、訂正を
断られた本そのものは作られる。

経路を ``FileOrganizer`` の直呼びではなく HTTP にするのは、この段階で増える
ものの半分が**依頼の検証**（422）で、そこは経路にしか無いため。流儀は
``test_organized_naming.py`` と ``test_plan_selection.py`` に合わせる。
"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# 素材の作り方は既存のテストと共有する。同じ物を別々に書くと、片方を直した
# ときに「同じ入力のはず」の 2 つが静かに食い違う
from test_toc_analysis import pages, zip_with  # noqa: E402

from manga_api import organize_job  # noqa: E402
from manga_api.app import create_app  # noqa: E402
from manga_core.file_organizer import FileOrganizer  # noqa: E402

# 整理済みの本が自分で持っている対
AUTHOR = "著者"
TITLE = "作品"
SERIES_DIR = f"[{AUTHOR}] {TITLE}"

# 依頼の対。蔵書の中身と**わざと違える**。揃えて走らせると、本ごとの名前と
# 依頼の対が同じ答えを出してしまい、行き先の食い違いが見えなくなる
REQUEST_AUTHOR = "別人"
REQUEST_TITLE = "別作品"
REQUEST_DIR = f"[{REQUEST_AUTHOR}] {REQUEST_TITLE}"

# 素材の見分け札。巻ごとにページ枚数を変えておくと、出来上がった ZIP を開いた
# ときに「どの中身にどの番号が付いたか」まで言える
FIRST_PAGES = 3
SECOND_PAGES = 4
PLAIN_PAGES = 2
ORGANIZED_PAGES = 5

# 自分の名前を持たない本。名前の数字から巻数は 9 に読める
PLAIN_NAME = "raw_09.zip"
PLAIN_VOLUME = 9

# 整理済みの本の巻数。断られた訂正のあとも、この番号のまま作られる
ORGANIZED_VOLUME = 3

# 訂正の値。自動判定（1 / 2 / 3 / 9）のどれとも重ならないものだけを使う
FIXED = 7
OTHER_FIXED = 4
CONFLICTING = 5


def volume_name(author: str, title: str, volume: int) -> str:
    """出来上がるはずのファイル名。

    ``format_volume_name`` を呼ばずに書き下す。作る側と同じ関数で期待値を
    作ると、名前の作り方が変わったときに素材も期待値も一緒に動いてしまい、
    何も見張らない検証になる。
    """
    return f"[{author}] {title} 第{volume:03d}巻.zip"


class VolumeOverrideApiTestBase(unittest.TestCase):
    """訂正を HTTP で送り、出来上がりと拒否の報告を見る土台。

    素材の自動判定は、期待値へ書き写すのではなく**その場で解析を走らせて**
    確かめる。訂正の値とたまたま揃った素材では、訂正を丸ごと無視する実装が
    そのまま通る。
    """

    def setUp(self):
        self._temp = TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name)
        # 出来上がりの表を丸ごと比べる。切り詰められると、どの本で食い違ったのかが
        # 失敗の出力から読めない
        self.maxDiff = None

        # 許可された場所を実際に絞る。絞らないと出力先の検証が意味を持たない
        self.app = create_app(
            state_dir=self.work_dir / "state",
            allowed_roots=[self.work_dir],
            run_jobs_inline=True,
        )
        self.token = self.app.state.token
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def auth(self) -> dict:
        return {"token": self.token}

    # --- 素材 -------------------------------------------------------------

    def compound(self, library: Path) -> Path:
        """1 つの ZIP に 2 冊。自動判定は 第01巻 -> 1、第02巻 -> 2"""
        return zip_with(
            library / "合本.zip",
            {
                **pages("第01巻/", FIRST_PAGES),
                **pages("第02巻/", SECOND_PAGES),
            },
        )

    def plain(self, library: Path) -> Path:
        """自分の名前を持たない本。自動判定は 9"""
        return zip_with(library / PLAIN_NAME, pages(count=PLAIN_PAGES))

    def shelve(self, library: Path, tag: str = "") -> Path:
        """整理そのものに「整理済みの本」を作らせ、蔵書へ並べる。

        判定の素材を手で書かないのは、``judge_organized`` が「作る側と同じ
        関数で期待値を作り直して比べる」形だから。手で並べた ZIP は、名前の
        作り方が変わった瞬間に「整理済みでない素材」に化けて、このファイルの
        門 2 のテストが**何も確かめずに緑になる**。
        """
        source = zip_with(
            self.work_dir / f"素材{tag}" / f"{AUTHOR}_{TITLE}_03.zip",
            pages(count=ORGANIZED_PAGES),
        )
        organizer = FileOrganizer(output_directory=library, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        results = organizer.process_single_archive(source)
        self.assertEqual(
            [], [r.error_message for r in results if not r.success], "素材の整理が失敗"
        )
        built = results[0].output_path
        self.assertIsNotNone(built, "整理済みの素材が出来ていない")
        self.assertEqual(
            volume_name(AUTHOR, TITLE, ORGANIZED_VOLUME), built.name, "素材の名前が違う"
        )
        self.assertEqual(SERIES_DIR, built.parent.name, "素材の置き場所が違う")
        return built

    # --- 経路 -------------------------------------------------------------

    def analyze(self, targets: list[Path]) -> list[dict]:
        """解析ジョブを走らせ、出来上がる本を返す。

        画面が持っている位置（``entry``）と自動判定の巻数を、テストが決め打ち
        するのではなく実物から取る。決め打ちすると、素材の見え方が変わった
        ときに「訂正が効いた」のか「もともとその番号だった」のか分からなくなる。
        """
        accepted = self.client.post(
            "/api/jobs/analyze",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "title": REQUEST_TITLE,
                "author": REQUEST_AUTHOR,
            },
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job["result"]["books"]

    def detected(self, books: list[dict]) -> dict[str, int | None]:
        """解析の結果を「位置 -> 自動判定の巻数」で写す"""
        return {book["entry"]: book["volume"] for book in books}

    def submit(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict],
        keep_originals: bool = True,
    ):
        """整理ジョブを投入する。受け付けられたかどうかは呼び出し側が見る"""
        return self.client.post(
            "/api/jobs/organize",
            params=self.auth(),
            json={
                "archives": [str(target) for target in targets],
                "output_directory": str(output_directory),
                "title": REQUEST_TITLE,
                "author": REQUEST_AUTHOR,
                "keep_originals": keep_originals,
                "books": books,
            },
        )

    def organize(
        self,
        targets: list[Path],
        output_directory: Path,
        books: list[dict],
        keep_originals: bool = True,
    ) -> dict:
        """整理ジョブを投入し、走り切ったジョブの詳細を返す"""
        accepted = self.submit(targets, output_directory, books, keep_originals)
        self.assertEqual(
            202, accepted.status_code, f"整理の投入が受け付けられない: {accepted.text}"
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))
        return job

    def job(self, job_id: str) -> dict:
        """ジョブの詳細。テストの起動は同期実行なので、投入の直後に読める"""
        return self.client.get(f"/api/jobs/{job_id}", params=self.auth()).json()

    # --- 出来上がりの見方 -------------------------------------------------

    def produced_map(self, output: Path) -> dict[str, list[str]]:
        """出力先を「作品フォルダ -> その中のファイル名」で写し取る。

        件数では本の取り違えを見張れない。2 冊が 2 つのフォルダに分かれる
        ことと、2 冊が 1 つのフォルダに固まることは、どちらも「2 件」になる。
        """
        if not output.exists():
            return {}
        found: dict[str, list[str]] = {}
        for path in sorted(output.rglob("*")):
            if not path.is_file():
                continue
            folder = path.parent.relative_to(output).as_posix()
            found.setdefault(folder, []).append(path.name)
        return {folder: sorted(names) for folder, names in found.items()}


class VolumeOverrideRoundTripTest(VolumeOverrideApiTestBase):
    """C1. 依頼に載せた訂正が、そのまま出来上がりの名前になる"""

    def test_only_the_corrected_book_in_a_compound_archive_changes_its_number(self):
        # Arrange - 素材の自動判定を先に固定する。1 と 2 であることを確かめて
        # おかないと、訂正の 7 とたまたま揃った素材で「訂正を無視する実装」が
        # 通ってしまう
        library = self.work_dir / "蔵書"
        compound = self.compound(library)
        output = self.work_dir / "再出力"
        books = self.analyze([compound])
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2},
            self.detected(books),
            "素材の自動判定が想定と違う。訂正の値と揃っていたら何も確かめられない",
        )

        # Act - 2 冊目だけを 7 に訂正する。1 冊目は訂正を載せない（鍵ごと省く）
        job = self.organize(
            [compound],
            output,
            books=[
                {
                    "source": book["source"],
                    "entry": book["entry"],
                    "title": book["title"],
                    "author": book["author"],
                    **({"volume": {"number": FIXED}} if book["volume"] == 2 else {}),
                }
                for book in books
            ],
        )

        # Assert - 2 冊分を 1 回の比較で見る。片方だけを見ると「渡された訂正を
        # 全部の巻に配る」実装が通ってしまう。訂正しなかったほうが自動判定の
        # ままであることは、訂正が届いたことと同じだけ重要な契約
        self.assertEqual(
            {
                REQUEST_DIR: [
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 1),
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED),
                ]
            },
            self.produced_map(output),
            "合本の片方だけの訂正が、出来上がりの名前になっていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 断っていない実行でも ``refused`` は鍵ごと在る。省くと画面から
        # 見て「拒否が無い」のか「数えていない」のかを区別できない
        self.assertEqual(
            [],
            job["result"]["refused"],
            f"断っていないのに拒否が並ぶ、または鍵ごと無い: {job['result']}",
        )


class VolumeOmittedTest(VolumeOverrideApiTestBase):
    """C2. ``volume`` を省いた依頼は、いままでと 1 冊も変わらない。

    **これが「``title`` / ``author`` の ``null`` を流用しない理由」を
    テストにした形。** 画面（``plan.ts`` の ``selectedBooks``）は自分の名前を
    持たない本にも ``title: null`` / ``author: null`` を**必ず**載せて送る。
    ``BookRef.volume`` を ``int | None`` にした実装は、同じ書き方で載る
    ``volume`` の欠落（および ``null``）を「巻数を外せ」と読むので、既定の
    依頼が全冊 ``Unknown.zip`` になる。ここで落ちる。
    """

    def test_a_request_without_any_correction_still_numbers_every_book(self):
        # Arrange - 合本 2 冊と単体 1 冊。自動判定は 1 / 2 / 9
        library = self.work_dir / "蔵書"
        compound = self.compound(library)
        plain = self.plain(library)
        output = self.work_dir / "再出力"
        books = self.analyze([compound, plain])
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2, "": PLAIN_VOLUME},
            self.detected(books),
            "素材の自動判定が想定と違う",
        )

        # Act - 画面が組み立てるのと同じ形。``title`` / ``author`` の null は
        # 全行に載せ、``volume`` の鍵は書かない
        job = self.organize(
            [compound, plain],
            output,
            books=[
                {
                    "source": book["source"],
                    "entry": book["entry"],
                    "title": book["title"],
                    "author": book["author"],
                }
                for book in books
            ],
        )

        # Assert - 3 冊とも自動判定の番号が付く。Unknown は 1 冊も無い
        self.assertEqual(
            {
                REQUEST_DIR: [
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 1),
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 2),
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, PLAIN_VOLUME),
                ]
            },
            self.produced_map(output),
            "訂正を 1 つも載せない依頼で、自動判定の巻数が付かなくなっている",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class VolumeOverrideShapeTest(VolumeOverrideApiTestBase):
    """C3. ``number`` を省いた包みは断る。

    ``{"volume": {}}`` を黙って「巻数なし」と読むと、包みの意味そのものが
    消える。``VolumeOverride.number`` に既定値を付けてはいけない。
    """

    def test_an_override_without_a_number_is_refused_but_a_proper_one_is_not(self):
        # Arrange - 自動判定 9 の本 1 冊。訂正の 7 とは重ならない
        library = self.work_dir / "蔵書"
        plain = self.plain(library)
        refused_output = self.work_dir / "断る側"
        accepted_output = self.work_dir / "通る側"

        # Act / Assert - 空の包みは断る。しかも 1 冊も書き出さない。ジョブに
        # してから失敗させると、途中まで書いた物が残る
        refused = self.submit(
            [plain],
            refused_output,
            books=[{"source": str(plain), "entry": "", "volume": {}}],
        )
        self.assertEqual(422, refused.status_code, refused.text)
        self.assertEqual(
            {}, self.produced_map(refused_output), "断ったのに書き出している"
        )

        # Act / Assert - 番号の入った包みは受け付けて、**実際に作る**。
        # 何にでも 422 を返す実装、受け付けるだけで訂正を捨てる実装は、
        # どちらもここで落ちる
        job = self.organize(
            [plain],
            accepted_output,
            books=[{"source": str(plain), "entry": "", "volume": {"number": FIXED}}],
        )
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED)]},
            self.produced_map(accepted_output),
            "番号の入った訂正が受け付けられていない、または効いていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class VolumeOverrideRangeTest(VolumeOverrideApiTestBase):
    """C4. 負の巻数は断り、0 は通す。

    体裁の話ではない。実際に走らせて確かめた事実は次の 2 つ。

    - ``-1`` は ``[著者] 作品 第-01巻.zip`` という名前になり、
      ``organized_detector._ORGANIZED_STEM``（``第(?P<volume>\\d+)巻``）に
      **一致しない**。つまりその本は二度と「整理済み」にならず、投入する
      たびに永久に作り直される
    - しかも同じ名前は ``VolumeDetector`` の ``第(\\d+)巻`` に拾われ、
      **第 1 巻として読み戻される**（``decide_volume_from_name`` が
      ``number=1, origin="pattern"`` を返すことを実測した）。利用者は
      「-1 巻にしたはずの本が 1 巻になっている」ものを受け取り続ける
    - ``0`` は ``第000巻.zip`` になり、``_ORGANIZED_STEM`` に一致して 0 へ
      読み戻る。**往復するので許す**

    0 まで弾く実装を落とすために、(c) を必ず置く。
    """

    def test_a_negative_number_is_refused_while_zero_round_trips(self):
        # Arrange
        library = self.work_dir / "蔵書"
        plain = self.plain(library)
        negative_output = self.work_dir / "負の側"
        zero_output = self.work_dir / "零の側"

        # Act / Assert - (a) -1 は断る。出力先は空のまま
        negative = self.submit(
            [plain],
            negative_output,
            books=[{"source": str(plain), "entry": "", "volume": {"number": -1}}],
        )
        self.assertEqual(422, negative.status_code, negative.text)
        self.assertEqual(
            {}, self.produced_map(negative_output), "断ったのに書き出している"
        )

        # Act / Assert - (b) 0 は受け付ける
        accepted = self.submit(
            [plain],
            zero_output,
            books=[{"source": str(plain), "entry": "", "volume": {"number": 0}}],
        )
        self.assertEqual(
            202, accepted.status_code, f"0 巻まで断っている: {accepted.text}"
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert - (c) 第000巻 が**実際に出来る**。ここが無いと「受け付けて
        # から捨てる」実装も「0 を偽として扱って自動判定へ戻す」実装も通る
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 0)]},
            self.produced_map(zero_output),
            "0 巻への訂正が効いていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class NamedBookOverrideTest(VolumeOverrideApiTestBase):
    """C5. 自分の名前を持つ本に訂正を載せた依頼は、ジョブになる前に断る（門 1）。

    サイドカーはこの時点で「整理済み」を知らない。**知っていること**――この本は
    自分の名前で書き出される――だけを理由に書く。「整理済みなので」と書くと、
    名前だけ載せた未整理の本にも同じ嘘が出る。

    対照を 2 つ置く。「``volume`` があれば断る」実装と「名前があれば断る」実装が
    両方ここで落ちる。
    """

    def test_a_correction_on_a_book_that_carries_its_own_name_is_refused(self):
        # Arrange - 整理済みの本（自分の名前を持つ）と、持たない本
        library = self.work_dir / "蔵書"
        built = self.shelve(library)
        plain = self.plain(library)
        refused_output = self.work_dir / "断る側"
        named_output = self.work_dir / "名前だけ"
        fixed_output = self.work_dir / "訂正だけ"

        # Act / Assert - 名前と訂正の両方を載せる。断る。しかも 1 冊も
        # 書き出さない。ジョブにしてから失敗させると、途中まで書いた物が残る
        refused = self.submit(
            [built],
            refused_output,
            books=[
                {
                    "source": str(built),
                    "entry": "",
                    "title": TITLE,
                    "author": AUTHOR,
                    "volume": {"number": FIXED},
                }
            ],
        )
        self.assertEqual(422, refused.status_code, refused.text)
        self.assertEqual(
            {}, self.produced_map(refused_output), "断ったのに書き出している"
        )

        # Act / Assert - (a) 名前あり・訂正なしは今までどおり通る。自分の名前で
        # 作られる。「``volume`` の欄があれば断る」実装はここで落ちる
        named = self.organize(
            [built],
            named_output,
            books=[
                {"source": str(built), "entry": "", "title": TITLE, "author": AUTHOR}
            ],
        )
        self.assertEqual(
            {SERIES_DIR: [volume_name(AUTHOR, TITLE, ORGANIZED_VOLUME)]},
            self.produced_map(named_output),
            "名前だけを載せた依頼まで断っている",
        )
        self.assertEqual([], named["result"]["failed"], named["result"])

        # Act / Assert - (b) 名前なし・訂正ありは通り、訂正が効く。
        # 「名前の欄があれば断る」実装と「何にでも 422 を返す」実装はここで落ちる
        fixed = self.organize(
            [plain],
            fixed_output,
            books=[
                {
                    "source": str(plain),
                    "entry": "",
                    "title": None,
                    "author": None,
                    "volume": {"number": FIXED},
                }
            ],
        )
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED)]},
            self.produced_map(fixed_output),
            "名前を持たない本への訂正まで断っている",
        )
        self.assertEqual([], fixed["result"]["failed"], fixed["result"])


class OrganizedBookGuardTest(VolumeOverrideApiTestBase):
    """C6 / C7. 画面を信じない。名前欄を落とした整理済みの本を、実行時に守る（門 2）。

    門 1（422）は依頼の**形**しか見ない。古い画面や台本が ``title`` / ``author``
    を載せずに ``volume`` だけ送ってくれば、その依頼は門 1 を素通りする。
    整理済みかどうかは、実際にアーカイブを見なければ分からない。

    追加の読み込みはゼロ。``locate_books`` が返す ``BookLocation`` は
    ``toc_names``（目次そのもの）を既に持っているので、それを ``judge_organized``
    へ渡せばファイルを 1 バイトも余分に読まない（C8 が呼び出し回数を固定する）。
    """

    def arrange(self, tag: str) -> tuple[Path, Path, Path, list[dict]]:
        """整理済みの本 1 冊と、整理済みでない本 1 冊を同じ実行に混ぜる。

        混ぜるのが要点。整理済みだけの実行では「訂正を丸ごと実装していない」
        実装がそのまま通る。混ぜた 1 冊がそれを落とす。

        整理済みの側には ``title`` / ``author`` を**載せない**。古い画面・台本が
        送ってくる形で、門 1 は素通りする。
        """
        library = self.work_dir / f"蔵書{tag}"
        built = self.shelve(library, tag)
        plain = self.plain(library)
        output = self.work_dir / f"再出力{tag}"
        books = [
            {"source": str(built), "entry": "", "volume": {"number": FIXED}},
            {"source": str(plain), "entry": "", "volume": {"number": OTHER_FIXED}},
        ]
        return built, plain, output, books

    def expected_map(self) -> dict[str, list[str]]:
        """整理済みの本は自動判定のまま、混ぜた 1 冊は訂正どおり。

        整理済みの側は名前を載せていないので、行き先は依頼の対になる（そこは
        段階 4a からの既存の契約で、この段階では変えない）。変わってはいけない
        のは**巻数**で、``第007巻`` はどこにも現れない。
        """
        return {
            REQUEST_DIR: [
                volume_name(REQUEST_AUTHOR, REQUEST_TITLE, ORGANIZED_VOLUME),
                volume_name(REQUEST_AUTHOR, REQUEST_TITLE, OTHER_FIXED),
            ]
        }

    def test_a_correction_on_an_organized_book_is_dropped_and_reported(self):
        # Arrange - 元のファイルの stat は**実行の前**に控える。実行のあとに
        # 取ると、書き直された値どうしを比べることになって何も見張らない
        built, _plain, output, books = self.arrange("C6")
        before = built.stat()

        # Act
        accepted = self.submit([built, _plain], output, books)

        # Assert 1 - 202。門 1 は素通りする。ここを固定しないと、後から門 1 を
        # 広げて門 2 を消す変更が通ってしまう
        self.assertEqual(
            202,
            accepted.status_code,
            f"名前欄の無い依頼を投入の時点で断っている: {accepted.text}",
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert 2 - 2 冊分をまとめて比較。整理済みの方に 第007巻 は無く、
        # 混ぜた方は訂正が効いている
        self.assertEqual(
            self.expected_map(),
            self.produced_map(output),
            "整理済みの本の訂正が通った、または混ぜた 1 冊の訂正が落ちた",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert 3 - 元のファイルに指 1 本触れていない
        after = built.stat()
        self.assertEqual(
            before.st_size, after.st_size, f"元の大きさが変わった: {built}"
        )
        self.assertEqual(
            before.st_mtime_ns, after.st_mtime_ns, f"元が書き直された: {built}"
        )

        # Assert 4 - **ここが本体。** 2 と 3 だけなら「訂正を丸ごと実装して
        # いない」実装が通る。断ったことが跡に残ること
        refused = job["result"]["refused"]
        self.assertEqual(1, len(refused), f"拒否が 1 件でない: {job['result']}")
        self.assertEqual(
            ["archive", "entry", "reason"],
            sorted(refused[0]),
            f"拒否の形が違う: {refused[0]}",
        )
        self.assertIn(
            built.name, refused[0]["archive"], f"どの本か読めない: {refused[0]}"
        )
        self.assertNotEqual("", refused[0]["reason"], f"理由が空: {refused[0]}")
        self.assertRegex(
            refused[0]["reason"],
            r"[ぁ-んァ-ヶ一-龠]",
            f"理由が利用者の言葉になっていない: {refused[0]}",
        )

        # Assert 4b - 同じ理由がログにも 1 行出る。``jobs.py`` が ``job_logs`` に
        # 積み、``OrganizePanel.tsx`` が ``job.log`` を読むので、画面を 1 行も
        # 直さずに見える。結果に積むだけで黙っている実装はここで落ちる
        self.assertTrue(
            [line for line in job["log"] if refused[0]["reason"] in line],
            f"断った理由がログに 1 行も出ていない: {job['log']}",
        )

    def test_the_verdict_does_not_depend_on_keep_originals(self):
        # Arrange / Act - 同じ依頼を、元を残す回と残さない回で 1 度ずつ
        kept_built, _kept_plain, kept_output, kept_books = self.arrange("残す")
        kept = self.organize(
            [kept_built, _kept_plain], kept_output, kept_books, keep_originals=True
        )
        gone_built, gone_plain, gone_output, gone_books = self.arrange("消す")
        gone = self.organize(
            [gone_built, gone_plain], gone_output, gone_books, keep_originals=False
        )

        # Assert - 判断は同じ。整理済みかどうかは元を消すかどうかと関係が無い
        self.assertEqual(
            self.expected_map(), self.produced_map(kept_output), "元を残す回の結果"
        )
        self.assertEqual(
            self.produced_map(kept_output),
            self.produced_map(gone_output),
            "keep_originals で出来上がりが変わった",
        )
        self.assertEqual(
            [
                {**item, "archive": Path(item["archive"]).name}
                for item in kept["result"]["refused"]
            ],
            [
                {**item, "archive": Path(item["archive"]).name}
                for item in gone["result"]["refused"]
            ],
            "keep_originals で拒否の中身が変わった",
        )
        self.assertEqual(1, len(kept["result"]["refused"]), kept["result"])

        # Assert - 対照。``keep_originals=False`` の回で、整理済みでない本の元は
        # 頼まれたとおり消えている。これが無いと「keep_originals=False では
        # 何もしない」実装が上の一致を満たしてしまう
        self.assertFalse(
            gone_plain.exists(), f"頼まれたのに元が残っている: {gone_plain}"
        )
        self.assertTrue(
            _kept_plain.is_file(), f"残せと言ったのに元が消えた: {_kept_plain}"
        )


class TocReadCountTest(VolumeOverrideApiTestBase):
    """C8. ``locate_books`` は 1 冊につき 1 回のまま。

    門 2 は「整理済みかどうか」を実行時に判定するが、そのために目次を読み直しては
    いけない。``locate_books`` が返す ``BookLocation`` は ``toc_names`` を既に
    持っている。2 回呼ぶと、数百 GB の入れ子で目次読みが 2 倍になる。
    """

    def test_the_toc_is_read_once_per_archive_even_with_skips_and_corrections(self):
        # Arrange - 「外す本」と「巻数を直す本」が同じアーカイブに両方ある形。
        # 第01巻 は依頼に載せない（外す）、第02巻 は 7 に訂正する
        library = self.work_dir / "蔵書"
        compound = self.compound(library)
        output = self.work_dir / "再出力"

        # Act
        original = organize_job.locate_books
        with mock.patch.object(organize_job, "locate_books", wraps=original) as spy:
            job = self.organize(
                [compound],
                output,
                books=[
                    {
                        "source": str(compound),
                        "entry": "第02巻",
                        "volume": {"number": FIXED},
                    }
                ],
            )

        # Assert - 外す判定と訂正と整理済みの判定で、目次は 1 回しか読まない
        self.assertEqual(
            1,
            spy.call_count,
            f"1 冊の整理で目次を {spy.call_count} 回読んでいる: {spy.call_args_list}",
        )

        # Assert - そのうえで、外すことも訂正も効いている。何もしない実装が
        # 呼び出し回数だけで通らないように
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED)]},
            self.produced_map(output),
            "外す指定と訂正が同時に効いていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class ConflictingOverrideTest(VolumeOverrideApiTestBase):
    """C9. 同じ 1 冊に違う巻数が 2 つ載っていたら断る。同じ値なら受け付ける。

    同じ本の行が 2 つ並ぶのは正常。利用者がフォルダとその中のアーカイブを
    両方投入すると、同じ ``source`` と ``entry`` の行が 2 つ出来る
    （``_names_belong_to_a_whole_archive`` が既にそう決めている）。
    そこを断ると、既存の契約が壊れる。
    """

    def test_two_different_numbers_for_the_same_book_are_refused(self):
        # Arrange
        library = self.work_dir / "蔵書"
        plain = self.plain(library)
        output = self.work_dir / "再出力"

        # Act - 同じ source と entry に、違う巻数を 2 つ
        refused = self.submit(
            [plain],
            output,
            books=[
                {"source": str(plain), "entry": "", "volume": {"number": FIXED}},
                {
                    "source": str(plain),
                    "entry": "",
                    "volume": {"number": CONFLICTING},
                },
            ],
        )

        # Assert - 断る。しかも 1 冊も書き出さない
        self.assertEqual(422, refused.status_code, refused.text)
        self.assertEqual({}, self.produced_map(output), "断ったのに書き出している")

    def test_the_same_number_twice_for_the_same_book_is_accepted(self):
        # Arrange - 利用者がフォルダとその中のアーカイブを両方投入した形
        library = self.work_dir / "蔵書"
        plain = self.plain(library)
        output = self.work_dir / "再出力"

        # Act
        job = self.organize(
            [plain],
            output,
            books=[
                {"source": str(plain), "entry": "", "volume": {"number": FIXED}},
                {"source": str(plain), "entry": "", "volume": {"number": FIXED}},
            ],
        )

        # Assert - 受け付けて、訂正どおりに 1 冊だけ作る。同じ値まで断る実装は
        # ここで落ちる
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED)]},
            self.produced_map(output),
            "同じ本が 2 行並んだだけの依頼を断っている、または 2 冊作っている",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class UnreadableTocRefusalTest(VolumeOverrideApiTestBase):
    """C10. 目次を読めなかったアーカイブに載っていた訂正も、黙って落とさない。

    訂正の当て先は目次から決まる。目次を読めなければ当て先が無い。**ここで
    黙って落とすと、利用者から見た症状は「直したのに直らない」だけになる。**
    しかもこの本は実処理でも失敗するので、失敗の一覧に並ぶ 1 行を見て
    「訂正は届いていたが本が作れなかった」のか「訂正がそもそも届かなかった」
    のかを切り分ける手がかりが無い。

    実装は ``_archive_plan`` の ``except Exception`` の枝にある。既存の
    9 本はどれも読める素材しか使わないので、**この枝を一度も通らない**。
    """

    def broken(self, library: Path) -> Path:
        """拡張子は ZIP だが中身が ZIP ではないファイル。

        名前で読み手が決まるので目次を読みに行き、そこで失敗する。
        """
        path = library / "壊れた_04.zip"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"this is not a zip")
        return path

    def test_a_correction_on_an_unreadable_archive_is_reported_not_dropped(self):
        # Arrange - 読めない 1 冊と、読める 1 冊を混ぜる。読める方が
        # 「訂正の仕組みそのものが動いている」ことの対照になる。混ぜないと、
        # 訂正を丸ごと実装していない実装もこのテストを通ってしまう
        library = self.work_dir / "蔵書C10"
        broken = self.broken(library)
        plain = self.plain(library)
        output = self.work_dir / "出力C10"
        books = [
            {"source": str(broken), "entry": "", "volume": {"number": 4}},
            {"source": str(plain), "entry": "", "volume": {"number": 7}},
        ]

        # Act
        accepted = self.submit([broken, plain], output, books)

        # Assert 1 - 202。読めない 1 つのせいで整理そのものを断らない
        self.assertEqual(
            202,
            accepted.status_code,
            f"読めない素材を投入の時点で断っている: {accepted.text}",
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert 2 - 読める方の訂正は効いている。これが対照
        self.assertEqual(
            {
                f"[{REQUEST_AUTHOR}] {REQUEST_TITLE}": [
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 7)
                ]
            },
            self.produced_map(output),
            "読める方の訂正が効いていない。訂正の仕組みそのものが動いていない",
        )

        # Assert 3 - 読めない方は失敗として並ぶ（今までどおり）
        self.assertEqual(
            [broken.name],
            [Path(item["archive"]).name for item in job["result"]["failed"]],
            f"読めない素材が失敗として並んでいない: {job['result']}",
        )

        # Assert 4 - **ここが本体。** 訂正を当てられなかったことが跡に残る。
        # 失敗の一覧に混ぜてはいけない。あちらは「本が作れなかった」の話で、
        # 訂正が届かなかったこととは別
        refused = job["result"]["refused"]
        self.assertEqual(
            [broken.name],
            [Path(item["archive"]).name for item in refused],
            f"読めなかった訂正が跡に残っていない: {job['result']}",
        )
        self.assertRegex(
            refused[0]["reason"],
            r"[ぁ-んァ-ヶ一-龠]",
            f"理由が利用者の言葉になっていない: {refused[0]}",
        )

        # Assert 5 - 同じ理由がログにも出る。結果に積むだけで黙っている実装が落ちる
        self.assertTrue(
            [line for line in job["log"] if refused[0]["reason"] in line],
            f"断った理由がログに 1 行も出ていない: {job['log']}",
        )


if __name__ == "__main__":
    unittest.main()
