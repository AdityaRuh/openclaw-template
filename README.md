# 🪝 Hookline — OpenClaw Lead Generation Agent

An autonomous OpenClaw agent that scans Reddit, Twitter/X, Hacker News, and IndieHackers for people expressing buying signals matching your ICP, scores them 0–100, and drafts personalized outreach for you to approve and send.

> **Quiet listener. Sharp drafter. Never spams.**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  HEARTBEAT (cron)                                                │
│  ├─ hourly      → scrape skills (reddit, twitter, …)             │
│  ├─ 30-minute   → lead-scorer skill                              │
│  ├─ 2-hour      → outreach-drafter skill                         │
│  └─ 6-hour      → telegram digest                                │
└──────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐         ┌─────────────┐       ┌──────────────┐
   │ skills/ │         │   bot.js    │       │  health.js   │
   │  (4 of) │ ◄────── │   main loop │ ────► │  /healthz    │
   └─────────┘         └─────────────┘       │  /readyz     │
                              │              │  / dashboard │
                              ▼              └──────────────┘
                      ┌──────────────┐
                      │  Postgres    │
                      │  raw_posts   │
                      │  leads       │
                      │  drafts      │
                      │  heartbeats  │
                      │  logs        │
                      │  funnel view │
                      └──────────────┘
```

---

## Folder map

| Box | Path | Purpose |
|---|---|---|
| 1️⃣ OpenClaw files | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`, `memory/`, `skills/`, `canvas/`, `avatars/` | Agent identity, behavior, skills, and memory |
| 2️⃣ Script (main) | `bot.js`, `package.json` | Entry point — runs scheduled cycles |
| 3️⃣ Health | `health.js` | `/healthz`, `/readyz`, dashboard server |
| 4️⃣ Troubleshoot | `troubleshoot.js` | Diagnostic CLI |
| 5️⃣ PG | `db/schema.sql`, `db/migrations/`, `db/client.js` | Persistent storage |

---

## Quick start

### 1. Configure
```bash
git clone <your-repo-url> hookline
cd hookline
cp .env.example .env
# Edit .env with your API keys
# Edit USER.md with your ICP and offer
```

### 2. Run with Docker
```bash
docker compose up --build
```
The agent will:
- Spin up Postgres
- Apply schema
- Start scraping (after 5s warmup)
- Expose dashboard at http://localhost:8080

### 3. Verify
```bash
docker compose exec agent node troubleshoot.js doctor
docker compose exec agent node troubleshoot.js test-apis
```

### 4. Seed your sources
Connect to Postgres and add what you want watched:
```sql
INSERT INTO sources (platform, config) VALUES
  ('reddit',  '{"subreddit":"SaaS","keywords":["looking for tool","frustrated with","anyone using"]}'),
  ('reddit',  '{"subreddit":"startups","keywords":["need help with","recommendation for"]}'),
  ('twitter', '{"query":"\"looking for\" SaaS lang:en -is:retweet min_replies:1"}');
```

---

## Operator playbook

| Situation | Command |
|---|---|
| "Is everything working?" | `node troubleshoot.js doctor` |
| "Did APIs go down?" | `node troubleshoot.js test-apis` |
| "Why is no scraping happening?" | `node troubleshoot.js show-rate-limits` |
| "What broke recently?" | `node troubleshoot.js tail-errors 50` |
| "Source X stuck on degraded" | `node troubleshoot.js retry-source <uuid>` |
| "Re-score after ICP change" | `node troubleshoot.js replay-scoring` |
| "Reset all degraded sources" | `node troubleshoot.js prune-degraded` |

---

## Customizing your agent

1. **Voice** — Edit `SOUL.md` and `USER.md`. The drafter reads both every run.
2. **Sources** — Add rows to the `sources` table. Each source has `platform` + arbitrary `config` JSON.
3. **Schedule** — Edit cron expressions in `bot.js` (search `cron.schedule`).
4. **Skills** — Drop a new folder under `skills/<your-skill>/SKILL.md` + script. Reference it from `bot.js`.
5. **Dashboard** — `canvas/index.html` is plain HTML/JS, edit freely.

---

## Safety

- **Never auto-sends.** All drafts wait at `outreach_drafts.status='pending_review'` until you approve.
- **Respects rate limits.** Tracks per-platform 429s in the `rate_limits` table; pauses automatically.
- **No private scraping.** Only public APIs + public posts.
- **No PII in logs.** Author handles only — never emails, never message bodies in error logs.
- **Disqualifier list.** Anyone you mark "skip" goes into `MEMORY.md` and is never approached again.

---

## Costs (rough)

| Service | Cost |
|---|---|
| LLM (scoring + drafting, ~500 leads/day) | $5–15/mo (Haiku scoring + Sonnet drafting) |
| Reddit API | Free tier sufficient |
| Twitter Basic | $100/mo (required for search API) |
| Postgres (small VPS) | $5/mo |
| **Total** | **~$110–125/mo** |

Skip Twitter and you're under $25/mo total.

---

## License

MIT

---

🦞 Built on [OpenClaw](https://github.com/openclaw/openclaw).
