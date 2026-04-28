# Setup Scripts

One-command setup for the Hookline OpenClaw agent. All scripts are idempotent — safe to re-run.

## Quick start

From the repo root:

```bash
bash script/setup.sh
```

That's it. This runs all four phases in order.

## What each script does

| Script | Purpose | Run independently |
|---|---|---|
| `setup.sh` | **Orchestrator.** Runs all phases below in order. | `bash script/setup.sh` |
| `install-deps.sh` | Installs Node 20+, pnpm, psql, Docker, jq, curl. Detects OS (Debian/RHEL/Alpine/macOS). | `bash script/setup.sh deps` |
| `sync-openclaw.sh` | Installs `openclaw` CLI globally, creates `~/.openclaw/workspace`, backs up any existing workspace, copies our repo's markdown files + skills into it. | `bash script/setup.sh openclaw` |
| `init-db.sh` | Waits for Postgres, applies `db/schema.sql` (idempotent — uses `CREATE TABLE IF NOT EXISTS`), seeds 2 example sources if `sources` table is empty. | `bash script/setup.sh db` |
| `health-check.sh` | Verifies CLIs, env vars, Postgres, OpenClaw workspace, health endpoint, and external APIs. Exits 0 if all green. | `bash script/setup.sh health` |

## Re-running individual phases

```bash
bash script/setup.sh deps      # only re-install deps
bash script/setup.sh openclaw  # only re-sync workspace from repo
bash script/setup.sh db        # only re-apply schema (safe, idempotent)
bash script/setup.sh health    # only run health check
```

## Prerequisites

- macOS, Debian/Ubuntu, RHEL/Fedora/CentOS, or Alpine Linux
- `sudo` (or run as root) on Linux for system package installs
- A `.env` file at repo root (`cp .env.example .env` and fill in)

## What gets installed where

| Item | Path |
|---|---|
| Node 20+ | system `/usr/bin/node` (Linux) or `/opt/homebrew/bin/node` (macOS) |
| `openclaw` CLI | `$(npm prefix -g)/bin/openclaw` |
| OpenClaw workspace | `~/.openclaw/workspace/` |
| Workspace backups | `~/.openclaw/workspace.bak-<timestamp>/` (created on every re-sync) |
| Repo node_modules | `<repo>/node_modules/` |

## Idempotency guarantees

- **install-deps.sh** — checks `command -v <tool>` before installing; verifies Node version with `version_ge`.
- **sync-openclaw.sh** — backs up the existing workspace before overwriting, so you never lose state.
- **init-db.sh** — `CREATE TABLE IF NOT EXISTS` everywhere; existing data is never touched.
- **health-check.sh** — read-only, never modifies anything.

## Common issues

| Symptom | Fix |
|---|---|
| `sudo: command not found` | Run as root or install sudo. |
| `openclaw: command not found` after install | Add npm global bin to PATH: `export PATH=$(npm prefix -g)/bin:$PATH` |
| `Postgres unreachable` | `docker compose up -d postgres` then re-run `bash script/setup.sh db`. |
| `Health check fails on heartbeat` | Agent isn't running yet — `docker compose up agent` or `node bot.js`. |
| Schema apply fails on permission | Postgres user needs CREATE; usually fine in the docker-compose setup. |

## Container usage

If you're running this inside a container that already has OpenClaw + Postgres:

```bash
# Skip dep install (image already has them), just sync + db + health:
bash script/setup.sh openclaw && \
bash script/setup.sh db && \
bash script/setup.sh health
```

Or in a Dockerfile:

```dockerfile
RUN bash script/install-deps.sh
COPY . /app
RUN bash script/sync-openclaw.sh
# (db init runs at container start, after Postgres is ready)
CMD ["bash", "-c", "bash script/init-db.sh && node bot.js"]
```
