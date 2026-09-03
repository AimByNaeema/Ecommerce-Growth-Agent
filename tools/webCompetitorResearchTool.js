'use strict';

// The live_competitor_research tool (tools/toolRegistry.js): the Research
// specialist's LIVE counterpart to competitor_research, for the one case
// competitor_research itself can never handle - a free-text objective with no
// caller-supplied structured `research_params` (see tools/competitorResearchTool.js's
// own honest 'failed' status for that case). Reached automatically instead of
// competitor_research whenever that happens - see
// agent/core/orchestratorExecutionContract.js's buildPlanStep, "LIVE WEB COMPETITOR
// RESEARCH" block, and agent/core/specialistCapabilityRegistry.js's competitor_research
// task (tool_ids includes this id).
//
// Unlike every other LIVE data source in this project (Shopify, the business's OWN
// store - tools/productDataRetrievalTool.js, tools/analyticsDataTool.js), this tool's
// live source is the public web, reached through Anthropic's own hosted web_search
// tool via agent/core/claudeClient.js's sendMessage `tools` passthrough. No new
// third-party credential, no new integration adapter - only the ANTHROPIC_API_KEY
// this project already requires for ai_reasoning_completion.
//
// NEVER FABRICATES: Claude is instructed to report only competitors it actually finds
// via web_search, each backed by a source URL - but a model can still describe
// research it didn't really do, or cite a URL search never actually returned. So every
// kept competitor record is verified mechanically, never trusted from the model's own
// text alone: a competitor survives only when at least one of its claimed `source`
// URLs is present in the set of URLs Anthropic's web_search tool itself actually
// returned for this call (claudeClient.extractWebSearchResultUrls) - a real fact about
// what was searched, not the model's self-report. Any competitor whose sources can't
// be verified this way is dropped, never kept as an unverified guess. If nothing
// survives verification, this reports status 'empty' - the same honest "no evidence"
// behavior every other research tool in this project already uses, never inventing a
// placeholder finding to fill the gap.
//
// Reuses agent/core/researchAgent.js's runCompetitorResearch() UNCHANGED to actually
// build/validate the final competitorResearchModel.js records - this tool's only new
// responsibility is turning a free-text objective into real, verified
// runCompetitorResearch() input; the record shape, validation, and
// confidence/verification-status grading are the exact same code path
// tools/competitorResearchTool.js already uses. confidence is asserted as 'medium'
// (this tool's own honest, conservative self-grading of unaudited-but-cited web
// evidence) and verificationStatus as 'verified' (every kept record is grounded in a
// real, returned search result) - both plain caller assertions researchAgent.js's own
// composeResult() re-checks and would downgrade to 'unverified' if no evidence/source
// actually ended up on the record, exactly like any other caller of that function.
//
// Returns { status, result, error, model, tokensUsed, inputTokens, outputTokens } -
// never throws. The usage fields are absent only when the Claude API was never
// actually reached (missing/empty objective, ANTHROPIC_API_KEY not configured, this
// run's token budget already exhausted, or the sendMessage call itself failed) -
// present on every other path, since a real call was made and its usage should count
// exactly like ai_reasoning_completion's own (see agent/core/usageLimits.js's
// MODEL_CALL_TOOL_IDS and agent/core/tokenControls.js's shared per-run budget).
//   status 'failed'  - no/empty objective, ANTHROPIC_API_KEY not configured, the
//                       Claude API call itself failed, or the model's reply was not
//                       valid structured JSON
//   status 'empty'   - the web search returned no real results, or none of the
//                       model's claimed competitors could be verified against them
//   status 'partial' - some but not all of the model's claimed competitors verified
//   status 'success' - every claimed competitor verified

const claudeClient = require('../agent/core/claudeClient');
const { runCompetitorResearch } = require('../agent/core/researchAgent');
const { checkTokenBudget, totalTokensFromUsage } = require('../agent/core/tokenControls');

// The oldest, most broadly available web_search tool version (per
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) -
// this tool needs only basic search, so the newer dynamic-filtering/response-control
// versions are not adopted (CLAUDE.md rule 15: no premature technical decisions).
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const MAX_COMPETITORS = 5;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are a competitor research assistant for an e-commerce business. Use the web_search tool to find REAL, currently-operating competitors relevant to the objective you are given. Never invent a competitor, and never describe one from memory alone without actually searching for it first.

After searching, respond with ONLY a single JSON object (no other text, no markdown code fences) with this exact shape:
{
  "topic": "short description of what was researched",
  "competitors": [
    {
      "competitor": "company or brand name",
      "market": "market or region",
      "productCategory": "product category",
      "positioning": "how they position themselves",
      "pricingEvidence": ["specific pricing facts actually found"],
      "strengths": ["specific strengths actually found"],
      "weaknesses": ["specific weaknesses actually found"],
      "marketingSignals": ["specific marketing activity actually found"],
      "seoSignals": ["specific SEO/search-visibility signals actually found"],
      "opportunities": ["specific opportunities this suggests"],
      "source": ["the exact URL(s) you actually retrieved this competitor and its evidence from"]
    }
  ],
  "recommendations": ["suggestions for a human to consider, grounded only in what was found"]
}

