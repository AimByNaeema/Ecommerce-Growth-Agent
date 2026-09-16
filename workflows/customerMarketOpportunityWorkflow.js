'use strict';

// Customer-related global market product research -> Top N opportunities for THIS business.
//
// THE POINT OF THIS MODULE is the direction of travel. It starts from the customer's own
// catalogue, derives the market they are actually in, researches THAT market globally, and
// only then ranks. A pipeline that started from "what is trending" would return ten
// products this business has no reason to sell.
//
//   customer catalogue -> market scope -> broad discovery -> cheap local filtering
//     -> deep validation of the shortlist only -> compliance/IP -> scoring -> Top N
//
// NOTHING HERE IS A SECOND RESEARCH OR PRODUCT AGENT. Every stage delegates:
//   agent/core/customerMarketScopeEngine.js   customer context + market scope (pure)
//   agent/core/aiProviderSelector.js          the ONLY public-web capability this project
//                                             has, reached through the active provider:
//                                             Claude's hosted web_search, or Gemini's
//                                             Google Search grounding
//   agent/core/opportunityCandidateEngine.js  de-duplication, customer fit, ranking (pure)
//   compliance/complianceEngine.js            the existing PASS/REVIEW/BLOCK boundary
//   compliance/etsyIpRiskDetector.js          the existing protected-mark pass
//   agent/core/productOpportunityScoringEngine.js  evidence coverage, reused unchanged
//
// PROVENANCE IS VERIFIED, NOT TRUSTED. A model can describe research it did not do and
// cite a URL that search never returned. So every candidate and every signal survives only
// when at least one of its claimed source URLs is in the set of URLs THE SEARCH TOOL ITSELF
// returned (aiProviderSelector.extractWebSearchResultUrls, which reads Anthropic's
// web_search_tool_result blocks or Gemini's groundingChunks depending on the active
// provider) - the same mechanical check tools/webCompetitorResearchTool.js already applies.
// A URL the model merely wrote in prose is never verified by either provider. Unverifiable
// entries are dropped, never downgraded and kept.
//
// WHAT THIS RUN CANNOT KNOW, AND SAYS SO. There is no search-volume provider, no trend API
// and no marketplace-insights feed in this project. Demand, competition and trend therefore
// arrive as cited QUALITATIVE assessments, and any numeric field a source did not supply is
// null with a stated reason - never 0, never a plausible-looking figure. Phase 12 of the
// request that specified this capability is the rule here: unavailable is an answer.
//
// IT ENDS AT OPPORTUNITIES. Nothing here creates, prices, lists or publishes a product on
// any channel. Acting on a ranked opportunity is a separate, human-approved decision.

const aiProviderSelector = require('../agent/core/aiProviderSelector');
const webSearchProvider = require('../agent/core/webSearchProvider');
const { createToolResultCache } = require('../agent/core/toolResultCache');
const { checkTokenBudget, normalizeUsage } = require('../agent/core/tokenControls');
const { buildCustomerMarketScope } = require('../agent/core/customerMarketScopeEngine');
const {
  dedupeCandidates,
  scoreCustomerFit,
  filterByCompliance,
  rankCandidates,
} = require('../agent/core/opportunityCandidateEngine');
const { evaluateCompliance } = require('../compliance/complianceEngine');
const { detectProtectedMarks } = require('../compliance/etsyIpRiskDetector');
const { createEmptyCustomerOpportunityResearch } = require('../agent/core/customerOpportunityResearchModel');
const { validateEvidence, minConfidence } = require('../agent/core/evidenceValidation');
const { classifyTrend, parseObservationDate } = require('../agent/core/trendEvidence');
const externalResearchMemory = require('../agent/core/externalResearchMemory');

// The tool id this research is stored and found again under (tools/toolRegistry.js).
const RESEARCH_TOOL_ID = 'catalogue_expansion_opportunities';

// Dated values a cited page itself states, for trend reasoning (agent/core/trendEvidence.js). Kept only when
// the page is one the search tool returned for this candidate, the date is real and the value is a number.
// Graded OBSERVED: the source states it; this system did not measure it.
function normalizeTrendObservations(raw, sources, provider) {
  const allowed = new Set(asArray(sources));
  const kept = [];
  for (const entry of asArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const source = typeof entry.source === 'string' ? entry.source.trim() : null;
    if (!source || !allowed.has(source)) continue;
    if (parseObservationDate(entry.date) === null) continue;
    if (entry.value === null || entry.value === '' || !Number.isFinite(Number(entry.value)) || Number(entry.value) < 0) continue;
    kept.push({
      date: String(entry.date).trim(),
      value: Number(entry.value),
      unit: nonEmptyString(entry.unit) ? entry.unit.trim() : null,
      metric: nonEmptyString(entry.metric) ? entry.metric.trim() : 'value',
      grade: 'OBSERVED',
      source,
      provider: provider || null,
      retrieved_at: new Date().toISOString(),
    });
  }
  return kept;
}

