#!/bin/bash
# SuperClaude + MCP installer (idempotent, non-interactive)

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

########################################
# (moved) Serena registration is handled by verify-serena.sh
########################################

########################################
# Ensure uv
########################################
if ! command -v "${UV_BIN}" >/dev/null 2>&1 && ! command -v uv >/dev/null 2>&1; then
    info "Installing uv..."
    curl -fsSL https://astral.sh/uv/install.sh | sh
fi

# Resolve uv path
if command -v "${UV_BIN}" >/dev/null 2>&1; then
    UV="${UV_BIN}"
else
    UV="$(command -v uv)"
fi

########################################
# Ensure venv
########################################
if [ ! -x "${PY_BIN}" ]; then
    info "Creating uv virtual environment at ${VENV_DIR}..."
    "${UV}" venv "${VENV_DIR}"
fi

########################################
# Install/upgrade SuperClaude and MCP
########################################
info "Installing/Upgrading SuperClaude and MCP packages..."
"${UV}" pip install --python "${PY_BIN}" -U SuperClaude mcp

########################################
# Verify installations
########################################
if ! "${SC_BIN}" --version >/dev/null 2>&1; then
    error "SuperClaude CLI not found after installation"
    exit 1
fi
"${SC_BIN}" --version || true
"${PY_BIN}" -c 'import mcp, sys; print("mcp", getattr(mcp, "__version__", "(version unknown)"))' || warn "mcp import check failed"

########################################
# Install SuperClaude components (core + mcp)
########################################
CLAUDE_DIR="${HOME_DIR}/.claude"
mkdir -p "${CLAUDE_DIR}"

# Remove empty placeholder MCP config to let installer populate
if [ -f "${CLAUDE_DIR}/mcp_servers.json" ] && grep -Eq '"servers"[[:space:]]*:[[:space:]]*\{[[:space:]]*\}' "${CLAUDE_DIR}/mcp_servers.json"; then
    info "Removing empty mcp_servers.json before installation..."
    rm -f "${CLAUDE_DIR}/mcp_servers.json"
fi

info "Installing SuperClaude components: core, mcp, commands (non-interactive with MCP selection)..."
printf "1,2,4,5\nall\n" | "${SC_BIN}" install --yes --no-update-check --no-backup --install-dir "${CLAUDE_DIR}" --components core mcp commands || warn "SuperClaude CLI install reported issues"

########################################
# Verify required MCP servers are present
########################################
REQUIRED_SERVERS=("sequential-thinking" "context7" "playwright" "serena")
MCP_CONFIG_FILE="${CLAUDE_DIR}/mcp_servers.json"
MCP_JSON_FILE="${CLAUDE_DIR}/.claude.json"

missing_servers=()
for s in "${REQUIRED_SERVERS[@]}"; do
    if ! ( [ -f "${MCP_CONFIG_FILE}" ] && grep -q "\"${s}\"" "${MCP_CONFIG_FILE}" ) && \
       ! ( [ -f "${MCP_JSON_FILE}" ] && grep -q "\"${s}\"" "${MCP_JSON_FILE}" ); then
        missing_servers+=("${s}")
    fi
done

if [ ${#missing_servers[@]} -gt 0 ]; then
    warn "Missing MCP servers after install: ${missing_servers[*]}"
else
    success "All required MCP servers are present: ${REQUIRED_SERVERS[*]}"
fi

########################################
# Configure Claude and MCP settings
########################################
CLAUDE_JSON="${CLAUDE_DIR}/.claude.json"
mkdir -p "${CLAUDE_DIR}"

if [ ! -f "${CLAUDE_JSON}" ]; then
    info "Creating default .claude.json configuration..."
    cat > "${CLAUDE_JSON}" <<EOF
{
  "claude": {
    "version": "1.0.0",
    "configDir": "${CLAUDE_DIR}"
  },
  "mcpServers": {
    "configDir": "${CLAUDE_DIR}",
    "servers": {}
  }
}
EOF
fi

# Ensure top-level compatibility symlink
if [ ! -L "${HOME_DIR}/.claude.json" ]; then
    ln -sf "${CLAUDE_JSON}" "${HOME_DIR}/.claude.json"
fi

# Create default (empty) mcp_servers.json if missing
if [ ! -f "${CLAUDE_DIR}/mcp_servers.json" ]; then
    info "Creating default mcp_servers.json..."
    cat > "${CLAUDE_DIR}/mcp_servers.json" <<EOF
{
  "servers": {}
}
EOF
fi

########################################
# Cleanup: keep only required MCP servers (sequential-thinking, context7, playwright, serena)
########################################
info "Pruning MCP server configuration to required set..."
"${PY_BIN}" - "$CLAUDE_DIR" <<'PY'
import json, os, sys
base = sys.argv[1]
allowed = {"sequential-thinking", "context7", "playwright", "serena"}

def prune_mcpjson(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return False
    changed = False
    # Top-level mcpServers map
    ms = data.get("mcpServers")
    if isinstance(ms, dict):
        for key in list(ms.keys()):
            if key == "configDir":
                continue
            if key not in allowed:
                ms.pop(key, None)
                changed = True
        # Keep whatever Serena entry the CLI created; do not override
    # Project-specific servers
    projects = data.get("projects")
    if isinstance(projects, dict):
        for proj_cfg in projects.values():
            m = proj_cfg.get("mcpServers")
            if isinstance(m, dict):
                for key in list(m.keys()):
                    if key not in allowed:
                        m.pop(key, None)
                        changed = True
                # Keep project-level Serena entry if present; do not override
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)
    return changed

def prune_mcp_servers_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return False
    servers = data.get("servers")
    if not isinstance(servers, dict):
        return False
    changed = False
    for key in list(servers.keys()):
        if key not in allowed:
            servers.pop(key, None)
            changed = True
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)
    return changed

prune_mcpjson(os.path.join(base, ".claude.json"))
prune_mcp_servers_json(os.path.join(base, "mcp_servers.json"))
PY

success "SuperClaude and MCP setup completed successfully."

echo ""
echo "Versions:"
"${UV}" --version || true
"${PY_BIN}" --version || true
"${SC_BIN}" --version || true
