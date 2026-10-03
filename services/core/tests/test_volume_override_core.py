"""利用者が訂正した巻数を、実処理が使うこと（段階 B）。

段階 A で「なぜこの本が第005巻になったのか」を画面まで通した。根拠が見えれば
次に来る要望は決まっていて、**間違っていたら直したい**。段階 B はその受け口を
``manga_core`` の側だけに作る。

    organizer.process_single_archive(archive, skip_locations, series, volumes=...)

``volumes`` は「鍵 -> 訂正後の巻数」の地図。API の受け口（``BookRef.volume``）は
次の段階なので、ここでは HTTP を 1 度も通さず ``FileOrganizer`` を直に呼ぶ。
経路を混ぜると、依頼の検証で断られたのか実処理へ届かなかったのかが、失敗の
出力から読めなくなる。

## 鍵は ``skip_locations`` と同じ鍵空間

展開ルートからの相対パスで、ルート自身は空文字。``_skipped`` が
``relative if relative != "." else ""`` で作っている形と 1 バイトも違わない。

**別の鍵空間にすると、外す判定は効いているのに訂正だけが黙って落ちる。**
利用者から見えるのは「外したい本は外れたのに、直した巻数だけ元のまま」で、
訂正が届かなかったのか訂正の値が無視されたのかを切り分ける手がかりが無い。
2 つの地図が同じ位置を指しているという前提は、ここでしか見張れない。

## 差し込む点は 2 つある

``FileOrganizer`` が巻数を決める場所は 1 つではない。

| 経路 | 場所 | 鍵 |
|---|---|---|
| 展開して巻ごとに処理 | ``process_single_archive`` のループ | ルートからの相対パス |
| 画像を直接置いたフォルダ | ``_process_image_directory`` | 常に空文字 |

後者は ``skip_locations`` を**一切見ていない**。フォルダは丸ごと 1 冊なので
外すかどうかは呼び出し側が決める、という取り決めになっている。訂正のほうは
そうはいかない。フォルダ 1 つでも巻数は間違いうるので、ここにも届く必要がある。

## ``None`` は「触っていない」ではなく「巻数を付けないでほしい」

``None`` は**正当な訂正の値**で、「まだ訂正していない」とは別物。両者を同じ物
として扱うと、「巻数を外して」という依頼が静かに消える。鍵の**有無**で分ける。

    volume = volumes[key] if key in volumes else detected

``volumes.get(key, detected)`` も、``Mapping`` が相手なら**これと同じ意味になる**
（``{"第01巻": None}.get("第01巻", 1)`` は ``1`` ではなく ``None`` を返す。既定値が
使われるのは鍵が無いときだけ）。実測で確かめた。飲み込むのは次の形のほうで、
``None`` を偽として扱うか、``None`` を「鍵が無い」と読み替えるかのどちらか。

    volumes.get(key) or detected                      # None が 0 と同じ扱い
    volumes[key] if volumes.get(key) is not None else detected

逆向きの取り違えもある。鍵が無いときに ``None`` を返す形
（``volumes.get(key)`` だけ）は、訂正を 1 つも渡していない実行で全冊の巻数を
消す。既定は**自動判定**であって ``None`` ではない。だから訂正を渡さない回を
それぞれの経路に 1 つずつ置いてある。

## 素材の自動判定（実測値）

訂正の値は自動判定と**必ず違える**。揃えた素材だと、訂正を丸ごと無視する実装が
そのまま通る。

| 素材 | 鍵 | 自動判定 | 訂正 |
|---|---|---|---|
| ``合本.zip`` の ``第01巻/`` | ``第01巻`` | 1 | 7 / ``None`` |
| ``合本.zip`` の ``第02巻/`` | ``第02巻`` | 2 | （訂正しない） |
| ``まとめ.zip`` の ``内_05.zip`` | ``_extracted_内_05_zip`` | 5 | 12 |
| 画像フォルダ ``第03巻`` | ``""`` | 3 | 8 |
"""

import io
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.archive_handler import ArchiveHandler  # noqa: E402
from manga_core.file_organizer import FileOrganizer, ProcessResult  # noqa: E402
from manga_core.volume_detector import VolumeDetector  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"

# 素材の見分け札。巻ごとにページ枚数を変えておくと、出来上がった ZIP を開いた
# ときに「どの中身にどの番号が付いたか」まで言える。名前だけを比べると、
# 2 冊の番号を取り違える実装がそのまま通る
FIRST_PAGES = 3
SECOND_PAGES = 4
NESTED_PAGES = 5
BARE_PAGES = 6


