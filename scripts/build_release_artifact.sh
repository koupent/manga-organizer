#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    ;;
  *)
    if [[ "${OS:-}" != "Windows_NT" ]]; then
      echo "Windows exe のビルドは Windows ホストでのみ実行できます" >&2
      exit 1
    fi
    ;;
esac

app_dir="$repo_root/manga-organizer"
if [[ ! -f "$app_dir/MangaOrganizer.spec" ]]; then
  echo "MangaOrganizer.spec が見つかりません" >&2
  exit 1
fi

mkdir -p "$repo_root/.artifacts"
rm -f "$repo_root/.artifacts/MangaOrganizer.exe"

cd "$app_dir"
command -v uv >/dev/null || {
  echo "uv が必要です" >&2
  exit 1
}

rm -rf build dist
uv run pyinstaller MangaOrganizer.spec

version=$(uv run python -c "import sys; sys.path.insert(0, 'src'); from __version__ import __version__; print(__version__)")
built="$app_dir/dist/MangaOrganizer-v${version}.exe"
if [[ ! -f "$built" ]]; then
  echo "ビルド成果物が見つかりません: $built" >&2
  exit 1
fi

cp "$built" "$repo_root/.artifacts/MangaOrganizer.exe"
echo "artifact: $repo_root/.artifacts/MangaOrganizer.exe"
