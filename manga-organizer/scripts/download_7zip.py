#!/usr/bin/env python
"""
7-Zipポータブル版のダウンロードヘルパースクリプト

注意: このスクリプトは7-Zipのライセンスに従って使用してください。
7-ZipはLGPL v2.1 + unRAR restrictionライセンスです。
"""

import os
import sys
import zipfile
import urllib.request
import urllib.error
from pathlib import Path
import tempfile
import shutil

# 7-Zip Extra のURL (バージョンは適宜更新)
SEVEN_ZIP_URL = "https://www.7-zip.org/a/7z2408-extra.7z"

def download_7zip():
    """Download and extract 7-Zip portable files"""

    # プロジェクトルートを確認
    project_root = Path(__file__).parent.parent
    resources_dir = project_root / "resources" / "7zip"

    # ディレクトリを作成
    resources_dir.mkdir(parents=True, exist_ok=True)

    # 既にファイルが存在する場合はスキップ
    exe_path = resources_dir / "7z.exe"
    dll_path = resources_dir / "7z.dll"

    if exe_path.exists() and dll_path.exists():
        print("✓ 7-Zipファイルは既に存在します")
        return True

    print("7-Zip Extraのダウンロードとセットアップ")
    print("=" * 50)
    print()
    print("注意: このスクリプトは7-Zipのライセンスに従って使用してください。")
    print("7-ZipはLGPL v2.1 + unRAR restrictionライセンスです。")
    print("詳細: https://www.7-zip.org/license.txt")
    print()
    print("手動でダウンロードする場合:")
    print("1. https://www.7-zip.org/download.html にアクセス")
    print("2. '7-Zip Extra' をダウンロード")
    print("3. 展開して x64/7z.exe と x64/7z.dll を resources/7zip/ にコピー")
    print()

    response = input("自動ダウンロードを続行しますか？ (y/n): ")
    if response.lower() != 'y':
        print("中止しました")
        return False

    try:
        # 一時ディレクトリにダウンロード
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            download_path = temp_path / "7z-extra.7z"

            print(f"ダウンロード中: {SEVEN_ZIP_URL}")
            urllib.request.urlretrieve(SEVEN_ZIP_URL, download_path)
            print("✓ ダウンロード完了")

            # 7zファイルの展開には7-Zipが必要なので、
            # システムに7-Zipがインストールされているか確認
            if shutil.which("7z"):
                print("システムの7-Zipを使用して展開中...")
                import subprocess
                subprocess.run(["7z", "x", str(download_path), f"-o{temp_path}"], check=True)

                # x64版のファイルをコピー
                x64_dir = temp_path / "x64"
                if x64_dir.exists():
                    shutil.copy2(x64_dir / "7z.exe", exe_path)
                    shutil.copy2(x64_dir / "7z.dll", dll_path)
                    print("✓ ファイルをコピーしました")
                    return True
                else:
                    print("エラー: x64ディレクトリが見つかりません")
                    return False
            else:
                print()
                print("エラー: システムに7-Zipがインストールされていません")
                print("手動でダウンロードしてください:")
                print("1. https://www.7-zip.org/download.html から '7-Zip Extra' をダウンロード")
                print("2. 展開して x64/7z.exe と x64/7z.dll を resources/7zip/ にコピー")
                return False

    except Exception as e:
        print(f"エラー: {e}")
        print()
        print("手動でダウンロードしてください:")
        print("1. https://www.7-zip.org/download.html から '7-Zip Extra' をダウンロード")
        print("2. 展開して x64/7z.exe と x64/7z.dll を resources/7zip/ にコピー")
        return False

if __name__ == "__main__":
    success = download_7zip()
    sys.exit(0 if success else 1)