def page() -> bytes:
    """テスト用のページ画像。実処理まで走らせるので、実際に開ける JPEG にする"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def pages(prefix: str = "", count: int = 2) -> dict[str, bytes]:
    """アーカイブに入れるページの並び。prefix でフォルダの中に置ける"""
    return {f"{prefix}{index:03d}.jpg": page() for index in range(1, count + 1)}


def zip_with(path: Path, entries: dict[str, bytes]) -> Path:
    """指定した中身の ZIP を作る。途中のフォルダも掘る"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


class VolumeOverrideTestBase(unittest.TestCase):
    """素材を作り、その素材が実際にどう見えているかを確かめてから訂正する土台。

    素材の自動判定を先に固定するのは、訂正の値と自動判定の値がたまたま揃うと
    「訂正を無視する実装」が通ってしまうため。揃っていないことを、期待値に
    書き写すのではなく**その場で走らせて**確かめる。
    """

    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()
        # 鍵の表と出来上がりの表を丸ごと比べる。切り詰められると、どの鍵で
        # 食い違ったのかが失敗の出力から読めない
        self.maxDiff = None

    def compound(self) -> Path:
        """1 つの ZIP に 2 冊。自動判定は 第01巻 -> 1、第02巻 -> 2。

        ページ枚数を巻ごとに変えてあるので、出来上がった ZIP を開けば
        どの中身に何番が付いたか分かる。
        """
        return zip_with(
            self.work_dir / "素材" / "合本.zip",
            {
                **pages("第01巻/", FIRST_PAGES),
                **pages("第02巻/", SECOND_PAGES),
            },
        )

    def nested(self) -> Path:
        """``まとめ.zip`` の中に ``内_05.zip``。自動判定は 5"""
        inner = zip_with(
            self.work_dir / "内側" / "内_05.zip", pages(count=NESTED_PAGES)
        ).read_bytes()
        return zip_with(self.work_dir / "素材" / "まとめ.zip", {"内_05.zip": inner})

    def bare_folder(self) -> Path:
        """画像を直接置いたフォルダ。名前から巻数が読める（第03巻 -> 3）"""
        folder = self.work_dir / "素材" / "第03巻"
        folder.mkdir(parents=True, exist_ok=True)
        for name, data in pages(count=BARE_PAGES).items():
            (folder / name).write_bytes(data)
        return folder

    def detected(self, archive: Path) -> dict[str, int | None]:
        """素材が実処理からどう見えているかを「鍵 -> 自動判定の巻数」で写す。

        鍵の作り方は ``FileOrganizer._skipped`` と同じ（展開ルートからの相対
        パス、ルート自身は空文字）。ここで鍵空間そのものを固定しておかないと、
        訂正が届かなかったときに「鍵が違うのか、訂正が無視されたのか」を
        失敗の出力から切り分けられない。
        """
        handler = ArchiveHandler()
        try:
            image_dirs, error = handler.process_archive(archive)
            self.assertIsNone(error, f"素材を展開できない: {archive} ({error})")
            root = handler.extract_root
            self.assertIsNotNone(root, "展開ルートが無い。鍵を作れない")
            detector = VolumeDetector()
            found: dict[str, int | None] = {}
            for index, image_dir in enumerate(image_dirs, 1):
                relative = image_dir.relative_to(root).as_posix()
                key = relative if relative != "." else ""
                found[key] = detector.resolve_volume(
                    image_dir, archive, index, len(image_dirs)
                ).number
            return found
        finally:
            handler.cleanup()

    def organize(
        self,
        target: Path,
        output: Path,
        volumes: dict[str, int | None] | None = None,
    ) -> list[ProcessResult]:
        """整理を 1 件走らせる。訂正を渡さない回は今までどおりの呼び方にする。

        ``volumes`` を渡す回だけ引数を足すのは、「訂正を 1 つも渡さない実行」が
        既存の呼び出しと同じ形であることを、テストの側でも保つため。
        """
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        if volumes is None:
            return organizer.process_single_archive(target)
        return organizer.process_single_archive(target, volumes=volumes)

    def reported(self, results: list[ProcessResult]) -> dict[str, int | None]:
        """出来たファイル名 -> 報告された巻数（``ProcessResult.volume_number``）。

        巻数だけを並べると、``第007巻`` のファイルが ``volume_number=2`` を、
        ``第002巻`` のファイルが 7 を持つ**入れ替わり**が素通りする。並びは
        どちらでも ``[2, 7]`` になり、名前とページ数を見る別のテストも通る。
        画面はこの番号を読んで一覧に出すので、番号の集合ではなく、名前と
        番号の**対応そのもの**を見る。

        並べずに対応で見ることで、``None`` どうしの比較（``TypeError``）も
        起きない。巻数を全部消す実装の失敗が「比較できません」という無関係な
        出力に化けることもない。
        """
        return {
            result.output_path.name: result.volume_number
            for result in results
            if result.success and result.output_path is not None
        }

    def produced_pages(self, results: list[ProcessResult]) -> dict[str, int]:
        """出来たファイル名 -> 中のページ枚数。

        枚数が素材の見分け札。名前と中身の結び付きを、ここで初めて見られる。
        """
        self.assertEqual(
            [],
            [result.error_message for result in results if not result.success],
            "実処理が失敗した。0 冊同士の一致では何も確かめられない",
        )
        produced: dict[str, int] = {}
        for result in results:
            if result.output_path is None:
                continue
            self.assertTrue(
                result.output_path.is_file(),
                f"出来たはずのファイルが無い: {result.output_path}",
            )
            with zipfile.ZipFile(result.output_path) as archive:
                produced[result.output_path.name] = len(archive.namelist())
        return produced


