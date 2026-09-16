'use strict';

// The live_competitor_research tool (tools/toolRegistry.js): the Research specialist's LIVE counterpart to
// competitor_research, for a free-text objective with no caller-supplied structured research_params (see
// tools/competitorResearchTool.js). Reached automatically instead of competitor_research in that case - see
// agent/core/orchestratorExecutionContract.js's buildPlanStep, "LIVE WEB COMPETITOR RESEARCH".
//
// ITS LIVE SOURCE IS THE PUBLIC WEB, through the SAME research call every live research capability uses
// (agent/core/liveResearchCall.js): the configured search provider chain (SEARCH_PROVIDER plus
// SEARCH_FALLBACK_PROVIDERS - Tavily, Gemini Google Search grounding or Anthropic web_search) with the active AI
// provider (AI_PROVIDER). It used to be bound to Anthropic alone, so an exhausted Anthropic credit left
// competitor research unavailable even when another configured provider could serve it. No new credential or
// adapter is involved.
//
// NEVER FABRICATES. A competitor survives only when at least one of its claimed source URLs is one the SEARCH
// TOOL itself returned for this call; unverifiable competitors are dropped, never kept as guesses. If nothing
// survives, the status is 'empty'. A provider failure is reported with its classified status
// (SEARCH_QUOTA_EXCEEDED, SEARCH_AUTH_FAILED, SEARCH_TIMEOUT ...), never as an empty or successful result.
//
// PROVENANCE AND GRADES. The result carries a `provenance` block: provider, mode, retrieval time, every provider
// attempt, and per competitor its verified sources, multi-source corroboration (agent/core/evidenceValidation.js)
// and graded evidence - pricing OBSERVED only when a price is actually quoted from a verified page, positioning
// and catalogue gaps INFERRED (a reading of the pages), anything absent UNKNOWN. Nothing is estimated here.
//
// Reuses agent/core/researchAgent.js's runCompetitorResearch() UNCHANGED to build and validate the records.
//
// Returns { status, result, error, model, stopReason, tokensUsed, inputTokens, outputTokens, search_status,
// search_status_message, search_attempts } - never throws. Usage fields are present whenever a model call was
// actually made, so agent/core/usageLimits.js / tokenControls.js count real cost.
//   status 'failed'  - no/empty objective, AI provider not configured, budget exhausted, the provider call failed,
//                       or the reply was not the structured JSON asked for
//   status 'empty'   - no real search results, or no claimed competitor could be verified against them
//   status 'partial' - some but not all claimed competitors verified
//   status 'success' - every claimed competitor verified

const aiProviderSelector = require('../agent/core/aiProviderSelector');
const webSearchProvider = require('../agent/core/webSearchProvider');
const liveResearchCall = require('../agent/core/liveResearchCall');
const { runCompetitorResearch } = require('../agent/core/researchAgent');
const { validateEvidence } = require('../agent/core/evidenceValidation');

// The oldest, most broadly available web_search tool version - used only when the search runs inside the AI
// provider's own turn (model-native mode). Basic search is all this tool needs.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const MAX_COMPETITORS = 5;
// agent/core/tokenControls.js takes the minimum of this, MAX_TOKENS_PER_CALL and the remaining run budget, so
// this constant only raises the ceiling a configured MAX_TOKENS_PER_CALL can reach.
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a competitor research assistant for an e-commerce business. Use the web_search tool to find REAL, currently-operating competitors relevant to the objective you are given. Never invent a competitor, and never describe one from memory alone without actually searching for it first.

Keep every field SHORT - this must fit in one response with no risk of being cut off:
- "positioning" - one short sentence.
- Every other array field (pricingEvidence, strengths, weaknesses, marketingSignals, seoSignals, opportunities) - AT MOST 2 items, each under 15 words.
- "recommendations" - at most 3 items, each under 20 words.
Brevity is required, not optional - a short, complete answer is always better than a longer one that risks being cut off before it finishes.

