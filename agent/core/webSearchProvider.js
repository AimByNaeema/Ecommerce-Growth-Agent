'use strict';

// WHICH web-search provider supplies evidence, kept deliberately separate from WHICH AI
// provider reasons about it (agent/core/aiProviderSelector.js). The two are different
// decisions and are configured independently:
//
//   AI_PROVIDER=gemini  SEARCH_PROVIDER=tavily            Tavily retrieves, Gemini reasons
//   AI_PROVIDER=claude  SEARCH_PROVIDER=claude_web_search Claude does both, as it always has
//   AI_PROVIDER=gemini  SEARCH_PROVIDER=gemini_grounding  Gemini does both, via Google Search
//
// Coupling them would mean a quota problem in one forced a provider change in the other,
// which is exactly the situation this split exists to avoid.
//
// THIS IS A SELECTOR, NOT A SEARCH ENGINE. It owns no endpoint, no HTTP call and no result
// parsing of its own: integrations/adapters/tavilyClient.js talks to Tavily, and the two
// model-native modes are executed by the caller through the AI provider it already uses.
// Adding a provider means adding an adapter and one entry in SEARCH_PROVIDERS.
//
// TWO EXECUTION MODES, because the providers genuinely differ:
//
//   'external'     - search runs as its own step BEFORE the model is called. The verified
//                    URL set comes from the search provider. The model never chooses what
//                    counts as a source; it only reasons over results it was handed.
//   'model_native' - the model calls a hosted search tool during its own turn (Anthropic's
//                    web_search, Google Search grounding). The verified URL set is read
//                    back out of the model response's search metadata - still the search
//                    tool's own output, never the model's prose.
//
// In BOTH modes the rule is identical and non-negotiable: a URL is evidence because the
// SEARCH TOOL returned it. A URL the model merely wrote in a sentence is never evidence.
//
// FAILURES ARE CLASSIFIED. SEARCH_STATUSES below is the shared vocabulary. "We searched and
// found nothing" and "our allowance is gone" must never collapse into the same answer: the
// first is a real research result, the second is an operational problem with a different
// fix, and only a caller that can tell them apart can report either honestly.

const tavilyClient = require('../../integrations/adapters/tavilyClient');
const { getCachedResult, setCachedResult } = require('./toolResultCache');

// The one place a search outcome's meaning is defined. Every provider adapter maps its own
// errors onto exactly these.
const SEARCH_STATUSES = [
  'SEARCH_OK',
  'SEARCH_PROVIDER_NOT_CONFIGURED',
  'SEARCH_QUOTA_EXCEEDED',
  'SEARCH_RATE_LIMITED',
  'SEARCH_AUTH_FAILED',
  'SEARCH_PROVIDER_UNAVAILABLE',
  'SEARCH_NETWORK_ERROR',
  'SEARCH_UNKNOWN_ERROR',
];

// A status that means "this provider cannot serve us right now", as distinct from
// "it served us and there was nothing there". Used by callers deciding whether a run's
// failure is operational (report it, keep prior research) or genuinely empty.
const OPERATIONAL_FAILURE_STATUSES = [
  'SEARCH_PROVIDER_NOT_CONFIGURED',
  'SEARCH_QUOTA_EXCEEDED',
  'SEARCH_RATE_LIMITED',
  'SEARCH_AUTH_FAILED',
  'SEARCH_PROVIDER_UNAVAILABLE',
  'SEARCH_NETWORK_ERROR',
];

const SEARCH_PROVIDERS = {
  tavily: { id: 'tavily', mode: 'external', adapter: tavilyClient },
  // Executed by the AI provider during its own turn - no adapter here, by design.
  claude_web_search: { id: 'claude_web_search', mode: 'model_native', adapter: null },
  gemini_grounding: { id: 'gemini_grounding', mode: 'model_native', adapter: null },
};

// Deliberate configured default (not a judgment about which provider is better):
// SEARCH_PROVIDER unset/blank means the model-native Claude path this project shipped
// with, so nothing changes for an existing install that never sets the variable.
const DEFAULT_SEARCH_PROVIDER = 'claude_web_search';

function getActiveSearchProvider() {
  tavilyClient.loadEnvOnce();
  const raw = process.env.SEARCH_PROVIDER;
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_SEARCH_PROVIDER;
  const normalized = raw.trim().toLowerCase();
  if (!SEARCH_PROVIDERS[normalized]) {
    throw new Error(
      `Unrecognized SEARCH_PROVIDER value '${raw}'. Set SEARCH_PROVIDER to one of: ` +
        `${Object.keys(SEARCH_PROVIDERS).join(', ')}, or leave it unset to use the default ` +
        `("${DEFAULT_SEARCH_PROVIDER}").`
    );
  }
  return normalized;
}

// 'external' or 'model_native' - see the header. Callers branch on this rather than on the
// provider id, so a future external provider needs no new branch.
function getSearchProviderMode(providerId = null) {
  const id = providerId || getActiveSearchProvider();
  return SEARCH_PROVIDERS[id].mode;
}

