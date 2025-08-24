FROM node:20

# Set timezone argument
ARG TZ=Asia/Tokyo
ENV TZ="$TZ"

# Install necessary packages including VNC components and development tools
RUN apt-get update && apt-get install -y \
    bash \
    fluxbox \
    git \
    net-tools \
    novnc \
    supervisor \
    x11vnc \
    xterm \
    xvfb \
    python3 \
    python3-venv \
    wget \
    less \
    sudo \
    fzf \
    zsh \
    unzip \
    gnupg2 \
    gh \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright browser binaries and dependencies
RUN npx playwright install chrome
RUN npx playwright install-deps

# Install delta for better git diffs
RUN ARCH=$(dpkg --print-architecture) && \
    wget "https://github.com/dandavison/delta/releases/download/0.18.2/git-delta_0.18.2_${ARCH}.deb" && \
    dpkg -i "git-delta_0.18.2_${ARCH}.deb" && \
    rm "git-delta_0.18.2_${ARCH}.deb"

# Setup environment variables for VNC
ENV HOME=/home/node \
    DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US.UTF-8 \
    LC_ALL=C.UTF-8 \
    DISPLAY=:0.0 \
    DISPLAY_WIDTH=1600 \
    DISPLAY_HEIGHT=900 \
    RUN_XTERM=yes \
    RUN_FLUXBOX=yes \
    DEVCONTAINER=true \
    SHELL=/bin/zsh

# Ensure default node user has access to /usr/local/share and Python packages
RUN mkdir -p /usr/local/share/npm-global/lib /usr/local/share/npm-global/bin && \
    chown -R node:node /usr/local/share

# Create necessary directories including claude config and command history
RUN mkdir -p /vnc-config /workspace /home/node/.claude /commandhistory && \
    chown -R node:node /vnc-config /workspace /home/node/.claude /commandhistory

# Persist bash history
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    && touch /commandhistory/.bash_history \
    && chown -R node /commandhistory

# Copy VNC configuration files
COPY vnc-config/ /vnc-config/

# Set proper permissions
RUN chmod +x /vnc-config/*.sh && \
    chown -R node:node /vnc-config

# Switch to node user
USER node

# Install uv for Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/node/.local/bin:${PATH}"

# Install SuperClaude Framework using uv
RUN mkdir -p /home/node/.claude/SuperClaude_Framework && \
    cd /home/node/.claude/SuperClaude_Framework && \
    git clone https://github.com/SuperClaude-Org/SuperClaude_Framework.git . && \
    uv sync && \
    chown -R node:node /home/node/.claude/SuperClaude_Framework

# Ensure SuperClaude is properly configured
RUN mkdir -p /home/node/.claude/SuperClaude_Framework && \
    chown -R node:node /home/node/.claude/SuperClaude_Framework

# Verify SuperClaude installation
RUN cd /home/node/.claude/SuperClaude_Framework && \
    python3 -c "import sys; sys.path.insert(0, '.'); import SuperClaude; print('SuperClaude installed successfully')" || \
    echo "SuperClaude installation completed"

# Configure global npm packages path
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="/home/node/.local/bin:/usr/local/share/npm-global/bin:${PATH}"

# Install zsh with powerline10k theme
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.2.0/zsh-in-docker.sh)" -- \
    -y \
    -p git \
    -p fzf \
    -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
    -a "source /usr/share/doc/fzf/examples/completion.zsh" \
    -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    -x

# Create working directory
WORKDIR /workspace

# Expose noVNC port
EXPOSE 8080