After searching, respond with ONLY a single JSON object (no other text, no markdown code fences) with this exact shape:
{
  "topic": "short description of what was researched",
  "competitors": [
    {
      "competitor": "company or brand name",
      "market": "market or region",
      "productCategory": "product category",
      "positioning": "how they position themselves, one short sentence",
      "pricingEvidence": ["specific pricing facts actually found - at most 2"],
      "strengths": ["specific strengths actually found - at most 2"],
      "weaknesses": ["specific weaknesses actually found - at most 2"],
      "marketingSignals": ["specific marketing activity actually found - at most 2"],
      "seoSignals": ["specific SEO/search-visibility signals actually found - at most 2"],
      "opportunities": ["specific opportunities this suggests - at most 2"],
      "source": ["the exact URL(s) you actually retrieved this competitor and its evidence from"]
    }
  ],
  "recommendations": ["suggestions for a human to consider, grounded only in what was found - at most 3"]
}

Rules:
- Every "source" URL must be a real URL you actually retrieved via web_search - never a URL you recall from memory or guess at.
- Only include array entries where you actually found real evidence - an empty array is honest, a placeholder is not.
- If you cannot find any real competitors via web_search, return "competitors": [].
- Return at most ${MAX_COMPETITORS} competitors, the most relevant to the objective.`;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// A competitor entry is verified only when at least one of its OWN claimed source URLs is present in the set of
// URLs the search tool itself returned for this call - never trusted from the model's text alone.
function isVerifiedEntry(entry, verifiedUrls) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const claimedSources = Array.isArray(entry.source) ? entry.source : [];
  return claimedSources.some((url) => typeof url === 'string' && verifiedUrls.has(url));
}

// A quoted price: a currency symbol or code next to a number.
const PRICE_PATTERN = /(?:[$£€¥₹]\s?\d)|(?:\b(?:usd|gbp|eur|cad|aud|inr|pkr)\s?\d)|(?:\d+(?:[.,]\d{1,2})?\s?(?:usd|gbp|eur|cad|aud|inr|pkr|dollars?|pounds?|euros?)\b)/i;

function gradeTexts(values, observedTest) {
  return asArray(values)
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => ({ text: value.trim(), grade: observedTest && observedTest(value) ? 'OBSERVED' : 'INFERRED' }));
}

// Per-competitor provenance and grades. Values the model did not report stay UNKNOWN; nothing is estimated.
function describeCompetitorEvidence(entry, { provider, retrievedAt }) {
  const sources = asArray(entry.source);
  const pricing = gradeTexts(entry.pricingEvidence, (text) => PRICE_PATTERN.test(text));
  const observedPrice = pricing.some((item) => item.grade === 'OBSERVED');
  return {
    competitor: typeof entry.competitor === 'string' ? entry.competitor : null,
    provider,
    retrieved_at: retrievedAt,
    sources,
    products: gradeTexts(entry.productCategory ? [entry.productCategory] : []),
    pricing_evidence: pricing.length > 0 ? pricing : [{ text: null, grade: 'UNKNOWN' }],
    positioning: typeof entry.positioning === 'string' && entry.positioning.trim()
      ? { text: entry.positioning.trim(), grade: 'INFERRED' }
      : { text: null, grade: 'UNKNOWN' },
    catalogue_gaps: gradeTexts(entry.opportunities),
    validation: validateEvidence({
      claims: sources.map((url) => ({ source_url: url, grade: observedPrice ? 'observed' : 'inferred', retrieved_at: retrievedAt })),
    }),
  };
}

async function runWebCompetitorResearchTool({ objective, businessId = null, tokensUsedThisRun = 0 } = {}) {
  if (typeof objective !== 'string' || objective.trim() === '') {
    return {
      status: 'failed',
      result: null,
      error: 'live_competitor_research requires a non-empty objective to search for real competitors.',
    };
  }

  if (!aiProviderSelector.isConfigured({ businessId })) {
    const provider = aiProviderSelector.getActiveProvider();
    const keyName = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
    const message = businessId
      ? `Business '${businessId}' has no configured ${keyName}, so live competitor research (web search) cannot run.`
      : `${keyName} is not set, so live competitor research (web search) cannot run. Copy .env.example to .env and add a real key.`;
    return { status: 'failed', result: null, error: message };
  }

  // The shared call applies agent/core/tokenControls.js's SAME per-run budget as every other model call, then
  // tries the configured provider chain.
  const outcome = await liveResearchCall.runSearchCall({
    system: SYSTEM_PROMPT,
    prompt: objective.trim(),
    query: objective.trim(),
    businessId,
    tokensUsedThisRun,
    maxTokens: MAX_TOKENS,
    webSearchTool: WEB_SEARCH_TOOL,
  });

  const usage = outcome.usage
    ? {
        model: outcome.usage.model,
        stopReason: outcome.usage.stopReason,
        tokensUsed: outcome.usage.tokensUsed,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      }
    : {};
  const attempts = asArray(outcome.attempts).map((attempt) => ({ provider: attempt.provider, mode: attempt.mode, status: attempt.status, layer: attempt.layer || null }));
  const searchFields = outcome.searchStatus
    ? { search_status: outcome.searchStatus, search_status_message: webSearchProvider.userFacingStatusMessage(outcome.searchStatus), search_attempts: attempts }
    : { search_attempts: attempts };

  if (!outcome.ok) {
    // No attempt at all: the shared run budget refused the call before any provider was reached.
    if (attempts.length === 0) return { status: 'failed', result: null, error: outcome.reason, ...usage };
    if (outcome.searchStatus === 'SEARCH_EMPTY_RESULTS') {
      return { status: 'empty', result: null, error: 'The web search returned no real results for this objective, so no competitor could be found.', ...usage, ...searchFields };
    }
    if (outcome.searchStatus === 'SEARCH_MALFORMED_RESULTS') {
      const cutOff = typeof outcome.reason === 'string' && /cut off/.test(outcome.reason);
      return {
        status: 'failed',
        result: null,
        error: cutOff ? outcome.reason : 'The research assistant did not return structured competitor data in the expected shape.',
        ...usage,
        ...searchFields,
      };
    }
    return { status: 'failed', result: null, error: outcome.reason, ...usage, ...searchFields };
  }

  const parsed = outcome.parsed;
  if (!parsed || !Array.isArray(parsed.competitors)) {
    return { status: 'failed', result: null, error: 'The research assistant did not return structured competitor data in the expected shape.', ...usage, ...searchFields };
  }

  const verifiedUrls = outcome.verifiedUrls instanceof Set ? outcome.verifiedUrls : new Set();
  const claimedCount = parsed.competitors.length;
  const verifiedCompetitors = parsed.competitors
    .filter((entry) => isVerifiedEntry(entry, verifiedUrls))
    .slice(0, MAX_COMPETITORS)
    .map((entry) => ({ ...entry, source: entry.source.filter((url) => verifiedUrls.has(url)) }));

  if (verifiedCompetitors.length === 0) {
    return {
      status: 'empty',
      result: null,
      error:
        claimedCount > 0
          ? 'None of the competitors the research assistant described could be verified against real web search results, so none are reported.'
          : 'The research assistant found no real competitors for this objective.',
      ...usage,
      ...searchFields,
    };
  }

  try {
    const result = runCompetitorResearch({
      competitors: verifiedCompetitors,
      topic: typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic.trim() : objective.trim(),
      confidence: 'medium',
      verificationStatus: 'verified',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    });
    const retrievedAt = new Date().toISOString();
    const provider = outcome.provider || (attempts.length > 0 ? attempts[attempts.length - 1].provider : null);
    result.provenance = {
      provider,
      mode: outcome.mode || null,
      retrieved_at: retrievedAt,
      search_attempts: attempts,
      evidence_rule:
        'A competitor is kept only when a source URL it cites was returned by the search tool. Pricing is OBSERVED only when a price is quoted from a verified page; positioning and gaps are INFERRED readings of those pages; anything not reported is UNKNOWN.',
      competitors: verifiedCompetitors.map((entry) => describeCompetitorEvidence(entry, { provider, retrievedAt })),
    };
    const status = verifiedCompetitors.length < claimedCount ? 'partial' : 'success';
    return { status, result, error: null, ...usage, ...searchFields };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message, ...usage, ...searchFields };
  }
}

module.exports = { runWebCompetitorResearchTool, describeCompetitorEvidence };

if (require.main === module) {
  if (!aiProviderSelector.isConfigured()) {
    console.log(`live_competitor_research tool loaded, but the active AI provider (${aiProviderSelector.getActiveProvider()}) is not configured.`);
    process.exit(0);
  }
  runWebCompetitorResearchTool({
    objective: 'Find real competitors for a small Shopify store selling handmade candles in the US.',
  })
    .then((outcome) => {
      console.log(`status: ${outcome.status}`);
      if (outcome.search_status) console.log(`search status: ${outcome.search_status}`);
      if (outcome.error) console.log(`error: ${outcome.error}`);
      if (outcome.result) console.log(JSON.stringify(outcome.result, null, 2));
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
