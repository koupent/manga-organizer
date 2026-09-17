#!/usr/bin/env bash
set -euo pipefail

# compose がマウントする公開鍵を sshd が読む場所へ置く。
# ファイルが無い／空のときは警告だけ出して起動する（ビルド検証用）。
auth_src=/etc/ssh/authorized_keys.host
auth_dst=/home/node/.ssh/authorized_keys

mkdir -p /home/node/.ssh
chmod 700 /home/node/.ssh

if [[ -f "$auth_src" && -s "$auth_src" ]]; then
  cp "$auth_src" "$auth_dst"
  chown node:node "$auth_dst"
  chmod 600 "$auth_dst"
else
  echo "warning: $auth_src が無いまたは空です。SSH 鍵認証は通りません。" >&2
  echo "  docker/authorized_keys.example を docker/authorized_keys にコピーし、公開鍵を書いてください。" >&2
fi

# 対話シェル向け。非対話は /etc/environment が PATH を渡す。
profile=/home/node/.bashrc
marker='# manga-organizer-path'
if ! grep -qF "$marker" "$profile" 2>/dev/null; then
  cat >> "$profile" <<EOF

$marker
export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH"
cd /workspace 2>/dev/null || true
EOF
  chown node:node "$profile"
fi

exec /usr/sbin/sshd -D -e
