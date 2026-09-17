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
const { isQuotaExhaustedMessage } = require('./networkRetry');
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
  'SEARCH_TIMEOUT',
  // The provider answered, but with nothing usable: no results at all, or a reply that is not the
  // structured result the caller asked for. Neither is an outage, and neither is a success.
  'SEARCH_EMPTY_RESULTS',
  'SEARCH_MALFORMED_RESULTS',
  // The configured provider cannot perform this kind of search with the active AI provider (for
  // example Anthropic's hosted web_search while AI_PROVIDER=gemini).
  'SEARCH_UNSUPPORTED_CAPABILITY',
  // No provider call was made: a research usage limit for this run or business-day was reached
  // (agent/core/researchUsageGuard.js).
  'SEARCH_USAGE_LIMIT_REACHED',
  // This provider was not called: it recently reported its quota or credit exhausted and is cooling down.
  'SEARCH_PROVIDER_COOLDOWN',
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
  'SEARCH_TIMEOUT',
  'SEARCH_USAGE_LIMIT_REACHED',
  'SEARCH_PROVIDER_COOLDOWN',
];

// `requiresAiProvider`: a model-native search runs INSIDE one specific AI provider's turn, so it can
// only serve a run whose active AI provider is that one. An external provider serves any AI provider.
const SEARCH_PROVIDERS = {
  tavily: { id: 'tavily', mode: 'external', adapter: tavilyClient, requiresAiProvider: null },
  // Executed by the AI provider during its own turn - no adapter here, by design.
  claude_web_search: { id: 'claude_web_search', mode: 'model_native', adapter: null, requiresAiProvider: 'claude' },
  gemini_grounding: { id: 'gemini_grounding', mode: 'model_native', adapter: null, requiresAiProvider: 'gemini' },
};

// Ordered fallback search providers, tried only after the active one fails OPERATIONALLY (see
// getSearchProviderChain). Configuration, never inferred from which keys happen to be present.
const SEARCH_FALLBACK_PROVIDERS_ENV = 'SEARCH_FALLBACK_PROVIDERS';

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

// Whether a provider can serve a run on the given AI provider at all.
function supportsAiProvider(providerId, aiProviderId) {
  const entry = SEARCH_PROVIDERS[providerId];
  if (!entry) return false;
  return !entry.requiresAiProvider || entry.requiresAiProvider === aiProviderId;
}

// The providers a search call may use, in order: the active provider first, exactly as before,
// then each configured fallback that is a known provider, not already listed, compatible with the
// active AI provider (a fallback that would fail by construction is never offered) and configured.
// An unrecognised fallback name is ignored rather than guessed at.
function getSearchProviderChain({ aiProviderId = null } = {}) {
  const active = getActiveSearchProvider();
  const chain = [active];
  const raw = process.env[SEARCH_FALLBACK_PROVIDERS_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return chain;
  for (const name of raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (!SEARCH_PROVIDERS[name] || chain.includes(name)) continue;
    if (aiProviderId && !supportsAiProvider(name, aiProviderId)) continue;
    if (!isSearchConfigured(name)) continue;
    chain.push(name);
  }
  return chain;
}

// Maps a failure raised by an AI provider call that performed (or followed) a search onto the shared
// vocabulary. The clients report failures as messages naming the HTTP status ("Gemini API request
// failed (429): ..."); this reads those, never guesses a success. Anything unrecognised is
// SEARCH_UNKNOWN_ERROR - still a failure.
function classifyProviderFailure(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const code = Number((text.match(/\((\d{3})\)/) || [])[1]);
  if (/timed out|timeout/.test(lower)) return 'SEARCH_TIMEOUT';
  if (isQuotaExhaustedMessage(text)) {
    return 'SEARCH_QUOTA_EXCEEDED';
  }
  if (code === 401 || code === 403 || /invalid (api key|authentication)|unauthori[sz]ed|permission denied/.test(lower)) return 'SEARCH_AUTH_FAILED';
  if (code === 402) return 'SEARCH_QUOTA_EXCEEDED';
  if (code === 429) return 'SEARCH_RATE_LIMITED';
  if (code >= 500) return 'SEARCH_PROVIDER_UNAVAILABLE';
  if (/unexpected\/missing|unexpected .*shape|not valid json|malformed/.test(lower)) return 'SEARCH_MALFORMED_RESULTS';
  if (/could not reach|network|econn|enotfound|fetch failed/.test(lower)) return 'SEARCH_NETWORK_ERROR';
  return 'SEARCH_UNKNOWN_ERROR';
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
  SEARCH_TIMEOUT: 'Live market research is temporarily unavailable because the research provider did not answer in time.',
  SEARCH_EMPTY_RESULTS: 'Live market research ran but the research provider returned no usable results.',
  SEARCH_MALFORMED_RESULTS: 'Live market research ran but the research provider returned a result that could not be read.',
  SEARCH_UNSUPPORTED_CAPABILITY: 'The configured research provider cannot perform this kind of live research with the active AI provider.',
  SEARCH_USAGE_LIMIT_REACHED: 'Live market research was not run because the research usage limit has been reached. Existing research remains available.',
  SEARCH_PROVIDER_COOLDOWN: 'Live market research is temporarily unavailable because the research provider recently reported its allowance exhausted. Existing research remains available.',
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
  SEARCH_FALLBACK_PROVIDERS_ENV,
  getActiveSearchProvider,
  getSearchProviderChain,
  supportsAiProvider,
  classifyProviderFailure,
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
