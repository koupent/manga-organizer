#!/usr/bin/env bash
# 配布する版の宣言が 4 箇所で同じかを確かめる。
#
# インストーラに刻まれるのは tauri.conf.json の版。ここが食い違うと、
# 配ったアプリと更新の案内が別の版を指す。引数にタグ名を渡したときは、
# そのタグが v<版> であることも確かめる。
# 一致したら版（v なし）を標準出力へ出す。
set -Eeuo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [tag]" >&2
  exit 2
fi

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

json_version() {
  node -p "require('./$1').version"
}

version=$(json_version apps/desktop/src-tauri/tauri.conf.json)
desktop_version=$(json_version apps/desktop/package.json)
cargo_version=$(sed -n '/^\[package\]/,/^\[/{s/^version = "\([^"]*\)"$/\1/p}' apps/desktop/src-tauri/Cargo.toml)
core_version=$(sed -n '/^\[project\]/,/^\[/{s/^version = "\([^"]*\)"$/\1/p}' services/core/pyproject.toml)

echo "tauri=$version package=$desktop_version cargo=$cargo_version core=$core_version" >&2
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$desktop_version" == "$version" ]]
[[ "$cargo_version" == "$version" ]]
[[ "$core_version" == "$version" ]]

if [[ $# -eq 1 && "$1" != "v$version" ]]; then
  echo "タグ $1 はファイルの版 v$version と違います" >&2
  exit 1
fi

printf '%s\n' "$version"
