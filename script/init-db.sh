#!/usr/bin/env bash
# =============================================================================
# init-db.sh — Initialize Postgres schema for Hookline
# =============================================================================
# Connects to $DATABASE_URL, applies db/schema.sql.
#
# Schema uses CREATE TABLE IF NOT EXISTS, so this is fully idempotent —
# running on an existing database is safe and only adds missing tables.
#
# If $DATABASE_URL is not set, will attempt to construct from POSTGRES_*
# env vars; failing that, exits with instructions.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; BLU='\033[0;34m'; RST='\033[0m'
log()  { printf "${BLU}▸${RST} %s\n" "$*"; }
ok()   { printf "${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "${YLW}!${RST} %s\n" "$*"; }
err()  { printf "${RED}✗${RST} %s\n" "$*" >&2; }

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCHEMA_FILE="${REPO_ROOT}/db/schema.sql"

# ---------- Resolve DATABASE_URL ----------
resolve_db_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    ok "Using DATABASE_URL from env"
    return
  fi

  # Try to construct from compose-style env vars
  local user="${POSTGRES_USER:-hookline}"
  local pass="${POSTGRES_PASSWORD:-}"
  local host="${POSTGRES_HOST:-localhost}"
  local port="${POSTGRES_PORT:-5432}"
  local db="${POSTGRES_DB:-hookline}"

  if [[ -n "${pass}" ]]; then
    export DATABASE_URL="postgres://${user}:${pass}@${host}:${port}/${db}"
    warn "Constructed DATABASE_URL from POSTGRES_* vars"
  else
    err "DATABASE_URL not set and POSTGRES_PASSWORD missing."
    err "Set DATABASE_URL in .env, or pass POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_HOST/POSTGRES_DB."
    exit 1
  fi
}

# ---------- Wait for DB ----------
wait_for_db() {
  log "Waiting for Postgres to accept connections (max 60s)"
  local i=0
  while [[ $i -lt 30 ]]; do
    if psql "${DATABASE_URL}" -c 'SELECT 1' >/dev/null 2>&1; then
      ok "Postgres reachable"
      return
    fi
    sleep 2
    i=$((i + 1))
  done
  err "Postgres unreachable after 60s. Check that the DB container/service is running."
  err "Try: docker compose up -d postgres   (or start your local Postgres)"
  exit 1
}

# ---------- Apply schema ----------
apply_schema() {
  if [[ ! -f "${SCHEMA_FILE}" ]]; then
    err "Schema file not found: ${SCHEMA_FILE}"
    exit 1
  fi

  log "Applying schema: ${SCHEMA_FILE}"
  if psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${SCHEMA_FILE}"; then
    ok "Schema applied"
  else
    err "Schema apply failed"
    exit 1
  fi
}

# ---------- Verify tables ----------
verify_tables() {
  log "Verifying tables exist"
  local expected=(sources raw_posts leads outreach_drafts heartbeats logs rate_limits sessions)
  local missing=()

  for tbl in "${expected[@]}"; do
    if psql "${DATABASE_URL}" -tAc "SELECT 1 FROM information_schema.tables WHERE table_name='${tbl}'" 2>/dev/null | grep -q 1; then
      ok "  ${tbl}"
    else
      err "  ${tbl} MISSING"
      missing+=("${tbl}")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "${#missing[@]} table(s) missing"
    exit 1
  fi

  # Check the funnel view too
  if psql "${DATABASE_URL}" -tAc "SELECT 1 FROM information_schema.views WHERE table_name='funnel'" 2>/dev/null | grep -q 1; then
    ok "  view: funnel"
  else
    warn "  view: funnel missing (dashboard will show zeros)"
  fi
}

# ---------- Seed sources (optional, only if empty) ----------
seed_if_empty() {
  local count
  count="$(psql "${DATABASE_URL}" -tAc 'SELECT count(*) FROM sources' 2>/dev/null || echo 0)"
  count="$(echo "${count}" | tr -d '[:space:]')"

  if [[ "${count}" == "0" ]]; then
    log "No sources configured — seeding 2 example sources (you can edit later)"
    psql "${DATABASE_URL}" -q <<'SQL'
INSERT INTO sources (platform, config) VALUES
  ('reddit',  '{"subreddit":"SaaS","keywords":["looking for tool","frustrated with","anyone using"]}'),
  ('reddit',  '{"subreddit":"startups","keywords":["need help with","recommendation for"]}')
ON CONFLICT DO NOTHING;
SQL
    ok "Seeded example sources"
  else
    ok "${count} source(s) already configured"
  fi
}

# ---------- Run ----------
resolve_db_url
wait_for_db
apply_schema
verify_tables
seed_if_empty

echo
ok "Database initialized"
