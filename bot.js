/**
 * Hookline — main entry point.
 * Boots the agent, runs scheduled scrape/score/draft cycles, emits heartbeats.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const db = require('./db/client');

const INSTANCE_ID = process.env.INSTANCE_ID || `hookline-${process.pid}`;
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '15000', 10);

let currentTask = 'idle';
let queueDepth = 0;

// --------------------------------------------------------------
// Heartbeat
// --------------------------------------------------------------
async function heartbeat() {
  try {
    await db.query(
      `INSERT INTO heartbeats (instance_id, status, current_task, queue_depth, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [INSTANCE_ID, currentTask === 'idle' ? 'idle' : 'working', currentTask, queueDepth, {
        node: process.version,
        uptime_s: Math.floor(process.uptime()),
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }]
    );
  } catch (err) {
    console.error('heartbeat failed:', err.message);
  }
}

// --------------------------------------------------------------
// Skill runner — spawns a skill, captures JSONL stdout
// --------------------------------------------------------------
function runSkill(skillPath, args = [], stdinData = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [skillPath, ...args], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0 && code !== null) {
        return reject(new Error(`Skill ${skillPath} exited ${code}: ${stderr}`));
      }
      resolve({ stdout, stderr });
    });
    if (stdinData != null) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
  });
}

function parseJsonl(s) {
  return s.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// --------------------------------------------------------------
// Rate-limit guard
// --------------------------------------------------------------
async function isRateLimited(platform) {
  const r = await db.query('SELECT resets_at FROM rate_limits WHERE platform=$1', [platform]);
  if (r.rows.length === 0) return false;
  return new Date(r.rows[0].resets_at) > new Date();
}

// --------------------------------------------------------------
// Scrape cycle
// --------------------------------------------------------------
async function scrapeCycle() {
  currentTask = 'scraping';
  const session = await db.query(
    `INSERT INTO sessions (kind, status) VALUES ('scrape_cycle','running') RETURNING id`
  );
  const sessionId = session.rows[0].id;

  try {
    const sources = await db.query(
      `SELECT * FROM sources WHERE is_active=true AND status != 'paused'
       ORDER BY COALESCE(last_scraped_at, '1970-01-01'::timestamptz) ASC`
    );

    let totalNew = 0;
    for (const src of sources.rows) {
      if (await isRateLimited(src.platform)) {
        await db.log('warn', 'bot', 'SKIP_RATE_LIMITED', `Skipping ${src.platform}`, { source_id: src.id });
        continue;
      }

      try {
        let result;
        if (src.platform === 'reddit') {
          result = await runSkill(
            path.join(__dirname, 'skills/reddit-scraper/scrape.js'),
            ['--subreddit', src.config.subreddit, '--keywords', (src.config.keywords || []).join(',')]
          );
        } else if (src.platform === 'twitter') {
          result = await runSkill(
            path.join(__dirname, 'skills/twitter-scraper/scrape.js'),
            ['--query', src.config.query]
          );
        } else {
          continue;
        }

        const records = parseJsonl(result.stdout);
        for (const rec of records) {
          try {
            await db.query(
              `INSERT INTO raw_posts (source_id, platform, external_id, author, title, body, url, posted_at, engagement, matched_keywords, raw)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (platform, external_id) DO NOTHING`,
              [src.id, rec.source, rec.external_id, rec.author, rec.title || '', rec.body || '',
               rec.url, rec.posted_at, rec.engagement || {}, rec.matched_keywords || [], rec]
            );
            totalNew++;
          } catch (e) { /* dedupe noise */ }
        }

        await db.query(
          `UPDATE sources SET last_scraped_at=now(), consecutive_failures=0, status='healthy' WHERE id=$1`,
          [src.id]
        );
      } catch (err) {
        await db.query(
          `UPDATE sources SET consecutive_failures = consecutive_failures + 1,
             status = CASE WHEN consecutive_failures >= 2 THEN 'degraded' ELSE status END
           WHERE id=$1`,
          [src.id]
        );
        await db.log('error', 'bot', 'SCRAPE_FAILED', err.message, { source_id: src.id });
      }
    }

    await db.query(`UPDATE sessions SET ended_at=now(), status='complete', stats=$2 WHERE id=$1`,
      [sessionId, { new_posts: totalNew }]);
    await db.log('info', 'bot', 'SCRAPE_DONE', `Scraped ${totalNew} new posts`, { session_id: sessionId });
  } catch (err) {
    await db.log('error', 'bot', 'SCRAPE_CYCLE_FAIL', err.message);
  } finally {
    currentTask = 'idle';
  }
}

