#!/usr/bin/env node
/**
 * Lead scorer — reads JSONL post records from stdin, outputs scored records.
 * Usage: cat raw_posts.jsonl | node score.js > scored.jsonl
 *
 * Provider auto-selected from env (OpenRouter > Anthropic > OpenAI).
 * See lib/llm.js for details.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { complete } = require(path.join(__dirname, '../../lib/llm'));

function loadUserContext() {
  const candidates = [
    path.join(__dirname, '../../USER.md'),
    '/workspace/USER.md',
    'USER.md'
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* keep trying */ }
  }
  return '(USER.md not found — using generic ICP)';
}

const SYSTEM_PROMPT = `You are a lead-scoring engine. Given a social media post and a user's ICP definition, you output a JSON score.

You MUST output valid JSON only, no other text. Schema:
{"score": <0-100 integer>, "reasoning": "<1-sentence justification>", "signal_tags": [<list of: explicit_intent, implicit_pain, icp_match, high_engagement, recent>], "disqualifiers": [<list of any reasons score should be 0>]}

Scoring:
- 90-100: Explicit buying intent + perfect ICP match + recent
- 75-89: Strong signal, good ICP match
- 60-74: Decent signal worth drafting outreach
- 40-59: Weak signal, monitor only
- 0-39: Not a lead

Disqualifiers (auto-zero): job ad, promotional content, competitor employee, bot account.`;

(async () => {
  const userContext = loadUserContext();
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let post;
    try { post = JSON.parse(line); } catch { continue; }

    try {
      const result = await complete({
        system: SYSTEM_PROMPT,
        user: `## User's ICP\n${userContext}\n\n## Post to score\n${JSON.stringify(post, null, 2)}`,
        role: 'scorer',
        jsonOnly: true,
        maxTokens: 400
      });

      process.stdout.write(JSON.stringify({
        external_id: post.external_id,
        source: post.source,
        score: result.score,
        reasoning: result.reasoning,
        signal_tags: result.signal_tags || [],
        disqualifiers: result.disqualifiers || []
      }) + '\n');
    } catch (err) {
      process.stderr.write(JSON.stringify({
        level: 'error', external_id: post.external_id, message: err.message
      }) + '\n');
    }
  }
})();