class CompoundOverrideTest(VolumeOverrideTestBase):
    """B1. 合本の中の 1 冊だけが、訂正した番号になる

    片方だけを見ると「渡された訂正を全部の巻に配る」実装が通ってしまうので、
    出来た本を **2 冊まとめてリストで**比べる。訂正しなかったほうが自動判定の
    ままであることは、訂正が届いたことと同じだけ重要な契約。
    """

    def test_only_the_corrected_book_in_a_compound_archive_changes_its_number(self):
        # Arrange - 素材の自動判定を先に固定する。1 と 2 であることを確かめて
        # おかないと、訂正の 7 とたまたま揃った素材で「訂正を無視する実装」が
        # 通ってしまう
        compound = self.compound()
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2},
            self.detected(compound),
            "素材の自動判定が想定と違う。訂正の値と揃っていたら何も確かめられない",
        )
        output = self.work_dir / "出力"

        # Act - 第01巻 の側だけを 7 に訂正する。7 は自動判定のどちらとも違う
        results = self.organize(compound, output, volumes={"第01巻": 7})

        # Assert - 訂正した本は 7 巻、訂正していない本は自動判定の 2 巻のまま。
        # ページ枚数まで見るので、2 冊の番号を入れ替える実装もここで落ちる
        self.assertEqual(
            {
                "[著者] 作品 第007巻.zip": FIRST_PAGES,
                "[著者] 作品 第002巻.zip": SECOND_PAGES,
            },
            self.produced_pages(results),
            "合本の片方だけの訂正が効いていない（出来た名前 -> 中のページ枚数）",
        )

    def test_the_reported_volume_numbers_follow_the_correction(self):
        # Arrange - 報告（``ProcessResult.volume_number``）は整理ジョブの応答を
        # 通って画面に出る。ファイル名だけ訂正が効いて報告が自動判定のままだと、
        # 一覧と出来上がりが食い違う
        compound = self.compound()
        output = self.work_dir / "出力"

        # Act
        results = self.organize(compound, output, volumes={"第01巻": 7})

        # Assert - 並べ替えは None を含んでも落ちない形にする。巻数を全部
        # 消す実装が TypeError で終わると、失敗の出力から何が起きたか読めない
        self.assertEqual(
            {
                "[著者] 作品 第007巻.zip": 7,
                "[著者] 作品 第002巻.zip": 2,
            },
            self.reported(results),
            f"報告された巻数が訂正に従っていない: {[r.volume_number for r in results]}",
        )


