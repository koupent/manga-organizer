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
if [ -f "MangaOrganizer.spec" ]; then
    rm -f MangaOrganizer.spec
    echo "  - MangaOrganizer.spec を削除"
fi
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
VERSION=$(python version.py 2>/dev/null | grep "Manga Organizer v" | sed 's/Manga Organizer v//' || echo "unknown")
echo "現在のバージョン: v$VERSION"

# ビルド実行
echo "ビルドを開始します..."
EXE_NAME="MangaOrganizer-v${VERSION}"
echo "コマンド: uv run pyinstaller --onefile --noconsole --windowed --name $EXE_NAME --paths src --add-data \"data;data\" src/main.py"
echo

uv run pyinstaller --onefile --noconsole --windowed --name "$EXE_NAME" --paths src --add-data "data;data" src/main.py

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
