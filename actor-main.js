const Apify = require('apify');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Default configuration
const DEFAULT_CHUNK_CHARS = 3000;
const MAX_CHUNKS = 12;

/**
 * Apify Actor entrypoint.
 *
 * Behavior:
 * - Accepts input.json containing { url, model?, max_tokens?, temperature?, chunk_chars?, pause_between_calls_ms?, auth_type? }
 * - Scrapes the page body text (CheerioCrawler), chunks long text, summarizes each chunk via Anthropic Claude,
 *   then aggregates the chunk summaries into a final summary.
 * - Saves results to the default dataset.
 *
 * Authentication:
 * - The actor reads CLAUDE_API_KEY from environment variables.
 * - Default header is x-api-key. You may set CLAUDE_AUTH_TYPE to "bearer" to use Authorization: Bearer <token>.
 */

Apify.main(async () => {
    const input = await Apify.getInput() || {};
    const startUrl = input.url;
    if (!startUrl) throw new Error('Provide input with { "url": "https://example.com" }');

    const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
    if (!CLAUDE_API_KEY) throw new Error('Set CLAUDE_API_KEY as an environment variable in Apify');

    // Auth type: "x-api-key" (default) or "bearer"
    const CLAUDE_AUTH_TYPE = (process.env.CLAUDE_AUTH_TYPE || input.auth_type || 'x-api-key').toLowerCase();
    const MODEL = input.model || process.env.CLAUDE_MODEL || 'claude-2.1';
    const MAX_TOKENS = input.max_tokens || 800;
    const TEMPERATURE = input.temperature ?? 0.2;
    const CHUNK_CHARS = input.chunk_chars || DEFAULT_CHUNK_CHARS;
    const PAUSE_MS = input.pause_between_calls_ms || 0;

    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({ url: startUrl });

    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        maxRequestsPerCrawl: 1,
        handlePageFunction: async ({ request, $ }) => {
            const rawText = $('body').text().replace(/\s+/g, ' ').trim();
            if (!rawText) {
                await Apify.pushData({ url: request.url, error: 'No text extracted' });
                return;
            }

            const chunks = chunkText(rawText, CHUNK_CHARS);
            if (chunks.length > MAX_CHUNKS) {
                console.warn(`Truncating ${chunks.length} -> ${MAX_CHUNKS} chunks to limit API usage.`);
                chunks.length = MAX_CHUNKS;
            }

            const chunkSummaries = [];
            const chunkResponses = [];

            for (let i = 0; i < chunks.length; i++) {
                const prompt = buildChunkPrompt(chunks[i], i + 1, chunks.length);
                const claudeResp = await callClaude(prompt, {
                    apiKey: CLAUDE_API_KEY,
                    authType: CLAUDE_AUTH_TYPE,
                    model: MODEL,
                    max_tokens_to_sample: MAX_TOKENS,
                    temperature: TEMPERATURE,
                });
                const text = extractTextFromClaude(claudeResp);
                chunkSummaries.push({ index: i + 1, length: chunks[i].length, summary: text });
                chunkResponses.push(claudeResp);
                if (PAUSE_MS) await sleep(PAUSE_MS);
            }

            const aggregationPrompt = buildAggregationPrompt(chunkSummaries.map(s => s.summary));
            const aggResp = await callClaude(aggregationPrompt, {
                apiKey: CLAUDE_API_KEY,
                authType: CLAUDE_AUTH_TYPE,
                model: MODEL,
                max_tokens_to_sample: MAX_TOKENS,
                temperature: TEMPERATURE,
            });
            const finalSummary = extractTextFromClaude(aggResp);

            await Apify.pushData({
                url: request.url,
                input,
                scraped_text_length: rawText.length,
                chunk_count: chunkSummaries.length,
                chunk_summaries: chunkSummaries,
                chunk_responses: chunkResponses,
                aggregated_response: aggResp,
                final_summary: finalSummary,
                timestamp: new Date().toISOString(),
            });

            console.log('Saved aggregated summary for', request.url);
        },
        handleFailedRequestFunction: async ({ request }) => {
            console.error('Request failed:', request.url);
            await Apify.pushData({ url: request.url, failed: true });
        },
    });

    await crawler.run();
});

/* Helpers */

function chunkText(text, maxChars) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let end = i + maxChars;
        if (end < text.length) {
            const slice = text.slice(i, end + 200);
            const lastDot = slice.lastIndexOf('. ');
            if (lastDot > 0 && lastDot < slice.length - 1) {
                end = i + lastDot + 1;
            }
        }
        chunks.push(text.slice(i, end).trim());
        i = end;
    }
    return chunks;
}

function buildChunkPrompt(chunkText, chunkIndex, totalChunks) {
    return `You are a helpful assistant. Summarize the following chunk of a web page in concise bullet points (3–8 bullets), highlight the most important facts, and list any named entities (people, organizations, products, locations).

Chunk ${chunkIndex}/${totalChunks}:
${chunkText}

Summary:`;
}

function buildAggregationPrompt(chunkSummaries) {
    const joined = chunkSummaries.map((s, idx) => `Chunk ${idx + 1} summary:\n${s}`).join('\n\n');
    return `You are a helpful assistant. Given the following summaries, produce:

HEADLINE: a 1-2 sentence headline.
SUMMARY: 6-12 concise bullet points capturing key facts/insights across all chunks.
ENTITIES: a deduplicated list of named entities (people, organizations, products, locations).

Here are the chunk summaries:

${joined}

Provide the aggregated output labeled exactly as HEADLINE:, SUMMARY:, ENTITIES:.`;
}

async function callClaude(prompt, { apiKey, authType, model, max_tokens_to_sample, temperature }) {
    const url = 'https://api.anthropic.com/v1/complete';
    const headers = { 'Content-Type': 'application/json' };
    if (authType === 'bearer' || authType === 'authorization') {
        headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
        headers['x-api-key'] = apiKey;
    }

    const body = { model, prompt, max_tokens_to_sample, temperature };

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Claude API error ${res.status}: ${txt}`);
    }
    if (contentType.includes('application/json')) return await res.json();
    const txt = await res.text();
    return { text: txt };
}

function extractTextFromClaude(resp) {
    try {
        if (!resp) return '';
        if (typeof resp.completion === 'string') return resp.completion;
        if (resp.completion && Array.isArray(resp.completion.data) && resp.completion.data[0].text) return resp.completion.data[0].text;
        if (Array.isArray(resp.output)) {
            const o = resp.output[0];
            if (typeof o === 'string') return o;
            if (o && (o.content || o.text)) return o.content || o.text;
            if (o && Array.isArray(o.content) && o.content[0] && o.content[0].text) return o.content[0].text;
        }
        if (typeof resp.text === 'string') return resp.text;
        if (typeof resp.response === 'string') return resp.response;
        if (typeof resp.message === 'string') return resp.message;
        if (resp?.result?.content) {
            if (typeof resp.result.content === 'string') return resp.result.content;
            if (Array.isArray(resp.result.content) && resp.result.content[0].text) return resp.result.content[0].text;
        }
        return JSON.stringify(resp).slice(0, 3000);
    } catch (e) {
        return JSON.stringify(resp).slice(0, 3000);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
