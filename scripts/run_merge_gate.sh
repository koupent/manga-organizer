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

app_dir="$repo_root/manga-organizer"
if [[ ! -f "$app_dir/pyproject.toml" ]]; then
  echo "manga-organizer/pyproject.toml が見つかりません" >&2
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

cd "$app_dir"
command -v uv >/dev/null || {
  echo "uv が必要です" >&2
  exit 1
}

uv lock --check
uv run ruff check src tests
uv run ruff format --check src tests
uv run python -m compileall -q src
uv run python -m unittest discover -s tests

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
