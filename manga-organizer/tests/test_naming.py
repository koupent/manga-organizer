"""自然順ソートのキー生成を検証する"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from utils.naming import natural_sort_key  # noqa: E402


class NaturalSortKeyTest(unittest.TestCase):
    def test_orders_numbers_numerically_not_lexically(self):
        # Arrange
        names = ["10.jpg", "2.jpg", "1.jpg"]

        # Act
        ordered = sorted(names, key=natural_sort_key)

        # Assert
        self.assertEqual(["1.jpg", "2.jpg", "10.jpg"], ordered)

    def test_sorts_names_that_start_with_a_number_and_with_a_letter(self):
        # Arrange - 数字始まりと文字始まりが混在すると int と str を比較していた
        names = ["cover.jpg", "001.jpg", "010.jpg", "back.jpg", "2.jpg"]

        # Act
        ordered = sorted(names, key=natural_sort_key)

        # Assert - 数値が先、その後は文字列順
        self.assertEqual(
            ["001.jpg", "2.jpg", "010.jpg", "back.jpg", "cover.jpg"], ordered
        )

    def test_sorts_bare_filenames_from_the_archive_list(self):
        # Arrange - SortableListbox は Path.name（裸のファイル名）を渡す
        names = [Path("/in/cover.zip").name, Path("/in/001.zip").name]

        # Act / Assert - 例外を出さずに並ぶこと
        self.assertEqual(["001.zip", "cover.zip"], sorted(names, key=natural_sort_key))

    def test_ignores_letter_case(self):
        # Arrange
        names = ["B2.jpg", "a10.jpg", "A2.jpg"]

        # Act
        ordered = sorted(names, key=natural_sort_key)

        # Assert
        self.assertEqual(["A2.jpg", "a10.jpg", "B2.jpg"], ordered)

    def test_keeps_multi_segment_numbering_in_order(self):
        # Arrange
        names = ["vol2-p10.jpg", "vol10-p1.jpg", "vol2-p2.jpg"]

        # Act
        ordered = sorted(names, key=natural_sort_key)

        # Assert
        self.assertEqual(["vol2-p2.jpg", "vol2-p10.jpg", "vol10-p1.jpg"], ordered)

    def test_handles_digit_like_characters_that_are_not_decimals(self):
        # Arrange - '²' は isdigit() が True だが正規表現の \d には一致しない
        names = ["\u00b23.jpg", "1.jpg"]

        # Act / Assert - int() に渡して落ちないこと
        self.assertEqual(["1.jpg", "\u00b23.jpg"], sorted(names, key=natural_sort_key))

    def test_accepts_paths_rendered_as_strings(self):
        # Arrange - ArchiveHandler は str(Path) を渡す
        paths = [str(Path("/tmp/x/10.jpg")), str(Path("/tmp/x/2.jpg"))]

        # Act
        ordered = sorted(paths, key=natural_sort_key)

        # Assert
        expected = [str(Path("/tmp/x/2.jpg")), str(Path("/tmp/x/10.jpg"))]
        self.assertEqual(expected, ordered)


if __name__ == "__main__":
    unittest.main()
