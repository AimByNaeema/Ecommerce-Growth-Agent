'use strict';

// A thin selector between agent/core/claudeClient.js and agent/core/geminiClient.js -
// NOT a new AI client. It reads AI_PROVIDER from .env to decide which of the two
// already-built connection layers is "active," and delegates sendMessage/isConfigured
// to that one, unchanged. Both clients share the same shape (sendMessage, isConfigured)
// so no adapter/translation logic is needed here - this stays a pure pass-through.
//
// Wired into the model-calling tools that go through it (tools/aiReasoningCompletion.js,
// tools/complianceCheckTool.js, tools/seoContentGenerationTool.js) and, since Gemini
// gained web-search grounding, workflows/customerMarketOpportunityWorkflow.js. It still
// decides nothing itself: it picks a client and delegates, exactly as before.
//
// tools/marketQuestionDiscoveryTool.js and tools/webCompetitorResearchTool.js remain on
// claudeClient.js directly. Moving them is a separate, explicitly-scoped decision per
// CLAUDE.md rule 1/section 6 - not something to do in passing.

const claudeClient = require('./claudeClient');
const geminiClient = require('./geminiClient');

// Deliberate configured default (not a business assumption about which provider is
// "better") - AI_PROVIDER unset/blank means "gemini".
const DEFAULT_PROVIDER = 'gemini';
const VALID_PROVIDERS = ['claude', 'gemini'];

const CLIENTS = {
  claude: claudeClient,
  gemini: geminiClient,
};

// Resolves AI_PROVIDER to "claude" or "gemini". Reuses claudeClient.js's own
// loadEnvOnce() to load the root .env file instead of duplicating that fs/path/
// process.loadEnvFile logic a third time (CLAUDE.md rules 3-4) - either client's copy
// has the identical effect, since both just populate process.env once per process.
function getActiveProvider() {
  claudeClient.loadEnvOnce();

  const raw = process.env.AI_PROVIDER;
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_PROVIDER;
  }

  const normalized = raw.trim().toLowerCase();
  if (!VALID_PROVIDERS.includes(normalized)) {
    throw new Error(
      `Unrecognized AI_PROVIDER value '${raw}'. Set AI_PROVIDER to "claude" or "gemini" ` +
      'in .env, or leave it unset to use the default ("gemini").'
    );
  }
  return normalized;
}

function resolveClient() {
  return CLIENTS[getActiveProvider()];
}

function isConfigured(...args) {
  return resolveClient().isConfigured(...args);
}

function sendMessage(...args) {
  return resolveClient().sendMessage(...args);
}

// Every REAL URL the active provider's own web-search tool actually retrieved for one
// call. This is the one place the two clients' response shapes genuinely differ, so the
// difference is absorbed here rather than at every research call site:
//
//   claude - Anthropic returns web_search_tool_result blocks on `raw.content`
//   gemini - Google returns groundingChunks on `raw.candidates[].groundingMetadata`
//
// Takes the WHOLE raw response so callers stay provider-agnostic, and returns [] for a
// response that carries no search results at all - which is a real answer ("this call
// searched nothing"), never an error to paper over.
//
// A URL the model merely WROTE in its prose is deliberately absent from this list in both
// providers. That is the evidence contract the research pipeline depends on: a source is
// verified because search returned it, never because the model mentioned it.
function extractWebSearchResultUrls(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return getActiveProvider() === 'gemini'
    ? geminiClient.extractWebSearchResultUrls(raw.candidates)
    : claudeClient.extractWebSearchResultUrls(raw.content);
}

module.exports = {
  sendMessage,
  isConfigured,
  getActiveProvider,
  extractWebSearchResultUrls,
  DEFAULT_PROVIDER,
};

if (require.main === module) {
  let provider;
  try {
    provider = getActiveProvider();
  } catch (err) {
    console.error(`STOP: ${err.message}`);
    process.exit(1);
  }
  console.log(`Active AI provider: ${provider}`);
  console.log(
    isConfigured()
      ? `${provider} is configured.`
      : `${provider} is NOT configured (missing API key) - see .env.example.`
  );
}
