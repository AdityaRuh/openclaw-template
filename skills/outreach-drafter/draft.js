#!/usr/bin/env node
/**
 * Outreach drafter — reads a lead record from stdin, writes a draft to stdout.
 * Usage: echo '<lead-json>' | node draft.js
 *
 * Provider auto-selected from env (OpenRouter > Anthropic > OpenAI).
 * See lib/llm.js for details.
 */

const fs = require('fs');
const path = require('path');
const { complete } = require(path.join(__dirname, '../../lib/llm'));

function loadFile(...candidates) {
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* keep trying */ }
  }
  return '';
}

const REPO = path.join(__dirname, '../..');
const USER_MD = loadFile(path.join(REPO, 'USER.md'), '/workspace/USER.md', 'USER.md');
const FACTS   = loadFile(path.join(REPO, 'memory/facts.md'), '/workspace/memory/facts.md', 'memory/facts.md');
const MEMORY  = loadFile(path.join(REPO, 'MEMORY.md'), '/workspace/MEMORY.md', 'MEMORY.md');

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

(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const lead = JSON.parse(raw);

  const userMsg = `## User context (their voice + offer)
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
    const draft = await complete({
      system: SYSTEM_PROMPT,
      user: userMsg,
      role: 'drafter',
      jsonOnly: true,
      maxTokens: 600
    });

    process.stdout.write(JSON.stringify({
      lead_external_id: lead.external_id,
      ...draft
    }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', message: err.message }) + '\n');
    process.exit(2);
  }
})();
