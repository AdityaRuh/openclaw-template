# SKILL: lead-scorer

Score a raw post 0-100 based on signal strength, ICP fit, and recency.

## When to use
- After every scrape cycle, batch-score all `raw_posts.processed=false`.

## Inputs
- A raw post record (see scraper output schema)
- USER.md content (for ICP definition)

## Scoring rubric
| Dimension | Weight | What to look for |
|---|---|---|
| Signal strength | 35 | Explicit "looking for / need / frustrated with" > implicit pain |
| ICP fit | 30 | Author profile matches ICP (role, company size, industry) |
| Recency | 15 | <6h = full points; >24h = half; >72h = zero |
| Specificity | 10 | Mentions exact problem we solve > vague pain |
| Reachability | 10 | Has public profile, accepts DMs, active in last 30d |

## Output
```json
{"external_id":"...","score":78,"reasoning":"Explicit 'looking for X', founder profile, posted 2h ago, mentions exact pain","signal_tags":["explicit_intent","icp_match"],"disqualifiers":[]}
```

## Disqualifiers (auto-zero)
- Author in `do_not_approach` list (from MEMORY.md)
- Post is a job ad / promotion / spam
- Author bio contains competitor product
- Lang != user's outreach lang

## Implementation
- File: `score.js`
- Calls LLM (OpenAI or Anthropic based on env) with a structured prompt.
- Returns parsed JSON.
