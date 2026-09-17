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
    && ssh-keygen -A \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && echo "PermitRootLogin no" >> /etc/ssh/sshd_config

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
    && mkdir -p /home/node/.ssh /workspace \
    && chown -R node:node /home/node /workspace

USER node
WORKDIR /home/node

# uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# rustup（default profile = rustc + cargo + rustfmt + clippy）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile default

ENV PATH="/home/node/.local/bin:/home/node/.cargo/bin:${PATH}"

# 非対話 SSH（ssh host 'cmd'）でも uv / cargo が使えるようにする
USER root
RUN echo 'PATH="/home/node/.local/bin:/home/node/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
      > /etc/environment \
    && printf '%s\n' \
      'export PATH="/home/node/.local/bin:/home/node/.cargo/bin:$PATH"' \
      > /etc/profile.d/dev-tools-path.sh \
    && chmod 644 /etc/profile.d/dev-tools-path.sh

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
