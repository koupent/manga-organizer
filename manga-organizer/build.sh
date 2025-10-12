#!/bin/bash

# Manga Organizer Build Script
# 使用方法: ./build.sh

set -e  # エラー時にスクリプトを停止

echo "=== Manga Organizer ビルドスクリプト ==="
echo

# 現在のディレクトリを確認
if [ ! -f "src/main.py" ]; then
    echo "エラー: src/main.py が見つかりません"
    echo "このスクリプトは manga-organizer ディレクトリで実行してください"
    exit 1
fi

# 前回のビルドファイルをクリーンアップ
echo "前回のビルドファイルをクリーンアップ中..."
if [ -d "dist" ]; then
    rm -rf dist
    echo "  - dist/ ディレクトリを削除"
fi
if [ -d "build" ]; then
    rm -rf build
    echo "  - build/ ディレクトリを削除"
fi
# Note: MangaOrganizer.spec is now version-controlled for consistent builds
# Do not delete it during cleanup
# if [ -f "MangaOrganizer.spec" ]; then
#     rm -f MangaOrganizer.spec
#     echo "  - MangaOrganizer.spec を削除"
# fi
echo "クリーンアップ完了"
echo

# PyInstallerがインストールされているか確認
echo "PyInstallerの確認中..."
if ! uv run pyinstaller --version > /dev/null 2>&1; then
    echo "PyInstallerがインストールされていません"
    echo "インストール中..."
    uv add pyinstaller
    echo "PyInstallerのインストール完了"
else
    echo "PyInstaller: $(uv run pyinstaller --version)"
fi
echo

# バージョン情報を取得
echo "バージョン情報を取得中..."
# src/__version__.pyから直接バージョンを取得
if [ -f "src/__version__.py" ]; then
    VERSION=$(python -c "import sys; sys.path.insert(0, 'src'); from __version__ import __version__; print(__version__)" 2>/dev/null || echo "3.6.1")
elif [ -f "version.py" ]; then
    # 旧version.pyからの取得（後方互換性）
    VERSION=$(python version.py 2>/dev/null | grep "Manga Organizer v" | sed 's/Manga Organizer v//' || echo "3.6.1")
else
    # ファイルが見つからない場合はデフォルト値を使用
    VERSION="3.6.1"
fi
echo "現在のバージョン: v$VERSION"

# 7-Zipファイルの確認
echo "7-Zipファイルを確認中..."
if [ -f "resources/7zip/7za.exe" ]; then
    echo "  ⚠ 7za.exe が見つかりました"
    echo "    注意: 7za.exeのバンドルは誤検知を増やす可能性があります"
    echo "    別配布を推奨します"
elif [ -f "resources/7zip/7z.exe" ] && [ -f "resources/7zip/7z.dll" ]; then
    echo "  ⚠ 7-Zipファイルが見つかりました"
    echo "    注意: 実行ファイルのバンドルは誤検知を増やす可能性があります"
else
    echo "  ✓ 7-Zipファイルは別配布されます（誤検知対策）"
    echo "    RAR対応が必要な場合は、システムに7-Zipをインストールしてください"
fi
echo

# ビルド実行
echo "ビルドを開始します..."

# specファイルが存在する場合はそれを使用、なければ従来の方法
if [ -f "MangaOrganizer.spec" ]; then
    echo "specファイルを使用してビルド（最適化設定）"
    echo "  - UPX圧縮: 無効（誤検知対策）"
    echo "  - 7za.exe: 別配布（誤検知対策）"
    echo "コマンド: uv run pyinstaller MangaOrganizer.spec"
    uv run pyinstaller MangaOrganizer.spec
else
    EXE_NAME="MangaOrganizer-v${VERSION}"
    echo "コマンド: uv run pyinstaller --onefile --noconsole --windowed --name $EXE_NAME --paths src --hidden-import rarfile src/main.py"
    echo
    echo "注意: specファイルが見つからないため、デフォルト設定でビルドします"
    echo "      誤検知対策のため、MangaOrganizer.specファイルの使用を推奨します"
    # Windows用のフラグ:
    # --noconsole: コンソールウィンドウを表示しない
    # --windowed: GUIアプリケーションとして実行
    # 注: PyInstaller v6.0以降では --win-no-prefer-redirects と --win-private-assemblies は削除されました
    # --add-data フラグは削除: 漫画データは実行時に外部から読み込む
    # --hidden-import rarfile: 条件付きインポートのrarfileを確実に含める
    uv run pyinstaller --onefile --noconsole --windowed --name "$EXE_NAME" --paths src --hidden-import rarfile src/main.py
fi

# ビルド結果の確認
if [ $? -eq 0 ]; then
    echo
    echo "=== ビルド成功！ ==="
    
    # 生成されたファイルの情報を表示
    if [ -f "dist/${EXE_NAME}.exe" ]; then
        echo "実行ファイル: dist/${EXE_NAME}.exe"
        echo "ファイルサイズ: $(du -h dist/${EXE_NAME}.exe | cut -f1)"
        echo
        echo "起動テストを実行しますか？ (y/n)"
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            echo "アプリケーションを起動中..."
            ./dist/${EXE_NAME}.exe &
            echo "アプリケーションが起動しました"
        fi
    else
        echo "警告: dist/${EXE_NAME}.exe が見つかりません"
    fi
else
    echo
    echo "=== ビルド失敗 ==="
    echo "エラーが発生しました。ログを確認してください。"
    exit 1
fi

echo
echo "ビルド完了！"