class NestedOverrideTest(VolumeOverrideTestBase):
    """B2. 入れ子アーカイブの中の本にも、訂正が届く

    **鍵の食い違いを捕まえられるのは、このテストだけ。**

    画面が本の位置として持っているのは ``内_05.zip``（``PlannedBook.entry``）で、
    ``FileOrganizer`` が使う鍵は展開先の ``_extracted_内_05_zip``
    （``PlannedBook.extracted_path``）。この 2 つが**違う値になるのは入れ子だけ**で、
    平坦な ZIP では ``第01巻`` と ``第01巻``、画像フォルダでは ``""`` と ``""`` と、
    どちらも一致してしまう。

    だから ``entry`` を鍵にした実装は B1・B3・B4 を全部素通りする。平坦な ZIP
    しか使わないテストでは、この欠陥は**絶対に見えない**。利用者から見た症状は
    「入れ子の本だけ訂正が効かない」で、しかも同じ依頼に入れた外す指定
    （``skip_locations``）のほうは効いているので、鍵が原因だと気づく道が無い。
    """

    def test_a_correction_reaches_a_book_inside_a_nested_archive(self):
        # Arrange - 素材が本当に入れ子の形であること、つまり鍵が展開先の名前に
        # なっていることを先に確かめる。ここが `内_05.zip` になっている素材では
        # このテストは鍵の食い違いを捕まえられない
        nested = self.nested()
        keys = self.detected(nested)
        self.assertEqual(
            {"_extracted_内_05_zip": NESTED_PAGES},
            keys,
            "素材が入れ子の形になっていない。鍵が展開先の名前でなければ、"
            "このテストは鍵の食い違いを捕まえられない",
        )
        key = next(iter(keys))
        self.assertTrue(
            key.startswith("_extracted_"),
            f"鍵が展開先の名前ではない: {key}",
        )
        self.assertNotEqual(
            "内_05.zip", key, "鍵と画面の位置が同じ値になっている。素材が入れ子でない"
        )
        output = self.work_dir / "出力"

        # Act - 12 に訂正する。自動判定の 5 とも、並び順の 1 とも違う値
        results = self.organize(nested, output, volumes={key: 12})

        # Assert - 第012巻。第005巻 のままなら訂正が届いていない
        self.assertEqual(
            {"[著者] 作品 第012巻.zip": NESTED_PAGES},
            self.produced_pages(results),
            "入れ子の中の本に訂正が届いていない。鍵が展開ルートからの相対パス"
            "（_extracted_ で始まる名前）になっているか確かめること",
        )

    def test_the_entry_path_is_not_the_key_for_a_nested_book(self):
        # Arrange - 画面が持っている位置（`内_05.zip`）をそのまま鍵にした依頼。
        # 実装がどちらの鍵でも拾うようになっていると、鍵空間が 2 つに増え、
        # 外す指定（skip_locations）と訂正が別々の地図を見ることになる
        nested = self.nested()
        output = self.work_dir / "出力"

        # Act
        results = self.organize(nested, output, volumes={"内_05.zip": 12})

        # Assert - 届かない。鍵空間は skip_locations と 1 つに保つ。当たらない
        # 鍵は黙って無視され、自動判定の 5 のまま作られる
        self.assertEqual(
            {"[著者] 作品 第005巻.zip": NESTED_PAGES},
            self.produced_pages(results),
            "画面の位置を鍵として受け付けている。鍵空間が skip_locations と"
            "食い違うと、外す指定は効くのに訂正だけが静かに落ちる",
        )


