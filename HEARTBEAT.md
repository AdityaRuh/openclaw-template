# HEARTBEAT

Proactive scheduled behaviors. Hookline runs these autonomously without user prompting.

## Schedule

### Every 15 minutes
- Emit liveness beat to `heartbeats` table (status, current_task, queue_depth).
- Check `rate_limits` table for any source recovering from 429.

### Every 1 hour
- Run `reddit-scraper` skill on each active subreddit in `sources` table.
- Run `twitter-scraper` skill on each active query.
- Insert new posts into `raw_posts` table with `processed=false`.

### Every 30 minutes
- Pick up unprocessed `raw_posts`, run through `lead-scorer`.
- Promote score ≥ 60 to `leads` table.
- Score ≥ 75 → enqueue for outreach drafting.

### Every 2 hours
- Run `outreach-drafter` on queued high-score leads.
- Store drafts in `outreach_drafts` with status='pending_review'.

### Every 6 hours
- Push notification to user with: count of new leads, top 3 by score, drafts awaiting review.

### Daily at 09:00 user-local
- Append yesterday's stats to `memory/learnings.md`.
- Run troubleshoot self-check, log result.
- If any source has been `degraded` for >24h, alert user.

### Weekly (Monday 09:00 user-local)
- Generate ICP fit report: which signals are converting to high-score leads, which aren't.
- Suggest USER.md edits based on patterns.

## Watchdog
- If no heartbeat written in 90 seconds → external watchdog (docker healthcheck) restarts container.
- If 3 consecutive scrape failures on same source → mark `degraded`, skip until manual review.
- If outreach draft queue > 50 pending review → pause new drafting, notify user.

## On-event hooks (not scheduled)
- New post matches a signal keyword exactly → score immediately, don't wait for batch.
- User replies "approved" to a draft → mark `approved`, log to `outreach_sent` (user actually sends).
- User replies "skip" → mark `rejected`, learn pattern in `learnings.md`.
