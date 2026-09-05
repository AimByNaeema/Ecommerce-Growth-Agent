'use strict';

// The discover_market_questions tool (tools/toolRegistry.js): the evidence ACQUISITION
// layer upstream of the existing Information Gap Finder. Finds real questions people
// publicly ask about a topic, verifies where each one actually came from, and returns
// evidence records that agent/core/informationGapEngine.js consumes unchanged.
//
// ONE SOURCE, BECAUSE ONE SOURCE EXISTS. This project's only public-web capability is
// Anthropic's hosted web_search tool, reached through agent/core/claudeClient.js's
// sendMessage `tools` passthrough - the exact same path tools/webCompetitorResearchTool.js
// already uses. No new credential, no new HTTP client, no new integration adapter, no
// scraper. Autocomplete, People Also Ask and related-search boxes are SERP features
// rather than pages: no client for them exists here, web_search returns pages, and
// inventing an API for them was explicitly out of the question - so they are reported as
// explicitly unsupported (see agent/core/questionEvidenceModel.js's
// UNSUPPORTED_EVIDENCE_KINDS) rather than faked.
//
// NEVER FABRICATES PROVENANCE. Claude is instructed to report only questions it actually
// finds, each with the URL it found them on - but a model can describe research it did
// not do and cite a URL search never returned. So every claimed source is checked
// mechanically against claudeClient.extractWebSearchResultUrls() - the URLs the search
// tool ITSELF returned - by agent/core/questionDiscoveryEngine.js. An unverifiable claim
// is kept but marked model_generated with its false URL discarded, never presented as a
// real market question. This is the same verification discipline
// tools/webCompetitorResearchTool.js applies to competitors.
//
// AI IS USED ONLY WHERE IT MUST BE. The model does one bounded thing: search, and report
// which questions it saw and where. Every deterministic step - normalization,
// deduplication, provenance verification, merging, limits, validation - happens offline
// in questionDiscoveryEngine.js at zero token cost. No page content is sent to the model
// for extraction, and no page body is stored.
//
// SHARES THE RUN'S BUDGET: like live_competitor_research, this spends real Claude tokens,
// so it goes through agent/core/tokenControls.js's checkTokenBudget with this run's
// running total and reports its usage back for agent/core/usageLimits.js and
// usage/usageTracker.js to record. It is registered in MODEL_CALL_TOOL_IDS, so a run's
// model-call ceiling applies to it exactly as it does to every other model call. One
// call, one bounded search - there is no loop, no crawl, and no background job here.
//
// Returns { status, result, error, model, stopReason, tokensUsed, inputTokens,
// outputTokens } - never throws. Usage fields are absent only when the API was never
// reached (missing topic, no API key, budget exhausted, or the call itself failed).
//   status 'failed'  - no topic, ANTHROPIC_API_KEY not configured, the call failed, or
//                       the reply was not valid structured JSON
//   status 'empty'   - the search returned no real results, or no question's provenance
//                       could be verified against them
//   status 'partial' - some but not all claimed questions verified
//   status 'success' - every claimed question verified

const claudeClient = require('../agent/core/claudeClient');
const { checkTokenBudget, totalTokensFromUsage, normalizeUsage } = require('../agent/core/tokenControls');
const { buildQuestionEvidence, toGapFinderQuestions, resolveLimit } = require('../agent/core/questionDiscoveryEngine');

// Same tool version and rationale as tools/webCompetitorResearchTool.js - basic search
// is all this needs, so the newer filtering/response-control versions are not adopted
// (CLAUDE.md rule 15).
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a market question researcher for an e-commerce business. Use the web_search tool to find REAL questions that real people publicly ask about the topic you are given.

Look for questions that actually appear on public pages: FAQ sections, Q&A sections, community forum threads, and help/support pages. Report the question as you actually saw it worded.

NEVER invent a question, and never report one from memory without searching for it first. It is far better to return three real questions than twenty plausible ones.

Respond with ONLY a single JSON object (no other text, no markdown code fences) with this exact shape:
{
  "topic": "short description of what was researched",
  "questions": [
    {
      "question": "the question exactly as it appears on the page",
      "evidenceKind": "one of: public_qa, public_forum_question, competitor_question, other_observed",
      "sourceUrl": "the exact URL you actually retrieved this question from",
      "originalObservation": "a SHORT note on where on the page it appeared, e.g. 'listed in the FAQ section' - under 15 words"
    }
  ]
}

