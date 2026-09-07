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


# 画像を直接置いたフォルダの素材。名前の数字から巻数は 8 に読める。ZIP と
# 違う経路（``_archive_plan`` は ``locate_books`` より先に ``is_dir()`` を見る）
# を通るので、ZIP だけの素材ではこの分岐を一度も踏まない
FOLDER_NAME = "画像_08"
FOLDER_VOLUME = 8
FOLDER_PAGES = 3

# 解析が予告しなかった位置。素材の目次（第01巻 / 第02巻）とわざと重ねない
MISSING_ENTRY = "第99巻"
MISSING_FOLDER_ENTRY = "在らぬ位置"

# 巻数を外したときの名前。``format_volume_name`` を呼ばずに書き下すのは
# ``volume_name`` と同じ理由（作る側と同じ関数で期待値を作らない）
UNKNOWN_NAME = f"[{REQUEST_AUTHOR}] {REQUEST_TITLE} Unknown.zip"


def image_folder(library: Path, name: str = FOLDER_NAME) -> Path:
    """画像を直接置いたフォルダ。自動判定は 8。

    ページの作り方は ``pages`` と共有する。同じ物を別々に書くと、片方を直した
    ときに「同じ入力のはず」の 2 つが静かに食い違う。
    """
    folder = library / name
    folder.mkdir(parents=True, exist_ok=True)
    for page_name, data in pages(count=FOLDER_PAGES).items():
        (folder / page_name).write_bytes(data)
    return folder


