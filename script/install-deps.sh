#!/usr/bin/env bash
# =============================================================================
# install-deps.sh — Install required system dependencies
# =============================================================================
# Detects OS (Debian/Ubuntu via apt, RHEL/Fedora via dnf, macOS via brew)
# and installs:
#   - Node.js 20+
#   - npm + pnpm
#   - PostgreSQL client (psql)
#   - Docker (if not present)
#   - jq, curl (utilities)
#
# Idempotent: skips anything already installed at correct version.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; BLU='\033[0;34m'; RST='\033[0m'
log()  { printf "${BLU}▸${RST} %s\n" "$*"; }
ok()   { printf "${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "${YLW}!${RST} %s\n" "$*"; }
err()  { printf "${RED}✗${RST} %s\n" "$*" >&2; }

# ---------- OS detection ----------
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ -f /etc/debian_version ]]; then
    echo "debian"
  elif [[ -f /etc/redhat-release ]]; then
    echo "rhel"
  elif [[ -f /etc/alpine-release ]]; then
    echo "alpine"
  else
    echo "unknown"
  fi
}

OS="$(detect_os)"
log "Detected OS: ${OS}"

# Sudo helper — works whether or not we're root
SUDO=""
if [[ "${OS}" != "macos" && "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    err "Not root and sudo not available. Re-run as root or install sudo."
    exit 1
  fi
fi

# ---------- Helpers ----------
have() { command -v "$1" >/dev/null 2>&1; }

version_ge() {
  # version_ge "20.5.0" "20.0.0" → 0 (true) if first >= second
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

# ---------- Package manager wrappers ----------
pkg_update() {
  case "${OS}" in
    debian)  ${SUDO} apt-get update -y -qq ;;
    rhel)    ${SUDO} dnf -q -y check-update || true ;;
    alpine)  ${SUDO} apk update -q ;;
    macos)   command -v brew >/dev/null || {
               warn "Homebrew not found — installing"
               /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
             }
             brew update --quiet
             ;;
  esac
}

pkg_install() {
  local pkg="$1"
  case "${OS}" in
    debian)  ${SUDO} apt-get install -y -qq --no-install-recommends "${pkg}" ;;
    rhel)    ${SUDO} dnf install -y -q "${pkg}" ;;
    alpine)  ${SUDO} apk add --no-cache -q "${pkg}" ;;
    macos)   brew install --quiet "${pkg}" ;;
  esac
}

# ---------- Step 1: basic utilities ----------
ensure_basics() {
  for tool in curl jq ca-certificates; do
    if have "${tool}"; then
      ok "${tool} present"
    else
      log "Installing ${tool}"
      pkg_install "${tool}" || warn "Could not install ${tool}"
    fi
  done
}

# ---------- Step 2: Node.js 20+ ----------
ensure_node() {
  local need_install=true
  if have node; then
    local v
    v="$(node -v 2>/dev/null | sed 's/v//')"
    if version_ge "${v}" "20.0.0"; then
      ok "Node.js ${v} present"
      need_install=false
    else
      warn "Node.js ${v} is too old (need 20+)"
    fi
  fi

  if ${need_install}; then
    log "Installing Node.js 20.x"
    case "${OS}" in
      debian)
        curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO} -E bash -
        ${SUDO} apt-get install -y -qq nodejs
        ;;
      rhel)
        curl -fsSL https://rpm.nodesource.com/setup_20.x | ${SUDO} bash -
        ${SUDO} dnf install -y -q nodejs
        ;;
      alpine)
        ${SUDO} apk add --no-cache nodejs npm
        ;;
      macos)
        brew install node@20
        brew link --overwrite --force node@20 || true
        ;;
      *)
        err "Don't know how to install Node on ${OS}. Install Node 20+ manually."
        exit 1
        ;;
    esac
    ok "Node.js installed: $(node -v)"
  fi

  if ! have npm; then
    err "npm not found after Node install"
    exit 1
  fi
}

# ---------- Step 3: pnpm (recommended for OpenClaw) ----------
ensure_pnpm() {
  if have pnpm; then
    ok "pnpm $(pnpm -v) present"
  else
    log "Installing pnpm globally via npm"
    ${SUDO:-} npm install -g pnpm@latest >/dev/null 2>&1
    ok "pnpm $(pnpm -v) installed"
  fi
}

# ---------- Step 4: PostgreSQL client ----------
ensure_psql() {
  if have psql; then
    ok "psql $(psql --version | awk '{print $3}') present"
    return
  fi
  log "Installing PostgreSQL client"
  case "${OS}" in
    debian)  pkg_install postgresql-client ;;
    rhel)    pkg_install postgresql ;;
    alpine)  pkg_install postgresql-client ;;
    macos)   pkg_install libpq && brew link --force libpq 2>/dev/null || true ;;
  esac
  if have psql; then ok "psql installed"; else warn "psql still not on PATH"; fi
}

# ---------- Step 5: Docker (optional but recommended) ----------
ensure_docker() {
  if have docker; then
    if docker info >/dev/null 2>&1; then
      ok "Docker present and running"
    else
      warn "Docker installed but daemon not running — start Docker Desktop or 'systemctl start docker'"
    fi
    return
  fi

  log "Installing Docker"
  case "${OS}" in
    debian)
      ${SUDO} install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/debian/gpg | ${SUDO} tee /etc/apt/keyrings/docker.asc >/dev/null
      ${SUDO} chmod a+r /etc/apt/keyrings/docker.asc
      local codename
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-bookworm}")"
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" | \
        ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null
      ${SUDO} apt-get update -y -qq
      ${SUDO} apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    rhel)
      ${SUDO} dnf -y install dnf-plugins-core
      ${SUDO} dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      ${SUDO} dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ${SUDO} systemctl enable --now docker
      ;;
    alpine)
      ${SUDO} apk add --no-cache docker docker-compose
      ${SUDO} rc-update add docker boot 2>/dev/null || true
      ${SUDO} service docker start 2>/dev/null || true
      ;;
    macos)
      warn "Docker Desktop must be installed manually on macOS:"
      warn "  https://www.docker.com/products/docker-desktop/"
      warn "Skipping (Docker is optional for local dev)"
      ;;
  esac

  if have docker; then ok "Docker installed: $(docker --version)"; fi
}

# ---------- Step 6: Repo npm deps ----------
ensure_repo_deps() {
  if [[ -f "${REPO_ROOT:-$(pwd)}/package.json" ]]; then
    log "Installing repo npm dependencies"
    cd "${REPO_ROOT:-$(pwd)}"
    npm install --omit=dev --no-audit --no-fund --silent
    ok "Repo deps installed"
  else
    warn "No package.json found in repo root — skipping npm install"
  fi
}

# ---------- Run ----------
pkg_update
ensure_basics
ensure_node
ensure_pnpm
ensure_psql
ensure_docker
ensure_repo_deps

echo
ok "All dependencies ready"
