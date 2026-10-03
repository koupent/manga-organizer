# Manga Organizer

日本語漫画アーカイブを自動整理・再パッケージ化する Windows 向け GUI アプリケーション

[![Release](https://img.shields.io/github/v/release/koupent/manga-organizer)](https://github.com/koupent/manga-organizer/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 🎯 主な機能

### 📚 アーカイブ管理

- **多形式対応**: ZIP, RAR, 7z, CBZ, CBR, CB7, EPUB
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

## 🔧 前提条件

### RAR 形式のアーカイブを扱う場合

MangaOrganizer で RAR 形式（.rar, .cbr）のファイルを処理するには、7-Zip のインストールが必要です。

#### 7-Zip のインストール方法（推奨）

1. **公式サイトからダウンロード**

   - [7-Zip 公式サイト](https://www.7-zip.org/download.html)にアクセス
   - Windows 64-bit 版（例：7z2408-x64.exe）をダウンロード

2. **インストール**

   - ダウンロードしたインストーラーを実行
   - デフォルト設定（C:\Program Files\7-Zip\）でインストール
   - 管理者権限が必要な場合があります

3. **確認**
   - インストール後、MangaOrganizer が自動的に 7-Zip を検出します
   - RAR 形式のファイルが処理できるようになります

#### 注意事項

- **ZIP, 7z, CBZ 形式**: これらの形式は 7-Zip なしで処理可能です
- **WinRAR**: 代替として[WinRAR](https://www.win-rar.com/)も使用可能ですが、有料ソフトです
- **v3.8.0 以降の変更**: セキュリティ向上のため、7za.exe のバンドルを廃止しました（Breaking Change）

## 📥 インストール

Windows 10 / 11（64 bit）向けです。インストーラは配布用のページに置いてあり、ログインせずにダウンロードできます。

1. [配布用のページ](https://github.com/koupent/manga-organizer-releases/releases/latest) の Assets から `MangaOrganizer-vX.X.X-setup.exe` をダウンロード
2. ダウンロードしたファイルを実行
   - 「Windows によって PC が保護されました」と出たら「**詳細情報**」→「**実行**」を押します（コード署名をしていないために出る警告です）
   - 管理者権限は要りません（自分のユーザーにだけ入ります）
   - 画面の部品（WebView2）が無い古い Windows では、途中で自動的に取り込みます（インターネット接続が必要）
3. スタートメニューの「Manga Organizer」から起動

**更新**: v4.1.0 からは、起動したときに新しい版があればアプリの上部に知らせが出ます。「更新する」を押すと、ダウンロードしてアプリがいったん閉じ、入れ替わってから起ち上がり直します。設定と辞書は残ります。v4.0.0 を使っている場合は、一度だけ v4.1.0 以降のインストーラを手で実行してください。

**アンインストール**: Windows の「設定」→「アプリ」→「インストールされているアプリ」から「Manga Organizer」を削除します。

### データの置き場所

`%APPDATA%\dev.koupent.manga-organizer\` に作品の辞書などの設定と、裏で動く処理の記録 `sidecar.log` を置きます。アンインストールしても残るので、要らなければ手で消してください。

## 🚀 使い方

起動すると「ファイル整理」「サムネイル作成」「ページ並べ替え」「ページ分割」の 4 つのタブがあります。ファイル整理の基本の流れ:

1. **作品情報**: 左上に作品名を入れると、著者の候補が出ます（辞書・AniList）
2. **投入したもの**: 整理したいフォルダやアーカイブをウィンドウにドラッグ&ドロップするか、「選んで追加」から辿って入れます。どのドライブでも扱えます
3. **出来上がる本**: 右に、できあがる本の名前と巻数が並びます。巻数が違うときは「第NNN巻」を押して直せます
4. **出力先**: 左下で保存先を選びます（最初に入れたものの場所が入ります）
5. 「**この内容で整理する**」を押すと、出力先に整理済みの ZIP ができます

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

## 💻 開発者向け

開発環境のセットアップ、ビルド方法、バージョンアップ手順などの詳細は [DEVELOPMENT.md](DEVELOPMENT.md) を参照してください。

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

- A: v3.8.0 以降は 7-Zip のシステムインストールが必要です。上記の[前提条件](#前提条件)セクションを参照してください

**Q: 巻番号が正しく検出されない**

- A: ファイル名に「第 X 巻」「vol.X」などを含めてください

**Q: 「Windows によって PC が保護されました」と出る／ウイルス対策ソフトが警告を出す**

- A: コード署名をしていないため、初めて実行するときに出ます。「詳細情報」→「実行」で進めてください。
  - ウイルス対策ソフトが止める場合は、インストール先（`%LOCALAPPDATA%\Manga Organizer`）を除外設定に追加してください

**Q: 起動したが「未接続」のまま、またはエラーが出る**

- A: 裏で動く処理が起動できていません。表示されたメッセージと `%APPDATA%\dev.koupent.manga-organizer\sidecar.log` を添えて Issue で知らせてください

**Q: API 連携が動作しない**

- A: インターネット接続を確認してください

### エラーが発生した場合

1. 画面のエラーメッセージと `sidecar.log`（[データの置き場所](#データの置き場所)）を確認
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
