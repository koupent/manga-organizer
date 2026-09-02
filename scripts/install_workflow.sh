#!/usr/bin/env bash
# Dev Container 内で公式 Plugin / ECC を固定 SHA から導入する。
#
# - checkout は Claude 設定 volume 配下へ置く（再ビルドで marketplace が切れない）
# - Claude の install cache は git 無しコピーになるため、固定 checkout への symlink に差し替え
#   SessionStart の provenance 検証（git commit 解決）が通るようにする
# - v0.15.0 以降は pin の pluginRoot と installPath の symlink 差分を同一視する
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

if ! command -v node >/dev/null; then
  echo "node が必要です。Dev Container 内で実行してください" >&2
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

claude_home=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
store_root="${ENGINEERING_WORKFLOW_STORE_ROOT:-$claude_home/engineering-workflow}"
plugin_root="${ENGINEERING_WORKFLOW_SOURCE_DIR:-$store_root/workflow-plugin/$plugin_commit}"
ecc_root="${ENGINEERING_ECC_SOURCE_DIR:-$store_root/ecc/$ecc_commit}"

checkout() {
  local repo=$1 commit=$2 dest=$3
  if [[ -n "${ENGINEERING_WORKFLOW_SOURCE_DIR:-}" && "$dest" == "$ENGINEERING_WORKFLOW_SOURCE_DIR" ]]; then
    :
  elif [[ -n "${ENGINEERING_ECC_SOURCE_DIR:-}" && "$dest" == "$ENGINEERING_ECC_SOURCE_DIR" ]]; then
    :
  elif [[ -d "$dest/.git" ]]; then
    git -C "$dest" fetch --depth 1 origin "$commit"
    git -C "$dest" checkout --detach "$commit"
  else
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      gh repo clone "$repo" "$dest" -- --filter=blob:none --no-checkout
    else
      git clone --filter=blob:none --no-checkout "$repo" "$dest"
    fi
    git -C "$dest" checkout --detach "$commit"
  fi
  local actual
  actual=$(git -C "$dest" rev-parse HEAD)
  if [[ "$actual" != "$commit" ]]; then
    echo "commit mismatch at $dest: expected $commit got $actual" >&2
    exit 1
  fi
}

find_install_path() {
  local plugin_id=$1
  node --input-type=module -e "
import { spawnSync } from 'node:child_process';
const result = spawnSync('claude', ['plugin', 'list', '--json'], {
  encoding: 'utf8',
  cwd: process.argv[1],
});
if (result.status !== 0) process.exit(1);
const installed = JSON.parse(result.stdout || '[]');
const projectDir = process.argv[1];
const pluginId = process.argv[2];
const match = installed.find((item) => item.id === pluginId
  && item.scope === 'project'
  && String(item.projectPath || '') === projectDir);
if (!match?.installPath) process.exit(2);
process.stdout.write(match.installPath);
" "$repo_root" "$plugin_id"
}

link_install_to_checkout() {
  local install_path=$1
  local checkout=$2
  mkdir -p "$(dirname "$install_path")"
  rm -rf "$install_path"
  ln -s "$checkout" "$install_path"
}

checkout "$plugin_repo" "$plugin_commit" "$plugin_root"
checkout "$ecc_repo" "$ecc_commit" "$ecc_root"

node "$plugin_root/scripts/install-project.mjs" \
  --project-dir "$repo_root" \
  --ecc-root "$ecc_root" \
  --workflow-root "$plugin_root"

plugin_install_path=$(find_install_path "engineering-workflow-plugin@engineering-workflow")
link_install_to_checkout "$plugin_install_path" "$plugin_root"

node "$plugin_root/scripts/configure-project.mjs" \
  --project-dir "$repo_root" \
  --ecc-root "$ecc_root" \
  --workflow-root "$plugin_root" \
  --rule-pack python

claude plugin enable ecc@ecc --scope project >/dev/null || true
claude plugin enable engineering-workflow-plugin@engineering-workflow --scope project >/dev/null || true

echo "workflow install complete"
echo "plugin_root=$plugin_root"
echo "plugin_install_path=$plugin_install_path"
echo "ecc_root=$ecc_root"