// The trend of one candidate, decided from dated observations only. The AI's own label is kept as
// source_assessment - what the pages were read as saying - and is never the classification.
function evidenceTrend({ entry, sources, provider, history }) {
  const label = entry && entry.trend && nonEmptyString(entry.trend.classification) ? entry.trend.classification.trim().toLowerCase() : 'unknown';
  const observations = normalizeTrendObservations(entry && entry.trend && entry.trend.observations, sources, provider);
  // This run's own measured/observed signal values join the series, dated now, so repeated research
  // builds real history over time.
  const now = new Date().toISOString();
  const current = [];
  for (const metric of ['demand', 'competition']) {
    const signal = entry && entry[metric];
    if (!signal || signal.value === null || signal.value === undefined || !Number.isFinite(Number(signal.value))) continue;
    if (!['measured', 'observed'].includes(String(signal.grade).toLowerCase())) continue;
    current.push({ date: now, value: Number(signal.value), unit: signal.unit || null, metric: `${metric}${signal.unit ? `:${signal.unit}` : ''}`, grade: String(signal.grade).toUpperCase(), source: sources[0] || null, provider });
  }
  const verdict = classifyTrend(asArray(history).concat(observations, current));
  const verified = verdict.verification === 'VERIFIED';
  return {
    metric: 'trend',
    classification: verdict.classification,
    evidence_status: verdict.evidence_status,
    verification: verdict.verification,
    assessment: verdict.reason,
    time_window: verdict.time_window,
    observations_used: verdict.observations_used,
    observations,
    evidence_sources: verdict.sources,
    providers: verdict.providers,
    source_assessment: {
      classification: label,
      assessment: entry && entry.trend && nonEmptyString(entry.trend.assessment) ? entry.trend.assessment : 'Not available from current research sources.',
      grade: 'inferred',
      note: 'What the cited pages were read as saying. Not a trend verdict: a trend needs dated values over time.',
    },
    grade: verified ? 'observed' : 'unknown',
    value: null,
    source: sources,
    confidence: verified ? (verdict.observations_used >= 8 ? 'medium' : 'low') : 'low',
  };
}

// The claims one ranked candidate rests on, for corroboration: every cited source with its grade, and
// each signal's value or classification against each source that supports it.
function corroborationClaims(candidate) {
  const claims = asArray(candidate.evidence).map((entry) => ({
    source_url: entry.source_url,
    grade: entry.grade,
    metric: entry.metric,
    retrieved_at: entry.retrieved_at || null,
  }));
  for (const metric of ['demand', 'competition', 'commercial']) {
    const signal = candidate[metric];
    if (!signal) continue;
    for (const url of asArray(signal.source)) {
      claims.push({ source_url: url, grade: signal.grade, metric, value: signal.value, unit: signal.unit, retrieved_at: signal.retrieved_at || null });
    }
  }
  const trend = candidate.trend;
  if (trend) {
    for (const url of asArray(trend.source)) {
      claims.push({ source_url: url, grade: trend.grade, metric: 'trend', classification: trend.classification });
    }
  }
  return claims;
}

// Evidence coverage caps confidence as before; corroboration can only lower it further.
function coverageConfidenceCap(percentage) {
  if (percentage >= 75) return 'high';
  if (percentage >= 50) return 'medium';
  return 'low';
}

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };
// Matches tools/webCompetitorResearchTool.js's own ceiling and reason: the shared
// per-call token cap in agent/core/tokenControls.js takes the minimum of this and the
// configured MAX_TOKENS_PER_CALL, so a small constant here would silently bind first.
const MAX_TOKENS = 8192;

// Staged budget. The whole run is deliberately a handful of BATCHED calls rather than one
// call per candidate: researching 50 candidates individually cannot fit inside this
// project's existing per-run ceilings (10 model calls, 15 research calls) and would spend
// real tokens proving that most candidates are irrelevant. Discovery is broad and cheap;
// deep validation is spent only on the shortlist that survived local filtering.
const DEFAULT_DISCOVERY_BATCHES = 2;
const DEFAULT_SHORTLIST_SIZE = 15;
const DEFAULT_TOP_LIMIT = 10;
// A candidate must clear this customer-fit score to earn deep research. This is the cheap
// filter that keeps token spend on things this business could actually sell.
const MIN_FIT_FOR_DEEP_RESEARCH = 20;

const DISCOVERY_SYSTEM_PROMPT = [
  'You are a product-opportunity researcher. You are given ONE business\'s real market scope.',
  'Use the web_search tool to find PRODUCT OPPORTUNITIES that are adjacent or related to that scope -',
  'products this kind of business could plausibly add, that real sources discuss.',
  '',
  'HARD RULES:',
  '- Report ONLY opportunities you actually found via web_search, each with the exact source URL you found it on.',
  '- Never invent a product, a market, a number, or a URL.',
  '- Do NOT report search volumes, revenue, market size, growth percentages or buyer counts unless the page itself states them.',
  '- Prefer breadth: many distinct opportunities beat a few described at length.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"candidates":[{"product":"short product name","market":"category it belongs to",',
  '"keywords":["..."],"why_related":"one sentence tying it to the given scope",',
  '"source":["https://exact-url-you-found-it-on"]}]}',
].join('\n');

