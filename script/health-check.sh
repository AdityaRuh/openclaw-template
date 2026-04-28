#!/usr/bin/env bash
# =============================================================================
# health-check.sh — Verify everything is wired up correctly
# =============================================================================
# Runs after setup. Checks:
#   - Required CLIs on PATH
#   - .env has the keys we expect (OpenRouter primary, Anthropic/OpenAI fallback)
#   - Postgres reachable + schema present
#   - OpenClaw workspace populated
#   - Health endpoint responding (if agent is running)
#   - External APIs reachable (best-effort, requires creds)
#
# Exits 0 only if everything passes. Exits 1 with a summary if anything fails.
# =============================================================================

set -uo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; CYN='\033[0;36m'; DIM='\033[2m'; RST='\033[0m'
ok()   { printf "${GRN}✓${RST} %s ${DIM}%s${RST}\n" "$1" "${2:-}"; PASSED=$((PASSED+1)); }
fail() { printf "${RED}✗${RST} %s ${DIM}%s${RST}\n" "$1" "${2:-}"; FAILED=$((FAILED+1)); }
warn() { printf "${YLW}!${RST} %s ${DIM}%s${RST}\n" "$1" "${2:-}"; WARNED=$((WARNED+1)); }
hdr()  { printf "\n${CYN}━━━ %s ━━━${RST}\n" "$*"; }

PASSED=0; FAILED=0; WARNED=0
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_PORT="${HEALTH_PORT:-8080}"

# ---------- Check CLIs ----------
check_clis() {
  hdr "CLI tools"
  for tool in node npm psql; do
    if command -v "${tool}" >/dev/null 2>&1; then
      ok "${tool}" "$(${tool} --version 2>/dev/null | head -1)"
    else
      fail "${tool}" "not on PATH"
    fi
  done
  if command -v openclaw >/dev/null 2>&1; then
    ok "openclaw" "$(openclaw --version 2>/dev/null || echo unknown)"
  else
    warn "openclaw" "not on PATH (optional)"
  fi
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "docker" "running"
    else
      warn "docker" "installed but daemon not running"
    fi
  else
    warn "docker" "not installed (optional)"
  fi
}

# ---------- Check .env ----------
check_env() {
  hdr ".env configuration"
  if [[ ! -f "${REPO_ROOT}/.env" ]]; then
    fail ".env" "missing — copy .env.example to .env and fill in"
    return
  fi
  ok ".env" "present"

  # DATABASE_URL is required
  if grep -qE "^DATABASE_URL=.+" "${REPO_ROOT}/.env"; then
    ok "  DATABASE_URL" "set"
  else
    fail "  DATABASE_URL" "missing or empty"
  fi

  # Need AT LEAST ONE LLM key — OpenRouter, Anthropic, or OpenAI
  local llm_keys=(OPENROUTER_API_KEY OPEN_ROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY)
  local llm_ok=false
  local found_keys=()
  for key in "${llm_keys[@]}"; do
    if grep -qE "^${key}=.+" "${REPO_ROOT}/.env"; then
      found_keys+=("${key}")
      llm_ok=true
    fi
  done
  if ${llm_ok}; then
    ok "  LLM key" "${found_keys[*]}"
  else
    fail "  LLM key" "none of OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY is set"
  fi

  # Show which model is configured
  local model
  model=$(grep -E "^MODEL=" "${REPO_ROOT}/.env" | head -1 | cut -d'=' -f2-)
  if [[ -n "${model}" ]]; then ok "  MODEL" "${model}"; else warn "  MODEL" "unset (using default)"; fi

  # Optional integrations
  for key in REDDIT_CLIENT_ID X_BEARER_TOKEN TELEGRAM_BOT_TOKEN; do
    if grep -qE "^${key}=.+" "${REPO_ROOT}/.env"; then
      ok "  ${key}" "set"
    else
      warn "  ${key}" "not set (optional)"
    fi
  done
}

# ---------- Source .env for DB checks ----------
source_env() {
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +a
  fi
}

# ---------- Check Postgres ----------
check_postgres() {
  hdr "Postgres"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    fail "DATABASE_URL" "not set"
    return
  fi

  if ! psql "${DATABASE_URL}" -c 'SELECT 1' >/dev/null 2>&1; then
    fail "connection" "cannot reach $(echo "${DATABASE_URL}" | sed 's/:[^:@]*@/:****@/')"
    return
  fi
  ok "connection" "reachable"

  local count
  count=$(psql "${DATABASE_URL}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY(ARRAY['sources','raw_posts','leads','outreach_drafts','heartbeats','logs','rate_limits','sessions'])" 2>/dev/null \
    | tr -d '[:space:]')

  if [[ "${count}" == "8" ]]; then
    ok "schema" "${count}/8 tables"
  else
    fail "schema" "${count}/8 tables present — run: bash script/init-db.sh"
  fi

  # Recent heartbeat?
  local hb_age
  hb_age=$(psql "${DATABASE_URL}" -tAc \
    "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(beat_at)))::int, -1) FROM heartbeats" 2>/dev/null \
    | tr -d '[:space:]')

  if [[ "${hb_age}" == "-1" ]]; then
    warn "heartbeat" "no heartbeats yet (agent not started?)"
  elif [[ "${hb_age}" -lt 120 ]]; then
    ok "heartbeat" "${hb_age}s ago"
  else
    warn "heartbeat" "${hb_age}s old (agent may be stopped)"
  fi
}

