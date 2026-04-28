# SKILL: reddit-scraper

Scrape Reddit posts matching buying-signal keywords from configured subreddits.

## When to use
- Scheduled hourly via HEARTBEAT.
- On-demand when user asks "check r/<subreddit> for leads".

## Inputs
- `subreddit` (required): name without r/ prefix
- `keywords` (required): array of signal phrases
- `lookback_hours` (default: 24)
- `max_results` (default: 50)

## How it works
1. Authenticate to Reddit API using refresh token flow.
2. For each keyword, hit `/r/{subreddit}/search.json?q={keyword}&restrict_sr=1&sort=new&t=day`.
3. For each post:
   - Skip if older than `lookback_hours`.
   - Skip if `over_18`, `stickied`, or author is `[deleted]`.
   - Extract: title, selftext, author, permalink, created_utc, score, num_comments.
4. Output JSONL to stdout, one post per line, with `source: "reddit"`.

## Rate limits
- Hard cap 60 req/min.
- On 429: write to `rate_limits` table with reset_at, exit gracefully.
- On 403 (banned/private sub): mark source `degraded` in db.

## Implementation
- File: `scrape.js`
- Run: `node scrape.js --subreddit SaaS --keywords "looking for tool,frustrated with"`
- Auth uses `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` from env.

## Output schema (one per line)
```json
{"source":"reddit","external_id":"t3_abc123","subreddit":"SaaS","author":"u/foo","title":"...","body":"...","url":"https://reddit.com/...","posted_at":"2026-04-28T10:00:00Z","engagement":{"score":42,"comments":7},"matched_keywords":["looking for tool"]}
```
