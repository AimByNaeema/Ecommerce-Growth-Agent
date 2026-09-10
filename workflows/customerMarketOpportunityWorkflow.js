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
//   agent/core/claudeClient.js + web_search   the ONLY public-web capability this project
//                                             has, reached exactly as
//                                             tools/webCompetitorResearchTool.js does
//   agent/core/opportunityCandidateEngine.js  de-duplication, customer fit, ranking (pure)
//   compliance/complianceEngine.js            the existing PASS/REVIEW/BLOCK boundary
//   compliance/etsyIpRiskDetector.js          the existing protected-mark pass
//   agent/core/productOpportunityScoringEngine.js  evidence coverage, reused unchanged
//
// PROVENANCE IS VERIFIED, NOT TRUSTED. A model can describe research it did not do and
// cite a URL that search never returned. So every candidate and every signal survives only
// when at least one of its claimed source URLs is in the set of URLs Anthropic's web_search
// tool ITSELF returned (claudeClient.extractWebSearchResultUrls) - the same mechanical
// check tools/webCompetitorResearchTool.js already applies. Unverifiable entries are
// dropped, never downgraded and kept.
//
// WHAT THIS RUN CANNOT KNOW, AND SAYS SO. There is no search-volume provider, no trend API
// and no marketplace-insights feed in this project. Demand, competition and trend therefore
// arrive as cited QUALITATIVE assessments, and any numeric field a source did not supply is
// null with a stated reason - never 0, never a plausible-looking figure. Phase 12 of the
// request that specified this capability is the rule here: unavailable is an answer.
//
// IT ENDS AT OPPORTUNITIES. Nothing here creates, prices, lists or publishes a product on
// any channel. Acting on a ranked opportunity is a separate, human-approved decision.

const claudeClient = require('../agent/core/claudeClient');
const { checkTokenBudget } = require('../agent/core/tokenControls');
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
  '- trend.classification must be one of: growing, stable, seasonal, declining, emerging, unknown.',
  '- A product that spikes yearly around one date is "seasonal", NOT "growing".',
  '- "unknown" is a correct answer when no source supports a classification.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"validated":[{"product":"exact name from the shortlist",',
  '"demand":{"assessment":"...","value":null,"unit":null,"grade":"measured|estimated|derived|inferred|unknown"},',
  '"competition":{"assessment":"...","value":null,"unit":null,"grade":"..."},',
  '"trend":{"classification":"...","assessment":"...","grade":"..."},',
  '"commercial":{"assessment":"...","price_low":null,"price_high":null,"currency":null,"grade":"..."},',
  '"source":["https://exact-url"]}]}',
].join('\n');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Same JSON extraction tools/webCompetitorResearchTool.js uses - a model reply may carry
// prose around the object even when told not to.
function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    return null;
  }
}

function extractFinalTextBlock(content) {
  const blocks = asArray(content).filter((block) => block && block.type === 'text' && nonEmptyString(block.text));
  return blocks.length > 0 ? blocks[blocks.length - 1].text : null;
}

// An entry survives only when a URL it claims is one web_search really returned.
function verifiedSources(entry, verifiedUrls) {
  return asArray(entry && entry.source).filter((url) => typeof url === 'string' && verifiedUrls.has(url));
}

// Adds one call's real usage to the run total. The model name is kept from the first call
// that reported one - every call in a run uses the same configured model.
function recordUsage(totals, usage) {
  if (!usage) return;
  totals.inputTokens += usage.inputTokens || 0;
  totals.outputTokens += usage.outputTokens || 0;
  totals.tokensUsed += usage.tokensUsed || 0;
  if (!totals.model && usage.model) totals.model = usage.model;
}

