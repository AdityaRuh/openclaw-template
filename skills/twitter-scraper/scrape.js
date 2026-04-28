#!/usr/bin/env node
/**
 * Twitter/X scraper — outputs JSONL of tweets matching a query.
 * Usage: node scrape.js --query '"looking for tool" lang:en -is:retweet'
 */

const args = require('minimist')(process.argv.slice(2));
const query = args.query;
const lookbackHours = parseInt(args.lookback_hours || '24', 10);
const maxResults = Math.min(parseInt(args.max_results || '50', 10), 100);

if (!query) {
  console.error('Usage: --query "<twitter search query>"');
  process.exit(1);
}

const TOKEN = process.env.X_BEARER_TOKEN;
if (!TOKEN) {
  console.error('Missing X_BEARER_TOKEN');
  process.exit(1);
}

(async () => {
  try {
    const startTime = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
    const url = new URL('https://api.twitter.com/2/tweets/search/recent');
    url.searchParams.set('query', query);
    url.searchParams.set('max_results', String(maxResults));
    url.searchParams.set('start_time', startTime);
    url.searchParams.set('tweet.fields', 'author_id,public_metrics,created_at,lang,conversation_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,public_metrics,description,verified');

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'hookline-leadgen/1.0'
      }
    });

    if (res.status === 429) {
      const reset = res.headers.get('x-rate-limit-reset');
      process.stderr.write(JSON.stringify({ level: 'warn', code: 'RATE_LIMIT', reset_at: reset }) + '\n');
      process.exit(0);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twitter search failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    const users = new Map((json.includes?.users || []).map(u => [u.id, u]));
    const tweets = json.data || [];

    let emitted = 0;
    for (const t of tweets) {
      const u = users.get(t.author_id);
      if (!u) continue;

      // Bot-ish filter
      const followers = u.public_metrics?.followers_count || 0;
      const following = u.public_metrics?.following_count || 0;
      if (followers < 10 && following > 1000) continue;

      const record = {
        source: 'twitter',
        external_id: t.id,
        author: `@${u.username}`,
        author_meta: {
          followers,
          following,
          verified: !!u.verified,
          bio: u.description || ''
        },
        title: '',
        body: t.text,
        url: `https://x.com/${u.username}/status/${t.id}`,
        posted_at: t.created_at,
        engagement: {
          likes: t.public_metrics?.like_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          retweets: t.public_metrics?.retweet_count || 0
        },
        matched_keywords: [query]
      };
      process.stdout.write(JSON.stringify(record) + '\n');
      emitted++;
    }

    process.stderr.write(JSON.stringify({ level: 'info', code: 'DONE', found: emitted }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', code: 'FATAL', message: err.message }) + '\n');
    process.exit(2);
  }
})();
