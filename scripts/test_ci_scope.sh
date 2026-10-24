#!/usr/bin/env bash
# ci_scope.sh が、版の番号だけの差分とソースの差分を取り違えないこと。
set -Eeuo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
scope=$root/scripts/ci_scope.sh
check=$root/scripts/check_versions.sh
zero=0000000000000000000000000000000000000000

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" config user.email "ci-scope@example.com"
git -C "$tmp" config user.name "ci-scope"

write_versions() {
  local version=$1
  mkdir -p "$tmp/apps/desktop/src-tauri" "$tmp/services/core"
  cat > "$tmp/apps/desktop/package.json" <<EOF
{
  "name": "manga-organizer-desktop",
  "version": "$version"
}
EOF
  cat > "$tmp/apps/desktop/package-lock.json" <<EOF
{
  "name": "manga-organizer-desktop",
  "version": "$version",
  "packages": {
    "": {
      "name": "manga-organizer-desktop",
      "version": "$version"
    }
  }
}
EOF
  cat > "$tmp/apps/desktop/src-tauri/tauri.conf.json" <<EOF
{
  "productName": "Manga Organizer",
  "version": "$version"
}
EOF
  cat > "$tmp/apps/desktop/src-tauri/Cargo.toml" <<EOF
[package]
name = "manga-organizer-desktop"
version = "$version"

[dependencies]
EOF
  cat > "$tmp/apps/desktop/src-tauri/Cargo.lock" <<EOF
[[package]]
name = "manga-organizer-desktop"
version = "$version"
EOF
  cat > "$tmp/services/core/pyproject.toml" <<EOF
[project]
name = "manga-core"
version = "$version"

[tool]
EOF
  cat > "$tmp/services/core/uv.lock" <<EOF
[[package]]
name = "manga-core"
version = "$version"
EOF
}

commit_all() {
  git -C "$tmp" add -A
  git -C "$tmp" commit -q -m "$1"
  git -C "$tmp" rev-parse HEAD
}

mkdir -p "$tmp/services/core/src"
write_versions 1.0.0
printf 'print(1)\n' > "$tmp/services/core/src/app.py"
base=$(commit_all init)

printf 'print(2)\n' >> "$tmp/services/core/src/app.py"
code=$(commit_all code)
[[ $(cd "$tmp" && bash "$scope" "$base" "$code") == full ]]

write_versions 1.0.1
ver=$(commit_all version)
[[ $(cd "$tmp" && bash "$scope" "$code" "$ver") == version ]]
# 合流先が前回のコミットの祖先なら、版だけなので省いてよい
[[ $(cd "$tmp" && bash "$scope" "$code" "$ver" "$base") == version ]]

got=$(cd "$tmp" && bash "$check")
[[ "$got" == "1.0.1" ]]
if (cd "$tmp" && bash "$check" v1.0.0 >/dev/null); then
  echo "違うタグを通してしまいました" >&2
  exit 1
fi
(cd "$tmp" && bash "$check" v1.0.1 >/dev/null)

# 依存の版だけを lock に足すと、版の番号だけの差分ではない
printf 'version = "9.9.9"\n' >> "$tmp/apps/desktop/src-tauri/Cargo.lock"
dep=$(commit_all dependency)
[[ $(cd "$tmp" && bash "$scope" "$ver" "$dep") == full ]]

[[ $(cd "$tmp" && bash "$scope" "$zero" "$ver") == full ]]

git -C "$tmp" checkout -q -b other "$base"
printf 'x\n' > "$tmp/other.txt"
other=$(commit_all other)
[[ $(cd "$tmp" && bash "$scope" "$other" "$ver") == full ]]
# 合流先が前回のコミットより進んでいたら、組み合わせを取り直す
[[ $(cd "$tmp" && bash "$scope" "$code" "$ver" "$other") == full ]]

live=$(cd "$root" && bash "$check")
[[ "$live" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]

echo "ci_scope ok"