function totalTokensFromUsage(usage) {
  if (!usage) return 0;
  return (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
}

// One batched web_search call. Returns the parsed payload plus the set of URLs search
// itself returned, so the caller can verify every entry against real results.
async function runSearchCall({ system, prompt, businessId, tokensUsedThisRun }) {
  const budget = checkTokenBudget({ requestedMaxTokens: MAX_TOKENS, tokensUsedThisRun });
  if (!budget.allowed) return { ok: false, reason: budget.reason, usage: null };

  let response;
  try {
    response = await claudeClient.sendMessage({
      messages: [{ role: 'user', content: prompt }],
      system,
      tools: [WEB_SEARCH_TOOL],
      maxTokens: budget.capped_max_tokens,
      businessId,
    });
  } catch (err) {
    return { ok: false, reason: err.message, usage: null };
  }

  const usage = {
    model: response.model,
    stopReason: response.stopReason,
    tokensUsed: totalTokensFromUsage(response.usage),
    inputTokens: Number(response.usage && response.usage.input_tokens) || 0,
    outputTokens: Number(response.usage && response.usage.output_tokens) || 0,
  };
  const verifiedUrls = new Set(claudeClient.extractWebSearchResultUrls(response.raw && response.raw.content));
  if (verifiedUrls.size === 0) {
    return { ok: false, reason: 'The web search returned no real results for this query.', usage, verifiedUrls };
  }
  const parsed = tryParseJson(extractFinalTextBlock(response.raw && response.raw.content));
  if (!parsed) {
    const reason =
      response.stopReason === 'max_tokens'
        ? "The research assistant's answer was cut off before it finished (Claude's per-call output-token limit was reached). Raise MAX_TOKENS_PER_CALL in .env (e.g. to 8192) and try again."
        : 'The research assistant did not return a parsable JSON result.';
    return { ok: false, reason, usage, verifiedUrls };
  }
  return { ok: true, parsed, verifiedUrls, usage };
}

// --- Stage 2: broad discovery -------------------------------------------------------
// Several batched queries, each aimed at a different slice of the customer's scope, so the
// candidate pool is genuinely broad rather than one query's first page.
function buildDiscoveryPrompts(marketScope, batches) {
  const related = asArray(marketScope.related_markets);
  const intents = asArray(marketScope.buyer_intents);
  const prompts = [
    [
      `Business's primary market: ${marketScope.primary_market}.`,
      related.length > 0 ? `It also sells in: ${related.join(', ')}.` : '',
      intents.length > 0 ? `Recurring themes in its catalogue: ${intents.slice(0, 10).join(', ')}.` : '',
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

async function discoverCandidates({ marketScope, batches, businessId, tokenTracker, stages, usageTotals }) {
  const candidates = [];
  const sourcesUsed = new Set();
  let calls = 0;

  for (const prompt of buildDiscoveryPrompts(marketScope, batches)) {
    const outcome = await runSearchCall({
      system: DISCOVERY_SYSTEM_PROMPT,
      prompt,
      businessId,
      tokensUsedThisRun: tokenTracker.tokensUsedThisRun,
    });
    calls += 1;
    if (outcome.usage) {
      tokenTracker.tokensUsedThisRun += outcome.usage.tokensUsed || 0;
      recordUsage(usageTotals, outcome.usage);
    }
    if (!outcome.ok) {
      stages.push({ stage: 'discovery', status: 'failed', detail: outcome.reason });
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
async function validateShortlist({ shortlist, businessId, tokenTracker, stages, usageTotals }) {
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
    businessId,
    tokensUsedThisRun: tokenTracker.tokensUsedThisRun,
  });
  if (outcome.usage) {
    tokenTracker.tokensUsedThisRun += outcome.usage.tokensUsed || 0;
    recordUsage(usageTotals, outcome.usage);
  }
  if (!outcome.ok) {
    stages.push({ stage: 'validation', status: 'failed', detail: outcome.reason });
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
} = {}) {
  const result = createEmptyCustomerOpportunityResearch();
  const stages = [];
  const tokenTracker = { tokensUsedThisRun };
  // Real Claude usage accumulated across every batched call this run makes, so
  // agent/core/orchestratorExecutionContract.js's usage ledger records this tool's actual
  // cost rather than counting it as one flat tool call.
  const usageTotals = { model: null, inputTokens: 0, outputTokens: 0, tokensUsed: 0 };
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

  if (!claudeClient.isConfigured({ businessId })) {
    result.status = 'needs_information';
    result.limitations = [
      'ANTHROPIC_API_KEY is not configured, so the live web research this capability depends on could not run. The customer context and market scope above were still derived from real business data.',
    ];
    result.research_summary = { stages, sources_used: [], verified_source_count: 0, model_calls: 0, usage: { ...usageTotals }, generated_at: new Date().toISOString() };
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
  const validation = await validateShortlist({ shortlist, businessId, tokenTracker, stages, usageTotals });
  modelCalls += validation.calls;
  validation.sourcesUsed.forEach((url) => sourcesUsed.add(url));

  const enriched = shortlist.map((candidate) => {
    const match = validation.validated.get(candidate.product.toLowerCase());
    if (!match) {
      return {
        ...candidate,
        demand: normalizeSignal(null, [], 'demand'),
        competition: normalizeSignal(null, [], 'competition'),
        trend: { metric: 'trend', classification: 'unknown', assessment: 'Not available from current research sources.', grade: 'unknown', value: null, source: [], confidence: 'low' },
        commercial: normalizeSignal(null, [], 'commercial'),
      };
    }
    const { entry, sources } = match;
    const trendClassification = nonEmptyString(entry.trend && entry.trend.classification) ? entry.trend.classification : 'unknown';
    return {
      ...candidate,
      evidence: candidate.evidence.concat(
        sources.map((url) => ({ metric: 'validation', assessment: 'Validation evidence.', value: null, unit: null, grade: 'inferred', source_url: url, retrieved_at: new Date().toISOString() }))
      ),
      demand: normalizeSignal(entry.demand, sources, 'demand'),
      competition: normalizeSignal(entry.competition, sources, 'competition'),
      trend: {
        metric: 'trend',
        classification: trendClassification,
        assessment: nonEmptyString(entry.trend && entry.trend.assessment) ? entry.trend.assessment : 'Not available from current research sources.',
        grade: nonEmptyString(entry.trend && entry.trend.grade) ? entry.trend.grade : 'inferred',
        value: null,
        source: sources,
        confidence: trendClassification === 'unknown' ? 'low' : 'medium',
      },
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
    confidence: candidate.coverage_score.percentage >= 75 ? 'medium' : 'low',
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
  if (ranking.ranked.length < limit) {
    limitations.push(
      `Fewer than ${limit} opportunities are reported (${ranking.ranked.length}). Remaining slots are deliberately left empty rather than filled with weakly-evidenced or irrelevant candidates.`
    );
  }
  if (asArray(result.market_scope.geographies).length === 0) {
    limitations.push('No target geography is declared in configuration/business.yaml, so this research is not geographically scoped and was not assumed to be global.');
  }

  result.limitations = limitations;
  result.research_summary = {
    stages,
    sources_used: [...sourcesUsed],
    verified_source_count: sourcesUsed.size,
    model_calls: modelCalls,
    tokens_used_this_run: tokenTracker.tokensUsedThisRun,
    usage: { ...usageTotals },
    generated_at: new Date().toISOString(),
  };
  result.status = result.top_opportunities.length > 0 ? 'complete' : 'partial';
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
