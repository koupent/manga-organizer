# バージョン管理ガイド

## 概要

Manga Organizer のバージョン番号は複数のファイルで管理されています。
バージョンアップ時は専用スクリプトを使用して一括更新します。

## バージョン番号が記載されているファイル

| ファイル             | 用途                    | 更新箇所                            |
| -------------------- | ----------------------- | ----------------------------------- |
| `pyproject.toml`     | Python プロジェクト設定 | `version = "X.Y.Z"`                 |
| `src/__version__.py` | メインバージョン情報    | `__version__` と `__release_date__` |
| `version.py`         | 配布用バージョン情報    | `VERSION` と `RELEASE_DATE`         |
| `CHANGELOG.md`       | リリースノート          | 手動更新が必要                      |

## バージョンアップ手順

### 1. 自動更新スクリプトを実行

```bash
# スクリプトを使用してバージョン番号を更新
python scripts/update_version.py 3.6.6
```

このスクリプトは以下を自動的に実行します：

- すべての関連ファイルのバージョン番号を更新
- リリース日を現在の日付に更新
- 更新結果を表示

### 2. CHANGELOG.md を手動更新

```markdown
## Version X.Y.Z - [簡潔なタイトル]

### Added

- 新機能の説明

### Changed

- 変更内容の説明

### Fixed

- バグ修正の説明

### Removed

- 削除された機能の説明
```

### 3. 変更をコミット

```bash
git add .
git commit -m "Release v3.6.6"
```

### 4. タグを作成（オプション）

```bash
git tag v3.6.6
git push origin v3.6.6
```

## バージョニング規則

セマンティックバージョニング（SemVer）を採用：

- **X.Y.Z** 形式
  - **X** (Major): 後方互換性のない変更
  - **Y** (Minor): 後方互換性のある機能追加
  - **Z** (Patch): バグ修正

### 例

- `3.6.5` → `3.6.6`: バグ修正
- `3.6.5` → `3.7.0`: 新機能追加
- `3.6.5` → `4.0.0`: 大規模な変更

## トラブルシューティング

### スクリプトが動作しない場合

手動で各ファイルを更新：

1. `pyproject.toml` の `version = "X.Y.Z"`
2. `src/__version__.py` の `__version__ = "X.Y.Z"`
3. `src/__version__.py` の `__release_date__ = "YYYY-MM-DD"`
4. `version.py` の `VERSION = "X.Y.Z"`
5. `version.py` の `RELEASE_DATE = "YYYY-MM-DD"`

### バージョン不整合の確認

```bash
# すべてのバージョン番号を確認
grep -r "3\.6\.[0-9]" --include="*.py" --include="*.toml" .
```

## 開発時の注意事項

- バージョン番号は必ずすべてのファイルで統一する
- リリース前に必ず CHANGELOG.md を更新する
- 重要な変更は詳細にドキュメント化する
