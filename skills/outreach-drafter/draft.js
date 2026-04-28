#!/usr/bin/env node
/**
 * Outreach drafter — reads a lead record from stdin, writes a draft to stdout.
 * Usage: echo '<lead-json>' | node draft.js
 */

const fs = require('fs');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';

function loadFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

const USER_MD = loadFile('USER.md') || loadFile('/workspace/USER.md');
const FACTS = loadFile('memory/facts.md') || loadFile('/workspace/memory/facts.md');
const MEMORY = loadFile('MEMORY.md') || loadFile('/workspace/MEMORY.md');

const SYSTEM_PROMPT = `You are an outreach copywriter. You draft cold first-touch DMs that feel human and helpful, never templated.

HARD RULES:
1. Max 4 sentences.
2. First sentence must reference something specific from their post.
3. NEVER use these phrases:
   - "I hope this email finds you well"
   - "I came across your post"
   - "I wanted to reach out"
   - "I noticed that you"
4. One ask only. Either a question or a soft CTA.
5. No emojis.
6. Match the user's voice exactly (case, vocabulary, rhythm).

Output JSON only:
{"channel": "reddit_dm|reddit_comment|twitter_dm|twitter_reply", "subject": "(optional)", "body": "...", "rationale": "<why this opener will land>", "estimated_quality": <0-100>}`;

async function draftWithAnthropic(payload) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: payload }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.content?.[0]?.text || '{}';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function draftWithOpenAI(payload) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payload }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const lead = JSON.parse(raw);

  const payload = `## User context (their voice + offer)
${USER_MD}

## Facts about user's product (citeable)
${FACTS}

## Recent approved/rejected drafts (style reference)
${MEMORY}

## The lead to draft outreach for
Source: ${lead.source}
Author: ${lead.author}
URL: ${lead.url}
Their post:
"""
${lead.title ? lead.title + '\n\n' : ''}${lead.body}
"""
Score: ${lead.score} (${lead.reasoning || ''})

Draft the best possible first-touch following all hard rules. Output JSON only.`;

  try {
    const draft = PROVIDER === 'openai' && OPENAI_KEY
      ? await draftWithOpenAI(payload)
      : await draftWithAnthropic(payload);

    process.stdout.write(JSON.stringify({
      lead_external_id: lead.external_id,
      ...draft
    }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', message: err.message }) + '\n');
    process.exit(2);
  }
})();