function isSearchConfigured(providerId = null) {
  const entry = SEARCH_PROVIDERS[providerId || getActiveSearchProvider()];
  // A model-native provider is configured exactly when its AI provider is - which the
  // caller already checks through aiProviderSelector.isConfigured() before calling.
  if (!entry.adapter) return true;
  return entry.adapter.isConfigured();
}

// What a person should be told, with no provider internals and no credentials in it. The
// technical `detail` stays on the outcome object for the audit trail and the run record.
const USER_FACING_MESSAGES = {
  SEARCH_OK: 'Live market research ran normally.',
  SEARCH_PROVIDER_NOT_CONFIGURED: 'Live market research is not configured.',
  SEARCH_QUOTA_EXCEEDED:
    'Live market research is temporarily unavailable because the web-search allowance has been reached. Existing research remains available.',
  SEARCH_RATE_LIMITED:
    'Live market research is temporarily unavailable because the web-search service is rate-limiting requests. Existing research remains available.',
  SEARCH_AUTH_FAILED: 'Live market research is not configured correctly, so it could not run.',
  SEARCH_PROVIDER_UNAVAILABLE: 'Live market research is temporarily unavailable.',
  SEARCH_NETWORK_ERROR: 'Live market research is temporarily unavailable.',
  SEARCH_UNKNOWN_ERROR: 'Live market research could not run.',
};

function userFacingStatusMessage(status) {
  return USER_FACING_MESSAGES[status] || USER_FACING_MESSAGES.SEARCH_UNKNOWN_ERROR;
}

function isOperationalFailure(status) {
  return OPERATIONAL_FAILURE_STATUSES.includes(status);
}

// Runs one search through the active EXTERNAL provider. Always resolves; never throws for
// a provider failure, so the caller branches on `status`.
//
// `cache` is an OPTIONAL agent/core/toolResultCache.js cache - the project's existing
// per-run memoizer, reused rather than duplicated. Passing one makes an identical query
// within the same run a cache hit instead of a second billed search. Queries are compared
// after whitespace/case normalization so two spellings of the same request collapse.
async function search({ query, maxResults, searchDepth, cache = null, providerId = null } = {}) {
  const id = providerId || getActiveSearchProvider();
  const entry = SEARCH_PROVIDERS[id];

  if (entry.mode !== 'external') {
    return {
      ok: false,
      status: 'SEARCH_UNKNOWN_ERROR',
      provider: id,
      query: typeof query === 'string' ? query : null,
      results: [],
      cached: false,
      detail: `Search provider '${id}' is model-native: its search runs inside the AI call and cannot be invoked as a separate step.`,
    };
  }

  const normalizedQuery = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ').toLowerCase() : null;
  const cacheParams = { query: normalizedQuery, maxResults: maxResults || null, searchDepth: searchDepth || null };
  const hit = getCachedResult(cache, `web_search:${id}`, cacheParams);
  if (hit) return { ...hit, cached: true };

  const outcome = await entry.adapter.search({ query, maxResults, searchDepth });
  const result = { ...outcome, provider: id, cached: false };
  // Only a real success is memoized. Caching a quota failure would make the rest of the run
  // report a stale operational error even if the allowance recovered.
  if (result.ok) setCachedResult(cache, `web_search:${id}`, cacheParams, result);
  return result;
}

// The URLs an external search actually returned - the verified set, in provider order.
// Reads ONLY the adapter's normalized results, so nothing a model wrote can enter it.
function verifiedUrlsFromSearch(searchOutcome) {
  if (!searchOutcome || !Array.isArray(searchOutcome.results)) return [];
  const urls = [];
  const seen = new Set();
  for (const result of searchOutcome.results) {
    const url = result && typeof result.url === 'string' ? result.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

module.exports = {
  SEARCH_STATUSES,
  OPERATIONAL_FAILURE_STATUSES,
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER,
  getActiveSearchProvider,
  getSearchProviderMode,
  isSearchConfigured,
  isOperationalFailure,
  userFacingStatusMessage,
  search,
  verifiedUrlsFromSearch,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - web search provider selection:\n');
  for (const entry of Object.values(SEARCH_PROVIDERS)) {
    console.log(`  ${entry.id.padEnd(20)} mode=${entry.mode.padEnd(13)} configured=${isSearchConfigured(entry.id)}`);
  }
  let active;
  try {
    active = getActiveSearchProvider();
  } catch (err) {
    console.error(`\nSTOP: ${err.message}`);
    process.exit(1);
  }
  console.log(`\nActive search provider: ${active} (mode: ${getSearchProviderMode(active)})`);
  console.log(`Active AI provider is chosen separately, via AI_PROVIDER.\n`);
  console.log('Statuses, and what a person would be told:');
  for (const status of SEARCH_STATUSES) {
    console.log(`  ${status.padEnd(32)} ${userFacingStatusMessage(status)}`);
  }
}
