#!/usr/bin/env node
/**
 * Reddit scraper — outputs JSONL of posts matching keywords.
 * Usage: node scrape.js --subreddit SaaS --keywords "looking for,frustrated with"
 */

const args = require('minimist')(process.argv.slice(2));
const subreddit = args.subreddit;
const keywords = (args.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
const lookbackHours = parseInt(args.lookback_hours || '24', 10);
const maxResults = parseInt(args.max_results || '50', 10);

if (!subreddit || keywords.length === 0) {
  console.error('Usage: --subreddit <name> --keywords "phrase1,phrase2"');
  process.exit(1);
}

async function getToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET');

  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'hookline-leadgen/1.0'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function searchKeyword(token, keyword) {
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search?` +
    `q=${encodeURIComponent(keyword)}&restrict_sr=1&sort=new&t=day&limit=${maxResults}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'hookline-leadgen/1.0'
    }
  });

  if (res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset') || '60';
    process.stderr.write(JSON.stringify({ level: 'warn', code: 'RATE_LIMIT', reset_in_s: reset }) + '\n');
    return [];
  }
  if (res.status === 403) {
    process.stderr.write(JSON.stringify({ level: 'error', code: 'FORBIDDEN', subreddit }) + '\n');
    return [];
  }
  if (!res.ok) throw new Error(`Reddit search failed: ${res.status}`);

  const json = await res.json();
  return (json.data?.children || []).map(c => c.data);
}

(async () => {
  try {
    const token = await getToken();
    const cutoff = (Date.now() / 1000) - lookbackHours * 3600;
    const seen = new Set();

    for (const kw of keywords) {
      const posts = await searchKeyword(token, kw);
      for (const p of posts) {
        if (seen.has(p.id)) continue;
        if (p.over_18 || p.stickied) continue;
        if (p.author === '[deleted]') continue;
        if (p.created_utc < cutoff) continue;

        seen.add(p.id);
        const record = {
          source: 'reddit',
          external_id: `t3_${p.id}`,
          subreddit: p.subreddit,
          author: p.author,
          title: p.title,
          body: p.selftext || '',
          url: `https://reddit.com${p.permalink}`,
          posted_at: new Date(p.created_utc * 1000).toISOString(),
          engagement: { score: p.score, comments: p.num_comments },
          matched_keywords: [kw]
        };
        process.stdout.write(JSON.stringify(record) + '\n');
      }
      // Polite pacing
      await new Promise(r => setTimeout(r, 1100));
    }

    process.stderr.write(JSON.stringify({ level: 'info', code: 'DONE', subreddit, found: seen.size }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', code: 'FATAL', message: err.message }) + '\n');
    process.exit(2);
  }
})();
