#!/usr/bin/env bash
set -euo pipefail

# **SSH ホスト鍵は volume 側に置き、無いときだけ作る。**イメージに焼くと作り直す
# たびに鍵が変わり、Orca がピン留めした鍵と食い違って接続できなくなる。
key_dir=/etc/ssh/host_keys
mkdir -p "$key_dir"
chmod 755 "$key_dir"
for type in ed25519 rsa ecdsa; do
  key="$key_dir/ssh_host_${type}_key"
  if [[ ! -f "$key" ]]; then
    echo "ホスト鍵がないので生成します: $key" >&2
    ssh-keygen -q -t "$type" -N '' -f "$key"
  fi
  chmod 600 "$key"
  chmod 644 "$key.pub"
done

# 認証とセッションの volume を node が書ける状態にする。イメージ側にマウント先が
# 無いと Docker は root 所有で volume を作るため、そのままでは gh / Claude Code /
# Codex が保存できない。
for dir in \
  /home/node/.claude \
  /home/node/.codex \
  /home/node/.config/gh \
  /home/node/.config/git; do
  mkdir -p "$dir"
  chown -R node:node "$dir"
done
chown node:node /home/node/.config

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

# 対話シェル向け。非対話は /etc/environment が PATH と各 CLI の設定先を渡す。
profile=/home/node/.bashrc
marker='# manga-organizer-path'
if ! grep -qF "$marker" "$profile" 2>/dev/null; then
  cat >> "$profile" <<EOF

$marker
export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH"
cd /workspace/manga-organizer 2>/dev/null || true
EOF
  chown node:node "$profile"
fi

exec /usr/sbin/sshd -D -e
