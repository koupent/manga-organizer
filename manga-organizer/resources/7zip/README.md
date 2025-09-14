# 7-Zip Portable Files

このディレクトリには、Windows 用の 7-Zip ポータブル版ファイルを配置します。

## 必要なファイル

以下のファイルが必要です：

- `7z.exe` - 7-Zip コマンドラインツール
- `7z.dll` - 7-Zip ライブラリ

## ダウンロード方法

1. 7-Zip 公式サイトから 7-Zip Extra をダウンロード:
   https://www.7-zip.org/download.html

2. "7-Zip Extra: standalone console version, 7z DLL, Plugin for Far Manager"
   をダウンロード（例: 7z2408-extra.7z）

3. ダウンロードしたファイルを展開

4. 以下のファイルをこのディレクトリにコピー：
   - `x64/7z.exe` → `resources/7zip/7z.exe`
   - `x64/7z.dll` → `resources/7zip/7z.dll`

## ライセンス

7-Zip は LGPL v2.1 + unRAR restriction ライセンスです。
詳細は https://www.7-zip.org/license.txt を参照してください。

## 注意事項

- GitHub に push する際は、実行ファイルは含めないでください
- ビルド時に PyInstaller が自動的にこれらのファイルをバンドルします
