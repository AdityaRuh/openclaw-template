#!/usr/bin/env node
/**
 * Hookline troubleshoot CLI.
 * Diagnoses issues, replays failed scrapes, validates config.
 *
 * Usage:
 *   node troubleshoot.js doctor              # Full self-check
 *   node troubleshoot.js retry-source <id>   # Force re-scrape a degraded source
 *   node troubleshoot.js replay-scoring      # Re-score raw_posts from last 24h
 *   node troubleshoot.js test-apis           # Hit each external API once
 *   node troubleshoot.js show-rate-limits    # Display active rate limits
 *   node troubleshoot.js tail-errors [n]     # Show last n errors (default 20)
 *   node troubleshoot.js prune-degraded      # Reset degraded sources
 */

const path = require('path');
const db = require('./db/client');
const llm = require(path.join(__dirname, 'lib/llm'));

const cmd = process.argv[2];
const args = process.argv.slice(3);

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };
const check = (ok, label, detail = '') =>
  console.log(`${ok ? C.green + '✓' : C.red + '✗'} ${label}${C.reset} ${C.dim}${detail}${C.reset}`);

async function doctor() {
  console.log(`${C.cyan}━━━ Hookline doctor ━━━${C.reset}\n`);

  // 1. DB
  try {
    await db.query('SELECT 1');
    check(true, 'Postgres reachable');
  } catch (err) { check(false, 'Postgres unreachable', err.message); return; }

  // 2. Schema
  try {
    const r = await db.query(`SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
      ('sources','raw_posts','leads','outreach_drafts','heartbeats','logs','rate_limits','sessions')`);
    const n = parseInt(r.rows[0].count, 10);
    check(n === 8, `Schema present`, `${n}/8 tables`);
  } catch (err) { check(false, 'Schema check failed', err.message); }

  // 3. Heartbeat freshness
  try {
    const r = await db.query(`SELECT EXTRACT(EPOCH FROM (now() - max(beat_at))) AS s FROM heartbeats`);
    const s = parseFloat(r.rows[0]?.s ?? 99999);
    check(s < 120, 'Heartbeat fresh', `${Math.round(s)}s ago`);
  } catch { check(false, 'Heartbeat check failed'); }

  // 4. Sources health
  try {
    const r = await db.query(`SELECT status, count(*) FROM sources GROUP BY status`);
    if (r.rows.length === 0) check(true, 'Sources', '(none configured yet)');
    for (const row of r.rows) {
      check(row.status === 'healthy', `Sources ${row.status}`, `${row.count}`);
    }
  } catch { check(false, 'Source check failed'); }

  // 5. Active rate limits
  try {
    const r = await db.query(`SELECT platform, resets_at FROM rate_limits WHERE resets_at > now()`);
    if (r.rows.length === 0) check(true, 'No active rate limits');
    else r.rows.forEach(x => check(false, `Rate-limited: ${x.platform}`, `until ${x.resets_at}`));
  } catch { check(false, 'Rate limit check failed'); }

  // 6. Recent errors
  try {
    const r = await db.query(
      `SELECT count(*) FROM logs WHERE level IN ('error','fatal') AND occurred_at > now() - interval '1 hour'`);
    const n = parseInt(r.rows[0].count, 10);
    check(n === 0, 'No errors in last hour', `${n} errors`);
  } catch { check(false, 'Error scan failed'); }

  // 7. LLM provider
  try {
    const provider = llm.pickProvider();
    check(true, 'LLM provider', provider);
    check(true, 'Scorer model', llm.modelFor('scorer'));
    check(true, 'Drafter model', llm.modelFor('drafter'));
  } catch (err) {
    check(false, 'LLM provider', err.message);
  }

  // 8. Env vars
  const required = ['DATABASE_URL'];
  const optional = ['REDDIT_CLIENT_ID', 'X_BEARER_TOKEN', 'TELEGRAM_BOT_TOKEN'];
  for (const v of required) check(!!process.env[v], `env: ${v}`);
  for (const v of optional) check(!!process.env[v], `env: ${v}`, '(optional)');

  console.log(`\n${C.cyan}━━━ done ━━━${C.reset}`);
}