class SplitRowOverrideTest(VolumeOverrideApiTestBase):
    """C11. 行を 2 つに分けても、門 1 は名前と訂正の同居を見抜く。

    門 1（``_corrections_stay_off_books_that_carry_their_own_name``）は
    **1 行の中しか見ていない**。同じ ``(source, entry)`` を 2 行に分け、片方に
    ``title`` / ``author``、もう片方に ``volume`` を載せると素通りする。
    そのあと ``wanted_books`` が名前と訂正を**元どおり 1 つの本へ再結合する**
    ので、断ったはずの訂正がそのまま効く。

    実測（``raw_09.zip``、自動判定 9、整理済みではない）:

    | 依頼の形 | いまの答え | 出来る物 |
    |---|---|---|
    | 1 行に名前と訂正 | 422 | （作らない） |
    | 2 行に分ける | **202** | ``[著者] 作品 第007巻.zip`` |

    2 行目の形は門 2 も通り抜ける。門 2 が見るのは「整理済みかどうか」だけで、
    この本は整理済みではないため ``refused`` は空のまま訂正が通る。**つまり
    いま塞いでいる門が 1 つも無い。**

    素材に整理済みでない本を選ぶのが要点。整理済みの本で試すと門 2 が拾って
    しまい、抜け道が塞がっているように見える。

    対照を 2 つ置く。「行が 2 つあれば断る」実装と「``volume`` の行が 2 つ
    あれば断る」実装が、両方ここで落ちる。
    """

    def named_row(self, plain: Path) -> dict:
        """自分の名前だけを載せた行"""
        return {"source": str(plain), "entry": "", "title": TITLE, "author": AUTHOR}

    def fixed_row(self, plain: Path) -> dict:
        """訂正だけを載せた行"""
        return {"source": str(plain), "entry": "", "volume": {"number": FIXED}}

    def test_a_name_and_a_correction_split_across_two_rows_are_still_refused(self):
        # Arrange - 整理済みでない本。門 2 に拾わせない
        library = self.work_dir / "蔵書C11"
        plain = self.plain(library)
        split_output = self.work_dir / "分けた側"
        reversed_output = self.work_dir / "並びを変えた側"

        # Act / Assert - 名前の行と訂正の行に分ける。断る。しかも 1 冊も
        # 書き出さない。``produced_map`` を見るのは、受け付けてジョブにしてから
        # 失敗させる実装を落とすため
        split = self.submit(
            [plain],
            split_output,
            books=[self.named_row(plain), self.fixed_row(plain)],
        )
        self.assertEqual(
            422,
            split.status_code,
            f"行を 2 つに分けた依頼が門 1 を素通りしている: {split.text}",
        )
        self.assertEqual(
            {}, self.produced_map(split_output), "断ったのに書き出している"
        )

        # Act / Assert - 並びを逆にしても同じ。行を上から 1 度なぞるだけの
        # 実装（名前を見る前に訂正の行を通す）はここで落ちる
        backwards = self.submit(
            [plain],
            reversed_output,
            books=[self.fixed_row(plain), self.named_row(plain)],
        )
        self.assertEqual(
            422,
            backwards.status_code,
            f"訂正の行が先だと素通りしている: {backwards.text}",
        )
        self.assertEqual(
            {}, self.produced_map(reversed_output), "断ったのに書き出している"
        )

    def test_two_rows_without_a_correction_are_still_accepted(self):
        # Arrange - 対照 (a)。利用者がフォルダとその中のアーカイブを両方
        # 投入すると、同じ本の行が 2 つ出来る（既存の契約）
        library = self.work_dir / "蔵書C11a"
        plain = self.plain(library)
        output = self.work_dir / "対照a"

        # Act - 2 行に分けるが、どちらにも訂正が無い
        job = self.organize(
            [plain],
            output,
            books=[self.named_row(plain), {"source": str(plain), "entry": ""}],
        )

        # Assert - 自分の名前で、自動判定の巻数のまま出来る。「行が 2 つあれば
        # 断る」実装はここで落ちる
        self.assertEqual(
            {SERIES_DIR: [volume_name(AUTHOR, TITLE, PLAIN_VOLUME)]},
            self.produced_map(output),
            "訂正の無い 2 行の依頼まで断っている",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual([], job["result"]["refused"], job["result"])

    def test_two_rows_carrying_only_the_same_correction_are_still_accepted(self):
        # Arrange - 対照 (b)。名前は 1 行も載せない
        library = self.work_dir / "蔵書C11b"
        plain = self.plain(library)
        output = self.work_dir / "対照b"

        # Act - 2 行に同じ訂正だけ
        job = self.organize(
            [plain],
            output,
            books=[self.fixed_row(plain), self.fixed_row(plain)],
        )

        # Assert - 受け付けて、訂正が効く。「``volume`` の行が 2 つあれば断る」
        # 実装と「何にでも 422 を返す」実装が、両方ここで落ちる
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED)]},
            self.produced_map(output),
            "名前の載らない 2 行の訂正まで断っている、または訂正が効いていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual([], job["result"]["refused"], job["result"])


