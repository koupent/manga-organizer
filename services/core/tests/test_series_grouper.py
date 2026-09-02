"""作品単位のグルーピング推定を検証する。

自動推定は必ず外れるので、後から人が直せることが前提。ここで保証するのは
「よくある命名なら妥当な初期案を出す」ことと「外したときに壊れない」こと。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.series_grouper import (  # noqa: E402
    SeriesGroup,
    estimate_series,
    series_key,
    strip_volume_marker,
)


def names_to_paths(names: list[str]) -> list[Path]:
    """テスト用にファイル名をパスへ直す"""
    return [Path("/library") / name for name in names]


class StripVolumeMarkerTest(unittest.TestCase):
    def test_removes_japanese_volume_markers(self):
        for name, expected in (
            ("ワンピース 第01巻", "ワンピース"),
            ("ワンピース 1巻", "ワンピース"),
            ("ワンピース　第100巻", "ワンピース"),
        ):
            with self.subTest(name=name):
                self.assertEqual(expected, strip_volume_marker(name))

    def test_removes_western_volume_markers(self):
        for name, expected in (
            ("Berserk vol.12", "Berserk"),
            ("Berserk v12", "Berserk"),
            ("Berserk Vol 12", "Berserk"),
            ("Berserk #12", "Berserk"),
        ):
            with self.subTest(name=name):
                self.assertEqual(expected, strip_volume_marker(name))

    def test_removes_a_trailing_bare_number(self):
        self.assertEqual("進撃の巨人", strip_volume_marker("進撃の巨人 03"))
        self.assertEqual("進撃の巨人", strip_volume_marker("進撃の巨人_03"))

    def test_keeps_a_number_that_belongs_to_the_title(self):
        # 末尾ではないので巻数ではない
        self.assertEqual("20世紀少年", strip_volume_marker("20世紀少年"))
        self.assertEqual("AKIRA", strip_volume_marker("AKIRA"))

    def test_keeps_the_title_when_there_is_no_marker(self):
        self.assertEqual("よつばと", strip_volume_marker("よつばと"))


class SeriesKeyTest(unittest.TestCase):
    def test_ignores_bracketed_metadata(self):
        # 作者名やタグの有無で別作品にしない
        self.assertEqual(
            series_key("[尾田栄一郎] ワンピース 第01巻"),
            series_key("ワンピース 第02巻"),
        )

    def test_ignores_separators_and_case(self):
        self.assertEqual(series_key("One_Piece v01"), series_key("one piece vol.2"))

    def test_distinguishes_different_titles(self):
        self.assertNotEqual(
            series_key("ワンピース 第01巻"), series_key("ナルト 第01巻")
        )


class EstimateSeriesTest(unittest.TestCase):
    def test_groups_volumes_of_the_same_work(self):
        # Arrange
        paths = names_to_paths(
            [
                "ワンピース 第01巻.zip",
                "ワンピース 第02巻.zip",
                "ワンピース 第10巻.zip",
                "ナルト 第01巻.zip",
            ]
        )

        # Act
        groups = estimate_series(paths)

        # Assert
        self.assertEqual(2, len(groups))
        titles = sorted(group.title for group in groups)
        self.assertEqual(["ナルト", "ワンピース"], titles)
        one_piece = next(g for g in groups if g.title == "ワンピース")
        self.assertEqual([1, 2, 10], [v.volume for v in one_piece.volumes])

    def test_orders_volumes_numerically(self):
        # Arrange - 辞書順では 10 が 2 より前に来てしまう
        paths = names_to_paths(["作品 第10巻.zip", "作品 第2巻.zip", "作品 第1巻.zip"])

        # Act
        groups = estimate_series(paths)

        # Assert
        self.assertEqual([1, 2, 10], [v.volume for v in groups[0].volumes])

    def test_groups_despite_differing_author_tags(self):
        # Arrange - 同じ作品でもタグの付き方が揃っていないことが多い
        paths = names_to_paths(
            [
                "[尾田栄一郎] ワンピース v01.zip",
                "ワンピース v02.zip",
                "ワンピース_03.zip",
            ]
        )

        # Act
        groups = estimate_series(paths)

        # Assert
        self.assertEqual(1, len(groups))
        self.assertEqual([1, 2, 3], [v.volume for v in groups[0].volumes])

    def test_keeps_a_single_volume_work_as_its_own_group(self):
        # Arrange
        paths = names_to_paths(["よつばと.zip", "ワンピース 第01巻.zip"])

        # Act
        groups = estimate_series(paths)

        # Assert
        self.assertEqual(2, len(groups))
        single = next(g for g in groups if g.title == "よつばと")
        self.assertEqual(1, len(single.volumes))
        self.assertIsNone(single.volumes[0].volume)

    def test_marks_duplicate_volume_numbers(self):
        # Arrange - 同じ巻が二重に入っていることは実際にある
        paths = names_to_paths(["作品 第01巻.zip", "作品 第01巻 (2).zip"])

        # Act
        groups = estimate_series(paths)

        # Assert - 人が直せるよう、まとめたうえで印を付ける
        self.assertEqual(1, len(groups))
        self.assertTrue(groups[0].has_duplicate_volumes)

    def test_reports_confidence_so_the_ui_can_highlight_guesses(self):
        # Arrange
        confident = names_to_paths(["作品 第01巻.zip", "作品 第02巻.zip"])
        uncertain = names_to_paths(["scan_final_v2.zip"])

        # Act / Assert
        self.assertGreater(
            estimate_series(confident)[0].confidence,
            estimate_series(uncertain)[0].confidence,
        )

    def test_returns_nothing_for_an_empty_input(self):
        self.assertEqual([], estimate_series([]))

    def test_groups_are_ordered_by_title(self):
        # Arrange
        paths = names_to_paths(["ワンピース 第01巻.zip", "あずまんが 第01巻.zip"])

        # Act
        groups = estimate_series(paths)

        # Assert
        self.assertEqual(["あずまんが", "ワンピース"], [g.title for g in groups])

    def test_group_is_serialisable_for_the_api(self):
        # Arrange
        groups = estimate_series(names_to_paths(["作品 第01巻.zip"]))

        # Act
        payload = groups[0].to_dict()

        # Assert
        self.assertEqual("作品", payload["title"])
        self.assertEqual(1, payload["volumes"][0]["volume"])
        self.assertIn("path", payload["volumes"][0])
        self.assertIsInstance(groups[0], SeriesGroup)


if __name__ == "__main__":
    unittest.main()