Rules:
- Every "sourceUrl" must be a real URL you actually retrieved via web_search - never one you recall from memory or guess at. A question whose URL you cannot cite will be discarded.
- "evidenceKind": use "competitor_question" for a question on a brand's or retailer's own site, "public_forum_question" for a community/forum thread, "public_qa" for a public Q&A or help page, and "other_observed" when none of those fit.
- Do NOT copy page content, answer text, or marketing wording - report only the question itself and a short note on where it appeared.
- Do NOT report any question containing a person's name, email, username, or other personal information.
- Do NOT include any search volume, traffic, popularity, or ranking figure. You do not have that data and must not estimate it.
- If you cannot find any real questions via web_search, return "questions": [].
- Return at most {{MAX_QUESTIONS}} questions, the most relevant to the topic.`;

// Same rationale as tools/webCompetitorResearchTool.js's own helper: a web_search-backed
// reply commonly narrates before searching, and joining every text block can corrupt
// JSON extraction. The model's real structured answer is always its LAST text block.
function extractFinalTextBlock(content) {
  if (!Array.isArray(content)) return '';
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

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

async function runMarketQuestionDiscoveryTool({
  topic,
  market = '',
  limit,
  businessId = null,
  tokensUsedThisRun = 0,
} = {}) {
  if (typeof topic !== 'string' || topic.trim() === '') {
    return {
      status: 'failed',
      result: null,
      error: 'discover_market_questions requires a non-empty `topic` to search for real market questions.',
    };
  }

  if (!claudeClient.isConfigured({ businessId })) {
    const message = businessId
      ? `Business '${businessId}' has no configured ANTHROPIC_API_KEY, so live market question discovery (web search) cannot run.`
      : 'ANTHROPIC_API_KEY is not set, so live market question discovery (web search) cannot run. Copy .env.example to .env and add a real key.';
    return { status: 'failed', result: null, error: message };
  }

  const resolvedLimit = resolveLimit(limit);

  // Shares this run's token budget with every other model call - a discovery step can
  // never spend unbounded tokens just because it is a different tool.
  const budget = checkTokenBudget({ requestedMaxTokens: MAX_TOKENS, tokensUsedThisRun });
  if (!budget.allowed) {
    return { status: 'failed', result: null, error: budget.reason };
  }

  const searchInstruction = market.trim()
    ? `Find real questions people publicly ask about: ${topic.trim()} (market: ${market.trim()})`
    : `Find real questions people publicly ask about: ${topic.trim()}`;

  let response;
  try {
    response = await claudeClient.sendMessage({
      messages: [{ role: 'user', content: searchInstruction }],
      system: SYSTEM_PROMPT.replace('{{MAX_QUESTIONS}}', String(resolvedLimit)),
      tools: [WEB_SEARCH_TOOL],
      maxTokens: budget.capped_max_tokens,
      businessId,
    });
  } catch (err) {
    // A source being unavailable is a normal outcome, not a crash: the existing
    // agent/core/networkRetry.js timeout/retry behavior inside claudeClient already
    // applied, and whatever it ultimately reported is surfaced honestly here.
    return { status: 'failed', result: null, error: err.message };
  }

  // Real tokens were spent the moment the call succeeded, whatever this reports below.
  const usage = {
    model: response.model,
    stopReason: response.stopReason,
    tokensUsed: totalTokensFromUsage(response.usage),
    inputTokens: normalizeUsage(response.usage).input,
    outputTokens: normalizeUsage(response.usage).output,
  };

  const verifiedUrls = claudeClient.extractWebSearchResultUrls(response.raw && response.raw.content);
  if (verifiedUrls.length === 0) {
    return {
      status: 'empty',
      result: null,
      error: 'The web search returned no real results for this topic, so no market question could be evidenced.',
      ...usage,
    };
  }

  const parsed = tryParseJson(extractFinalTextBlock(response.raw && response.raw.content));
  if (!parsed || !Array.isArray(parsed.questions)) {
    const error =
      response.stopReason === 'max_tokens'
        ? "The research assistant's answer was cut off before it finished (Claude's output-token limit for one call was reached). Raise MAX_TOKENS_PER_CALL in .env (e.g. to 8192) and try again."
        : 'The research assistant did not return structured question data in the expected shape.';
    return { status: 'failed', result: null, error, ...usage };
  }

  // Everything from here is deterministic and offline - verification, normalization,
  // provenance-preserving merge, limits and validation all happen in the engine.
  let evidence;
  try {
    evidence = buildQuestionEvidence({
      claims: parsed.questions,
      verifiedUrls,
      limit: resolvedLimit,
    });
  } catch (err) {
    return { status: 'failed', result: null, error: err.message, ...usage };
  }

  const evidencedRecords = evidence.records.filter((record) => record.evidence_strength !== 'model_generated');
  if (evidencedRecords.length === 0) {
    return {
      status: 'empty',
      result: null,
      error:
        parsed.questions.length > 0
          ? 'None of the questions the research assistant reported could be verified against real web search results, so none are reported as real market questions.'
          : 'The research assistant found no real questions for this topic.',
      ...usage,
    };
  }

  const result = {
    topic: typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic.trim() : topic.trim(),
    market: market.trim(),
    questions: evidence.records,
    // Ready to hand straight to the existing Gap Finder with no further translation -
    // model-generated entries carry no evidence sources, so it classifies them itself.
    gap_finder_input: toGapFinderQuestions(evidence.records),
    verified_source_count: verifiedUrls.length,
    demand_measured: false,
    unsupported_sources: evidence.unsupported_sources,
    limitations: evidence.limitations,
  };

  const status = evidencedRecords.length < evidence.records.length ? 'partial' : 'success';
  return { status, result, error: null, ...usage };
}

module.exports = { runMarketQuestionDiscoveryTool };

if (require.main === module) {
  claudeClient.loadEnvOnce();
  if (!claudeClient.isConfigured()) {
    console.log('discover_market_questions tool loaded, but ANTHROPIC_API_KEY is not set.');
    console.log('Copy .env.example to .env and add a real key from:');
    console.log('  https://platform.claude.com/settings/keys');
    process.exit(0);
  }
  runMarketQuestionDiscoveryTool({ topic: 'caring for an insulated winter jacket', limit: 10 })
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