class MissingPlaceOverrideTest(VolumeOverrideApiTestBase):
    """C12. 当て先の消えた訂正を、黙って落とさない。

    ``_archive_plan`` は**目次に現れた位置だけ**をなぞって訂正を当てる。訂正した
    位置が目次に無ければ、``volumes`` にも ``refused`` にも何も残らない。解析の
    あとにアーカイブの中身が変わると起きる（利用者が中を差し替える、別の道具が
    触る、解析の結果を古いまま送る）。

    実測（合本の目次は 第01巻 / 第02巻）:

    | 訂正した位置 | 当たったか | ``refused`` |
    |---|---|---|
    | ``第02巻`` | 当たる | （空） |
    | ``第99巻`` | **当たらない** | **（空）** |

    これは「黙らせない」という決めごと（C10 が目次を読めない側で固定したもの）
    への違反。利用者から見た症状は「直したのに直らない」だけで、届かなかったのか
    断られたのかを切り分ける手がかりが無い。

    当たる訂正を同じ実行に混ぜるのが要点。混ぜないと、訂正を丸ごと実装して
    いない実装がそのまま通る。
    """

    def test_a_correction_for_a_place_that_is_gone_is_reported_not_dropped(self):
        # Arrange - 素材の目次を先に固定する。第99巻 が「たまたま在る」形だと
        # 何も確かめられない
        library = self.work_dir / "蔵書C12"
        compound = self.compound(library)
        output = self.work_dir / "出力C12"
        books = self.analyze([compound])
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2},
            self.detected(books),
            f"素材の目次が想定と違う。{MISSING_ENTRY} が在ったら何も確かめられない",
        )

        # Act - 当たる訂正（第02巻 -> 7）と、当て先の無い訂正（第99巻 -> 4）を
        # 同じ実行に混ぜる
        accepted = self.submit(
            [compound],
            output,
            books=[
                {"source": str(compound), "entry": "第01巻"},
                {
                    "source": str(compound),
                    "entry": "第02巻",
                    "volume": {"number": FIXED},
                },
                {
                    "source": str(compound),
                    "entry": MISSING_ENTRY,
                    "volume": {"number": OTHER_FIXED},
                },
            ],
        )

        # Assert 1 - 202。当て先の無い訂正 1 つのせいで整理そのものを断らない
        self.assertEqual(
            202,
            accepted.status_code,
            f"当て先の無い訂正を投入の時点で断っている: {accepted.text}",
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert 2 - 当たる方の訂正は効いている。これが対照。第004巻 は
        # どこにも現れない（当たらなかった訂正が別の本に流れ込んでいない）
        self.assertEqual(
            {
                REQUEST_DIR: [
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 1),
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED),
                ]
            },
            self.produced_map(output),
            "当たる方の訂正が効いていない、または当たらない訂正が別の本に流れた",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert 3 - **ここが本体。** 当たらなかった訂正が跡に残る
        refused = job["result"]["refused"]
        self.assertEqual(1, len(refused), f"拒否が 1 件でない: {job['result']}")
        self.assertEqual(
            ["archive", "entry", "reason"],
            sorted(refused[0]),
            f"拒否の形が違う: {refused[0]}",
        )

        # Assert 4 - どの位置が当たらなかったのかが読める。ここが空文字や
        # アーカイブ名だけだと、合本の中のどの本の話か利用者に伝わらない
        self.assertEqual(
            MISSING_ENTRY,
            refused[0]["entry"],
            f"当たらなかった位置が読めない: {refused[0]}",
        )
        self.assertEqual(
            str(compound), refused[0]["archive"], f"どの本か読めない: {refused[0]}"
        )
        self.assertRegex(
            refused[0]["reason"],
            r"[ぁ-んァ-ヶ一-龠]",
            f"理由が利用者の言葉になっていない: {refused[0]}",
        )

        # Assert 5 - 同じ理由がログにも 1 行出る。結果に積むだけで黙っている
        # 実装はここで落ちる
        self.assertIn(
            refused[0]["reason"],
            job["log"],
            f"断った理由がログに 1 行も出ていない: {job['log']}",
        )

    def test_the_image_folder_path_reports_a_gone_place_too(self):
        # Arrange - フォルダは ``locate_books`` を通らない別の経路。ZIP の側を
        # 直しただけの実装は、こちらを黙って落としたままになる
        library = self.work_dir / "蔵書C12F"
        folder = image_folder(library)
        output = self.work_dir / "出力C12F"

        # Act - 丸ごと 1 冊の行（訂正なし）と、当て先の無い位置への訂正
        accepted = self.submit(
            [folder],
            output,
            books=[
                {"source": str(folder), "entry": ""},
                {
                    "source": str(folder),
                    "entry": MISSING_FOLDER_ENTRY,
                    "volume": {"number": FIXED},
                },
            ],
        )
        self.assertEqual(
            202,
            accepted.status_code,
            f"フォルダの依頼を投入の時点で断っている: {accepted.text}",
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert - 本そのものは自動判定のまま出来る（訂正は当たらなかった）
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FOLDER_VOLUME)]},
            self.produced_map(output),
            "当たらないはずの訂正がフォルダの本に当たっている",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 当たらなかったことが、ZIP と同じ形で跡に残る
        refused = job["result"]["refused"]
        self.assertEqual(1, len(refused), f"拒否が 1 件でない: {job['result']}")
        self.assertEqual(
            MISSING_FOLDER_ENTRY,
            refused[0]["entry"],
            f"当たらなかった位置が読めない: {refused[0]}",
        )
        self.assertIn(
            refused[0]["reason"],
            job["log"],
            f"断った理由がログに 1 行も出ていない: {job['log']}",
        )


