#!/usr/bin/env bash
# Dev Container 内で公式 Plugin / ECC を固定 SHA から導入する。
set -Eeuo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

lock_file="$repo_root/.engineering-workflow/workflow-plugin.lock.json"
if [[ ! -f "$lock_file" ]]; then
  echo "workflow-plugin.lock.json がありません" >&2
  exit 1
fi

if ! command -v claude >/dev/null; then
  echo "claude CLI が必要です。Dev Container 内で実行してください" >&2
  exit 1
fi

read_lock() {
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const path = process.argv[2].split('.');
let value = lock;
for (const key of path) value = value?.[key];
if (typeof value !== 'string' || !value) process.exit(2);
process.stdout.write(value);
" "$lock_file" "$1"
}

plugin_commit=$(read_lock commit)
plugin_repo=$(read_lock repository)
ecc_commit=$(read_lock ecc.commit)
ecc_repo=$(read_lock ecc.repository)

cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/manga-organizer-workflow"
plugin_root="$cache_root/workflow-plugin/$plugin_commit"
ecc_root="$cache_root/ecc/$ecc_commit"

checkout() {
  local repo=$1 commit=$2 dest=$3
  if [[ -d "$dest/.git" ]]; then
    git -C "$dest" fetch --depth 1 origin "$commit"
    git -C "$dest" checkout --detach "$commit"
  else
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    git clone --filter=blob:none --no-checkout "$repo" "$dest"
    git -C "$dest" checkout --detach "$commit"
  fi
  local actual
  actual=$(git -C "$dest" rev-parse HEAD)
  if [[ "$actual" != "$commit" ]]; then
    echo "commit mismatch at $dest: expected $commit got $actual" >&2
    exit 1
  fi
}

checkout "$plugin_repo" "$plugin_commit" "$plugin_root"
checkout "$ecc_repo" "$ecc_commit" "$ecc_root"

node "$plugin_root/scripts/install-project.mjs" \
  --project-dir "$repo_root" \
  --ecc-root "$ecc_root" \
  --workflow-root "$plugin_root"

node "$plugin_root/scripts/configure-project.mjs" \
  --project-dir "$repo_root" \
  --ecc-root "$ecc_root" \
  --workflow-root "$plugin_root" \
  --rule-pack python

echo "workflow install complete"
