#!/usr/bin/env bash
# Merge Gate。PR ごとに GitHub Actions（.github/workflows/ci.yml）が回し、
# main への合流はこれの合格が条件になる。手元やクラウドのセッションでも
# 同じものを回せる（uv・npm・cargo と Tauri のビルドに要るライブラリが要る）。
set -Eeuo pipefail

project_git_dir=${CI_GATE_GIT_DIR:-${GIT_DIR:-}}
project_work_tree=${CI_GATE_WORK_TREE:-${GIT_WORK_TREE:-}}
unset GIT_DIR GIT_WORK_TREE

project_git() {
  if [[ -n "$project_git_dir" && -n "$project_work_tree" ]]; then
    git --git-dir="$project_git_dir" --work-tree="$project_work_tree" "$@"
  else
    git "$@"
  fi
}

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

if [[ -n "$project_work_tree" ]]; then
  repo_root=$project_work_tree
else
  repo_root=$(project_git rev-parse --show-toplevel 2>/dev/null) || {
    echo "Gitリポジトリ内で実行してください" >&2
    exit 2
  }
fi
cd "$repo_root"

core_dir="$repo_root/services/core"
if [[ ! -f "$core_dir/pyproject.toml" ]]; then
  echo "services/core が見つかりません" >&2
  exit 1
fi

head_sha=$(project_git rev-parse HEAD)

if [[ -n "$(project_git status --porcelain --untracked-files=normal)" ]]; then
  echo "作業ツリーをクリーンにしてから実行してください" >&2
  exit 1
fi

# ソースが .gitignore に飲み込まれていないか確かめる。
#
# git status は無視されたファイルを報告しないため、クリーン判定を通り抜ける。
# 作業ツリーにだけ存在するソースがあると、ここでの検査は通るのにコミットから
# はビルドできない状態になる（apps/desktop/src/lib/utils.ts の事例）。
# 検査対象と配布物を一致させるため、ソースの置き場に無視されたものがあれば
# 落とす。
SOURCE_DIRS=(
  apps/desktop/src
  apps/desktop/e2e
  apps/desktop/src-tauri/src
  services/core/src
  services/core/tests
  scripts
)
ignored_sources=$(
  project_git ls-files --others --ignored --exclude-standard -- "${SOURCE_DIRS[@]}" \
    | grep -vE '(^|/)(__pycache__|node_modules|dist|target|\.ruff_cache)/' \
    || true
)
if [[ -n "$ignored_sources" ]]; then
  echo "ソースの置き場に .gitignore で除外されたファイルがあります" >&2
  echo "コミットからビルドできなくなるため、追跡するか置き場所を変えてください" >&2
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    printf '  %s\n' "$(project_git check-ignore -v "$path" 2>/dev/null || echo "$path")" >&2
  done <<< "$ignored_sources"
  exit 1
fi

command -v uv >/dev/null || {
  echo "uv が必要です" >&2
  exit 1
}

run_python_checks() {
  local target=$1
  echo "== $target"
  ( cd "$repo_root/$target" \
    && uv lock --check \
    && uv run ruff check src tests \
    && uv run ruff format --check src tests \
    && uv run python -m compileall -q src \
    && uv run python -m unittest discover -s tests )
}

run_frontend_checks() {
  echo "== apps/desktop"
  command -v npm >/dev/null || {
    echo "npm が必要です" >&2
    exit 1
  }
  # lint は型検査（tsc --noEmit）と ESLint の両方を通す。react-hooks の
  # 依存配列など、過去に実際に出た欠陥を機械的に見つける側はここで落ちる
  ( cd "$repo_root/apps/desktop" \
    && npm ci --no-fund --no-audit \
    && npm run lint \
    && npm run build \
    && npx playwright test )
}

run_schema_check() {
  echo "== services/core/openapi.json"
  # 画面の型（apps/desktop/src/api/schema.ts）はこの成果物から作り、画面は
  # operationId を文字列で直に書いている。経路を変えて作り直すのを忘れると、
  # 画面は古い型のまま存在しない経路を叩き続ける。
  #
  # 黙って書き直さない。ここで直してしまうと、変えた本人が気づかないまま
  # 食い違ったスキーマがコミットされ、ゲートは合格を出す。作り直しは人がやる
  ( cd "$repo_root/services/core" \
    && uv run python scripts/export_openapi.py --check )
}

run_python_checks services/core
run_schema_check

run_shell_checks() {
  echo "== Tauri シェル"
  # 飛ばさない。検査していないものを合格にしないため、cargo が無ければ
  # 環境の不備として落とす
  command -v cargo >/dev/null || {
    echo "cargo が必要です" >&2
    return 1
  }
  ( cd "$repo_root/apps/desktop/src-tauri" \
    && cargo fmt --check \
    && cargo clippy --all-targets -- -D warnings \
    && cargo test )
}

# フロントは Tauri の WebView が読み込むものと同じ。ブラウザで駆動して検証する
run_frontend_checks
run_shell_checks

cd "$repo_root"
if [[ "$(project_git rev-parse HEAD)" != "$head_sha" ]]; then
  echo "ゲート実行中にHEADが変更されました" >&2
  exit 1
fi
if [[ -n "$(project_git status --porcelain --untracked-files=normal)" ]]; then
  echo "ゲート実行中に作業ツリーが変更されました" >&2
  exit 1
fi

echo "Merge Gate passed: $head_sha"
