# 公式のClaude Code DevContainerのベースを使用
FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# rootユーザーに切り替え、Playwright、noVNC、GUIアプリケーションの依存関係をインストール
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
  # 開発・ネットワーク CLI
  git gh jq wget curl ca-certificates \
  # シェル・UX
  zsh fzf man-db less \
  # エディタ
  nano vim \
  # アーカイブ・暗号
  unzip gnupg2 \
  # システム管理
  procps sudo \
  # ロケール・フォント
  locales fonts-noto-cjk fonts-ipafont-gothic \
  # GUI ランタイム（ブラウザ依存）
  libgtk-3-0 libnotify4 libnss3 libxss1 libasound2 libxkbcommon0 \
  # 仮想ディスプレイ・WM
  xvfb fluxbox feh \
  # VNC/リモートデスクトップ
  x11vnc novnc websockify \
  # プロセス管理
  supervisor \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Generate locales and set defaults to C.UTF-8
RUN sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
  && sed -i 's/^# *C.UTF-8/C.UTF-8/' /etc/locale.gen \
  && locale-gen en_US.UTF-8 C.UTF-8 \
  && update-locale LANG=C.UTF-8 LC_ALL=C.UTF-8

# nodeユーザーにパスワードなしのsudo権限を付与
RUN echo "node ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/node-user \
    && chmod 0440 /etc/sudoers.d/node-user

# npm globalパッケージのインストール先を確保
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# bash履歴の永続化
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# 環境変数を設定
ENV DEVCONTAINER=true

# ワークスペースと設定ディレクトリを作成し、パーミッションを設定
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

# git-deltaをインストール
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# 非rootユーザーに切り替え
USER node

# Create per-user config directories with safe permissions (simplified)
RUN mkdir -p "$HOME/.config" "$HOME/.config/gh" && \
  chmod 700 "$HOME/.config" "$HOME/.config/gh"

# グローバルパッケージのインストール
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# デフォルトシェルをzshに設定
ENV SHELL=/bin/zsh

# デフォルトエディタを設定
ENV EDITOR=nano
ENV VISUAL=nano

# powerline10kテーマを設定
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# ClaudeCodeをインストール
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Playwrightブラウザをインストール (nodeユーザーとして)
RUN npx playwright install chrome

# uv を node ユーザー環境にインストール
RUN wget -qO- https://astral.sh/uv/install.sh | sh

# uv のバイナリパスを PATH に追加
ENV PATH=/home/node/.local/bin:$PATH
