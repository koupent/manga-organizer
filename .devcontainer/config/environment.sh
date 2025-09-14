#!/bin/bash
# Environment variables configuration for DevContainer
# This file centralizes all environment variables used across the container

# System environment
export TZ="${TZ:-Asia/Tokyo}"
export DEBIAN_FRONTEND=noninteractive

# Locale settings (avoid warnings)
export LANG=C.UTF-8
export LANGUAGE=C.UTF-8
export LC_ALL=C.UTF-8

# Display and VNC settings
export DISPLAY=:0.0
export DISPLAY_WIDTH="${DISPLAY_WIDTH:-1600}"
export DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-900}"
export RUN_XTERM=yes
export RUN_FLUXBOX=yes

# Development environment
export DEVCONTAINER=true
export SHELL=/bin/zsh
export HOME=/home/node

# Python environment
export VIRTUAL_ENV="/home/node/.venv"
export PATH="/home/node/.venv/bin:/home/node/.local/bin:${PATH}"
# Safely include existing PYTHONPATH if present; avoid VS Code template syntax
export PYTHONPATH="/home/node/.venv/lib/python3.11/site-packages:/home/node/.local/lib/python3.11/site-packages${PYTHONPATH:+:${PYTHONPATH}}"

# Node.js and npm configuration
export NPM_CONFIG_PREFIX=/usr/local/share/npm-global
export PATH="/usr/local/share/npm-global/bin:${PATH}"

# Claude and SuperClaude configuration
export CLAUDE_CONFIG_DIR="/home/node/.claude"
export CLAUDE_ROOT_CONFIG="/home/node/.claude.json"

# Playwright MCP configuration
export PLAYWRIGHT_MCP_HEADLESS=false
export PLAYWRIGHT_MCP_SANDBOX=false

# Git and shell configuration
export POWERLEVEL9K_DISABLE_GITSTATUS=true
export PROMPT_COMMAND='history -a'
export HISTFILE=/commandhistory/.bash_history

# Node.js optimization
export NODE_OPTIONS="--max-old-space-size=4096"
