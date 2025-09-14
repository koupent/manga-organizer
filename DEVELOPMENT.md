# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizerの開発者向け情報をまとめたものです。

## 📋 目次

- [バージョンアップ手順](#バージョンアップ手順)
- [開発環境のセットアップ](#開発環境のセットアップ)
- [ビルド方法](#ビルド方法)
- [リリース手順](#リリース手順)
- [プロジェクト構造](#プロジェクト構造)
- [コーディング規約](#コーディング規約)

## バージョンアップ手順

### 1. バージョン番号の更新

以下のファイルのバージョン番号を更新します：

#### `manga-organizer/src/__version__.py`
```python
__version__ = "X.Y.Z"  # 新しいバージョン番号
__release_date__ = "YYYY-MM-DD"  # リリース日
```

#### `manga-organizer/pyproject.toml`
```toml
[project]
version = "X.Y.Z"  # 新しいバージョン番号
```

### 2. CHANGELOG.mdの更新

`manga-organizer/CHANGELOG.md`に新バージョンのセクションを追加：

```markdown
## Version X.Y.Z - 簡潔な説明

### New Features / Improvements / Bug Fixes
- 変更内容の詳細
```

### 3. コミットとタグ付け

```bash
# 変更をステージング
git add -A

# バージョンアップをコミット
git commit -m "バージョンX.Y.Zリリース: 主な変更点の要約"

# タグを作成
git tag vX.Y.Z

# リモートにプッシュ
git push origin main
git push origin vX.Y.Z
```

### 4. GitHub Actionsによる自動ビルド

タグをプッシュすると、GitHub Actionsが自動的に：
1. Windows実行ファイルをビルド
2. GitHubリリースを作成
3. ビルド済みexeファイルを添付

## 開発環境のセットアップ

### 必要環境

- Python 3.8以上
- Git
- uv（推奨）またはpip

### セットアップ手順

```bash
# リポジトリをクローン
git clone https://github.com/koupent/manga-organizer.git
cd manga-organizer

# uvを使用（推奨）
pip install uv
cd manga-organizer
uv sync

# または pip を使用
cd manga-organizer
pip install -r requirements.txt
```

### 開発用実行

```bash
cd manga-organizer
python src/main.py
```

## ビルド方法

### GitHub Actions（推奨）

タグをプッシュすると自動ビルド：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

ワークフロー設定: `.github/workflows/build-release.yml`

### ローカルビルド

#### Linuxでのビルド

```bash
cd manga-organizer
./build.sh
```

#### Windowsでのビルド

```powershell
cd manga-organizer
powershell -ExecutionPolicy Bypass -File build-windows.ps1
```

#### 手動ビルド

```bash
cd manga-organizer

# PyInstallerを使用
uv run pyinstaller MangaOrganizer.spec

# または直接コマンド
uv run pyinstaller --onefile --noconsole --windowed \
    --name "MangaOrganizer-vX.Y.Z" \
    --paths src \
    --hidden-import rarfile \
    src/main.py
```

### ビルド成果物

- 出力先: `dist/MangaOrganizer-vX.Y.Z.exe`
- ファイルサイズ: 約20-30MB
- 7za.exe内蔵（RAR対応）

## リリース手順

### 1. 事前確認

- [ ] すべてのテストが通過
- [ ] CHANGELOGが更新済み
- [ ] バージョン番号が正しい
- [ ] ローカルでビルドテスト完了

### 2. リリース作成

1. バージョンタグをプッシュ（自動ビルド開始）
2. GitHub Actionsのビルド完了を確認
3. リリースページで内容を確認
4. 必要に応じてリリースノートを編集

### 3. リリース後の確認

- [ ] ダウンロードリンクの動作確認
- [ ] 実行ファイルの起動テスト
- [ ] ウイルス対策ソフトでの誤検知確認

## プロジェクト構造

```
manga-organizer/
├── src/                        # ソースコード
│   ├── __version__.py         # バージョン情報
│   ├── main.py                # エントリーポイント
│   ├── core/                  # コアロジック
│   │   ├── archive_handler.py # アーカイブ処理
│   │   ├── file_organizer.py  # ファイル整理
│   │   └── volume_detector.py # 巻番号検出
│   ├── gui/                   # GUI関連
│   │   └── main_window.py     # メインウィンドウ
│   └── api/                   # API連携
│       └── anilist_client.py  # AniList API
├── resources/                  # リソースファイル
│   └── 7zip/                  # 7za.exe配置用
├── scripts/                    # ユーティリティスクリプト
├── tests/                      # テストコード
├── docs/                       # ドキュメント
├── .github/                    # GitHub設定
│   └── workflows/             # GitHub Actions
├── build.sh                   # ビルドスクリプト（Unix）
├── MangaOrganizer.spec        # PyInstaller設定
├── pyproject.toml             # プロジェクト設定
├── CHANGELOG.md               # 変更履歴
├── README.md                  # ユーザー向けドキュメント
└── DEVELOPMENT.md             # このファイル
```

## コーディング規約

### Python コーディングスタイル

- PEP 8準拠
- 型ヒントの使用を推奨
- docstringは必須（Google スタイル）

### コミットメッセージ

形式：`<type>: <description>`

タイプ：
- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメント
- `style`: コードスタイル
- `refactor`: リファクタリング
- `test`: テスト
- `chore`: その他

例：
```
feat: RAR形式のサポートを追加
fix: 巻番号検出の不具合を修正
docs: インストール手順を更新
```

### ブランチ戦略

- `main`: メインブランチ（安定版）
- `feature/*`: 新機能開発
- `fix/*`: バグ修正
- `docs/*`: ドキュメント更新

### テスト

```bash
# テスト実行
cd manga-organizer
python -m pytest tests/

# カバレッジ測定
python -m pytest --cov=src tests/
```

## トラブルシューティング

### ビルドエラー

#### PyInstallerが見つからない
```bash
uv add pyinstaller
# または
pip install pyinstaller
```

#### 7za.exeが含まれない
1. `resources/7zip/`ディレクトリを確認
2. GitHub Actionsワークフローで自動ダウンロード
3. 手動で配置する場合は`resources/7zip/README.md`参照

### 開発環境の問題

#### tkinterが見つからない
```bash
# Ubuntu/Debian
sudo apt-get install python3-tk

# macOS
brew install python-tk

# Windows
# Pythonの再インストールが必要な場合あり
```

## 貢献方法

1. このリポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'feat: Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

### プルリクエストのガイドライン

- 1つのPRに1つの機能/修正
- テストを含める
- CHANGELOGを更新
- コミットメッセージは規約に従う

## ライセンス

MIT License - 詳細は[LICENSE](LICENSE)を参照

## 連絡先

- Issues: [GitHub Issues](https://github.com/koupent/manga-organizer/issues)
- Discussions: [GitHub Discussions](https://github.com/koupent/manga-organizer/discussions)