class NullNumberOverTheWireTest(VolumeOverrideApiTestBase):
    """C13. ``{"number": null}`` を HTTP で送ると、その本だけ巻数が外れる。

    ``null`` が「巻数を外す」という正当な訂正であることは、包みを ``int | None``
    に潰さない理由そのもの（C2 の表）。ところがコア側のテストは Pydantic の
    検証も ``wanted_books`` の経路も通らないので、**``number`` を非 null にする
    変更でも、``None`` を「未訂正」として捨てる変更でも、この経路は誰も
    見張っていない。**

    ``_Wanted.volumes`` は「鍵の有無が訂正したかどうか、値の ``None`` が
    巻数なし」という約束で出来ている。値の側で見分ける実装（``if number:`` や
    ``volumes.get(entry)``）は、外す依頼を自動判定の番号へ静かに戻す。

    訂正していない対照を同じ実行に置き、``produced_map`` を 1 回の比較で
    両方見る。片方だけを見ると「渡された訂正を全部の巻に配る」実装が通る。
    """

    def test_clearing_the_number_leaves_only_that_book_without_one(self):
        # Arrange - 自動判定は 1 と 2。どちらも番号が付いている
        library = self.work_dir / "蔵書C13"
        compound = self.compound(library)
        output = self.work_dir / "出力C13"
        books = self.analyze([compound])
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2},
            self.detected(books),
            "素材の自動判定が想定と違う。もともと番号が無ければ何も確かめられない",
        )

        # Act - 2 冊目だけ巻数を外す。1 冊目は ``volume`` の鍵ごと省く
        job = self.organize(
            [compound],
            output,
            books=[
                {
                    "source": book["source"],
                    "entry": book["entry"],
                    **({"volume": {"number": None}} if book["volume"] == 2 else {}),
                }
                for book in books
            ],
        )

        # Assert - 2 冊分を 1 回の比較で見る。外した方だけが Unknown になり、
        # 訂正していない方は自動判定の番号のまま。全冊 Unknown になる実装
        # （``null`` を全行へ配る）と、外す依頼を捨てて 第002巻 を作る実装が、
        # 両方ここで落ちる
        self.assertEqual(
            {
                REQUEST_DIR: sorted(
                    [UNKNOWN_NAME, volume_name(REQUEST_AUTHOR, REQUEST_TITLE, 1)]
                )
            },
            self.produced_map(output),
            "巻数を外す訂正が効いていない、または訂正していない本まで巻き込んだ",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])

        # Assert - 外すのは正当な訂正であって、拒否ではない
        self.assertEqual(
            [],
            job["result"]["refused"],
            f"巻数を外す訂正を拒否として扱っている: {job['result']}",
        )


