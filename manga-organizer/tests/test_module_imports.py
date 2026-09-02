"""すべてのモジュールが import できることを確認する。

`callable | None` のように評価時に落ちる型注釈は、GUI を起動するまで気付けず
アプリ全体が起動不能になる。`compileall` は構文しか見ないため検出できない。
import できることだけでも常に検証しておく。
"""

import importlib
import sys
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))


def discover_modules() -> list[str]:
    """src/ 配下の import 可能なモジュール名を集める"""
    modules = []
    for path in sorted(SRC_ROOT.rglob("*.py")):
        parts = list(path.relative_to(SRC_ROOT).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        if parts:
            modules.append(".".join(parts))
    return modules


class ModuleImportTest(unittest.TestCase):
    def test_every_module_imports(self):
        # Arrange
        modules = discover_modules()
        self.assertGreater(len(modules), 5, "モジュールを検出できていません")

        # Act / Assert
        for name in modules:
            with self.subTest(module=name):
                importlib.import_module(name)


if __name__ == "__main__":
    unittest.main()
