/**
 * Unified LLM client.
 *
 * Provider precedence:
 *   1. LLM_PROVIDER env var (explicit choice: openrouter | anthropic | openai)
 *   2. Auto-detect: OPENROUTER_API_KEY > ANTHROPIC_API_KEY > OPENAI_API_KEY
 *
 * OpenRouter uses an OpenAI-compatible endpoint and accepts model slugs like
 * "anthropic/claude-sonnet-4" or "openai/gpt-4o". Browse all models at
 * https://openrouter.ai/models.
 *
 * Env vars supported:
 *   OPENROUTER_API_KEY    (also accepts OPEN_ROUTER_API_KEY)
 *   ANTHROPIC_API_KEY
 *   OPENAI_API_KEY
 *   MODEL                 default model slug (e.g. anthropic/claude-sonnet-4)
 *   MODEL_SCORER          override for scoring (cheaper recommended)
 *   MODEL_DRAFTER         override for drafting (stronger recommended)
 */

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;

function pickProvider() {
  const explicit = (process.env.LLM_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'openrouter' && OPENROUTER_KEY) return 'openrouter';
  if (explicit === 'anthropic'  && ANTHROPIC_KEY)  return 'anthropic';
  if (explicit === 'openai'     && OPENAI_KEY)     return 'openai';
  // Auto-detect (OpenRouter wins because it's the most flexible)
  if (OPENROUTER_KEY) return 'openrouter';
  if (ANTHROPIC_KEY)  return 'anthropic';
  if (OPENAI_KEY)     return 'openai';
  throw new Error('No LLM credentials found. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
}

function modelFor(role) {
  // role = 'scorer' | 'drafter'
  const override = role === 'scorer' ? process.env.MODEL_SCORER : process.env.MODEL_DRAFTER;
  if (override) return override;
  if (process.env.MODEL) return process.env.MODEL;
  // Sensible defaults per provider
  const provider = pickProvider();
  if (provider === 'openrouter') {
    return role === 'scorer'
      ? 'anthropic/claude-haiku-4.5'
      : 'anthropic/claude-sonnet-4';
  }
  if (provider === 'anthropic') {
    return role === 'scorer'
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';
  }
  return role === 'scorer' ? 'gpt-4o-mini' : 'gpt-4o';
}

/**
 * complete({ system, user, role, jsonOnly, maxTokens })
 * Returns: parsed JSON if jsonOnly=true, else string.
 */
async function complete({ system, user, role = 'scorer', jsonOnly = false, maxTokens = 600 }) {
  const provider = pickProvider();
  const model = modelFor(role);

  if (provider === 'openrouter') {
    return callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: OPENROUTER_KEY,
      model, system, user, jsonOnly, maxTokens,
      extraHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/AdityaRuh/openclaw-template',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Hookline Lead Gen Agent'
      }
    });
  }

  if (provider === 'openai') {
    return callOpenAICompatible({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: OPENAI_KEY,
      model, system, user, jsonOnly, maxTokens
    });
  }

  // Anthropic (native API)
  return callAnthropic({ model, system, user, jsonOnly, maxTokens });
}

async function callOpenAICompatible({ url, apiKey, model, system, user, jsonOnly, maxTokens, extraHeaders = {} }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user }
    ]
  };
  if (jsonOnly) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  if (!jsonOnly) return content;
  // Some providers return JSON wrapped in ```json fences even with response_format
  const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
  return JSON.parse(cleaned);
}

async function callAnthropic({ model, system, user, jsonOnly, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json.content?.[0]?.text || '';
  if (!jsonOnly) return content;
  const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Quick connectivity test — returns { ok, provider, model, error? }
 */
async function ping() {
  try {
    const provider = pickProvider();
    const model = modelFor('scorer');
    const result = await complete({
      user: 'Reply with just the word: ok',
      role: 'scorer',
      maxTokens: 5
    });
    return { ok: true, provider, model, sample: String(result).slice(0, 20) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { complete, ping, pickProvider, modelFor };