class ImageFolderOverrideTest(VolumeOverrideApiTestBase):
    """C14. 画像を直接置いたフォルダにも訂正は効く。目次は読みに行かない。

    ``_archive_plan`` は ``archive.is_dir()`` を ``locate_books`` より**先に**
    見る。裸の画像フォルダは目次を読む経路（``_reader_for`` が名前の拡張子で
    ``None`` を返す）を通らないためで、**この分岐を消しても既存のテストは
    1 本も落ちない**（どれも ZIP しか使わない）。消すとフォルダに載った訂正が
    丸ごと落ちる。

    呼ばれないことまで見るのは、分岐を消して「フォルダも ``locate_books`` に
    渡す」形にした実装を落とすため。それは訂正が効いているように見えて、
    フォルダ 1 つごとに無駄な読みが増える。spy の張り方は C8 に合わせる。
    """

    def test_a_folder_is_corrected_without_going_through_the_toc(self):
        # Arrange - フォルダと ZIP を同じ実行に混ぜる。ZIP の側が「spy が
        # そもそも刺さっている」ことの対照になる。刺さっていない spy は
        # 呼び出し 0 回で「フォルダを読んでいない」を満たしてしまう
        library = self.work_dir / "蔵書C14"
        folder = image_folder(library)
        plain = self.plain(library)
        output = self.work_dir / "出力C14"

        # Act
        original = organize_job.locate_books
        with mock.patch.object(organize_job, "locate_books", wraps=original) as spy:
            job = self.organize(
                [folder, plain],
                output,
                books=[
                    {"source": str(folder), "entry": "", "volume": {"number": FIXED}},
                    {
                        "source": str(plain),
                        "entry": "",
                        "volume": {"number": OTHER_FIXED},
                    },
                ],
            )

        # Assert - フォルダの訂正が名前になる。ZIP の側も一緒に見るのは、
        # 訂正の仕組みそのものが動いていることの対照
        self.assertEqual(
            {
                REQUEST_DIR: sorted(
                    [
                        volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FIXED),
                        volume_name(REQUEST_AUTHOR, REQUEST_TITLE, OTHER_FIXED),
                    ]
                )
            },
            self.produced_map(output),
            "フォルダに載せた訂正が出来上がりの名前になっていない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual([], job["result"]["refused"], job["result"])

        # Assert - そのフォルダについて目次は読みに行かない。ZIP の側では
        # 1 回読む（spy が刺さっている証拠）
        read = [str(call.args[0]) for call in spy.call_args_list]
        self.assertEqual(
            [str(plain)],
            read,
            f"フォルダの目次を読みに行っている、または spy が刺さっていない: {read}",
        )

    def test_a_folder_without_a_correction_keeps_its_detected_number(self):
        # Arrange / Act - 対照。訂正を載せないと自動判定の 8 のまま
        library = self.work_dir / "蔵書C14b"
        folder = image_folder(library)
        output = self.work_dir / "出力C14b"
        job = self.organize(
            [folder], output, books=[{"source": str(folder), "entry": ""}]
        )

        # Assert - これが無いと、上の 第007巻 が「訂正が効いた」のか
        # 「もともとその番号だった」のか言えない
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, FOLDER_VOLUME)]},
            self.produced_map(output),
            "フォルダの自動判定が想定と違う。訂正の値と揃っていたら何も確かめられない",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class RefusalWordingTest(VolumeOverrideApiTestBase):
    """C15. 断り方の文言そのものを固定する。

    3 つとも、既存の 11 本が**言葉の中身を見ていない**ところ。

    1. 門 1 の 422 に「整理済み」と書かない。**この時点でサイドカーは整理済みか
       どうかを知らない**（知るにはアーカイブを開くしかない）。書くと、名前だけ
       載せた未整理の本にも嘘が出る。ここで使う素材は ``raw_09.zip`` で、
       整理済みではない
    2. ``refused`` の ``reason`` **そのもの**にファイル名が入る。既存は
       ``archive`` 欄でしか見ていないので、理由を「巻数の訂正を断りました」の
       ような本の分からない一文にする変更が通ってしまう。理由は画面にそのまま
       1 行として出るので、そこにどの本か書いていないと問い合わせに答えられない
    3. 同じ理由が **1 行まるごと** ログに現れる。既存は部分一致なので、理由を
       切り詰めた行を出す実装が通る
    """

    def test_the_refusal_at_the_gate_does_not_claim_the_book_is_organized(self):
        # Arrange - 整理済みでない本。ここで「整理済みなので」と言えば嘘になる
        library = self.work_dir / "蔵書C15a"
        plain = self.plain(library)
        output = self.work_dir / "出力C15a"

        # Act - 名前と訂正を同じ行に載せる。門 1 が断る
        refused = self.submit(
            [plain],
            output,
            books=[
                {
                    "source": str(plain),
                    "entry": "",
                    "title": TITLE,
                    "author": AUTHOR,
                    "volume": {"number": FIXED},
                }
            ],
        )
        self.assertEqual(422, refused.status_code, refused.text)

        # Assert - 知らないことを理由にしない
        detail = str(refused.json()["detail"])
        self.assertNotIn(
            "整理済み",
            detail,
            f"投入の時点では整理済みかどうか分からないのに、そう書いている: {detail}",
        )

        # Assert - 黙って断ってもいない。どの本の話かは読める
        self.assertIn(plain.name, detail, f"どの本の話か読めない: {detail}")

    def test_the_refusal_reason_itself_names_the_book_and_reaches_the_log(self):
        # Arrange - 門 2 が断る形（名前欄を落として訂正だけ送る）
        library = self.work_dir / "蔵書C15b"
        built = self.shelve(library, "C15b")
        output = self.work_dir / "出力C15b"

        # Act
        job = self.organize(
            [built],
            output,
            books=[{"source": str(built), "entry": "", "volume": {"number": FIXED}}],
        )

        # Assert - 断ってはいる（形は C6 が固定済み。ここは文言だけを見る）
        refused = job["result"]["refused"]
        self.assertEqual(1, len(refused), f"拒否が 1 件でない: {job['result']}")
        reason = refused[0]["reason"]

        # Assert - 理由**そのもの**にファイル名が入る。``archive`` 欄に在ること
        # では代えられない。画面に出るのはこの 1 行
        self.assertIn(built.name, reason, f"理由からどの本か読めない: {reason}")

        # Assert - 同じ理由が 1 行まるごとログに出る。切り詰めた行を出す実装は
        # ここで落ちる
        self.assertIn(
            reason,
            job["log"],
            f"断った理由が 1 行まるごとログに出ていない: {job['log']}",
        )

        # Assert - 断られた本そのものは今までどおり作られる（``failed`` には
        # 混ぜない）。行き先が依頼の対になるのは、この依頼が名前欄を載せて
        # いないから（C6 の ``expected_map`` と同じ既存の契約）。変わっては
        # いけないのは**巻数**で、第007巻 はどこにも現れない
        self.assertEqual([], job["result"]["failed"], job["result"])
        self.assertEqual(
            {
                REQUEST_DIR: [
                    volume_name(REQUEST_AUTHOR, REQUEST_TITLE, ORGANIZED_VOLUME)
                ]
            },
            self.produced_map(output),
            "訂正を断った本が作られていない、または訂正が通った",
        )