// --------------------------------------------------------------
// Score cycle
// --------------------------------------------------------------
async function scoreCycle() {
  currentTask = 'scoring';
  try {
    const r = await db.query(
      `SELECT id, platform, external_id, author, title, body, url, posted_at, engagement, matched_keywords
         FROM raw_posts WHERE processed=false ORDER BY scraped_at ASC LIMIT 25`
    );
    if (r.rows.length === 0) { currentTask = 'idle'; return; }

    queueDepth = r.rows.length;
    const stdin = r.rows.map(row => JSON.stringify({
      source: row.platform, external_id: row.external_id, author: row.author,
      title: row.title, body: row.body, url: row.url,
      posted_at: row.posted_at, engagement: row.engagement,
      matched_keywords: row.matched_keywords
    })).join('\n');

    const result = await runSkill(
      path.join(__dirname, 'skills/lead-scorer/score.js'), [], stdin
    );

    const scored = parseJsonl(result.stdout);
    const byId = new Map(scored.map(s => [s.external_id, s]));

    for (const post of r.rows) {
      const s = byId.get(post.external_id);
      if (!s) continue;

      if (s.score >= 60) {
        await db.query(
          `INSERT INTO leads (raw_post_id, platform, external_id, author, score, reasoning, signal_tags, disqualifiers)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (platform, external_id) DO NOTHING`,
          [post.id, post.platform, post.external_id, post.author, s.score, s.reasoning,
           s.signal_tags || [], s.disqualifiers || []]
        );
      }
      await db.query('UPDATE raw_posts SET processed=true WHERE id=$1', [post.id]);
    }

    await db.log('info', 'bot', 'SCORE_DONE', `Scored ${scored.length} posts`);
  } catch (err) {
    await db.log('error', 'bot', 'SCORE_CYCLE_FAIL', err.message);
  } finally {
    queueDepth = 0;
    currentTask = 'idle';
  }
}

// --------------------------------------------------------------
// Draft cycle
// --------------------------------------------------------------
async function draftCycle() {
  currentTask = 'drafting';
  try {
    const r = await db.query(`
      SELECT l.id AS lead_id, l.score, l.reasoning, l.external_id, l.author,
             rp.title, rp.body, rp.url, rp.platform AS source
        FROM leads l JOIN raw_posts rp ON rp.id = l.raw_post_id
       WHERE l.status='new' AND l.score >= 75
       ORDER BY l.score DESC LIMIT 10
    `);

    for (const lead of r.rows) {
      const stdin = JSON.stringify(lead);
      try {
        const out = await runSkill(
          path.join(__dirname, 'skills/outreach-drafter/draft.js'), [], stdin
        );
        const drafts = parseJsonl(out.stdout);
        if (drafts.length === 0) continue;
        const d = drafts[0];

        await db.query(
          `INSERT INTO outreach_drafts (lead_id, channel, subject, body, rationale, estimated_quality, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_review')`,
          [lead.lead_id, d.channel, d.subject || null, d.body, d.rationale, d.estimated_quality || null]
        );
        await db.query(`UPDATE leads SET status='drafted' WHERE id=$1`, [lead.lead_id]);
      } catch (err) {
        await db.log('error', 'bot', 'DRAFT_FAIL', err.message, { lead_id: lead.lead_id });
      }
    }
  } catch (err) {
    await db.log('error', 'bot', 'DRAFT_CYCLE_FAIL', err.message);
  } finally {
    currentTask = 'idle';
  }
}

// --------------------------------------------------------------
// Notifier
// --------------------------------------------------------------
async function notifyUser() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  const r = await db.query(`
    SELECT l.score, l.author, rp.url, rp.title
      FROM leads l JOIN raw_posts rp ON rp.id = l.raw_post_id
     WHERE l.scored_at > now() - interval '6 hours' AND l.score >= 85
     ORDER BY l.score DESC LIMIT 5
  `);
  if (r.rows.length === 0) return;

  const lines = r.rows.map(x => `🔥 ${x.score} — ${x.author}\n${(x.title || '').slice(0, 80)}\n${x.url}`).join('\n\n');
  const text = `🪝 *Hookline digest*\n\n${lines}`;

  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    await db.log('warn', 'bot', 'TELEGRAM_FAIL', err.message);
  }
}

// --------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------
async function bootstrap() {
  console.log('🪝 Hookline starting…');
  // Verify DB
  await db.query('SELECT 1');
  // Apply schema (idempotent)
  const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await db.query(schema);
  await db.log('info', 'bot', 'BOOT', 'Hookline online', { instance_id: INSTANCE_ID });
  console.log('🪝 Hookline online.');
}

// --------------------------------------------------------------
// Schedule
// --------------------------------------------------------------
async function main() {
  await bootstrap();

  setInterval(heartbeat, HEARTBEAT_MS);
  heartbeat();

  cron.schedule('0 * * * *', scrapeCycle);            // hourly
  cron.schedule('*/30 * * * *', scoreCycle);          // every 30 min
  cron.schedule('0 */2 * * *', draftCycle);           // every 2 hours
  cron.schedule('0 */6 * * *', notifyUser);           // every 6 hours

  // Start health server (Box 3)
  require('./health.js');

  // Run one cycle immediately on startup
  setTimeout(() => scrapeCycle().then(scoreCycle).then(draftCycle), 5000);
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down…');
  await db.close();
  process.exit(0);
});

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
