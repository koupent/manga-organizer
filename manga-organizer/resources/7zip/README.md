# 7-Zip Portable Files

このディレクトリには、Windows 用の 7-Zip スタンドアロン版ファイルを配置します。

## 必要なファイル

以下のファイルが必要です：

- `7za.exe` - 7-Zip スタンドアロン版（DLL不要）

## ダウンロード方法

1. 7-Zip 公式サイトから 7-Zip Extra をダウンロード:
   https://www.7-zip.org/download.html

2. "7-Zip Extra: standalone console version, 7z DLL, Plugin for Far Manager"
   をダウンロード（例: 7z2501-extra.7z）

3. ダウンロードしたファイルを展開

4. 以下のファイルをこのディレクトリにコピー：
   - `7za.exe` → `resources/7zip/7za.exe`

## 7za.exe の特徴

- **スタンドアロン**: DLLファイル不要で単体動作
- **ファイルサイズ**: 約1-2MB
- **機能**: RAR展開を含む基本的なアーカイブ操作に対応
- **バンドル適合**: PyInstallerで簡単にバンドル可能

## ライセンス

7-Zip は LGPL v2.1 + unRAR restriction ライセンスです。
詳細は https://www.7-zip.org/license.txt を参照してください。

## 注意事項

- GitHub に push する際は、実行ファイルは含めないでください
- ビルド時に PyInstaller が自動的にこれらのファイルをバンドルします