async function retrySource(id) {
  if (!id) { console.error('Usage: retry-source <source_id>'); process.exit(1); }
  await db.query(
    `UPDATE sources SET status='healthy', consecutive_failures=0, last_scraped_at=NULL WHERE id=$1`, [id]);
  console.log(`✓ Source ${id} reset to healthy`);
}

async function replayScoring() {
  const r = await db.query(
    `UPDATE raw_posts SET processed=false
       WHERE scraped_at > now() - interval '24 hours'
       RETURNING id`);
  console.log(`✓ Re-queued ${r.rowCount} posts for scoring`);
}

async function testApis() {
  console.log(`${C.cyan}Testing external APIs…${C.reset}\n`);

  // LLM (via shared client — will use whichever provider is configured)
  try {
    const r = await llm.ping();
    if (r.ok) check(true, `LLM (${r.provider})`, `${r.model} → ${r.sample}`);
    else check(false, 'LLM', r.error);
  } catch (err) { check(false, 'LLM', err.message); }

  // Reddit
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    try {
      const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
      const r = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'hookline/1.0' },
        body: 'grant_type=client_credentials'
      });
      check(r.ok, 'Reddit auth', `${r.status}`);
    } catch (err) { check(false, 'Reddit auth', err.message); }
  } else check(false, 'Reddit', 'creds missing');

  // Twitter
  if (process.env.X_BEARER_TOKEN) {
    try {
      const r = await fetch('https://api.twitter.com/2/tweets/search/recent?query=hello&max_results=10', {
        headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
      });
      check(r.ok, 'Twitter search', `${r.status}`);
    } catch (err) { check(false, 'Twitter search', err.message); }
  } else check(false, 'Twitter', 'token missing');

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
      check(r.ok, 'Telegram bot', `${r.status}`);
    } catch (err) { check(false, 'Telegram bot', err.message); }
  } else check(false, 'Telegram', 'token missing');
}

async function showRateLimits() {
  const r = await db.query(`SELECT * FROM rate_limits ORDER BY resets_at DESC`);
  if (r.rows.length === 0) { console.log('No rate limits recorded.'); return; }
  console.table(r.rows);
}

async function tailErrors(n = 20) {
  const r = await db.query(
    `SELECT occurred_at, level, source, code, message FROM logs
       WHERE level IN ('error','fatal','warn')
       ORDER BY occurred_at DESC LIMIT $1`, [parseInt(n, 10)]);
  console.table(r.rows);
}

async function pruneDegraded() {
  const r = await db.query(
    `UPDATE sources SET status='healthy', consecutive_failures=0
       WHERE status='degraded' RETURNING id`);
  console.log(`✓ Reset ${r.rowCount} degraded sources`);
}

(async () => {
  try {
    switch (cmd) {
      case 'doctor': await doctor(); break;
      case 'retry-source': await retrySource(args[0]); break;
      case 'replay-scoring': await replayScoring(); break;
      case 'test-apis': await testApis(); break;
      case 'show-rate-limits': await showRateLimits(); break;
      case 'tail-errors': await tailErrors(args[0]); break;
      case 'prune-degraded': await pruneDegraded(); break;
      default:
        console.log(`Usage: node troubleshoot.js <command>

Commands:
  doctor                Full self-check
  retry-source <id>     Reset a degraded source
  replay-scoring        Re-score raw_posts from last 24h
  test-apis             Test every external API
  show-rate-limits      Show active rate limits
  tail-errors [n]       Show last n errors (default 20)
  prune-degraded        Reset all degraded sources to healthy`);
        process.exit(1);
    }
  } finally {
    await db.close();
  }
})();