# 同じ実体に与えるもう 1 つの名前。数字を ``PLAIN_NAME`` と揃えるのは、綴りが
# 2 つに割れたときに出来上がりが「同じ本の 2 冊目」（``_1`` 付き）として現れ、
# 失敗の出力からそれと読めるようにするため
LINK_NAME = "複製_09.zip"


class SameFileTestBase(VolumeOverrideApiTestBase):
    """同じ 1 つのファイルに、2 通りの綴りを与える土台。

    ``source_key``（``organize_job.py``）は ``Path.resolve()`` で鍵を作る。
    **これは「同じファイルの別の綴り」を同じ鍵にできない。** 大文字小文字を
    区別しないファイルシステム（配布先の Windows、この開発環境の
    ``/workspaces``）では綴り違いがそのまま起きるが、テストが走る ``/tmp`` は
    区別するので、大文字小文字では書けない。

    ハードリンクなら**どのファイルシステムでも**同じ穴を踏める（実測）::

        resolve a: a.zip / resolve b: b.zip
        samefile: True
        Path.resolve() が一致: False      <- ここが穴
        (st_dev, st_ino) が一致: True
    """

    def twin(self, original: Path, name: str = LINK_NAME) -> Path:
        """同じ実体に、もう 1 つの名前を与える。

        中身を写した別ファイルではいけない。それは「同じ本が 2 つある」だけの
        話で、鍵の作り方とは関係が無い。ここで確かめたいのは**同じ 1 つの
        ファイル**が 2 つの鍵に割れることなので、実体を 1 つに保つ。
        """
        link = original.parent / name
        link.hardlink_to(original)
        return link

    def assert_two_spellings_of_one_file(self, original: Path, link: Path) -> None:
        """素材が本当に「1 つのファイルの 2 通りの綴り」であることを、依頼の前に
        確かめる。

        前提が崩れた素材（別々のファイル、あるいは ``resolve()`` が一致する
        綴り）だと、この下のテストは**何も確かめずに緑になる**。ハードリンクを
        張れない環境で黙って通り抜けるのを防ぐ。
        """
        self.assertTrue(
            original.samefile(link),
            f"素材が同じファイルになっていない: {original} / {link}",
        )
        self.assertNotEqual(
            original.resolve(),
            link.resolve(),
            "2 つの綴りが同じパスに解けている。これでは穴を踏めない: "
            f"{original} / {link}",
        )