Rules:
- Every "source" URL must be a real URL you actually retrieved via web_search - never a URL you recall from memory or guess at.
- Only include array entries where you actually found real evidence - an empty array is honest, a placeholder is not.
- If you cannot find any real competitors via web_search, return "competitors": [].
- Return at most ${MAX_COMPETITORS} competitors, the most relevant to the objective.`;

// Finds the outermost {...} span in the model's reply and parses it - tolerates
// incidental leading/trailing text (a stray "Here is the JSON:" preface, etc.)
// without ever attempting to repair or guess at malformed JSON itself.
function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch (err) {
    return null;
  }
}

// A competitor entry is verified only when at least one of its OWN claimed source
// URLs is present in the set of URLs Anthropic's web_search tool itself actually
// returned for this call - never trusted from the model's text alone.
function isVerifiedEntry(entry, verifiedUrls) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const claimedSources = Array.isArray(entry.source) ? entry.source : [];
  return claimedSources.some((url) => typeof url === 'string' && verifiedUrls.has(url));
}

async function runWebCompetitorResearchTool({ objective, businessId = null, tokensUsedThisRun = 0 } = {}) {
  if (typeof objective !== 'string' || objective.trim() === '') {
    return {
      status: 'failed',
      result: null,
      error: 'live_competitor_research requires a non-empty objective to search for real competitors.',
    };
  }

  if (!claudeClient.isConfigured({ businessId })) {
    const message = businessId
      ? `Business '${businessId}' has no configured ANTHROPIC_API_KEY, so live competitor research (web search) cannot run.`
      : 'ANTHROPIC_API_KEY is not set, so live competitor research (web search) cannot run. Copy .env.example to .env and add a real key.';
    return { status: 'failed', result: null, error: message };
  }

  // Shares agent/core/tokenControls.js's SAME per-run token budget as
  // ai_reasoning_completion (agent/core/orchestratorExecutionContract.js passes this
  // run's running total via runTokenTracker) - a plan step can never spend unbounded
  // Claude tokens just because it happens to call this tool instead of that one.
  const budget = checkTokenBudget({ requestedMaxTokens: MAX_TOKENS, tokensUsedThisRun });
  if (!budget.allowed) {
    return { status: 'failed', result: null, error: budget.reason };
  }

  let response;
  try {
    response = await claudeClient.sendMessage({
      messages: [{ role: 'user', content: objective.trim() }],
      system: SYSTEM_PROMPT,
      tools: [WEB_SEARCH_TOOL],
      maxTokens: budget.capped_max_tokens,
      businessId,
    });
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }

  // Real token usage was spent the moment sendMessage above succeeded, whatever this
  // call ultimately reports below - surfaced on every remaining return path so
  // agent/core/orchestratorExecutionContract.js's runExecutor (which reads
  // data.tokensUsed/model/inputTokens/outputTokens for any MODEL_CALL_TOOL_IDS entry,
  // exactly like tools/aiReasoningCompletion.js's own result shape) can record it
  // against both the token budget above and usage/usageTracker.js's cost ledger,
  // instead of silently under-reporting real API cost.
  const usage = {
    model: response.model,
    tokensUsed: totalTokensFromUsage(response.usage),
    inputTokens: Number(response.usage && response.usage.input_tokens) || 0,
    outputTokens: Number(response.usage && response.usage.output_tokens) || 0,
  };

  const verifiedUrls = new Set(claudeClient.extractWebSearchResultUrls(response.raw && response.raw.content));
  if (verifiedUrls.size === 0) {
    return {
      status: 'empty',
      result: null,
      error: 'The web search returned no real results for this objective, so no competitor could be found.',
      ...usage,
    };
  }

  const parsed = tryParseJson(response.text);
  if (!parsed || !Array.isArray(parsed.competitors)) {
    return {
      status: 'failed',
      result: null,
      error: 'The research assistant did not return structured competitor data in the expected shape.',
      ...usage,
    };
  }

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
    const status = verifiedCompetitors.length < claimedCount ? 'partial' : 'success';
    return { status, result, error: null, ...usage };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message, ...usage };
  }
}

module.exports = { runWebCompetitorResearchTool };

if (require.main === module) {
  claudeClient.loadEnvOnce();
  if (!claudeClient.isConfigured()) {
    console.log('live_competitor_research tool loaded, but ANTHROPIC_API_KEY is not set.');
    console.log('Copy .env.example to .env and add a real key from:');
    console.log('  https://platform.claude.com/settings/keys');
    process.exit(0);
  }
  runWebCompetitorResearchTool({
    objective: 'Find real competitors for a small Shopify store selling handmade candles in the US.',
  })
    .then((outcome) => {
      console.log(`status: ${outcome.status}`);
      if (outcome.error) console.log(`error: ${outcome.error}`);
      if (outcome.result) console.log(JSON.stringify(outcome.result, null, 2));
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
