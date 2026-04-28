# SKILL: outreach-drafter

Draft personalized first-touch outreach for a high-score lead, in the user's voice.

## When to use
- For any lead with score ≥ 75.

## Inputs
- Lead record (with the original post body)
- USER.md (voice, offer, ICP)
- memory/facts.md (statistics, social proof)
- Last 5 approved drafts from MEMORY.md (style reference)
- Last 5 rejected drafts (anti-style reference)

## Hard rules (non-negotiable)
1. **Max 4 sentences** for first-touch.
2. **Lead with their situation, not your product.** First sentence must reference something specific from their post.
3. **No corporate AI tells.** Banned phrases:
   - "I hope this email finds you well"
   - "I came across your post"
   - "I wanted to reach out"
   - "I noticed that you"
   - Em-dashes used for dramatic effect
4. **One ask only.** Either a question or a soft CTA — never both.
5. **No emojis** in cold first-touch (they read as templated).
6. **Match user's voice** from USER.md (lowercase if user writes lowercase, etc.).

## Output schema
```json
{
  "lead_external_id": "...",
  "channel": "reddit_dm | twitter_dm | reddit_comment",
  "subject": "(optional, for email)",
  "body": "...",
  "rationale": "Why this opener will land",
  "estimated_quality": 0-100
}
```

## Channel selection
- Reddit: prefer public reply if signal is asking for recommendations; DM if personal pain.
- Twitter: DM if author has DMs open; otherwise reply with a 1-line value-add.

## Implementation
- File: `draft.js`
- Reads lead record + post body from stdin (JSON), writes draft to stdout.
