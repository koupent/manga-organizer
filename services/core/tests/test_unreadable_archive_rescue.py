"""目次を読めないアーカイブを、機械的に ZIP へ変換して予告に乗せる。

#227 までの実装では、目次を読めない書庫（コメント付き RAR など。``_open_rar``
の docstring）は「目次を読めません」としか出せず、出来上がる本を一つも予告
できなかった。実処理（``FileOrganizer`` → ``ArchiveHandler``）は外部ツールが
あれば同じ書庫を実際に展開できるので、予告だけが実処理に追いつけていなかった。

``toc_analyzer._rescue_unreadable`` は、目次を読めなかった書庫**だけ**を
``ArchiveHandler`` で展開し、リネームせず同じ中身を ZIP へ詰め直して置き換える。
以後はただの ZIP として ``_open_zip`` が読む。中から出てきた、同じく目次を
読めないアーカイブも同じ規則で先に直してから詰める。

ここで求める公開契約は次の 3 つ。

1. 目次を読めない書庫（中に画像と、同じく目次を読めない入れ子書庫がある）が、
   変換後に同じ中身の ZIP と同じ本を予告すること。入れ子も含めて 1 冊も
   消えない
2. 読める ZIP には一切触れないこと（変換を試みない。ファイルも書き換えない）
3. 道具が無くて展開そのものに失敗したら、変換前の「目次を読めません」を
   そのまま返すこと（嘘の予告は出さない）

展開には外部ツール（unrar / 7-Zip）が要る。この環境には無いため、1 の
テストでは ``ArchiveHandler.extract_archive`` だけを差し替えて実処理の展開を
再現する。目次が読める／読めないの判定そのもの（``rarfile`` での本物の
コメント付き RAR の解析）は差し替えず、実物のまま確かめる。3 は道具を
取り上げたままの本物のコメント付き RAR で確かめる。
"""

import io
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from test_toc_rar_7z import (  # noqa: E402
    REAL_RAR3_WITH_COMMENT,
    without_archive_tools,
    zip_with,
)

from manga_api.analysis_job import analysis_work  # noqa: E402
from manga_core import toc_analyzer  # noqa: E402
from manga_core.archive_handler import ArchiveHandler  # noqa: E402

AUTHOR = "著者"
TITLE = "作品"


