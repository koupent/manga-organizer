#!/usr/bin/env bash
set -Eeuo pipefail

# Windows 向け成果物の作成。
#
# 旧 Tkinter アプリを PyInstaller で単一 exe にする経路は #28 で撤去済み。
# 現在の構成は Tauri シェル + Python サイドカーで、これを 1 つのインストーラへ
# まとめる実装はまだ無い。
#
# ここで黙って何かを作ると、配信の各段（digest 照合、prerelease、製品 Release）
# が古い前提のまま進んでしまう。未実装であることを明示して止める。

cat >&2 <<'MESSAGE'
Windows 向け成果物のビルドは未実装です。

  旧 PyInstaller 経路（manga-organizer/MangaOrganizer.spec）は撤去済みです。
  現在の構成は Tauri シェル + Python サイドカーで、サイドカー単体の梱包は
  scripts/build_sidecar.sh にありますが、インストーラへまとめる処理は
  まだありません。
MESSAGE
exit 1
