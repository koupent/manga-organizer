#!/usr/bin/env bash
# コンテナ内でアプリ依存を同期する（初回セットアップ）
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

command -v uv >/dev/null || {
  echo "uv が必要です。開発コンテナ内で実行してください（bash scripts/dev-up.sh）" >&2
  exit 1
}
command -v npm >/dev/null || {
  echo "npm が必要です。開発コンテナ内で実行してください" >&2
  exit 1
}

echo "== Python (uv sync)"
( cd "$repo_root/services/core" && uv sync --group dev )

echo "== Frontend (npm ci + Playwright Chromium)"
( cd "$repo_root/apps/desktop" && npm ci && npx playwright install --with-deps chromium )

echo "依存の同期が完了しました。"