# ---------- Check OpenClaw workspace ----------
check_workspace() {
  hdr "OpenClaw workspace"
  local ws="${OPENCLAW_HOME:-${HOME}/.openclaw}/workspace"
  if [[ ! -d "${ws}" ]]; then
    fail "workspace" "not found at ${ws} — run: bash script/sync-openclaw.sh"
    return
  fi
  ok "workspace" "${ws}"

  local required=(SOUL.md MEMORY.md AGENTS.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md BOOTSTRAP.md)
  for f in "${required[@]}"; do
    if [[ -f "${ws}/${f}" ]]; then
      ok "  ${f}"
    else
      fail "  ${f}" "missing in workspace"
    fi
  done

  if [[ -d "${ws}/skills" ]]; then
    local n
    n=$(find "${ws}/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')
    ok "  skills/" "${n} skill(s)"
  else
    warn "  skills/" "missing"
  fi
}

# ---------- Check health endpoint ----------
check_health_endpoint() {
  hdr "Health endpoint (port ${HEALTH_PORT})"
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl" "not installed — skipping endpoint check"
    return
  fi

  local url="http://localhost:${HEALTH_PORT}"
  if curl -fsS --max-time 3 "${url}/healthz" >/dev/null 2>&1; then
    ok "/healthz" "200"
  else
    warn "/healthz" "not responding (agent not running?)"
    return
  fi

  if curl -fsS --max-time 5 "${url}/readyz" >/dev/null 2>&1; then
    ok "/readyz" "200"
  else
    warn "/readyz" "not 200 (some dependency unhealthy)"
  fi
}

# ---------- External APIs (best-effort) ----------
check_apis() {
  hdr "External APIs (best-effort)"

  # OpenRouter (preferred)
  local OR_KEY="${OPENROUTER_API_KEY:-${OPEN_ROUTER_API_KEY:-}}"
  if [[ -n "${OR_KEY}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
      -H "Authorization: Bearer ${OR_KEY}" \
      https://openrouter.ai/api/v1/auth/key 2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "OpenRouter auth" "${code}" || warn "OpenRouter auth" "${code}"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
      -X POST https://api.anthropic.com/v1/messages \
      -H "x-api-key: ${ANTHROPIC_API_KEY}" \
      -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' \
      2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "Anthropic" "${code}" || warn "Anthropic" "${code}"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
      -H "Authorization: Bearer ${OPENAI_API_KEY}" \
      https://api.openai.com/v1/models 2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "OpenAI" "${code}" || warn "OpenAI" "${code}"
  else
    warn "LLM" "no key configured"
  fi

  # Reddit
  if [[ -n "${REDDIT_CLIENT_ID:-}" && -n "${REDDIT_CLIENT_SECRET:-}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -u "${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}" \
      -A 'hookline-healthcheck/1.0' \
      -d 'grant_type=client_credentials' \
      https://www.reddit.com/api/v1/access_token 2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "Reddit auth" "${code}" || warn "Reddit auth" "${code}"
  else
    warn "Reddit" "creds not set"
  fi

  # Twitter
  if [[ -n "${X_BEARER_TOKEN:-}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "Authorization: Bearer ${X_BEARER_TOKEN}" \
      'https://api.twitter.com/2/tweets/search/recent?query=hello&max_results=10' 2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "Twitter search" "${code}" || warn "Twitter search" "${code}"
  else
    warn "Twitter" "X_BEARER_TOKEN not set"
  fi

  # Telegram
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || echo 000)
    [[ "${code}" == "200" ]] && ok "Telegram bot" "${code}" || warn "Telegram bot" "${code}"
  fi
}

# ---------- Run ----------
check_clis
check_env
source_env
check_postgres
check_workspace
check_health_endpoint
check_apis

# ---------- Summary ----------
hdr "Summary"
printf "${GRN}Passed:${RST} %d   ${YLW}Warnings:${RST} %d   ${RED}Failed:${RST} %d\n" \
  "${PASSED}" "${WARNED}" "${FAILED}"

if [[ ${FAILED} -gt 0 ]]; then
  printf "\n${RED}✗ Health check FAILED${RST} — fix the items above and re-run\n" >&2
  exit 1
fi

if [[ ${WARNED} -gt 0 ]]; then
  printf "\n${YLW}! Health check passed with warnings${RST} — review above\n"
else
  printf "\n${GRN}✓ All checks passed — system is healthy${RST}\n"
fi
exit 0
