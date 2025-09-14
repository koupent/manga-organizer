#!/bin/bash
# Enhanced VNC startup script for Playwright MCP headful monitoring

set -Eeuo pipefail

# Source common functions (robust path resolution)
SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# VNC-specific: display access information
show_access_info() {
  echo ""
  echo "========================================="
  echo "🎉 VNC services started successfully!"
  echo "========================================="
  echo "📺 noVNC Web Interface: http://localhost:${NOVNC_PORT:-6080}/vnc.html"
  echo "🌐 Chrome DevTools: http://localhost:9222 (when browser is running)"
  echo ""
  echo "Playwright MCP is configured to run in HEADFUL mode."
  echo "You can monitor browser interactions via the noVNC interface."
  echo "========================================="
}

# Detect and select an available noVNC port (default 6080, auto-increment if occupied)
is_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" | grep -qE "LISTEN"
    return $?
  else
    (timeout 0.2 bash -c "echo > /dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && return 0 || return 1
  fi
}

find_free_port() {
  local base_port="${1:-6080}"
  local max_tries="${2:-20}"
  local p="$base_port"
  for _ in $(seq 0 "$max_tries"); do
    if ! is_port_in_use "$p"; then
      echo "$p"
      return 0
    fi
    p=$((p+1))
  done
  # Fallback to base if none found
  echo "$base_port"
  return 1
}

log_info "Starting VNC services for Playwright MCP headful monitoring..."

# Ensure runtime PATH (npm-global and ~/.local/bin) is normalized
if command -v ensure_runtime_path >/dev/null 2>&1; then
  ensure_runtime_path
fi

# Setup environment
setup_environment || exit 1

# Choose NOVNC_PORT dynamically before starting supervisord
log_step "Selecting noVNC port..."
BASE_NOVNC_PORT="${NOVNC_BASE_PORT:-6080}"
NOVNC_PORT="${NOVNC_PORT:-$(find_free_port "$BASE_NOVNC_PORT" "${NOVNC_MAX_TRIES:-20}")}"
export NOVNC_PORT
log_success "noVNC will listen on http://localhost:${NOVNC_PORT}"

# Kill any existing supervisord processes
log_step "Stopping existing supervisord processes..."
pkill -f supervisord 2>/dev/null || true

# Clean up old log files
log_step "Cleaning up old log files..."
rm -f /tmp/supervisord.log /tmp/supervisord.pid

# Start supervisord with unified configuration (detached)
log_step "Starting supervisord..."
nohup setsid supervisord \
  -c /workspace/.devcontainer/config/supervisord.conf \
  -l /tmp/supervisord.log \
  -j /tmp/supervisord.pid \
  >> /tmp/supervisord.bootstrap.log 2>&1 < /dev/null &

# Brief non-blocking health check (do not fail postStart)
sleep 1
(supervisorctl -c /workspace/.devcontainer/config/supervisord.conf status >/dev/null 2>&1 || true)

# Show quick pointers and return
show_access_info
log_info "Supervisord started in background. Logs: /tmp/supervisord.log"
