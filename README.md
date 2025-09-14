# Manga Organizer

日本語漫画アーカイブを自動整理・再パッケージ化する Windows 向け GUI アプリケーション

[![Release](https://img.shields.io/github/v/release/koupent/manga-organizer)](https://github.com/koupent/manga-organizer/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 🎯 主な機能

### 📚 アーカイブ管理

- **多形式対応**: ZIP, RAR, 7z, CBZ, CBR, CB7, EPUB
- **スタンドアロン動作**: 7za.exe 内蔵で RAR 展開も外部ツール不要（v3.7.0〜）
- **ネスト処理**: アーカイブ内のアーカイブも自動展開
- **巻番号自動検出**: 第 X 巻、vol.X、vX など多様なパターンに対応
- **画像リネーム**: 001.jpg, 002.jpg...の連番に自動変換

### 🗂️ データベース機能

- 作品・作者情報の永続管理
- JSON 形式でのエクスポート/インポート
- 重複作品の自動認識

### 🌐 API 連携

- AniList/MyAnimeList 連携で作者名自動取得
- 日本語作者名優先
- API キャッシュによる高速化

### 🖥️ ユーザーインターフェース

- ドラッグ&ドロップ対応
- リアルタイム処理ログ
- 自然順ソート（1→2→10 の正しい順序）
- 完全日本語 UI

## 📥 ダウンロード

### Windows 実行ファイル（推奨）

[最新リリース](https://github.com/koupent/manga-organizer/releases/latest)から`MangaOrganizer-vX.X.X.exe`をダウンロード

**特徴:**

- インストール不要
- Python 環境不要
- 7-Zip 不要（内蔵済み）
- ダブルクリックで起動

## 🚀 使い方

### 基本的な使用手順

1. **MangaOrganizer.exe を起動**

   - ダウンロードした実行ファイルをダブルクリック

2. **作品情報を入力**

   - 作者名: 手動入力または API 自動取得
   - 作品名: 入力すると作者名候補が表示

3. **アーカイブファイルを追加**

   - ドラッグ&ドロップ
   - または「ファイル追加」ボタンから選択
   - 複数ファイル一括処理対応

4. **出力先を選択**

   - 「出力先選択」ボタンで保存先を指定

5. **処理を開始**
   - 「処理開始」ボタンをクリック
   - 進捗はログウィンドウに表示

### 出力形式

```
[作者名] 作品名/
├── [作者名] 作品名 第001巻.zip
├── [作者名] 作品名 第002巻.zip
└── [作者名] 作品名 第003巻.zip
```

各 ZIP ファイル内:

```
001.jpg  # ページ順に連番
002.jpg
003.jpg
...
```

## 🔧 高度な機能

### データベース管理

「DB 編集」ボタンから:

- 登録済み作品の編集・削除
- 新規作品の手動追加
- JSON エクスポート/インポート

### 巻番号検出ロジック

優先順位:

1. **画像ディレクトリ名**: `001/`、`chapter_05/`など
2. **アーカイブ名**: 単一ボリュームの場合のみ
3. **フォールバック**: 処理順序のインデックス

特殊判定:

- 番外編、外伝、短編などの認識
- 一時ディレクトリ名は無視

## 💻 開発者向け情報

### ソースコードから実行

#### 必要環境

- Python 3.8 以上
- Windows/macOS/Linux

#### インストール

```bash
# リポジトリをクローン
git clone https://github.com/koupent/manga-organizer.git
cd manga-organizer

# uvを使用（推奨）
pip install uv
uv sync

# または pip を使用
pip install -r requirements.txt
```

#### 実行

```bash
cd manga-organizer
python src/main.py
```

### ビルド方法

#### GitHub Actions（推奨）

タグをプッシュすると自動ビルド:

```bash
git tag v3.7.0
git push origin v3.7.0
```

#### ローカルビルド

```bash
# ビルドスクリプトを使用（推奨）
cd manga-organizer
./build.sh  # Linux/Mac/Git Bash

# または手動でビルド
uv run pyinstaller MangaOrganizer.spec
```

## 📊 処理フロー

```mermaid
flowchart TB
    Start([開始]) --> Input[作品情報入力]
    Input --> AddFiles[アーカイブ追加]
    AddFiles --> Process[処理開始]
    Process --> Extract[アーカイブ展開]
    Extract --> DetectVolume[巻番号検出]
    DetectVolume --> RenameImages[画像リネーム<br/>001.jpg, 002.jpg...]
    RenameImages --> CreateArchive[新規アーカイブ作成]
    CreateArchive --> SaveDB[DB保存]
    SaveDB --> Output[整理済みファイル出力]
    Output --> End([完了])
```

## ❓ トラブルシューティング

### よくある質問

**Q: RAR ファイルが開けない**

- A: v3.7.0 以降は 7za.exe 内蔵のため追加インストール不要です

**Q: 巻番号が正しく検出されない**

- A: ファイル名に「第 X 巻」「vol.X」などを含めてください

**Q: ウイルス対策ソフトが警告を出す**

- A: PyInstaller でビルドした exe は誤検知されることがあります。安全です。

**Q: API 連携が動作しない**

- A: インターネット接続を確認してください

### エラーが発生した場合

1. ログウィンドウのエラーメッセージを確認
2. [Issues](https://github.com/koupent/manga-organizer/issues)で既知の問題を検索
3. 新しい Issue を作成して報告

[全ての更新履歴](manga-organizer/CHANGELOG.md)

## 📄 ライセンス

MIT License - 詳細は[LICENSE](LICENSE)を参照

## 📧 サポート

- [Issues](https://github.com/koupent/manga-organizer/issues) - バグ報告・機能要望
- [Discussions](https://github.com/koupent/manga-organizer/discussions) - 質問・議論

## 🙏 謝辞

このプロジェクトは以下のライブラリを使用しています:

- [Pillow](https://python-pillow.org/) - 画像処理
- [py7zr](https://github.com/miurahr/py7zr) - 7z 形式対応
- [tkinterdnd2](https://github.com/pmgagne/tkinterdnd2) - ドラッグ&ドロップ
- [7-Zip](https://www.7-zip.org/) - アーカイブ処理
