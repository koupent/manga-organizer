"""TitleAuthorCombo の保存処理が実在するメソッドだけを呼ぶことを確認する"""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from gui.title_author_combo import (  # noqa: E402
    SimpleTitleCombobox,
    TitleAuthorCombo,
)


def build_combo(title="ワンピース", author="尾田栄一郎"):
    """Tk ウィジェットを作らずに TitleAuthorCombo を組み立てる"""
    combo = object.__new__(TitleAuthorCombo)
    combo.database = Mock()
    # spec を付けると、実在しないメソッド呼び出しは AttributeError になる
    combo.title_combo = Mock(spec=SimpleTitleCombobox)
    combo.author_combo = Mock(spec=[])
    combo.get_title = lambda: title
    combo.get_author = lambda: author
    return combo


class SaveToDatabaseTest(unittest.TestCase):
    def test_saves_and_refreshes_the_title_dropdown(self):
        # Arrange
        combo = build_combo()

        # Act
        saved = combo.save_to_database()

        # Assert
        self.assertTrue(saved)
        combo.database.save_manga_info.assert_called_once_with(
            "ワンピース", "尾田栄一郎"
        )
        combo.title_combo.refresh_titles.assert_called_once_with()

    def test_does_not_save_when_title_or_author_is_missing(self):
        # Arrange
        combo = build_combo(title="")

        # Act
        saved = combo.save_to_database()

        # Assert
        self.assertFalse(saved)
        combo.database.save_manga_info.assert_not_called()


if __name__ == "__main__":
    unittest.main()
