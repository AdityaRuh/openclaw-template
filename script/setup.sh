#!/usr/bin/env bash
# =============================================================================
# Hookline OpenClaw Agent — One-Command Setup
# =============================================================================
# Runs all phases in order. Idempotent — safe to re-run.
#
# Usage:
#   bash script/setup.sh                # full setup
#   bash script/setup.sh deps           # only install deps
#   bash script/setup.sh openclaw       # only sync openclaw workspace
#   bash script/setup.sh db             # only init database
#   bash script/setup.sh health         # only run health checks
# =============================================================================

set -euo pipefail

# ---------- Colors / logging ----------
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; BLU='\033[0;34m'; CYN='\033[0;36m'; DIM='\033[2m'; RST='\033[0m'

log()  { printf "${BLU}▸${RST} %s\n" "$*"; }
ok()   { printf "${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "${YLW}!${RST} %s\n" "$*"; }
err()  { printf "${RED}✗${RST} %s\n" "$*" >&2; }
hdr()  { printf "\n${CYN}━━━ %s ━━━${RST}\n" "$*"; }

# ---------- Path resolution ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

export REPO_ROOT SCRIPT_DIR

# ---------- Phase: deps ----------
phase_deps() {
  hdr "Phase 1/4 — Installing dependencies"
  bash "${SCRIPT_DIR}/install-deps.sh"
}

# ---------- Phase: openclaw ----------
phase_openclaw() {
  hdr "Phase 2/4 — Installing & syncing OpenClaw"
  bash "${SCRIPT_DIR}/sync-openclaw.sh"
}

# ---------- Phase: db ----------
phase_db() {
  hdr "Phase 3/4 — Initializing database"
  bash "${SCRIPT_DIR}/init-db.sh"
}

# ---------- Phase: health ----------
phase_health() {
  hdr "Phase 4/4 — Health checks"
  bash "${SCRIPT_DIR}/health-check.sh"
}

# ---------- .env loading ----------
load_env() {
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    log "Loading ${REPO_ROOT}/.env"
    set -a
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +a
    ok ".env loaded"
  elif [[ -f "${REPO_ROOT}/.env.example" ]]; then
    warn "No .env found — copying .env.example → .env (FILL IT IN before re-running)"
    cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
    err "Edit ${REPO_ROOT}/.env now, then re-run: bash script/setup.sh"
    exit 1
  else
    err "No .env or .env.example found"
    exit 1
  fi
}

# ---------- Dispatcher ----------
main() {
  local target="${1:-all}"

  hdr "🪝 Hookline setup"
  log "Repo root:    ${REPO_ROOT}"
  log "Target phase: ${target}"

  case "${target}" in
    deps)        phase_deps ;;
    openclaw)    load_env; phase_openclaw ;;
    db)          load_env; phase_db ;;
    health)      load_env; phase_health ;;
    all|"")
      phase_deps
      load_env
      phase_openclaw
      phase_db
      phase_health
      hdr "🎉 Setup complete"
      ok "Next: review your USER.md, then run 'docker compose up' to start the agent"
      ;;
    *)
      err "Unknown phase: ${target}"
      echo "Usage: bash script/setup.sh [deps|openclaw|db|health|all]"
      exit 2
      ;;
  esac
}

main "$@"
