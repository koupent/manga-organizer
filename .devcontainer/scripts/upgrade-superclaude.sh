#!/bin/bash
# SuperClaude + MCP upgrader (idempotent, non-interactive)

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

# Normalize runtime PATH (npm-global, ~/.local/bin)
if command -v ensure_runtime_path >/dev/null 2>&1; then
  ensure_runtime_path
fi

HOME_DIR="${HOME:-/home/node}"
UV_BIN="${HOME_DIR}/.local/bin/uv"
VENV_DIR="${HOME_DIR}/.venv"
PY_BIN="${VENV_DIR}/bin/python"
SC_BIN="${VENV_DIR}/bin/SuperClaude"

# (PATH is normalized via ensure_runtime_path above when available)

if [ ! -x "${SC_BIN}" ]; then
    error "SuperClaude is not installed. Run install-superclaude.sh first."
    exit 1
fi

########################################
# Upgrade Python packages
########################################
info "Upgrading SuperClaude and MCP packages..."
if command -v "${UV_BIN}" >/dev/null 2>&1; then
  UV="${UV_BIN}"
else
  UV="$(command -v uv)"
fi
"${UV}" pip install --python "${PY_BIN}" -U SuperClaude mcp

########################################
# Run SuperClaude update
########################################
CLAUDE_DIR="${HOME_DIR}/.claude"
info "Updating SuperClaude framework (non-interactive)..."
printf "1\n" | "${SC_BIN}" update --yes --no-update-check --install-dir "${CLAUDE_DIR}" || warn "SuperClaude CLI update reported issues"

########################################
# Ensure Serena MCP server is runnable and present
########################################
UVX_BIN="$(command -v uvx || true)"
if { [ -n "${UVX_BIN}" ] && ! "${UVX_BIN}" serena --help >/dev/null 2>&1; } && [ ! -x "${VENV_DIR}/bin/serena" ]; then
    info "Installing Serena MCP server package into venv..."
    "${UV}" pip install --python "${PY_BIN}" -U serena || warn "Failed to install serena package"
fi
if [ -n "${UVX_BIN}" ]; then
    SERENA_CMD="uvx"
    SERENA_ARGS='["serena"]'
else
    SERENA_CMD="${VENV_DIR}/bin/serena"
    SERENA_ARGS='[]'
fi

########################################
# Re-prune MCP servers to required set and enforce serena entry
########################################
info "Pruning MCP server configuration after upgrade..."
"${PY_BIN}" - "${CLAUDE_DIR}" "${SERENA_CMD}" "${SERENA_ARGS}" <<'PY'
import json, os, sys
base = sys.argv[1]
serena_cmd = sys.argv[2]
serena_args = sys.argv[3]
allowed = {"sequential-thinking", "context7", "playwright", "serena"}

def prune(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return
    changed = False
    ms = data.get("mcpServers")
    if isinstance(ms, dict):
        for key in list(ms.keys()):
            if key == "configDir":
                continue
            if key not in allowed:
                ms.pop(key, None)
                changed = True
        desired = {
            "type": "stdio",
            "command": serena_cmd,
            "args": json.loads(serena_args),
            "env": {}
        }
        if ms.get("serena") != desired:
            ms["serena"] = desired
            changed = True
    projects = data.get("projects")
    if isinstance(projects, dict):
        for proj_cfg in projects.values():
            m = proj_cfg.get("mcpServers")
            if isinstance(m, dict):
                for key in list(m.keys()):
                    if key not in allowed:
                        m.pop(key, None)
                        changed = True
                desired = {
                    "type": "stdio",
                    "command": serena_cmd,
                    "args": json.loads(serena_args),
                    "env": {}
                }
                if m.get("serena") != desired:
                    m["serena"] = desired
                    changed = True
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)

prune(os.path.join(base, ".claude.json"))
PY

success "SuperClaude upgrade completed."
