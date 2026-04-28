# SKILL: twitter-scraper

Search X/Twitter for tweets matching buying-signal keywords with engagement filters.

## When to use
- Scheduled hourly via HEARTBEAT.
- On-demand for spike-tracking (e.g., user says "find people complaining about X today").

## Inputs
- `query` (required): Twitter search query (supports operators like `min_replies:`, `lang:`, `-is:retweet`)
- `lookback_hours` (default: 24)
- `max_results` (default: 50, capped at 100 by API)

## How it works
1. Authenticate using bearer token (Basic tier supports search).
2. Hit `/2/tweets/search/recent` with the query, `tweet.fields=author_id,public_metrics,created_at,lang`, `expansions=author_id`, `user.fields=username,public_metrics,description`.
3. Filter out retweets, replies (configurable), bot-like accounts (followers < 10 AND following > 1000).
4. Output JSONL.

## Rate limits
- Basic tier: 180 req / 15min on search.
- Track in `rate_limits` table.

## Implementation
- File: `scrape.js`
- Run: `node scrape.js --query '"looking for" lang:en -is:retweet min_replies:1'`
- Auth uses `X_BEARER_TOKEN` from env.