class SplitSpellingOverrideTest(SameFileTestBase):
    """C16. 綴りを 2 つに分けても、門 1 は名前と訂正の同居を見抜く。

    C11 が塞いだのは「同じ ``(source, entry)`` を 2 **行**に分ける」抜け道
    だった。門 1 は位置ごとに全行をまとめてから見るようになったが、**その
    まとめ方（``source_key``）が同じファイルの別の綴りを別の位置として扱う。**

    実測（``raw_09.zip`` と、その実体へのハードリンク ``複製_09.zip``。素材は
    整理済みではないので門 2 も拾わない）:

    | 依頼の形 | いまの答え | 出来る物 |
    |---|---|---|
    | 1 つの綴りに名前と訂正 | 422 | （作らない） |
    | 2 つの綴りに分ける | **202** | ``[著者] 作品 第007巻.zip`` |

    ``wanted_books`` も同じ ``source_key`` で鍵を作るので、同じファイルが 2 つの
    鍵に分かれ、名前の載っていない側の鍵に訂正がそのまま残る。**つまり門が
    1 つも塞がっていない。**

    対照を 2 つ置く。「綴りが 2 つあれば断る」実装と「訂正の載った綴りが 2 つ
    あれば断る」実装が、両方ここで落ちる。
    """

    def test_a_name_and_a_correction_split_across_two_spellings_are_refused(self):
        # Arrange - 素材が「1 つのファイルの 2 通りの綴り」であることを先に
        # 確かめる。前提が崩れているのに緑になるのを防ぐ
        library = self.work_dir / "蔵書C16"
        plain = self.plain(library)
        twin = self.twin(plain)
        self.assert_two_spellings_of_one_file(plain, twin)
        split_output = self.work_dir / "綴りを分けた側"
        nameless_output = self.work_dir / "対照a"
        fixed_output = self.work_dir / "対照b"

        # Act / Assert - 一方の綴りに名前、もう一方に訂正。断る。しかも 1 冊も
        # 書き出さない。``produced_map`` を見るのは、受け付けてジョブにしてから
        # 失敗させる実装を落とすため
        split = self.submit(
            [plain, twin],
            split_output,
            books=[
                {"source": str(plain), "entry": "", "title": TITLE, "author": AUTHOR},
                {"source": str(twin), "entry": "", "volume": {"number": FIXED}},
            ],
        )
        self.assertEqual(
            422,
            split.status_code,
            f"綴りを 2 つに分けた依頼が門 1 を素通りしている: {split.text}",
        )
        self.assertEqual(
            {}, self.produced_map(split_output), "断ったのに書き出している"
        )

        # Act / Assert - 対照 (a)。2 つの綴りに分けるが、どちらにも訂正が無い。
        # 「綴りが 2 つあれば断る」実装はここで落ちる
        nameless = self.submit(
            [plain, twin],
            nameless_output,
            books=[
                {"source": str(plain), "entry": "", "title": TITLE, "author": AUTHOR},
                {"source": str(twin), "entry": ""},
            ],
        )
        self.assertEqual(
            202,
            nameless.status_code,
            f"訂正の無い 2 つの綴りの依頼まで断っている: {nameless.text}",
        )

        # Act / Assert - 対照 (b)。2 つの綴りに同じ訂正だけ（名前は 1 行も
        # 載せない）。受け付けて、訂正が効く。「訂正の載った綴りが 2 つあれば
        # 断る」実装と「何にでも 422 を返す」実装が、両方ここで落ちる
        accepted = self.submit(
            [plain, twin],
            fixed_output,
            books=[
                {"source": str(plain), "entry": "", "volume": {"number": FIXED}},
                {"source": str(twin), "entry": "", "volume": {"number": FIXED}},
            ],
        )
        self.assertEqual(
            202,
            accepted.status_code,
            f"名前の載らない 2 つの綴りの訂正まで断っている: {accepted.text}",
        )
        job = self.job(accepted.json()["id"])
        self.assertEqual("succeeded", job["state"], job.get("error"))

        # Assert - 出来た物はどれも訂正どおりの番号を持つ。**冊数はここでは
        # 見ない。** 同じファイルが 2 冊に増えるかどうかは C17 の担当で、
        # ここで一緒に見ると門 1 の話と展開の話が 1 本のテストで混ざる
        produced = self.produced_map(fixed_output)
        corrected = f"[{REQUEST_AUTHOR}] {REQUEST_TITLE} 第{FIXED:03d}巻"
        self.assertEqual(
            [REQUEST_DIR], list(produced), f"行き先が想定と違う: {produced}"
        )
        self.assertTrue(
            produced[REQUEST_DIR]
            and all(name.startswith(corrected) for name in produced[REQUEST_DIR]),
            f"2 つの綴りに載せた訂正が効いていない: {produced}",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


class DuplicateSpellingExpansionTest(SameFileTestBase):
    """C17. 同じファイルを 2 通りに書いて投入しても、本が 2 冊できない。

    ``input_expander.iter_inputs`` は ``set[Path]`` で重複を落とすが、**綴りが
    違えば同じ実体を 2 回返す。** その 2 件はどちらも整理されるので、同じ本が
    2 回書き出され、2 冊目に ``_1`` が付く。

    利用者から見た症状は「同じ本が 2 冊出来た」。しかも中身は同じなので、
    どちらを消せばよいのかは名前からは分からない。

    ``produced_map`` を丸ごと比べる。件数だけだと、別の理由で 1 冊になった場合
    （行き先を取り違えた、片方が失敗した）も通ってしまう。
    """

    def test_two_spellings_of_the_same_file_do_not_produce_two_books(self):
        # Arrange - 素材が「1 つのファイルの 2 通りの綴り」であることを先に
        # 確かめる。別々のファイルなら 2 冊出来て当たり前で、何も確かめられない
        library = self.work_dir / "蔵書C17"
        plain = self.plain(library)
        twin = self.twin(plain)
        self.assert_two_spellings_of_one_file(plain, twin)
        output = self.work_dir / "出力C17"

        # Act - 2 つの綴りを両方投入する。``books`` は載せない（投入したものを
        # 全部作る）。訂正の話をここへ持ち込まないのは、展開の重複そのものが
        # 訂正と関わりなく起きるため
        job = self.organize([plain, twin], output, books=None)

        # Assert - 出来る本は 1 冊。自動判定の 9 のまま。``_1`` の付いた
        # 2 冊目はどこにも無い
        self.assertEqual(
            {REQUEST_DIR: [volume_name(REQUEST_AUTHOR, REQUEST_TITLE, PLAIN_VOLUME)]},
            self.produced_map(output),
            "同じファイルの 2 通りの綴りから、本が 2 冊出来ている",
        )
        self.assertEqual([], job["result"]["failed"], job["result"])


if __name__ == "__main__":
    unittest.main()
