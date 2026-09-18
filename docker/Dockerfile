FROM ubuntu:24.04

# libwebkit2gtk 以下は Tauri シェルのビルドに要る。これが無いと
# cargo clippy / cargo test すら通らない
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      jq \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      openssh-server \
      pkg-config \
      python3 \
      python3-tk \
      sudo \
      unzip \
      wget \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && printf '%s\n' \
      'PermitRootLogin no' \
      '' \
      '# **ホスト鍵はイメージに焼かない。**焼くとリビルドのたびに鍵が変わり、Orca が' \
      '# ピン留めした鍵と食い違って、鍵交換の段階で接続できなくなる。原因が見えない' \
      '# まま「リビルドしたら繋がらない」になるので、named volume に置いて entrypoint' \
      '# が無いときだけ作る。' \
      'HostKey /etc/ssh/host_keys/ssh_host_ed25519_key' \
      'HostKey /etc/ssh/host_keys/ssh_host_rsa_key' \
      'HostKey /etc/ssh/host_keys/ssh_host_ecdsa_key' \
      >> /etc/ssh/sshd_config

# 開発ユーザー。ubuntu:24.04 は既に UID 1000 の ubuntu がいるので差し替える。
# パスワード認証は無効なので鍵だけ通す。
RUN if id -u ubuntu >/dev/null 2>&1; then \
      usermod -l node ubuntu \
      && groupmod -n node ubuntu \
      && usermod -d /home/node -m node; \
    else \
      useradd -m -s /bin/bash -u 1000 node; \
    fi \
    && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && mkdir -p /home/node/.ssh /workspace/manga-organizer \
    && chown -R node:node /home/node /workspace

USER node
WORKDIR /home/node

# **認証とセッションの置き場を 1 ディレクトリずつに集約する。**既定では
# Claude Code が ~/.claude と ~/.claude.json、git が ~/.gitconfig という具合に
# 単一ファイルを撒くが、named volume はファイル単位で当てられない。環境変数で
# ディレクトリ配下へ寄せておくと、そこへ volume を当てるだけで永続化できる。
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    CODEX_HOME=/home/node/.codex \
    GH_CONFIG_DIR=/home/node/.config/gh \
    GIT_CONFIG_GLOBAL=/home/node/.config/git/config

# uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# rustup（default profile = rustc + cargo + rustfmt + clippy）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile default

# Claude Code CLI（公式ネイティブインストーラ → ~/.local/bin）
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/node/.local/bin:/home/node/.cargo/bin:${PATH}"

# volume を当てる先をイメージ側にも作っておく。Docker が named volume を初めて
# 作るときはマウント先の中身と所有を引き継ぐので、無いと root 所有で作られて
# node が書けず、認証を保存できない。
RUN mkdir -p \
      /home/node/.claude \
      /home/node/.codex \
      /home/node/.config/gh \
      /home/node/.config/git

# Codex CLI（npm グローバル。システム Node へ入れる）
USER root
RUN npm install -g @openai/codex

# 非対話 SSH（ssh host 'cmd'）でも uv / cargo / claude が使えるようにする。
# sshd は Dockerfile の ENV を引き継がないので、PAM が読む /etc/environment と
# ログインシェルが読む profile.d の両方へ同じ内容を置く。
RUN printf '%s\n' \
      'PATH="/home/node/.local/bin:/home/node/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
      'CLAUDE_CONFIG_DIR="/home/node/.claude"' \
      'CODEX_HOME="/home/node/.codex"' \
      'GH_CONFIG_DIR="/home/node/.config/gh"' \
      'GIT_CONFIG_GLOBAL="/home/node/.config/git/config"' \
      > /etc/environment \
    && printf '%s\n' \
      'export PATH="/home/node/.local/bin:/home/node/.cargo/bin:$PATH"' \
      'export CLAUDE_CONFIG_DIR="/home/node/.claude"' \
      'export CODEX_HOME="/home/node/.codex"' \
      'export GH_CONFIG_DIR="/home/node/.config/gh"' \
      'export GIT_CONFIG_GLOBAL="/home/node/.config/git/config"' \
      > /etc/profile.d/dev-tools-path.sh \
    && chmod 644 /etc/profile.d/dev-tools-path.sh

# **bind mount した repo を、worktree と gitdir の両方で信頼する。**repo はホストから
# bind mount しているので、container の中では root 所有に見える。実行するのは node なので、
# 例外にしないと git は "dubious ownership" で止まり、**この container では git が何も
# できない。**clone のように gitdir の path で所有を見る操作があるため、.git の側も要る。
RUN git config --system --add safe.directory /workspace/manga-organizer \
    && git config --system --add safe.directory /workspace/manga-organizer/.git
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace/manga-organizer
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
