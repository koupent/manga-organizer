#!/usr/bin/env bash
# 直前のコミットから、今回のコミットまでの差分が版の番号だけかを返す。
#
# 標準出力は full（ソースも変わった。検査を全部回す）か
# version（版の番号だけ。重い検査は直前の成功に任せる）のどちらか。
# 判断できないとき（履歴が無い、force-push で祖先でない、
# 合流先の main が前回の検査のあと進んだ）は full。
# 検査を省く側に倒さない。
set -Eeuo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <before-sha> <head-sha> [base-sha]" >&2
  exit 2
fi

before=$1
head=$2
base=${3:-}
zero=0000000000000000000000000000000000000000

say() {
  printf '%s\n' "$1"
  exit 0
}

[[ "$head" =~ ^[0-9a-f]{40}$ ]] || say full
[[ "$before" =~ ^[0-9a-f]{40}$ && "$before" != "$zero" ]] || say full

cd "$(git rev-parse --show-toplevel)"
git cat-file -e "$before^{commit}" 2>/dev/null || say full
git cat-file -e "$head^{commit}" 2>/dev/null || say full
git merge-base --is-ancestor "$before" "$head" || say full
# 合流先が進んでいると、前回の成功は今の main との組み合わせを見ていない
if [[ -n "$base" ]]; then
  [[ "$base" =~ ^[0-9a-f]{40}$ && "$base" != "$zero" ]] || say full
  git cat-file -e "$base^{commit}" 2>/dev/null || say full
  git merge-base --is-ancestor "$base" "$before" || say full
fi

# 版の宣言と、その宣言を写した lock だけ。依存の追加はここには入らない。
allowed=(
  apps/desktop/package.json
  apps/desktop/package-lock.json
  apps/desktop/src-tauri/tauri.conf.json
  apps/desktop/src-tauri/Cargo.toml
  apps/desktop/src-tauri/Cargo.lock
  services/core/pyproject.toml
  services/core/uv.lock
)

is_allowed() {
  local path=$1
  local candidate
  for candidate in "${allowed[@]}"; do
    [[ "$path" == "$candidate" ]] && return 0
  done
  return 1
}

mapfile -t entries < <(git diff --name-status --no-renames "$before" "$head")
if [[ ${#entries[@]} -eq 0 ]]; then
  say version
fi

for entry in "${entries[@]}"; do
  status=${entry%%$'\t'*}
  path=${entry#*$'\t'}
  [[ "$status" == "M" ]] || say full
  is_allowed "$path" || say full
done

# 変わった行が、すべて同じ旧版から同じ新版への置き換えであること。
# 依存の版だけが 1 行変わった場合も、旧版と新版が 1 組なら数の上では通る。
# そのときはファイルが上の一覧に無いので、先に full になる。
json_version_re='^[[:space:]]*"version": "([0-9]+\.[0-9]+\.[0-9]+)",?[[:space:]]*$'
toml_version_re='^version = "([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*$'
old_version=
new_version=
while IFS= read -r line; do
  case "$line" in
    "diff "*|"index "*|"--- "*|"+++ "*|"@@"*) continue ;;
    "-"*)
      body=${line#-}
      ;;
    "+"*)
      body=${line#+}
      ;;
    *)
      say full
      ;;
  esac
  if [[ "$body" =~ $json_version_re ]]; then
    found=${BASH_REMATCH[1]}
  elif [[ "$body" =~ $toml_version_re ]]; then
    found=${BASH_REMATCH[1]}
  else
    say full
  fi
  if [[ "$line" == -* ]]; then
    if [[ -n "$old_version" && "$old_version" != "$found" ]]; then
      say full
    fi
    old_version=$found
  else
    if [[ -n "$new_version" && "$new_version" != "$found" ]]; then
      say full
    fi
    new_version=$found
  fi
done < <(git diff -U0 --no-renames "$before" "$head" -- "${allowed[@]}")

[[ -n "$old_version" && -n "$new_version" && "$old_version" != "$new_version" ]] || say full
say version
