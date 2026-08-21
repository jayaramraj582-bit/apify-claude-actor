# Apify → Claude Actor (chunked + aggregated)

This repository contains an Apify Actor that:

- Scrapes a web page using CheerioCrawler.
- Splits long page text into chunks.
- Summarizes each chunk with Anthropic Claude.
- Aggregates the chunk summaries into a final headline, bullet summary, and entity list.

This actor is configurable and supports both `x-api-key` and `Authorization: Bearer` styles for Anthropic auth.

## Quickstart

1. Create an Apify Actor (or use this repo locally).

2. Install dependencies:

   npm install

3. Set environment variables (in Apify Actor settings or locally):

   - `CLAUDE_API_KEY` — your Anthropic API key/token (do NOT commit this to the repo)
   - `CLAUDE_AUTH_TYPE` — optional, `x-api-key` (default) or `bearer`
   - Optional: `CLAUDE_MODEL` — default model to use (e.g., `claude-2.1`)

4. Run the actor locally:

   export CLAUDE_API_KEY="YOUR_KEY"
   export CLAUDE_AUTH_TYPE="x-api-key"   # or "bearer"
   node actor-main.js

   (Or `npm start`)

5. Run on Apify:

   - Upload these files to an Actor on apify.com (or connect this GitHub repo).
   - In Actor settings → Environment variables, add `CLAUDE_API_KEY` and optionally `CLAUDE_AUTH_TYPE` and `CLAUDE_MODEL`.
   - Run the Actor with input JSON (see `input.json`).

## Input

Example `input.json`:

```json
{
  "url": "https://example.com",
  "model": "claude-2.1",
  "max_tokens": 800,
  "temperature": 0.2,
  "chunk_chars": 3000,
  "pause_between_calls_ms": 250,
  "auth_type": "x-api-key"
}
```

## Notes

- Default auth header is `x-api-key`. If your Anthropic account requires `Authorization: Bearer <token>`, set `CLAUDE_AUTH_TYPE` to `bearer` or pass `auth_type` in the input.
- The actor truncates to a maximum number of chunks (12) to avoid runaway API usage; adjust `MAX_CHUNKS` in `actor-main.js` if needed.
- Never commit your API keys. Use Apify Actor environment variables to store secrets.

## Customization ideas

- Add retry/backoff logic for Claude calls.
- Push results to Slack, Google Sheets, or a webhook.
- Use Anthropic's chat/responses API shape if required by your account.