class VolumeRemovalTest(VolumeOverrideTestBase):
    """B3. ``None`` で巻数を外せる

    ``None`` は「まだ訂正していない」ではなく「巻数を付けないでほしい」という
    正当な依頼。``None`` を偽として扱う実装（``volumes.get(key) or detected``）や、
    ``None`` を「鍵が無い」と読み替える実装
    （``volumes[key] if volumes.get(key) is not None else detected``）は、この
    依頼を自動判定の番号へ戻して静かに消す。

    ``volumes.get(key, detected)`` はこの罠では**ない**。``Mapping`` の既定値は
    鍵が無いときにしか使われないので、鍵の有無で分けるのと同じ意味になる。

    出来上がりは ``Unknown`` を含む**完全な名前**で見る。「第001巻ではない」
    だけを見ると、名前そのものが壊れた実装でも通ってしまう。
    """

    def test_a_book_can_have_its_volume_number_removed(self):
        # Arrange - 自動判定は 1 と 2。片方だけ「巻数なし」に訂正する
        compound = self.compound()
        self.assertEqual(
            {"第01巻": 1, "第02巻": 2},
            self.detected(compound),
            "素材の自動判定が想定と違う",
        )
        output = self.work_dir / "出力"

        # Act
        results = self.organize(compound, output, volumes={"第01巻": None})

        # Assert - 外した本は Unknown、**同じ実行のもう 1 冊は番号付きのまま**。
        # 対にするのが要点。左側は None を飲み込む実装（`get(key) or detected`）
        # をここで止め、右側は「渡された訂正を全巻へ配る」実装をここで止める。
        # 片方だけを見ると、もう片方の実装がそのまま通る
        self.assertEqual(
            {
                "[著者] 作品 Unknown.zip": FIRST_PAGES,
                "[著者] 作品 第002巻.zip": SECOND_PAGES,
            },
            self.produced_pages(results),
            "巻数を外す訂正が効いていない（出来た名前 -> 中のページ枚数）",
        )

    def test_the_removal_is_reported_as_no_volume_number(self):
        # Arrange - 報告のほうにも `None` が乗ること。ファイル名だけ Unknown で
        # 報告が 1 のままだと、画面の一覧と出来上がりが食い違う
        compound = self.compound()
        output = self.work_dir / "出力"

        # Act
        results = self.organize(compound, output, volumes={"第01巻": None})

        # Assert - 巻数なしと 2 巻が 1 冊ずつ
        self.assertEqual(
            {
                "[著者] 作品 Unknown.zip": None,
                "[著者] 作品 第002巻.zip": 2,
            },
            self.reported(results),
            f"報告された巻数が訂正に従っていない: {[r.volume_number for r in results]}",
        )

    def test_a_run_without_any_correction_still_numbers_every_book(self):
        """訂正を 1 つも渡さない実行が、今までどおりであること。

        既定を「全部 ``None``」として扱う実装、つまり訂正の地図が空のときに
        巻数を外してしまう実装は、ここで落ちる。B3 の片割れであり、同じ素材で
        対にしておかないと「巻数を外す」直しが既定まで巻き込んだことに
        気づけない。
        """
        # Arrange - 素材は同じ合本
        compound = self.compound()
        output = self.work_dir / "出力"

        # Act - 訂正を渡さない。呼び方も今までどおり
        results = self.organize(compound, output)

        # Assert - 2 冊とも自動判定の番号が付く。Unknown は 1 冊も無い
        self.assertEqual(
            {
                "[著者] 作品 第001巻.zip": FIRST_PAGES,
                "[著者] 作品 第002巻.zip": SECOND_PAGES,
            },
            self.produced_pages(results),
            "訂正を渡さない実行で、自動判定の巻数が付かなくなっている",
        )


class ImageDirectoryOverrideTest(VolumeOverrideTestBase):
    """B4. 画像を直接置いたフォルダにも、訂正が効く

    **``_process_image_directory`` の経路を通るのは、このテストだけ。**

    フォルダが投入されたとき ``process_single_archive`` は展開へ進まず、
    別の関数へ丸ごと分岐する。その関数は ``skip_locations`` を一切見ておらず、
    巻数も ``volume_detector.detect_volume`` を自前で 1 回呼ぶだけ。つまり
    通常経路のループにだけ訂正を差し込んだ実装は、B1〜B3 を全部通したうえで
    **ここだけが落ちる**。

    フォルダは丸ごと 1 冊なので鍵は空文字。展開ルートからの相対パスが ``.``
    になる場合と同じ扱いで、``_skipped`` の ``relative if relative != "." else ""``
    が作る値と揃う。
    """

    def test_a_correction_reaches_a_folder_of_loose_images(self):
        # Arrange - 名前から巻数が読めるフォルダ。自動判定が無い素材だと
        # 「訂正が効いた」のか「もともと番号が無かった」のか区別できない
        folder = self.bare_folder()
        self.assertEqual(
            3,
            VolumeDetector().detect_volume(folder),
            "素材フォルダの自動判定が想定と違う。訂正の 8 と揃っていたら"
            "何も確かめられない",
        )
        output = self.work_dir / "出力"

        # Act - フォルダは丸ごと 1 冊なので鍵は空文字
        results = self.organize(folder, output, volumes={"": 8})

        # Assert - 第008巻。第003巻 のままなら、訂正が通常経路にしか
        # 差し込まれていない
        self.assertEqual(
            {"[著者] 作品 第008巻.zip": BARE_PAGES},
            self.produced_pages(results),
            "画像を直接置いたフォルダに訂正が届いていない。"
            "_process_image_directory は通常経路とは別の関数",
        )

    def test_a_folder_without_a_correction_keeps_its_detected_number(self):
        # Arrange - 対照。訂正を渡さない回が今までどおりであること
        folder = self.bare_folder()
        output = self.work_dir / "出力"

        # Act
        results = self.organize(folder, output)

        # Assert - フォルダ名から読んだ 3 巻のまま
        self.assertEqual(
            {"[著者] 作品 第003巻.zip": BARE_PAGES},
            self.produced_pages(results),
            "訂正を渡さないフォルダの巻数が変わった",
        )

    def test_a_folder_can_have_its_volume_number_removed(self):
        # Arrange - フォルダの経路でも `None` が正当な値であること。通常経路
        # だけを鍵の有無で分け、こちらを `get(key) or detected` のままにした
        # 実装は、B4 の中でここだけが落ちる
        folder = self.bare_folder()
        output = self.work_dir / "出力"

        # Act
        results = self.organize(folder, output, volumes={"": None})

        # Assert - Unknown を含む完全な名前で見る
        self.assertEqual(
            {"[著者] 作品 Unknown.zip": BARE_PAGES},
            self.produced_pages(results),
            "フォルダの巻数を外す訂正が効いていない",
        )


