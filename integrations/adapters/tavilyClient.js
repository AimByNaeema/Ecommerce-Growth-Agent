'use strict';

// The ONE connection to Tavily's search API. A CONNECTION LAYER ONLY, exactly like
// agent/core/claudeClient.js and agent/core/geminiClient.js: it can run one search and
// return what Tavily returned. It decides nothing, retries nothing, caches nothing, and
// never invents a result - those concerns belong to agent/core/webSearchProvider.js (the
// search abstraction that selects between providers) and to the callers above it.
//
// RETRIEVAL, NEVER REASONING. Tavily returns real pages. It is never asked to analyse,
// summarise or judge anything - the AI provider does that, from these results. That split
// is what lets a URL be verified: it is evidence because SEARCH returned it.
//
// FAILURES ARE CLASSIFIED, NOT FLATTENED. Every failure resolves to one of the shared
// SEARCH_* statuses rather than throwing or degrading into "no results", because
// "we found nothing" and "our allowance ran out" are completely different facts and the
// caller must be able to tell them apart (see webSearchProvider.SEARCH_STATUSES).
//
// THE KEY NEVER SURFACES. It is read from the environment at call time, sent only in the
// Authorization header, and never written into a result, an error message, or a log.

const fs = require('fs');
const path = require('path');
const { withTimeout } = require('../../agent/core/networkRetry');

const API_URL = 'https://api.tavily.com/search';

// Tavily's own default is 5; kept small deliberately. Every extra result is a bigger
// prompt for the synthesis call, and this project's per-run token budget is 32,768.
const DEFAULT_MAX_RESULTS = 5;

let envLoadAttempted = false;

function loadEnvOnce() {
  if (envLoadAttempted) return;
  envLoadAttempted = true;
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error(`Warning: failed to load .env (${envPath}): ${err.message}`);
  }
}

function resolveCredentials() {
  loadEnvOnce();
  return { apiKey: process.env.TAVILY_API_KEY };
}

function isConfigured() {
  const { apiKey } = resolveCredentials();
  return Boolean(apiKey && apiKey.trim());
}

// Tavily separates "you are sending too fast" (429) from "your plan's credits are gone"
// (402, and the 432/433 codes its docs use for plan/usage limits). Both are surfaced
// distinctly because the operator's next action differs: wait, versus top up.
// The response text is also inspected, since providers move these codes around over time.
function classifyHttpFailure(status, message) {
  const text = String(message || '').toLowerCase();
  if (status === 401 || status === 403) return 'SEARCH_AUTH_FAILED';
  if (status === 402 || status === 432 || status === 433) return 'SEARCH_QUOTA_EXCEEDED';
  if (status === 429) {
    return /credit|quota|usage limit|plan limit|exceeded your/.test(text)
      ? 'SEARCH_QUOTA_EXCEEDED'
      : 'SEARCH_RATE_LIMITED';
  }
  if (status >= 500) return 'SEARCH_PROVIDER_UNAVAILABLE';
  return 'SEARCH_UNKNOWN_ERROR';
}

// One Tavily result -> the shared normalized shape. Only fields Tavily actually returned
// survive; anything absent stays null rather than becoming an empty string that would
// read like a real (but blank) value.
function normalizeResult(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const url = typeof entry.url === 'string' && entry.url.trim() !== '' ? entry.url.trim() : null;
  if (!url) return null;
  return {
    url,
    title: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : null,
    content: typeof entry.content === 'string' && entry.content.trim() !== '' ? entry.content.trim() : null,
    // Tavily's own relevance score. Relayed as-is; this project never recomputes or
    // reinterprets it, and never presents it as a market metric.
    score: typeof entry.score === 'number' ? entry.score : null,
    published_date: typeof entry.published_date === 'string' ? entry.published_date : null,
    provider: 'tavily',
  };
}

// Runs one search. ALWAYS resolves - never throws - so a caller can branch on `status`
// rather than wrapping every call in a try/catch that would flatten the distinctions.
async function search({ query, maxResults = DEFAULT_MAX_RESULTS, searchDepth = 'basic' } = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return { ok: false, status: 'SEARCH_UNKNOWN_ERROR', provider: 'tavily', query: null, results: [], detail: 'search requires a non-empty `query` string.' };
  }

  const { apiKey } = resolveCredentials();
  if (!apiKey || !apiKey.trim()) {
    return {
      ok: false,
      status: 'SEARCH_PROVIDER_NOT_CONFIGURED',
      provider: 'tavily',
      query,
      results: [],
      detail: 'TAVILY_API_KEY is not set. Add it to .env (see .env.example) to enable live web search. No Tavily request was attempted.',
    };
  }

  let response;
  try {
    response = await withTimeout((signal) =>
      fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: searchDepth }),
        signal,
      })
    );
  } catch (err) {
    // The message is the transport's, never the key's - nothing here echoes credentials.
    return { ok: false, status: 'SEARCH_NETWORK_ERROR', provider: 'tavily', query, results: [], detail: `Could not reach the Tavily API: ${err.message}` };
  }

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage = (raw && (raw.detail || raw.error || raw.message)) || response.statusText || '';
    const detailText = typeof apiMessage === 'object' ? JSON.stringify(apiMessage) : String(apiMessage);
    return {
      ok: false,
      status: classifyHttpFailure(response.status, detailText),
      provider: 'tavily',
      query,
      results: [],
      http_status: response.status,
      detail: `Tavily search failed (${response.status}): ${detailText}`,
    };
  }

  if (!raw || !Array.isArray(raw.results)) {
    return { ok: false, status: 'SEARCH_UNKNOWN_ERROR', provider: 'tavily', query, results: [], detail: 'Tavily returned a success response with an unexpected/missing results shape.' };
  }

  const results = raw.results.map(normalizeResult).filter(Boolean);
  return {
    ok: true,
    status: 'SEARCH_OK',
    provider: 'tavily',
    query,
    results,
    // Usage/credit fields only when Tavily actually reported them - never a guess.
    usage: raw.usage || null,
    response_time: typeof raw.response_time === 'number' ? raw.response_time : null,
  };
}

module.exports = {
  search,
  isConfigured,
  loadEnvOnce,
  resolveCredentials,
  normalizeResult,
  classifyHttpFailure,
  API_URL,
  DEFAULT_MAX_RESULTS,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Tavily search adapter (retrieval only):\n');
  console.log(`Endpoint: ${API_URL}`);
  console.log(`Configured: ${isConfigured() ? 'yes' : 'no (TAVILY_API_KEY is not set)'}`);
  console.log('\nThis module never reasons, never caches, and never invents a result.');
  console.log('Failure classification (status codes -> shared SEARCH_* vocabulary):');
  for (const [code, label] of [[401, 'auth'], [402, 'quota'], [429, 'rate limit or quota'], [503, 'unavailable']]) {
    console.log(`  HTTP ${code} -> ${classifyHttpFailure(code, '')}   (${label})`);
  }
}
