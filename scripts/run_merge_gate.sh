#!/usr/bin/env bash
set -Eeuo pipefail

publish_status=false
gh_bin=${GH_BIN:-gh}
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

case "${1:-}" in
  "") ;;
  --publish-status) publish_status=true ;;
  *)
    echo "Usage: $0 [--publish-status]" >&2
    exit 2
    ;;
esac

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
status_context="Local Merge Gate"
status_pending=false
repo_slug=""

resolve_repo_slug() {
  if [[ -n "${CI_GATE_REPO_SLUG:-}" ]]; then
    repo_slug=$CI_GATE_REPO_SLUG
  else
    local remote_url
    remote_url=$(project_git remote get-url origin)
    case "$remote_url" in
      https://github.com/*) repo_slug=${remote_url#https://github.com/} ;;
      git@github.com:*) repo_slug=${remote_url#git@github.com:} ;;
      ssh://git@github.com/*) repo_slug=${remote_url#ssh://git@github.com/} ;;
      *)
        echo "GitHubリポジトリを特定できません。CI_GATE_REPO_SLUGを指定してください" >&2
        return 1
        ;;
    esac
    repo_slug=${repo_slug%.git}
  fi
  if [[ ! "$repo_slug" =~ ^[^/]+/[^/]+$ ]]; then
    echo "CI_GATE_REPO_SLUGは owner/repository 形式にしてください" >&2
    return 1
  fi
}

post_status() {
  local state=$1
  local description=$2
  "$gh_bin" api --method POST "repos/$repo_slug/statuses/$head_sha" \
    -f "state=$state" \
    -f "context=$status_context" \
    -f "description=$description" >/dev/null
}

command_available() {
  local candidate=$1
  if [[ "$candidate" == */* ]]; then
    [[ -x "$candidate" ]]
  else
    command -v "$candidate" >/dev/null
  fi
}

finish_status() {
  local exit_code=$?
  if [[ "$publish_status" == true && "$status_pending" == true && $exit_code -ne 0 ]]; then
    post_status failure "ローカルマージゲートに失敗しました" || true
  fi
  exit "$exit_code"
}
trap finish_status EXIT

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

if [[ "$publish_status" == true ]]; then
  command_available "$gh_bin" || {
    echo "ghコマンドが必要です" >&2
    exit 1
  }
  "$gh_bin" auth status >/dev/null
  project_git fetch origin main:refs/remotes/origin/main --no-tags
  if ! project_git merge-base --is-ancestor origin/main "$head_sha"; then
    echo "最新のorigin/mainを取り込んでから再実行してください" >&2
    exit 1
  fi
  resolve_repo_slug
  post_status pending "ローカルマージゲートを実行中です"
  status_pending=true
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
  # 飛ばさない。検査していないものを合格として公開しないため、cargo が
  # 無ければ環境の不備として落とす
  command_available cargo || {
    echo "cargo が必要です。Dev Container を再作成してください" >&2
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

if [[ "$publish_status" == true ]]; then
  post_status success "ローカルマージゲートに合格しました"
  status_pending=false
fi

echo "Local Merge Gate passed: $head_sha"
