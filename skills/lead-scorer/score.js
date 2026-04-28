#!/usr/bin/env node
/**
 * Lead scorer — reads JSONL post records from stdin, outputs scored records.
 * Usage: cat raw_posts.jsonl | node score.js > scored.jsonl
 */

const fs = require('fs');
const readline = require('readline');

const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

function loadUserContext() {
  try {
    return fs.readFileSync('/workspace/USER.md', 'utf8');
  } catch {
    try { return fs.readFileSync('USER.md', 'utf8'); }
    catch { return '(USER.md not found — using generic ICP)'; }
  }
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

async function scoreWithAnthropic(post, userContext) {
  const userMsg = `## User's ICP\n${userContext}\n\n## Post to score\n${JSON.stringify(post, null, 2)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const json = await res.json();
  const text = json.content?.[0]?.text || '{}';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function scoreWithOpenAI(post, userContext) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `## User's ICP\n${userContext}\n\n## Post\n${JSON.stringify(post)}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

(async () => {
  const userContext = loadUserContext();
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let post;
    try { post = JSON.parse(line); } catch { continue; }

    try {
      const result = PROVIDER === 'openai' && OPENAI_KEY
        ? await scoreWithOpenAI(post, userContext)
        : await scoreWithAnthropic(post, userContext);

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
