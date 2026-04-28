/**
 * Health server — exposes /healthz and /readyz for k8s/docker probes.
 * Started by bot.js. Also serves the canvas dashboard at /.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db/client');

const PORT = parseInt(process.env.HEALTH_PORT || '8080', 10);
const STALE_HEARTBEAT_S = 90;

async function checkLiveness() {
  // /healthz: am I running and reachable?
  return { ok: true, ts: new Date().toISOString() };
}

async function checkReadiness() {
  // /readyz: can I do real work? DB up + recent heartbeat + no fatal logs in last 5 min
  const checks = {};
  let ok = true;

  try {
    await db.query('SELECT 1');
    checks.db = { ok: true };
  } catch (err) {
    checks.db = { ok: false, error: err.message };
    ok = false;
  }

  try {
    const r = await db.query(
      `SELECT EXTRACT(EPOCH FROM (now() - max(beat_at))) AS seconds_ago FROM heartbeats`
    );
    const ago = r.rows[0]?.seconds_ago;
    checks.heartbeat = { ok: ago != null && ago < STALE_HEARTBEAT_S, seconds_ago: ago };
    if (!checks.heartbeat.ok) ok = false;
  } catch (err) {
    checks.heartbeat = { ok: false, error: err.message };
    ok = false;
  }

  try {
    const r = await db.query(
      `SELECT count(*) FROM logs WHERE level='fatal' AND occurred_at > now() - interval '5 minutes'`
    );
    const n = parseInt(r.rows[0].count, 10);
    checks.no_fatal_recent = { ok: n === 0, fatal_count: n };
    if (!checks.no_fatal_recent.ok) ok = false;
  } catch (err) {
    checks.no_fatal_recent = { ok: false, error: err.message };
    ok = false;
  }

  // Rate-limit visibility (not a failure, just exposed)
  try {
    const r = await db.query(`SELECT platform, resets_at FROM rate_limits WHERE resets_at > now()`);
    checks.rate_limits_active = r.rows;
  } catch { /* ignore */ }

  return { ok, checks, ts: new Date().toISOString() };
}

async function getFunnel() {
  const r = await db.query('SELECT * FROM funnel');
  return r.rows[0] || {};
}

async function getRecentLeads() {
  const r = await db.query(`
    SELECT l.score, l.author, l.reasoning, l.signal_tags, l.status,
           rp.platform, rp.title, rp.url, l.scored_at
      FROM leads l JOIN raw_posts rp ON rp.id = l.raw_post_id
     WHERE l.scored_at > now() - interval '7 days'
     ORDER BY l.score DESC, l.scored_at DESC LIMIT 50`);
  return r.rows;
}

async function getRecentBeats() {
  const r = await db.query(`
    SELECT beat_at, status, current_task FROM heartbeats
     ORDER BY beat_at DESC LIMIT 20`);
  return r.rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/healthz') {
      const r = await checkLiveness();
      res.writeHead(r.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r));
    }

    if (url.pathname === '/readyz') {
      const r = await checkReadiness();
      res.writeHead(r.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r, null, 2));
    }

    if (url.pathname === '/api/funnel') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await getFunnel()));
    }

    if (url.pathname === '/api/leads') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await getRecentLeads()));
    }

    if (url.pathname === '/api/beats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await getRecentBeats()));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'canvas/index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`🩺 health server listening on :${PORT}`);
});

module.exports = server;
