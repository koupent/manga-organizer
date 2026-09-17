#!/usr/bin/env bash
# 常駐開発コンテナを起動する（Orca SSH 用）
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

auth_file="$repo_root/docker/authorized_keys"
if [[ ! -f "$auth_file" ]]; then
  echo "docker/authorized_keys がありません。" >&2
  echo "  cp docker/authorized_keys.example docker/authorized_keys" >&2
  echo "  に ~/.ssh/id_manga_organaizer_orca.pub を追記してから再実行してください。" >&2
  exit 1
fi
if [[ ! -s "$auth_file" ]] || ! grep -qvE '^\s*(#|$)' "$auth_file"; then
  echo "docker/authorized_keys に公開鍵（コメント以外の行）がありません。" >&2
  exit 1
fi

docker compose -f docker/compose.yaml up -d --build

echo
echo "起動しました。Orca の Settings → SSH に次を登録してください。"
echo "  Host: 127.0.0.1"
echo "  Port: 2223"
echo "  User: node"
echo "  IdentityFile: ~/.ssh/id_manga_organaizer_orca"
echo
echo "接続確認: ssh -p 2223 -i ~/.ssh/id_manga_organaizer_orca node@127.0.0.1"
echo "初回依存同期（SSH 先で）: bash scripts/dev-setup.sh"
