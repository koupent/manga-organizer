#!/bin/bash
# Dispatcher: install or upgrade SuperClaude based on current state

set -Eeuo pipefail

HERE_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME:-/home/node}"
SC_BIN="${HOME_DIR}/.venv/bin/SuperClaude"

# Normalize runtime PATH early if available
if [ -f "${HERE_DIR}/common.sh" ]; then
  # shellcheck source=/dev/null
  source "${HERE_DIR}/common.sh"
  if command -v ensure_runtime_path >/dev/null 2>&1; then
    ensure_runtime_path
  fi
fi

if [ -x "$SC_BIN" ]; then
  echo "[INFO] SuperClaude detected. Running upgrade..."
  bash "$HERE_DIR/upgrade-superclaude.sh"
else
  echo "[INFO] SuperClaude not found. Running install..."
  bash "$HERE_DIR/install-superclaude.sh"
fi

# Post-install verification and Serena fixup
if [ -f "$HERE_DIR/verify-serena.sh" ]; then
  echo "[INFO] Verifying Serena MCP connectivity..."
  bash "$HERE_DIR/verify-serena.sh"
else
  echo "[WARN] verify-serena.sh not found; skipping Serena verification"
fi
