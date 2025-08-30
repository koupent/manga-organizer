# Manga Organizer ドキュメント

## 📚 概要

Manga Organizer は、漫画ファイルの整理と管理を効率化するツールです。
タイトルと作者名の自動取得、巻番号の検出、ファイルの再パッケージング機能を提供します。

## 🚀 クイックスタート

1. タイトル欄に作品名を入力
2. 作者名が自動的に候補表示される
3. 再パッケージボタンで整理実行

## 📖 ドキュメント構成

### 機能ドキュメント（features/）

ユーザー向けの機能説明と使い方

- [`title-author-input.md`](./features/title-author-input.md) - タイトル・作者入力機能
- [`volume-detection.md`](./features/volume-detection.md) - 巻番号検出機能

### 開発ドキュメント（development/）

開発者向けの技術情報と履歴

- [`changelog.md`](./development/changelog.md) - 変更履歴
- [`improvement-history.md`](./development/improvement-history.md) - 改善の記録

## 🔍 主要機能

### タイトル・作者入力

- **リアルタイムサジェスチョン**: 入力中に候補を表示
- **データベース連携**: 過去の入力を記憶
- **API 連携**: AniList から作品情報を取得
- **日本語優先**: 作者名は日本語表記を優先

### 巻番号検出

- **複雑なパターン対応**: 「第 1 巻」「Vol.1」など多様な形式
- **特殊ケース処理**: 上下巻、特装版なども認識
- **高精度**: ファイル名とディレクトリ名から総合判定

## 💡 使い方のヒント

### 効率的な入力方法

1. タイトルは 3 文字以上入力すると API 検索が始まる
2. DB に登録済みの作品は即座に作者名が自動入力される
3. ESC キーで入力をクリアできる

### トラブルシューティング

- 作者名が表示されない → 作者欄をクリックしてフォーカスを当てる
- 候補が多すぎる → より具体的なタイトルを入力
- 日本語が文字化けする → UTF-8 エンコーディングを確認

## 🛠️ 技術スタック

- **言語**: Python 3.8+
- **GUI**: Tkinter
- **データベース**: SQLite
- **API**: AniList GraphQL API

## 📝 ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。

## 🤝 貢献

改善提案やバグ報告は[GitHub の Issues](https://github.com/yourusername/manga-organizer/issues)からお願いします。