const VALIDATION_SYSTEM_PROMPT = [
  'You are validating a shortlist of product opportunities for ONE business.',
  'Use the web_search tool to find real evidence about demand, competition, trend and typical price.',
  '',
  'HARD RULES:',
  '- Every claim must come from a page you actually opened, cited by exact URL.',
  '- If a page gives a NUMBER, report it with its unit and grade it "measured".',
  '- If you are characterising rather than measuring, set the value to null and grade it "inferred".',
  '- NEVER invent search volume, revenue, market size, growth %, competitor counts or buyer numbers.',
  '- trend.classification must be one of: growing, stable, seasonal, declining, emerging, fad, unknown.',
  '- trend.observations: ONLY dated numeric values a page itself states (e.g. a year-by-year or month-by-month figure),',
  '  each with its exact date (YYYY-MM or YYYY-MM-DD), value, unit, what it measures, and that page\'s exact URL.',
  '  If no page states dated values, return "observations":[] - never estimate, interpolate or read values off a chart.',
  '- A product that spikes yearly around one date is "seasonal", NOT "growing".',
  '- "unknown" is a correct answer when no source supports a classification.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"validated":[{"product":"exact name from the shortlist",',
  '"demand":{"assessment":"...","value":null,"unit":null,"grade":"measured|estimated|derived|inferred|unknown"},',
  '"competition":{"assessment":"...","value":null,"unit":null,"grade":"..."},',
  '"trend":{"classification":"...","assessment":"...","grade":"...","observations":[{"date":"YYYY-MM","value":0,"unit":"...","metric":"...","source":"https://exact-url"}]},',
  '"commercial":{"assessment":"...","price_low":null,"price_high":null,"currency":null,"grade":"..."},',
  '"source":["https://exact-url"]}]}',
].join('\n');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The live research call - provider chain, fallback, failure classification, budgeting and source verification -
// lives in agent/core/liveResearchCall.js, shared with live competitor research.
const {
  tryParseJson,
  extractFinalTextBlock,
  verifiedSources,
  recordUsage,
  recordSearch,
  totalTokensFromUsage,
  isMaxTokensStopReason,
  adaptSystemPromptForExternalSearch,
  formatSearchResults,
  runSearchCall,
} = require('../agent/core/liveResearchCall');

