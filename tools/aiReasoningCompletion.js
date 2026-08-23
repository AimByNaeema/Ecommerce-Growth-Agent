'use strict';

// The ai_reasoning_completion tool (tools/toolRegistry.js): the Chief/Orchestrator's
// only path to calling Claude. Thin wrapper around agent/core/claudeClient.js's
// sendMessage() - reuses it directly (no new HTTP logic, no second Claude client, no
// SDK). Structured input/output only: callers pass a compact
// { instruction, context, maxTokens } request, never a raw Anthropic messages array;
// callers receive a compact { text, model, stopReason, tokensUsed } result, never the
// raw API envelope.
//
// Token controls (agent/core/tokenControls.js) are enforced here, before
// claudeClient.js is ever called: a request that would exceed the run's remaining
// token budget is refused outright (sendMessage is never reached), and a request
// asking for more than the per-call ceiling is capped, never trusted as-is.
//
// claudeClient is required as a module object (not destructured) and called via
// property access (claudeClient.sendMessage(...)) so tests can substitute a mocked
// implementation without a mocking framework - see
// verification/testing/aiReasoningCompletion.test.js.

const claudeClient = require('../agent/core/claudeClient');
const { checkTokenBudget, totalTokensFromUsage } = require('../agent/core/tokenControls');

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
// Returns: { text, model, stopReason, tokensUsed }
// Throws: if instruction is missing/empty, if the run's token budget is already
// exhausted (before any network call is attempted), or whatever
// claudeClient.sendMessage() itself throws (not configured / network failure / API
// error) - never fabricates a reply.
async function runReasoningCompletion({ instruction, context, maxTokens, tokensUsedThisRun = 0 } = {}) {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('runReasoningCompletion requires a non-empty `instruction` string.');
  }

  const budget = checkTokenBudget({ requestedMaxTokens: maxTokens, tokensUsedThisRun });
  if (!budget.allowed) {
    throw new Error(budget.reason);
  }

  const userContent = context ? `${instruction}\n\nContext:\n${context}` : instruction;

  const result = await claudeClient.sendMessage({
    messages: [{ role: 'user', content: userContent }],
    maxTokens: budget.capped_max_tokens,
  });

  return {
    text: result.text,
    model: result.model,
    stopReason: result.stopReason,
    tokensUsed: totalTokensFromUsage(result.usage),
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
