-- Hookline Lead Generation Agent — Postgres schema
-- Run via: psql $DATABASE_URL -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- SOURCES: configured platforms + queries the agent watches
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        TEXT NOT NULL CHECK (platform IN ('reddit','twitter','hackernews','indiehackers')),
  config          JSONB NOT NULL,        -- e.g. {"subreddit":"SaaS","keywords":[...]}
  is_active       BOOLEAN NOT NULL DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','paused')),
  last_scraped_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sources_active ON sources (is_active, last_scraped_at);

-- ============================================================
-- RAW_POSTS: every scraped post, before scoring
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID REFERENCES sources(id) ON DELETE SET NULL,
  platform        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  author          TEXT,
  title           TEXT,
  body            TEXT,
  url             TEXT,
  posted_at       TIMESTAMPTZ,
  engagement      JSONB,
  matched_keywords TEXT[],
  raw             JSONB,                 -- full original payload for replay
  processed       BOOLEAN NOT NULL DEFAULT false,
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_raw_posts_unprocessed ON raw_posts (processed, scraped_at);

-- ============================================================
-- LEADS: scored leads (score >= 60)
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_post_id     UUID NOT NULL REFERENCES raw_posts(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  author          TEXT,
  score           INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasoning       TEXT,
  signal_tags     TEXT[],
  disqualifiers   TEXT[],
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','drafted','approved','rejected','sent','responded','converted','lost')),
  scored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_status_score ON leads (status, score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_scored_at ON leads (scored_at DESC);

-- ============================================================
-- OUTREACH_DRAFTS: drafts queued for user review
-- ============================================================
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  rationale       TEXT,
  estimated_quality INT,
  status          TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('drafting','pending_review','approved','rejected','sent')),
  rejection_reason TEXT,
  drafted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_drafts_pending ON outreach_drafts (status, drafted_at);

-- ============================================================
-- HEARTBEATS: liveness signals from the agent
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeats (
  id              BIGSERIAL PRIMARY KEY,
  instance_id     TEXT NOT NULL,
  beat_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL,         -- idle | scraping | scoring | drafting | degraded
  current_task    TEXT,
  queue_depth     INT,
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_recent ON heartbeats (beat_at DESC);

-- ============================================================
-- LOGS: structured event log (every skill invocation, every error)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id              BIGSERIAL PRIMARY KEY,
  level           TEXT NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  source          TEXT NOT NULL,         -- which module emitted
  code            TEXT,                  -- machine-readable code, e.g. RATE_LIMIT
  message         TEXT,
  context         JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_recent ON logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level, occurred_at DESC);

-- ============================================================
-- RATE_LIMITS: track per-source rate limit state
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limits (
  platform        TEXT PRIMARY KEY,
  resets_at       TIMESTAMPTZ NOT NULL,
  reason          TEXT,
  consecutive_429s INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SESSIONS: conversation/run sessions for grouping work
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL,         -- scrape_cycle | score_cycle | draft_cycle | manual
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  stats           JSONB
);
CREATE INDEX IF NOT EXISTS idx_sessions_recent ON sessions (started_at DESC);

-- ============================================================
-- VIEW: pipeline funnel (used by canvas/index.html)
-- ============================================================
CREATE OR REPLACE VIEW funnel AS
SELECT
  (SELECT count(*) FROM raw_posts WHERE scraped_at > now() - interval '7 days') AS scraped_7d,
  (SELECT count(*) FROM leads WHERE scored_at > now() - interval '7 days') AS scored_7d,
  (SELECT count(*) FROM leads WHERE scored_at > now() - interval '7 days' AND score >= 75) AS qualified_7d,
  (SELECT count(*) FROM outreach_drafts WHERE drafted_at > now() - interval '7 days') AS drafted_7d,
  (SELECT count(*) FROM outreach_drafts WHERE status = 'approved' AND reviewed_at > now() - interval '7 days') AS approved_7d,
  (SELECT count(*) FROM outreach_drafts WHERE status = 'sent' AND reviewed_at > now() - interval '7 days') AS sent_7d,
  (SELECT count(*) FROM leads WHERE status = 'responded' AND scored_at > now() - interval '7 days') AS responded_7d,
  (SELECT count(*) FROM leads WHERE status = 'converted' AND scored_at > now() - interval '7 days') AS converted_7d;
