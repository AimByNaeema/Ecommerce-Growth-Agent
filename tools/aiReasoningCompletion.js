'use strict';

// The ai_reasoning_completion tool (tools/toolRegistry.js): the Chief/Orchestrator's
// only path to a language model. Thin wrapper around agent/core/aiProviderSelector.js's
// sendMessage() - reuses it directly (no new HTTP logic, no second client, no SDK).
// Structured input/output only: callers pass a compact
// { instruction, context, maxTokens } request, never a raw provider messages array;
// callers receive a compact { text, model, stopReason, tokensUsed, inputTokens,
// outputTokens } result, never the raw API envelope.
//
// PROVIDER SELECTION: which model actually answers is decided by AI_PROVIDER (see
// agent/core/aiProviderSelector.js - "claude" or "gemini", defaulting to gemini), never
// hardcoded here and never chosen by a caller. This tool previously required
// agent/core/claudeClient.js directly, which meant a project configured for Gemini
// silently got Claude for every orchestrated reasoning call. Going through the selector
// is the whole fix: both clients already expose the same
// sendMessage({ messages, maxTokens, businessId }) shape, so nothing else here changes,
// and neither client's own behavior is touched.
//
// Deliberately NOT changed alongside this: tools/webCompetitorResearchTool.js still
// uses agent/core/claudeClient.js directly, because it passes a Claude-native
// `web_search` tool that agent/core/geminiClient.js has no equivalent for and would
// silently ignore. Routing that through the selector would quietly disable live web
// research whenever AI_PROVIDER is gemini - a separate, explicitly-scoped decision.
//
// Token controls (agent/core/tokenControls.js) are enforced here, before
// claudeClient.js is ever called: a request that would exceed the run's remaining
// token budget is refused outright (sendMessage is never reached), and a request
// asking for more than the per-call ceiling is capped, never trusted as-is.
//
// aiProviderSelector is required as a module object (not destructured) and called via
// property access (aiProviderSelector.sendMessage(...)) so tests can substitute a mocked
// implementation without a mocking framework - see
// verification/testing/aiReasoningCompletion.test.js. The selector resolves the active
// client per call, so a test can equally mock the underlying claudeClient/geminiClient
// (see verification/testing/aiReasoningProviderSelection.test.js).

const aiProviderSelector = require('../agent/core/aiProviderSelector');
const { checkTokenBudget, totalTokensFromUsage, normalizeUsage } = require('../agent/core/tokenControls');

// Runs one structured Claude completion.
//
// request:
//   instruction        - required, non-empty string: what Claude should do
//   context            - optional string: supporting context, kept separate from the
//                         instruction so callers never need to hand-build a prompt
//   maxTokens          - optional number: requested output token ceiling (checked and
//                         capped by tokenControls, never trusted as-is)
//   tokensUsedThisRun  - optional number: tokens already consumed this orchestrator
//                         run, used to enforce the run's token budget (default 0)
//
// Returns: { text, model, stopReason, tokensUsed, inputTokens, outputTokens }
// Throws: if instruction is missing/empty, if the run's token budget is already
// exhausted (before any network call is attempted), or whatever
// claudeClient.sendMessage() itself throws (not configured / network failure / API
// error) - never fabricates a reply.
async function runReasoningCompletion({ instruction, context, maxTokens, tokensUsedThisRun = 0, businessId = null } = {}) {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('runReasoningCompletion requires a non-empty `instruction` string.');
  }

  const budget = checkTokenBudget({ requestedMaxTokens: maxTokens, tokensUsedThisRun });
  if (!budget.allowed) {
    throw new Error(budget.reason);
  }

  const userContent = context ? `${instruction}\n\nContext:\n${context}` : instruction;

  const result = await aiProviderSelector.sendMessage({
    messages: [{ role: 'user', content: userContent }],
    maxTokens: budget.capped_max_tokens,
    businessId,
  });

  return {
    text: result.text,
    model: result.model,
    stopReason: result.stopReason,
    tokensUsed: totalTokensFromUsage(result.usage),
    // Additive - the input/output split, discarded by totalTokensFromUsage above,
    // survives here for usage/usageTracker.js's structured model_call usage events
    // (see agent/core/orchestratorExecutionContract.js's runExecutor). tokensUsed
    // itself is unchanged, so every existing consumer of this return value is
    // unaffected.
    //
    // Read through tokenControls.normalizeUsage rather than off Claude's own field
    // names: Gemini reports { promptTokenCount, candidatesTokenCount } instead, so
    // reading input_tokens/output_tokens directly reported 0 for every real Gemini
    // call - which would have left the run's token budget permanently at 0 and the
    // usage ledger understating real spend.
    inputTokens: normalizeUsage(result.usage).input,
    outputTokens: normalizeUsage(result.usage).output,
  };
}

module.exports = { runReasoningCompletion };

if (require.main === module) {
  claudeClient.loadEnvOnce();
  if (!claudeClient.isConfigured()) {
    console.log('ai_reasoning_completion tool loaded, but ANTHROPIC_API_KEY is not set.');
    console.log('Copy .env.example to .env and add a real key from:');
    console.log('  https://platform.claude.com/settings/keys');
    process.exit(0);
  }
  runReasoningCompletion({ instruction: 'Reply with exactly: connection ok' })
    .then((result) => {
      console.log('Claude reasoning completion succeeded.');
      console.log(`Model: ${result.model}`);
      console.log(`Reply: ${result.text}`);
      console.log(`Tokens used: ${result.tokensUsed}`);
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
