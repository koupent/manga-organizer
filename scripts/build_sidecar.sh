#!/usr/bin/env bash
# Python サイドカーを PyInstaller で onedir バンドルし、Tauri の資材へ配置する。
#
# onefile ではなく onedir にする。起動のたびに展開しないぶん速く、ウイルス
# 対策ソフトの誤検知も出にくい（#4〜#7）。Tauri のインストーラが丸ごと配る
# ので、単一ファイルである必要がない。
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
core_dir="$repo_root/services/core"
target_dir="$repo_root/apps/desktop/src-tauri/resources/sidecar"

command -v uv >/dev/null || {
  echo "uv が必要です" >&2
  exit 1
}

cd "$core_dir"
uv sync --group dev --extra api
uv run pyinstaller --clean --noconfirm manga_api.spec

# 前回の資材を入れ替える（同梱物が混ざらないよう作り直す）
mkdir -p "$(dirname "$target_dir")"
if [ -d "$target_dir" ]; then find "$target_dir" -mindepth 1 -delete; fi
mkdir -p "$target_dir"
cp -r "$core_dir/dist/manga-api/." "$target_dir/"

echo "サイドカーを配置しました: $target_dir"
