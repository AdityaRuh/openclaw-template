# TOOLS

Tools available to Hookline and how to use them.

## Built-in OpenClaw tools
- `bash` — Execute shell commands. Use for git, gh, curl, jq.
- `read` / `write` / `edit` — Workspace file ops.
- `browser` — Headless Chromium for sites without APIs.
- `cron` — Schedule recurring tasks (used by HEARTBEAT).
- `sessions_*` — Multi-session coordination.

## External APIs (configured via .env)
| Service | Purpose | Env var |
|---|---|---|
| Reddit API | Scrape subreddit posts | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| Twitter/X API v2 | Search tweets matching signals | `X_BEARER_TOKEN` |
| Hacker News (Firebase) | Fetch HN stories/comments | (no auth) |
| IndieHackers RSS | Fetch IH posts | (no auth) |
| OpenAI / Anthropic | Score + draft outreach | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` |
| Telegram Bot API | Notify user | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Postgres | Persistent storage | `DATABASE_URL` |

## Workspace skills (in `skills/`)
- `reddit-scraper` — Pulls posts from configured subreddits matching signal keywords.
- `twitter-scraper` — Searches X for matching tweets with engagement filters.
- `lead-scorer` — Scores 0-100 based on signal strength, recency, ICP fit.
- `outreach-drafter` — Drafts personalized first-touch message in user's voice.

## Tool conventions
- All scrapers return JSONL to stdout. Bot.js pipes into PG.
- Every external HTTP call must use exponential backoff (2s, 4s, 8s, give up).
- Every scrape skill must respect a `--max-results` flag (default 50).
- Every skill writes its own log line to `logs` table on completion.

## Rate limit discipline
- Reddit: 60 req/min (authenticated). Tracked in `rate_limits` table.
- Twitter: 180 req/15min (Basic). Tracked.
- Always check `rate_limits` table BEFORE the call, not after the 429.