class SkippedBookNumberingTest(VolumeOverrideTestBase):
    """外した本のぶんも番号を数え続けること（訂正を差し込んでも壊れない）。

    名前から巻数を読めない合本は、並び順（``position``）で番号が決まる。
    実処理は**外した本のぶんも先に番号を決めてから**外す判定をしている。
    飛ばしてから数えると、1 冊目を外した瞬間に 2 冊目が 1 巻になり、
    利用者が「作らない」と言っただけで残した本の名前が変わる。

    段階 B で ``_skipped`` から鍵の作り方を ``_location_key`` へ切り出し、
    巻数を決める行の隣に訂正を差し込んだ。**順序を入れ替えれば静かに壊れる**
    場所なので、ここで押さえる。新しい 10 本はどれも ``skip_locations`` を
    渡さないため、この経路を一度も通らない。
    """

    def numberless(self) -> Path:
        """1 つの ZIP に 2 冊。**名前に数字を入れない**ので並び順で決まる。

        ``第01巻`` のような名前だと ``pattern`` で決まってしまい、外した本を
        数え続けているかどうかが分からない。
        """
        return zip_with(
            self.work_dir / "素材" / "並び順.zip",
            {
                **pages("上巻/", FIRST_PAGES),
                **pages("下巻/", SECOND_PAGES),
            },
        )

    def organize_with_skip(
        self, target: Path, output: Path, skip: frozenset[str]
    ) -> list[ProcessResult]:
        organizer = FileOrganizer(output_directory=output, keep_originals=True)
        organizer.set_manga_info(author=AUTHOR, title=TITLE)
        return organizer.process_single_archive(target, skip)

    def test_the_kept_book_keeps_the_number_the_skipped_one_left_behind(self):
        """1 冊目を外しても、2 冊目は 2 巻のまま。"""
        # Arrange - 素材が本当に並び順で 1 と 2 になることを、先に確かめる
        compound = self.numberless()
        self.assertEqual(
            {"上巻": 1, "下巻": 2},
            self.detected(compound),
            "素材が並び順で決まっていない。この形でないと外した本を"
            "数え続けているかどうかが分からない",
        )
        output = self.work_dir / "出力"

        # Act - 1 冊目だけ外す
        results = self.organize_with_skip(compound, output, frozenset({"上巻"}))

        # Assert - 残った 1 冊が 2 巻。外した本のぶんを数えていない実装は、
        # ここで 第001巻 を作る。ページ枚数まで見て、中身の取り違えも塞ぐ
        self.assertEqual(
            {"[著者] 作品 第002巻.zip": SECOND_PAGES},
            self.produced_pages(results),
            "外した本のぶんを数えずに番号を振り直している",
        )

    def test_nothing_is_skipped_when_no_location_is_given(self):
        """対照。外す指定が無ければ 2 冊とも出来る。

        これが無いと「``skip_locations`` を無視して全部作る」実装も、
        「何を渡されても 1 冊しか作らない」実装も上のテストを通る。
        """
        # Arrange
        compound = self.numberless()
        output = self.work_dir / "出力"

        # Act
        results = self.organize_with_skip(compound, output, frozenset())

        # Assert
        self.assertEqual(
            {
                "[著者] 作品 第001巻.zip": FIRST_PAGES,
                "[著者] 作品 第002巻.zip": SECOND_PAGES,
            },
            self.produced_pages(results),
            "外す指定が空なのに本が減っている",
        )


if __name__ == "__main__":
    unittest.main()