def page() -> bytes:
    """テスト用のページ画像"""
    buffer = io.BytesIO()
    Image.new("RGB", (40, 60), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def pages(count: int = 2) -> dict[str, bytes]:
    return {f"{index:03d}.jpg": page() for index in range(1, count + 1)}


class RescueUnreadableArchiveTest(unittest.TestCase):
    def setUp(self):
        self._temp = TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.work_dir = Path(self._temp.name).resolve()

    def analyze(self, root: Path) -> list:
        return list(toc_analyzer.analyze_inputs([root], author=AUTHOR, title=TITLE))

    def fake_extraction(self, mapping: dict[str, dict[str, bytes]]):
        """``ArchiveHandler.extract_archive`` を差し替え、道具の無い環境でも
        実処理の展開結果を再現する。

        鍵はファイル名（拡張子込み）。入れ子の展開先は一時フォルダの下に
        毎回新しく作られ、フルパスは予測できないが、置くファイル名はこちら
        で決めているので名前だけで引ける。
        """

        def extract(
            _self, archive_path: Path, extract_to: Path, progress_callback=None
        ):
            entries = mapping.get(archive_path.name)
            if entries is None:
                return False
            for name, data in entries.items():
                target = extract_to / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            return True

        return mock.patch.object(ArchiveHandler, "extract_archive", extract)

    def test_unreadable_archive_with_unreadable_nested_archive_becomes_predictable(
        self,
    ):
        # Arrange - 本物の、目次ごと読めない RAR（コメント付き）を 2 つ使う。
        # 1 つは投入した書庫そのもの、もう 1 つはその中の入れ子書庫を演じる
        root = self.work_dir / "蔵書"
        root.mkdir(parents=True)
        outer = root / "raw_04.rar"
        outer.write_bytes(REAL_RAR3_WITH_COMMENT.read_bytes())
        nested_bytes = REAL_RAR3_WITH_COMMENT.read_bytes()

        # Arrange - 下準備の確認。本物のコメント付き RAR は、道具が無くても
        # 本当に目次を読めない（握りつぶさず上まで出ることをここで押さえる）
        with without_archive_tools():
            with self.assertRaises(toc_analyzer.rarfile.Error):
                toc_analyzer.locate_books(outer)

        mapping = {
            # 外側を展開すると、画像と「読めない入れ子書庫」が出てくる
            "raw_04.rar": {
                "001.jpg": page(),
                "002.jpg": page(),
                "内側.rar": nested_bytes,
            },
            # 入れ子書庫を展開すると、画像だけが出てくる
            "内側.rar": {"001.jpg": page()},
        }

        # Act - 道具は無いまま（``_rescue_unreadable`` の展開だけ差し替える）
        with without_archive_tools(), self.fake_extraction(mapping):
            books = self.analyze(root)

        # Assert - 2 冊とも予告に乗る。外側の画像から 1 冊、
        # 変換された入れ子（``内側.zip``）から 1 冊
        self.assertEqual(
            {"[著者] 作品 第004巻.zip", "[著者] 作品 第002巻.zip"},
            {book.output_name for book in books},
            f"変換後に予告できた本が足りない: {[b.output_name for b in books]}",
        )
        self.assertEqual(2, len(books))
        entries = {book.entry for book in books}
        self.assertIn("内側.zip", entries, f"入れ子の変換が位置に出ていない: {entries}")

        # Assert - 元の RAR は消え、ZIP に置き換わっている（リネームなし、
        # 拡張子だけ変わる）
        self.assertFalse(outer.exists(), "元の RAR が残っている")
        self.assertTrue((root / "raw_04.zip").exists(), "変換した ZIP が無い")

        # Assert - どの本も「変換した ZIP」を指す。古い RAR のパスは残らない
        for book in books:
            self.assertEqual(root / "raw_04.zip", Path(book.source))

    def test_the_analysis_job_moves_the_container_from_rar_to_zip(self):
        """解析ジョブの ``containers`` / ``unreadable`` も、変換後の場所に
        入れ替わること。入れ替えないと、画面は変換前のパスを「解析中」のまま
        待ち続け、変換で出来た本が誰の行にも紐付かないまま浮く。
        """
        # Arrange
        root = self.work_dir / "蔵書"
        root.mkdir(parents=True)
        outer = root / "raw_04.rar"
        outer.write_bytes(REAL_RAR3_WITH_COMMENT.read_bytes())
        mapping = {"raw_04.rar": {"001.jpg": page(), "002.jpg": page()}}

        # Act
        with without_archive_tools(), self.fake_extraction(mapping):
            work = analysis_work([root], AUTHOR, TITLE, lambda _path: True)
            result = work(lambda **kwargs: None)

        # Assert - 変換後の ZIP が containers に載り、元の RAR は残らない
        self.assertEqual([str(root / "raw_04.zip")], result["containers"])
        # Assert - 読めるようになったので unreadable には出ない
        self.assertEqual([], result["unreadable"])
        self.assertEqual(
            ["[著者] 作品 第004巻.zip"],
            [book["output_name"] for book in result["books"]],
        )

    def test_a_normal_zip_is_not_touched(self):
        """読める ZIP には変換を試みない。ファイルも書き換えない"""
        # Arrange
        root = self.work_dir / "蔵書"
        healthy = zip_with(root / "raw_04.zip", pages())
        before_bytes = healthy.read_bytes()
        before_mtime_ns = healthy.stat().st_mtime_ns

        # Act - 呼ばれたら即座に分かるよう、変換そのものを落とし穴にする
        with mock.patch.object(
            toc_analyzer,
            "_rescue_unreadable",
            side_effect=AssertionError("読める ZIP まで変換しようとした"),
        ):
            books = self.analyze(root)

        # Assert
        self.assertEqual(
            ["[著者] 作品 第004巻.zip"], [book.output_name for book in books]
        )
        self.assertEqual(before_bytes, healthy.read_bytes(), "ZIP の中身が変わった")
        self.assertEqual(
            before_mtime_ns, healthy.stat().st_mtime_ns, "ZIP が書き直された"
        )

    def test_a_password_required_rar_stays_unreadable_without_a_tool(self):
        """展開にも道具が要る書庫は、道具が無ければ変換できず、変換前と同じ
        「目次を読めません」のまま残ること。嘘の予告は出さない。
        """
        # Arrange - 本物の、目次ごと暗号化された RAR。鍵が無いので展開にも
        # 必ず道具（と鍵）が要る。偽の展開は差し替えない
        from test_toc_rar_7z import REAL_RAR3_WITH_ENCRYPTED_HEADER

        root = self.work_dir / "蔵書"
        root.mkdir(parents=True)
        locked = root / "施錠_02.rar"
        locked.write_bytes(REAL_RAR3_WITH_ENCRYPTED_HEADER.read_bytes())

        # Act
        with without_archive_tools():
            work = analysis_work([root], AUTHOR, TITLE, lambda _path: True)
            result = work(lambda **kwargs: None)

        # Assert - 変換を試みても展開できないので、読めないままで残る
        self.assertEqual([str(locked)], result["containers"])
        self.assertEqual(
            [str(locked)],
            [item["source"] for item in result["unreadable"]],
        )
        self.assertEqual([], result["books"])
        self.assertTrue(locked.exists(), "展開できないのに元のファイルが消えた")


if __name__ == "__main__":
    unittest.main()
