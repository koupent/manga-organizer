#!/bin/bash
# Common helper functions for DevContainer scripts

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_step() {
    echo -e "${BLUE}🔧 $1${NC}"
}

# Legacy-style logging aliases for backward compatibility (non-colored)
info() {
    echo "[INFO]  $*"
}

warn() {
    echo "[WARN]  $*"
}

error() {
    echo "[ERROR] $*" 1>&2
}

success() {
    echo "[OK]    $*"
}

# Ensure PATH contains npm global bin and per-user local bin (uv/uvx)
ensure_runtime_path() {
    local home_dir
    home_dir="${HOME:-/home/node}"
    # Prepend npm-global and user local bin to PATH if not already present
    case ":$PATH:" in
        *:"/usr/local/share/npm-global/bin":*) :;;
        *) PATH="/usr/local/share/npm-global/bin:${PATH}";;
    esac
    case ":$PATH:" in
        *:"${home_dir}/.local/bin":*) :;;
        *) PATH="${home_dir}/.local/bin:${PATH}";;
    esac
    export PATH
}

# Environment setup
setup_environment() {
    # Resolve config file path candidates
    local this_dir=""
    if [ -n "${BASH_SOURCE[0]}" ]; then
        this_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    fi
    local candidate1="${this_dir%/scripts}/config/environment.sh"
    local candidate2="/workspace/.devcontainer/config/environment.sh"
    local candidate3="/devcontainer/config/environment.sh"

    for f in "$candidate1" "$candidate2" "$candidate3"; do
        if [ -f "$f" ]; then
            source "$f"
            log_success "Environment variables loaded from $f"
            return 0
        fi
    done
    log_error "Environment file not found: tried $candidate1, $candidate2, $candidate3"
    return 1
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Wait for service to be ready
wait_for_service() {
    local service_name="$1"
    local check_command="$2"
    local max_attempts="${3:-30}"
    local delay="${4:-1}"
    
    log_info "Waiting for $service_name to be ready..."
    for i in $(seq 1 "$max_attempts"); do
        if eval "$check_command" >/dev/null 2>&1; then
            log_success "$service_name is ready"
            return 0
        fi
        if [ $i -eq "$max_attempts" ]; then
            log_error "$service_name failed to start after $max_attempts attempts"
            return 1
        fi
        sleep "$delay"
    done
}

# Display service status
show_service_status() {
    log_info "Service Status:"
    if command_exists supervisorctl; then
        supervisorctl status
    else
        log_warning "supervisorctl not available"
    fi
}
