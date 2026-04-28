# BOOTSTRAP

First-run and every-restart procedure.

## On first run
1. Verify all required env vars present (see .env.example). If any missing → exit with clear error.
2. Connect to Postgres. If unreachable → wait 5s, retry up to 3 times, then exit.
3. Run migrations from `db/migrations/` in order.
4. Seed `sources` table with default subreddits/queries from USER.md if empty.
5. Verify external APIs:
   - Reddit: GET /api/v1/me → expect 200
   - Twitter: GET /2/users/me → expect 200
   - LLM provider: 1-token completion → expect 200
   - Telegram: getMe → expect 200
6. Write a "boot complete" event to `logs` table.
7. Send Telegram message: "🪝 Hookline online. Watching N sources for ICP."

## On every restart
1. Adopt unfinished work: any `raw_posts.processed=false` older than 30min → reprocess.
2. Resume `outreach_drafts.status='drafting'` if interrupted (mark `pending_review` if content exists).
3. Read last `heartbeats` row — if last beat >5min ago, log "recovered from outage" event.
4. Resume schedule.

## Self-check (run via troubleshoot.js)
- DB reachable + migrations current
- All external APIs returning 200
- No rate limits currently active
- Last heartbeat <2 minutes ago
- No `degraded` sources older than 24h without alert sent
