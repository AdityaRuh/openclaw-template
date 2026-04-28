#!/usr/bin/env bash
# =============================================================================
# sync-openclaw.sh — Install OpenClaw and overwrite workspace with our config
# =============================================================================
# 1. Installs (or updates) the global `openclaw` CLI.
# 2. Runs `openclaw setup` if first run (creates ~/.openclaw + workspace).
# 3. Backs up any existing workspace files into ~/.openclaw/workspace.bak-<ts>.
# 4. Copies our repo's OpenClaw markdown files + skills into the workspace.
# 5. Verifies the sync with `openclaw doctor` (if available).
#
# Idempotent: re-running just refreshes the workspace from the repo.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; BLU='\033[0;34m'; RST='\033[0m'
log()  { printf "${BLU}▸${RST} %s\n" "$*"; }
ok()   { printf "${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "${YLW}!${RST} %s\n" "$*"; }
err()  { printf "${RED}✗${RST} %s\n" "$*" >&2; }

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
WORKSPACE="${OPENCLAW_HOME}/workspace"

# ---------- Step 1: install / update openclaw CLI ----------
ensure_openclaw_cli() {
  if command -v openclaw >/dev/null 2>&1; then
    local v
    v="$(openclaw --version 2>/dev/null || echo unknown)"
    ok "openclaw CLI present (${v})"
    log "Updating to latest"
    npm install -g openclaw@latest --silent --no-audit --no-fund 2>&1 | tail -3 || \
      warn "Update failed (continuing with current version)"
  else
    log "Installing openclaw globally"
    npm install -g openclaw@latest --silent --no-audit --no-fund
    if ! command -v openclaw >/dev/null 2>&1; then
      err "openclaw still not on PATH after install"
      err "Try: export PATH=\$(npm bin -g):\$PATH"
      exit 1
    fi
    ok "openclaw installed: $(openclaw --version 2>/dev/null || echo '?')"
  fi
}

# ---------- Step 2: ensure workspace exists ----------
ensure_workspace() {
  mkdir -p "${OPENCLAW_HOME}"
  if [[ ! -d "${WORKSPACE}" ]]; then
    log "First-run: creating OpenClaw workspace via 'openclaw setup'"
    if openclaw setup --no-interactive 2>/dev/null || openclaw setup 2>/dev/null; then
      ok "openclaw setup ran"
    else
      warn "openclaw setup failed — falling back to manual mkdir"
      mkdir -p "${WORKSPACE}"
    fi
  else
    ok "Workspace exists: ${WORKSPACE}"
  fi
  mkdir -p "${WORKSPACE}/memory" "${WORKSPACE}/skills" "${WORKSPACE}/canvas" "${WORKSPACE}/avatars"
}

# ---------- Step 3: backup existing workspace files ----------
backup_existing() {
  local files=(SOUL.md MEMORY.md AGENTS.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md BOOTSTRAP.md)
  local need_backup=false
  for f in "${files[@]}"; do
    if [[ -f "${WORKSPACE}/${f}" ]]; then need_backup=true; break; fi
  done

  if ${need_backup}; then
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    local bak="${OPENCLAW_HOME}/workspace.bak-${ts}"
    log "Backing up existing workspace → ${bak}"
    cp -R "${WORKSPACE}" "${bak}"
    ok "Backup saved (delete with: rm -rf ${bak})"
  else
    log "No existing workspace files to back up"
  fi
}

# ---------- Step 4: copy repo files into workspace ----------
sync_files() {
  log "Syncing repo files → ${WORKSPACE}"

  # Top-level markdown files
  local md_files=(SOUL.md MEMORY.md AGENTS.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md BOOTSTRAP.md)
  for f in "${md_files[@]}"; do
    if [[ -f "${REPO_ROOT}/${f}" ]]; then
      cp -f "${REPO_ROOT}/${f}" "${WORKSPACE}/${f}"
      ok "  ${f}"
    else
      warn "  ${f} missing in repo — skipping"
    fi
  done

  # memory/
  if [[ -d "${REPO_ROOT}/memory" ]]; then
    rm -rf "${WORKSPACE}/memory"
    cp -R "${REPO_ROOT}/memory" "${WORKSPACE}/memory"
    ok "  memory/  ($(find "${WORKSPACE}/memory" -type f | wc -l | tr -d ' ') files)"
  fi

  # skills/
  if [[ -d "${REPO_ROOT}/skills" ]]; then
    rm -rf "${WORKSPACE}/skills"
    cp -R "${REPO_ROOT}/skills" "${WORKSPACE}/skills"
    ok "  skills/  ($(find "${WORKSPACE}/skills" -name 'SKILL.md' | wc -l | tr -d ' ') skills)"
  fi

  # canvas/
  if [[ -d "${REPO_ROOT}/canvas" ]]; then
    rm -rf "${WORKSPACE}/canvas"
    cp -R "${REPO_ROOT}/canvas" "${WORKSPACE}/canvas"
    ok "  canvas/"
  fi

  # avatars/
  if [[ -d "${REPO_ROOT}/avatars" ]]; then
    cp -R "${REPO_ROOT}/avatars/." "${WORKSPACE}/avatars/" 2>/dev/null || true
    ok "  avatars/"
  fi
}

# ---------- Step 5: verify ----------
verify() {
  log "Verifying workspace bootstrap files"
  local required=(SOUL.md MEMORY.md AGENTS.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md BOOTSTRAP.md)
  local missing=0
  for f in "${required[@]}"; do
    if [[ -f "${WORKSPACE}/${f}" ]]; then
      ok "  ${f}"
    else
      err "  ${f} MISSING"
      missing=$((missing + 1))
    fi
  done

  if [[ ${missing} -gt 0 ]]; then
    err "${missing} required file(s) missing — fix repo and re-run"
    exit 1
  fi

  if command -v openclaw >/dev/null 2>&1; then
    log "Running 'openclaw doctor' (best-effort)"
    openclaw doctor 2>&1 | sed 's/^/    /' || warn "openclaw doctor failed (non-fatal)"
  fi
}

# ---------- Run ----------
ensure_openclaw_cli
ensure_workspace
backup_existing
sync_files
verify

echo
ok "OpenClaw workspace synced"
log "Workspace path: ${WORKSPACE}"
