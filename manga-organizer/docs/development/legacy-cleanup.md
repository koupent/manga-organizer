# レガシーコード削除記録

## Version 3.6.6 での削除内容

### 削除されたレガシー互換性コード

#### 1. VERSION フォールバック (main_window.py)

**削除前:**

```python
try:
    from __version__ import __version__ as VERSION
except ImportError:
    # Fallback if __version__.py is not found
    VERSION = "3.6.5"
```

**削除後:**

```python
from __version__ import __version__ as VERSION
```

**理由:** `__version__.py`は常に存在するため、ImportError のフォールバックは不要

#### 2. process_archive_single メソッド (archive_handler.py)

**削除内容:**

```python
def process_archive_single(
    self, archive_path: Path
) -> Tuple[Optional[Path], Optional[str]]:
    """Legacy method for backward compatibility - returns single directory"""
    dirs, error = self.process_archive(archive_path)
    if error:
        return None, error
    return dirs[0] if dirs else None, None
```

**理由:** 使用されていないレガシーメソッド。`process_archive`で代替可能

#### 3. 古いスタイルのフォーマット文字列

**変更内容:**

- `update_version.py`で`.format()`を f-string に変更

**削除前:**

```python
print("  2. Commit changes with message: 'Release v{}'".format(new_version))
```

**削除後:**

```python
print(f"  2. Commit changes with message: 'Release v{new_version}'")
```

**理由:** Python 3.6+では f-string が推奨される

### ドキュメント更新

#### version-management.md

- main_window.py の VERSION フォールバックに関する記述を削除
- ファイル数を 6 から 5 に更新

#### update_version.py

- main_window.py の更新処理を削除
- 更新対象ファイル数を 5 に削減

## 維持されたコード

### RAR 処理のフォールバック

`archive_handler.py`の RAR 処理での rarfile モジュールへのフォールバックは維持:

- 7-Zip が利用できない環境での RAR 対応に必要
- 実際の機能要件のため削除しない

## 今後の削除候補

現時点で追加のレガシーコードは検出されませんでした。