// --- Stage 2: broad discovery -------------------------------------------------------
// Several batched queries, each aimed at a different slice of the customer's scope, so the
// candidate pool is genuinely broad rather than one query's first page.
function buildDiscoveryPrompts(marketScope, batches) {
  const related = asArray(marketScope.related_markets);
  const intents = asArray(marketScope.buyer_intents);
  const targets = asArray(marketScope.requested_markets);
  const targetLine = targets.length > 0 ? `Target markets (countries/regions): ${targets.join(', ')}. Report demand evidence per market only where a source states it for that market.` : '';
  // Each entry pairs the model PROMPT with a concise SEARCH QUERY. An external provider
  // is given the query; a model-native provider composes its own from the prompt.
  const prompts = [
    [
      `Business's primary market: ${marketScope.primary_market}.`,
      related.length > 0 ? `It also sells in: ${related.join(', ')}.` : '',
      intents.length > 0 ? `Recurring themes in its catalogue: ${intents.slice(0, 10).join(', ')}.` : '',
      targetLine,
      '',
      'Find as many distinct PRODUCT OPPORTUNITIES as real sources support that are adjacent to this market -',
      'products this business could plausibly add next. Aim for breadth.',
    ]
      .filter(Boolean)
      .join('\n'),
  ];
  if (batches > 1) {
    prompts.push(
      [
        `Business's primary market: ${marketScope.primary_market}.`,
        intents.length > 0 ? `Buyer themes: ${intents.slice(0, 10).join(', ')}.` : '',
        targetLine,
        '',
        'Find PRODUCT OPPORTUNITIES that are currently in demand, newly emerging, or seasonally strong in this market',
        'and closely-related markets. Report what real sources say, including seasonality where stated.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return prompts.slice(0, batches);
}

async function discoverCandidates({ marketScope, batches, businessId, tokenTracker, stages, usageTotals, searchCache, searchStats }) {
  const candidates = [];
  const sourcesUsed = new Set();
  let calls = 0;

  const related = asArray(marketScope.related_markets);
  const targets = asArray(marketScope.requested_markets);
  const inMarkets = targets.length > 0 ? ` in ${targets.join(', ')}` : '';
  const discoveryQueries = [
    `products related to ${marketScope.primary_market} that online stores sell${inMarkets}`,
    `trending and seasonal products in ${marketScope.primary_market}${related.length > 0 ? ` and ${related[0]}` : ''}${inMarkets}`,
  ];
  const prompts = buildDiscoveryPrompts(marketScope, batches);
  for (let i = 0; i < prompts.length; i += 1) {
    const outcome = await runSearchCall({
      system: DISCOVERY_SYSTEM_PROMPT,
      prompt: prompts[i],
      query: discoveryQueries[i] || discoveryQueries[0],
      businessId,
      tokensUsedThisRun: tokenTracker.tokensUsedThisRun,
      searchCache,
    });
    calls += 1;
    recordSearch(searchStats, outcome);
    if (outcome.usage) {
      tokenTracker.tokensUsedThisRun += outcome.usage.tokensUsed || 0;
      recordUsage(usageTotals, outcome.usage);
    }
    if (!outcome.ok) {
      stages.push({ stage: 'discovery', status: 'failed', detail: outcome.reason, search_status: outcome.searchStatus || null });
      continue;
    }

    let kept = 0;
    let dropped = 0;
    for (const entry of asArray(outcome.parsed.candidates)) {
      if (!entry || !nonEmptyString(entry.product)) continue;
      const sources = verifiedSources(entry, outcome.verifiedUrls);
      if (sources.length === 0) {
        dropped += 1;
        continue;
      }
      sources.forEach((url) => sourcesUsed.add(url));
      candidates.push({
        product: entry.product.trim(),
        market: nonEmptyString(entry.market) ? entry.market.trim() : null,
        keywords: asArray(entry.keywords).filter(nonEmptyString),
        why_related: nonEmptyString(entry.why_related) ? entry.why_related.trim() : null,
        evidence: sources.map((url) => ({
          metric: 'discovery',
          assessment: entry.why_related || 'Reported as an opportunity related to this market.',
          value: null,
          unit: null,
          grade: 'inferred',
          source_url: url,
          retrieved_at: new Date().toISOString(),
        })),
      });
      kept += 1;
    }
    stages.push({
      stage: 'discovery',
      status: 'complete',
      detail: `${kept} candidate(s) kept with a verified source; ${dropped} dropped because no claimed URL was in the search results.`,
    });
  }

  return { candidates, sourcesUsed, calls };
}

// --- Stage 4: deep validation of the shortlist only ---------------------------------
async function validateShortlist({ shortlist, businessId, tokenTracker, stages, usageTotals, searchCache, searchStats }) {
  if (shortlist.length === 0) return { validated: new Map(), sourcesUsed: new Set(), calls: 0 };

  const prompt = [
    'Shortlisted product opportunities to validate:',
    ...shortlist.map((c, i) => `${i + 1}. ${c.product}${c.market ? ` (market: ${c.market})` : ''}`),
    '',
    'For each, search for real evidence of demand, competition, trend and typical price.',
    'Use the exact product name given above so the results can be matched back.',
  ].join('\n');

  const outcome = await runSearchCall({
    system: VALIDATION_SYSTEM_PROMPT,
    prompt,
    query: `${shortlist.slice(0, 5).map((c) => c.product).join(', ')} demand competition price`,
    businessId,
    tokensUsedThisRun: tokenTracker.tokensUsedThisRun,
    searchCache,
  });
  recordSearch(searchStats, outcome);
  if (outcome.usage) {
    tokenTracker.tokensUsedThisRun += outcome.usage.tokensUsed || 0;
    recordUsage(usageTotals, outcome.usage);
  }
  if (!outcome.ok) {
    stages.push({ stage: 'validation', status: 'failed', detail: outcome.reason, search_status: outcome.searchStatus || null });
    return { validated: new Map(), sourcesUsed: new Set(), calls: 1 };
  }

  const validated = new Map();
  const sourcesUsed = new Set();
  let dropped = 0;
  for (const entry of asArray(outcome.parsed.validated)) {
    if (!entry || !nonEmptyString(entry.product)) continue;
    const sources = verifiedSources(entry, outcome.verifiedUrls);
    if (sources.length === 0) {
      dropped += 1;
      continue;
    }
    sources.forEach((url) => sourcesUsed.add(url));
    validated.set(entry.product.trim().toLowerCase(), { entry, sources });
  }
  stages.push({
    stage: 'validation',
    status: 'complete',
    detail: `${validated.size} of ${shortlist.length} shortlisted candidate(s) returned verifiable evidence; ${dropped} dropped as unverifiable.`,
  });
  return { validated, sourcesUsed, calls: 1 };
}

// Normalizes one validated signal, enforcing the no-fabrication rule structurally: a value
// survives only when it is a real number AND the grade says it was measured or estimated.
// Anything else becomes null with the assessment preserved, so a characterisation can
// never be read back as a measurement.
function normalizeSignal(raw, sources, metric) {
  const grade = nonEmptyString(raw && raw.grade) ? raw.grade : 'unknown';
  const numeric = raw && Number.isFinite(Number(raw.value)) && raw.value !== null && raw.value !== '';
  const keepsValue = numeric && (grade === 'measured' || grade === 'estimated');
  return {
    metric,
    value: keepsValue ? Number(raw.value) : null,
    unit: keepsValue && nonEmptyString(raw.unit) ? raw.unit : null,
    grade: keepsValue ? grade : grade === 'unknown' ? 'unknown' : 'inferred',
    assessment: nonEmptyString(raw && raw.assessment)
      ? raw.assessment
      : 'Not available from current research sources.',
    source: sources,
    source_url: sources[0] || null,
    retrieved_at: new Date().toISOString(),
    confidence: keepsValue ? 'medium' : 'low',
  };
}

// --- Stage 5: compliance / IP -------------------------------------------------------
// Runs the EXISTING boundary over each candidate's own name. The protected-mark pass is
// reused directly; the structural proper-noun pass is deliberately NOT applied here,
// because a candidate name is a short phrase where sentence-initial capitalisation carries
// no meaning - that pass is for body copy.
function assessCandidateCompliance(candidate) {
  const content = [candidate.product, candidate.market, asArray(candidate.keywords).join(' ')]
    .filter(nonEmptyString)
    .join(' - ');

  const verdict = evaluateCompliance({
    content,
    content_type: 'product_opportunity',
    content_reference: candidate.canonical_key || candidate.product,
    provenance: {
      source: 'customer_market_opportunity_research',
      generator: 'workflows/customerMarketOpportunityWorkflow.js',
      evidence: asArray(candidate.evidence).map((e) => e.source_url).filter(Boolean),
      supported_facts: [],
    },
    required_checks: ['provenance', 'unsupported_claims', 'prohibited_content'],
  });

  const marks = detectProtectedMarks(content);
  if (marks.length > 0) {
    // A protected mark is a hard stop. It is never rewritten around, and a high-demand
    // brand term is never kept because it is popular.
    return {
      status: 'BLOCK',
      review_reasons: verdict.review_reasons,
      findings: marks.map((mark) => ({
        check_type: 'ip_indicators',
        severity: 'block',
        message: `Protected mark indicator '${mark.mark || mark}' appears in this opportunity. Excluded rather than reworded.`,
      })),
      limitations: verdict.limitations,
      checked_at: verdict.checked_at,
      checker_version: verdict.checker_version,
    };
  }

  return {
    status: verdict.status,
    review_reasons: verdict.review_reasons,
    findings: verdict.findings,
    limitations: verdict.limitations,
    checked_at: verdict.checked_at,
    checker_version: verdict.checker_version,
  };
}

// --- The pipeline -------------------------------------------------------------------
async function runCustomerMarketOpportunityResearch({
  businessConfig = null,
  catalogue = [],
  excludedCategories = [],
  limit = DEFAULT_TOP_LIMIT,
  discoveryBatches = DEFAULT_DISCOVERY_BATCHES,
  shortlistSize = DEFAULT_SHORTLIST_SIZE,
  businessId = null,
  tokensUsedThisRun = 0,
  // Countries/regions the request names. Scoping only: never a claim about those markets.
  requestedMarkets = [],
  // Cross-run reuse (agent/core/externalResearchMemory.js). Off unless the caller asks, so a direct call
  // never reads another run's research implicitly.
  reuseResearch = false,
  storeReference = null,
  researchStoreDir = undefined,
  now = Date.now(),
} = {}) {
  const result = createEmptyCustomerOpportunityResearch();
  const stages = [];
  const tokenTracker = { tokensUsedThisRun };
  // Real Claude usage accumulated across every batched call this run makes, so
  // agent/core/orchestratorExecutionContract.js's usage ledger records this tool's actual
  // cost rather than counting it as one flat tool call.
  const usageTotals = { model: null, inputTokens: 0, outputTokens: 0, tokensUsed: 0 };
  // The project's EXISTING per-run memoizer (agent/core/toolResultCache.js), reused rather
  // than a second cache: an identical query inside one run is served from it instead of
  // spending a second search credit.
  const searchCache = createToolResultCache();
  const searchStats = {
    provider: null,
    mode: null,
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    resultsReturned: 0,
    statuses: [],
    usage: [],
    attempts: [],
    failures: [],
    successfulCalls: 0,
  };
  const limitations = [];

  // Stage 1 - customer context and market scope, from the business's own real data.
  const scopeOutcome = buildCustomerMarketScope({ businessConfig, catalogue, excludedCategories });
  result.customer_context = scopeOutcome.customer_context;
  result.market_scope = scopeOutcome.market_scope || {};
  stages.push({ stage: 'customer_scope', status: scopeOutcome.status, detail: `${scopeOutcome.customer_context.product_count} catalogue record(s) read.` });

  if (scopeOutcome.status === 'needs_information') {
    // The niche could not be identified, so no research is attempted against a guessed
    // market. This is the honest stop, not a failure to try.
    result.status = 'needs_information';
    result.limitations = scopeOutcome.missing_information.concat([
      'No market research was attempted: researching a market this business may not be in would produce opportunities for someone else.',
    ]);
    result.research_summary = { stages, sources_used: [], verified_source_count: 0, model_calls: 0, usage: { ...usageTotals }, generated_at: new Date().toISOString() };
    return result;
  }

  result.market_scope.requested_markets = [...new Set(asArray(requestedMarkets).filter(nonEmptyString).map((m) => m.trim()))];

  // CROSS-RUN REUSE. The same question for the same business and store, answered successfully within the
  // freshness limit, is served from the stored run - with its original sources, timestamps and run id -
  // instead of spending new searches. Anything else (a different scope, a failed or partial run, stale
  // research) is researched fresh. Checked BEFORE the provider checks: valid research stays usable even
  // while a provider is unavailable.
  const researchKey = externalResearchMemory.buildResearchKey({
    toolId: RESEARCH_TOOL_ID,
    businessId,
    storeReference,
    scope: result.market_scope,
    requestedMarkets: result.market_scope.requested_markets,
    excludedCategories,
    limit,
  });
  let freshMode = 'fresh';
  let freshReason = 'No stored research answered this question, so live research ran.';
  if (reuseResearch) {
    const found = externalResearchMemory.findReusableExternalResearch({ toolId: RESEARCH_TOOL_ID, researchKey, businessId, now, storeDir: researchStoreDir });
    if (found.research) {
      const reused = JSON.parse(JSON.stringify(found.research.result));
      const reason = `Reused live research from run ${found.research.source_run_id}, produced ${found.research.produced_at} (${found.research.age_hours} hour(s) old, within the ${externalResearchMemory.getExternalResearchMaxAgeHours()}-hour limit). No new search or model call was made.`;
      reused.research_memory = {
        ...reused.research_memory,
        mode: 'reused',
        reason,
        source_run_id: found.research.source_run_id,
        reused_at: new Date(now).toISOString(),
      };
      reused.limitations = [reason].concat(asArray(reused.limitations).filter((line) => !/^Reused live research from run/.test(line)));
      return reused;
    }
    if (found.considered.stale > 0) {
      freshMode = 'refreshed';
      freshReason = `Stored research for this question was older than the ${externalResearchMemory.getExternalResearchMaxAgeHours()}-hour limit (newest produced ${found.considered.newest_stale_produced_at}), so it was refreshed with live research.`;
    } else if (found.considered.not_successful > 0) {
      freshReason = 'Stored research for this question did not complete successfully, so it was not reused; live research ran.';
    }
  }

  searchStats.provider = webSearchProvider.getActiveSearchProvider();
  searchStats.mode = webSearchProvider.getSearchProviderMode();

  if (!aiProviderSelector.isConfigured({ businessId })) {
    result.status = 'needs_information';
    result.limitations = [
      `The active AI provider (${aiProviderSelector.getActiveProvider()}) is not configured, so the live web research this capability depends on could not run. Set its API key in .env. The customer context and market scope above were still derived from real business data.`,
    ];
    result.research_summary = { stages, sources_used: [], verified_source_count: 0, model_calls: 0, usage: { ...usageTotals }, search: { ...searchStats }, generated_at: new Date().toISOString() };
    return result;
  }

  // The SEARCH provider is a separate dependency from the AI provider, and is reported as
  // one: 'we cannot search' is a different problem from 'we cannot reason', with a
  // different fix. Reported BEFORE any call is attempted, so no allowance is spent proving
  // something the configuration already tells us.
  if (!webSearchProvider.isSearchConfigured()) {
    const status = 'SEARCH_PROVIDER_NOT_CONFIGURED';
    stages.push({ stage: 'discovery', status: 'failed', detail: `Search provider '${searchStats.provider}' is not configured.`, search_status: status });
    searchStats.statuses.push(status);
    result.status = 'needs_information';
    result.search_status = status;
    result.search_status_message = webSearchProvider.userFacingStatusMessage(status);
    result.limitations = [
      `${webSearchProvider.userFacingStatusMessage(status)} The configured search provider is '${searchStats.provider}' and its API key is not set, so no live web search was attempted. The customer context and market scope above were still derived from real business data.`,
    ];
    result.research_summary = { stages, sources_used: [], verified_source_count: 0, model_calls: 0, usage: { ...usageTotals }, search: { ...searchStats }, generated_at: new Date().toISOString() };
    return result;
  }

  // Stage 2 - broad discovery.
  const discovery = await discoverCandidates({
    marketScope: result.market_scope,
    batches: Math.max(1, discoveryBatches),
    businessId,
    tokenTracker,
    stages,
    usageTotals,
    searchCache,
    searchStats,
  });
  const sourcesUsed = new Set(discovery.sourcesUsed);
  let modelCalls = discovery.calls;
  result.candidate_count.discovered = discovery.candidates.length;

  // Stage 3 - cheap local filtering: de-duplicate, then measure customer fit and keep only
  // what is plausibly this business's. No tokens are spent here at all.
  const deduped = dedupeCandidates(discovery.candidates);
  result.candidate_count.after_deduplication = deduped.length;
  const withFit = deduped.map((candidate) => ({ ...candidate, customer_fit: scoreCustomerFit(candidate, result.market_scope) }));
  const passedFit = withFit.filter((c) => c.customer_fit.score >= MIN_FIT_FOR_DEEP_RESEARCH);
  const shortlist = passedFit
    .sort((a, b) => b.customer_fit.score - a.customer_fit.score)
    .slice(0, Math.max(0, shortlistSize));
  // Candidates the cheap filter removed, recorded with their reason. Without this the
  // funnel counts would show a drop from N unique candidates to a smaller shortlist with
  // nothing saying which ones went or why - an invisible decision. Note these were dropped
  // for IRRELEVANCE before any deep research or IP screening was spent on them; nothing
  // unscreened can reach the ranked output, because compliance runs on everything that
  // survives this point.
  const fitFiltered = withFit
    .filter((c) => c.customer_fit.score < MIN_FIT_FOR_DEEP_RESEARCH)
    .map((c) => ({
      product: c.product,
      compliance_status: null,
      reason: `Dropped before deep research: customer-fit score ${c.customer_fit.score} is below the threshold of ${MIN_FIT_FOR_DEEP_RESEARCH}. ${c.customer_fit.reason}`,
      findings: [],
    }))
    .concat(
      passedFit.slice(Math.max(0, shortlistSize)).map((c) => ({
        product: c.product,
        compliance_status: null,
        reason: `Cleared the customer-fit threshold but fell outside the ${shortlistSize}-candidate shortlist that deep research is spent on.`,
        findings: [],
      }))
    );
  stages.push({
    stage: 'local_filtering',
    status: 'complete',
    detail: `${deduped.length} unique candidate(s); ${shortlist.length} scored at or above the customer-fit threshold of ${MIN_FIT_FOR_DEEP_RESEARCH} and earned deep research.`,
  });

  // Stage 4 - deep validation, shortlist only.
  const validation = await validateShortlist({ shortlist, businessId, tokenTracker, stages, usageTotals, searchCache, searchStats });
  modelCalls += validation.calls;
  validation.sourcesUsed.forEach((url) => sourcesUsed.add(url));

  const history = (product) =>
    reuseResearch ? externalResearchMemory.collectHistoricalObservations({ toolId: RESEARCH_TOOL_ID, businessId, productKey: product, storeDir: researchStoreDir }) : [];
  const enriched = shortlist.map((candidate) => {
    const match = validation.validated.get(candidate.product.toLowerCase());
    if (!match) {
      return {
        ...candidate,
        demand: normalizeSignal(null, [], 'demand'),
        competition: normalizeSignal(null, [], 'competition'),
        trend: evidenceTrend({ entry: null, sources: [], provider: searchStats.provider, history: history(candidate.product) }),
        commercial: normalizeSignal(null, [], 'commercial'),
      };
    }
    const { entry, sources } = match;
    return {
      ...candidate,
      evidence: candidate.evidence.concat(
        sources.map((url) => ({ metric: 'validation', assessment: 'Validation evidence.', value: null, unit: null, grade: 'inferred', source_url: url, retrieved_at: new Date().toISOString() }))
      ),
      demand: normalizeSignal(entry.demand, sources, 'demand'),
      competition: normalizeSignal(entry.competition, sources, 'competition'),
      trend: evidenceTrend({ entry, sources, provider: searchStats.provider, history: history(candidate.product) }),
      commercial: normalizeSignal(entry.commercial, sources, 'commercial'),
    };
  });

  // Stage 5 - compliance / IP on every remaining candidate.
  const withCompliance = enriched.map((candidate) => ({ ...candidate, compliance: assessCandidateCompliance(candidate) }));
  const { eligible, excluded } = filterByCompliance(withCompliance);
  result.candidate_count.compliance_eligible = eligible.length;
  stages.push({ stage: 'compliance', status: 'complete', detail: `${eligible.length} eligible, ${excluded.length} excluded (BLOCK or no verdict).` });

  // Stage 6 - evidence coverage + customer fit -> rank -> Top N.
  const scored = eligible.map((candidate) => {
    // Coverage is a mechanical count of how many of this result's own signal dimensions
    // carry real evidence - the same "measure what exists, judge nothing" principle
    // agent/core/productOpportunityScoringEngine.js applies to its 8 dimensions.
    const dimensions = ['demand', 'competition', 'trend', 'commercial'];
    const available = dimensions.filter((d) => {
      const signal = candidate[d];
      if (!signal) return false;
      if (d === 'trend') return signal.classification !== 'unknown';
      return signal.value !== null || (signal.grade !== 'unknown' && asArray(signal.source).length > 0);
    }).length;
    return {
      ...candidate,
      coverage_score: {
        dimensions_total: dimensions.length,
        dimensions_available: available,
        dimensions_missing: dimensions.length - available,
        percentage: Math.round((available / dimensions.length) * 100),
      },
    };
  });

  const ranking = rankCandidates(scored, { limit });
  result.candidate_count.ranked = ranking.ranked.length;

  for (const candidate of ranking.ranked) {
    candidate.validation = validateEvidence({ claims: corroborationClaims(candidate) });
  }
  result.top_opportunities = ranking.ranked.map((candidate) => ({
    rank: candidate.rank,
    product: candidate.product,
    customer_fit_reason: candidate.customer_fit.reason,
    market: candidate.market,
    demand: candidate.demand,
    competition: candidate.competition,
    trend: candidate.trend,
    commercial: candidate.commercial,
    scores: {
      customer_fit: candidate.customer_fit.score,
      evidence_coverage: candidate.coverage_score.percentage,
      rank_score: candidate.rank_score,
      rank_basis:
        'Equal-weight mean of evidence coverage and customer fit, both mechanical measurements. This orders by "best-evidenced and most relevant to this business" - it is NOT a prediction of sales or profit.',
      matched_terms: candidate.customer_fit.matched_terms,
    },
    compliance: candidate.compliance,
    // Multi-source corroboration (agent/core/evidenceValidation.js): one site, however many pages, is
    // one source, and too few independent sources can never produce more than low confidence.
    validation: candidate.validation,
    confidence: minConfidence(candidate.validation.confidence, coverageConfidenceCap(candidate.coverage_score.percentage)),
    evidence: candidate.evidence,
    variant_names: candidate.variant_names,
    mention_count: candidate.mention_count,
    specialized_records: { coverage_score: candidate.coverage_score, customer_fit: candidate.customer_fit },
  }));

  result.excluded_opportunities = fitFiltered
    .concat(excluded)
    .concat(ranking.dropped.map((d) => ({ product: d.product, compliance_status: null, reason: d.reason, findings: [] })));

  // Limitations: state plainly what this run could not establish.
  limitations.push(
    'No search-volume provider, trend API or marketplace-insights feed is connected to this project. Demand, competition and trend are cited qualitative assessments; any metric a source did not state is reported as null, never as 0 or an estimate presented as a measurement.'
  );
  if (result.candidate_count.discovered === 0) {
    limitations.push('Live discovery returned no candidate with a verifiable source URL, so no opportunity could be ranked.');
  }
  const uncorroborated = result.top_opportunities.filter((item) => item.validation.status !== 'corroborated');
  if (uncorroborated.length > 0) {
    limitations.push(
      `${uncorroborated.length} of ${result.top_opportunities.length} ranked opportunit(ies) are not corroborated by at least ${uncorroborated[0].validation.min_independent_sources} independent source domain(s) without conflict, so their confidence is capped (see each opportunity's validation).`
    );
  }
  if (ranking.ranked.length < limit) {
    limitations.push(
      `Fewer than ${limit} opportunities are reported (${ranking.ranked.length}). Remaining slots are deliberately left empty rather than filled with weakly-evidenced or irrelevant candidates.`
    );
  }
  const unverifiedTrends = result.top_opportunities.filter((item) => item.trend && item.trend.verification !== 'VERIFIED').length;
  if (unverifiedTrends > 0) {
    limitations.push(
      `Trend is NOT VERIFIED for ${unverifiedTrends} of ${result.top_opportunities.length} ranked opportunit(ies): a trend is decided only from dated measured or observed values over time, and not enough were available. The pages' own reading is kept as source_assessment, not as a trend.`
    );
  }
  if (asArray(result.market_scope.geographies).length === 0) {
    limitations.push('No target geography is declared in configuration/business.yaml, so this research is not geographically scoped and was not assumed to be global.');
  }

  // An OPERATIONAL search failure (allowance gone, rate limited, provider down) is a
  // different fact from 'we searched and found nothing', and is reported as such so a
  // caller can keep prior research and tell the user why this run is not fresh.
  // Only failures that ENDED a call count here: one a fallback provider recovered from left that call
  // with real research, and is kept in research_summary.search.attempts for the record.
  const unrecovered = asArray(searchStats.unrecoveredFailures);
  const operationalStatus = unrecovered.find((status) => webSearchProvider.isOperationalFailure(status)) || null;
  // No call succeeded at all, and the reason was not an outage: the provider answered with nothing
  // usable (empty, unreadable, unsupported). Still a failure - never SEARCH_OK.
  const nothingSucceeded = (searchStats.successfulCalls || 0) === 0 && unrecovered.length > 0;
  const failureStatus = operationalStatus || (nothingSucceeded ? unrecovered[0] : null);
  if (failureStatus) {
    result.search_status = failureStatus;
    result.search_status_message = webSearchProvider.userFacingStatusMessage(failureStatus);
    limitations.push(
      `${webSearchProvider.userFacingStatusMessage(failureStatus)} (search provider: ${searchStats.provider}, status: ${failureStatus}).`
    );
  } else if (searchStats.mode) {
    result.search_status = 'SEARCH_OK';
    result.search_status_message = webSearchProvider.userFacingStatusMessage('SEARCH_OK');
  }

  result.limitations = limitations;
  result.research_memory = externalResearchMemory.describeResearchMemory({
    researchKey,
    mode: freshMode,
    reason: freshReason,
    provider: searchStats.provider,
  });
  result.research_summary = {
    stages,
    sources_used: [...sourcesUsed],
    verified_source_count: sourcesUsed.size,
    model_calls: modelCalls,
    tokens_used_this_run: tokenTracker.tokensUsedThisRun,
    usage: { ...usageTotals },
    // Search cost, tracked separately from token cost - different provider, different bill.
    search: { ...searchStats },
    generated_at: new Date().toISOString(),
  };
  // 'complete' only when real opportunities came back. A run whose SEARCH failed
  // operationally is never 'complete', even if the pipeline itself ran cleanly.
  result.status = result.top_opportunities.length > 0 && !failureStatus ? 'complete' : 'partial';
  return result;
}

module.exports = {
  DEFAULT_TOP_LIMIT,
  DEFAULT_SHORTLIST_SIZE,
  DEFAULT_DISCOVERY_BATCHES,
  MIN_FIT_FOR_DEEP_RESEARCH,
  DISCOVERY_SYSTEM_PROMPT,
  VALIDATION_SYSTEM_PROMPT,
  buildDiscoveryPrompts,
  formatSearchResults,
  adaptSystemPromptForExternalSearch,
  recordSearch,
  normalizeSignal,
  assessCandidateCompliance,
  runCustomerMarketOpportunityResearch,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer market opportunity workflow:\n');
  console.log('Pipeline: customer catalogue -> market scope -> broad discovery -> cheap local');
  console.log('filtering -> deep validation of the shortlist only -> compliance/IP -> Top N.\n');
  console.log(`Discovery batches (default): ${DEFAULT_DISCOVERY_BATCHES}`);
  console.log(`Shortlist size (default)   : ${DEFAULT_SHORTLIST_SIZE}`);
  console.log(`Customer-fit threshold     : ${MIN_FIT_FOR_DEEP_RESEARCH}`);
  console.log(`Top N (default)            : ${DEFAULT_TOP_LIMIT}`);
  console.log('\nWith no business context, no live call is made at all:');
  runCustomerMarketOpportunityResearch({ businessConfig: {}, catalogue: [] }).then((res) => {
    console.log(`  status: ${res.status}`);
    for (const item of res.limitations) console.log(`   - ${item}`);
  });
}
