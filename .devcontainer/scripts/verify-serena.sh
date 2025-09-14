#!/bin/bash
# Post-install verifier/fixer for Serena MCP

set -Eeuo pipefail

# Source common utilities if available (provides info/warn/error/success)
SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/common.sh" ]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/common.sh"
else
  info()    { echo "[INFO]  $*"; }
  warn()    { echo "[WARN]  $*"; }
  error()   { echo "[ERROR] $*" 1>&2; }
  success() { echo "[OK]    $*"; }
fi

HERE_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME:-/home/node}"
VENV_DIR="${HOME_DIR}/.venv"
PY_BIN="${VENV_DIR}/bin/python"

# Normalize runtime PATH (npm-global, ~/.local/bin)
if command -v ensure_runtime_path >/dev/null 2>&1; then
  ensure_runtime_path
fi

# Tunables (override via env)
SERENA_PORT_START="${SERENA_PORT_START:-8000}"
SERENA_PORT_TRIES="${SERENA_PORT_TRIES:-50}"
SERENA_CONTEXT="${SERENA_CONTEXT:-ide-assistant}"
SERENA_PROJECT="${SERENA_PROJECT:-$(pwd)}"
VERIFY_RETRIES="${VERIFY_RETRIES:-5}"
VERIFY_DELAY_SEC="${VERIFY_DELAY_SEC:-1}"

is_port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | grep -qx "$port"; then
      return 1
    else
      return 0
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
      return 1
    else
      return 0
    fi
  fi
  return 0
}

find_free_port() {
  local start="$1"; local tries="$2"; local p="$start"; local i=0
  while [ "$i" -lt "$tries" ]; do
    if is_port_free "$p"; then echo "$p"; return 0; fi
    p=$((p+1)); i=$((i+1))
  done
  echo "$start"
}

run_install() {
  info "Running SuperClaude installer..."
  bash "${HERE_DIR}/install-superclaude.sh"
}

apply_serena_config() {
  local cfg_dir="${HOME_DIR}/.serena"
  local cfg_file="${cfg_dir}/serena_config.yml"
  mkdir -p "${cfg_dir}"
  if [ ! -f "${cfg_file}" ]; then
    info "Creating ${cfg_file} with web_dashboard_open_on_launch: false"
    printf "web_dashboard_open_on_launch: false\n" > "${cfg_file}"
  else
    if grep -Eq '^[[:space:]]*web_dashboard_open_on_launch:' "${cfg_file}"; then
      info "Updating web_dashboard_open_on_launch: false in ${cfg_file}"
      sed -i -E 's/^[[:space:]]*web_dashboard_open_on_launch:.*/web_dashboard_open_on_launch: false/' "${cfg_file}" || true
    else
      info "Appending web_dashboard_open_on_launch: false to ${cfg_file}"
      printf "\nweb_dashboard_open_on_launch: false\n" >> "${cfg_file}"
    fi
  fi
}

ensure_serena_registered() {
  local port="$1"
  local uvx_bin
  uvx_bin="$(command -v uvx || true)"

  # Prefer uvx from git; fallback to venv binary
  if [ -n "${uvx_bin}" ]; then
    local -a launch=("uvx" "--from" "git+https://github.com/oraios/serena" "serena" "start-mcp-server")
    claude mcp remove serena -s local 2>/dev/null || true
    claude mcp remove serena -s user 2>/dev/null || true
    claude mcp add serena -s local -- "${launch[@]}" --enable-web-dashboard false --context "${SERENA_CONTEXT}" --project "${SERENA_PROJECT}" --port "${port}"
  else
    local serena_bin="${VENV_DIR}/bin/serena"
    if [ ! -x "${serena_bin}" ]; then
      info "Installing serena into venv..."
      local uv
      if command -v "${HOME_DIR}/.local/bin/uv" >/dev/null 2>&1; then
        uv="${HOME_DIR}/.local/bin/uv"
      else
        uv="$(command -v uv)"
      fi
      "${uv}" pip install --python "${PY_BIN}" -U serena || warn "Failed to install serena package"
    fi
    claude mcp remove serena -s local 2>/dev/null || true
    claude mcp remove serena -s user 2>/dev/null || true
    claude mcp add serena -s local -- "${serena_bin}" start-mcp-server --enable-web-dashboard false --context "${SERENA_CONTEXT}" --project "${SERENA_PROJECT}" --port "${port}"
  fi
}

verify_connected() {
  local retries="$1"; local delay="$2"; local i
  for i in $(seq 1 "$retries"); do
    local out
    out="$(claude mcp list 2>&1 | cat || true)"
    if echo "$out" | grep -E "^serena:.*Connected|serena.*✓[[:space:]]*Connected" >/dev/null 2>&1; then
      success "Serena is Connected"
      return 0
    fi
    if echo "$out" | grep -E "^serena:.*Failed to connect|serena.*✗[[:space:]]*Failed" >/dev/null 2>&1; then
      # Immediate failure detected for this attempt; allow caller to re-register
      return 1
    fi
    sleep "$delay"
  done
  return 1
}

main() {
  if ! command -v claude >/dev/null 2>&1; then
    error "claude CLI not found. Please ensure Claude Code CLI is installed."
    exit 1
  fi

  if [ "${SC_SKIP_INSTALL:-0}" != "1" ]; then
    run_install || warn "Installer returned non-zero or produced warnings"
  else
    info "SC_SKIP_INSTALL=1 set; skipping installer run"
  fi

  apply_serena_config

  info "Checking Serena connectivity..."
  if verify_connected "$VERIFY_RETRIES" "$VERIFY_DELAY_SEC"; then
    return 0
  fi

  info "Serena not Connected. Attempting re-registration with incremental ports..."
  local base
  base="$SERENA_PORT_START"
  local attempt=1
  while [ $attempt -le 5 ]; do
    local start_port=$((base + attempt - 1))
    local selected_port
    selected_port="$(find_free_port "$start_port" "$SERENA_PORT_TRIES")"
    info "Attempt $attempt: registering Serena on port ${selected_port}..."
    ensure_serena_registered "$selected_port" || warn "Registration attempt $attempt failed"
    info "Re-checking Serena connectivity..."
    if verify_connected "$VERIFY_RETRIES" "$VERIFY_DELAY_SEC"; then
      success "Serena Connected after re-registration (port ${selected_port})"
      return 0
    fi
    attempt=$((attempt+1))
  done
  warn "Serena still not Connected after multiple attempts. Please run 'claude mcp list' and inspect logs."
  exit 2
}

main "$@"
