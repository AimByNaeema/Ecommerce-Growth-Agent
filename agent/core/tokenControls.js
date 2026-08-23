'use strict';

// Token/cost controls for the Chief/Orchestrator's connection to Claude
// (agent/core/claudeClient.js). This is CLAUDE.md section 3's "Cost/token controls"
// shared infrastructure component: every Claude call must be checked here before it
// happens - a request that asks for more than the per-call ceiling is capped, never
// silently honored as-is, and once a run's token budget is exhausted, further calls
// are refused outright rather than allowed through quietly.
//
// Pure functions only - no I/O beyond reading configured env var overrides (the same
// convention agent/core/claudeClient.js already uses for ANTHROPIC_MAX_TOKENS), no
// network calls, no persistence. The defaults below are a conservative safety
// ceiling, not an asserted business cost policy - making them configuration-driven
// (configuration/business.yaml) is a natural next step, out of scope for this module.

const claudeClient = require('./claudeClient');

// The hard per-call ceiling: no single Claude call may request more output tokens
// than this, regardless of what's asked for. Reuses claudeClient.js's own
// DEFAULT_MAX_TOKENS as the default (single source of truth), overridable via
// MAX_TOKENS_PER_CALL - mirrors claudeClient.js's own ANTHROPIC_MAX_TOKENS pattern.
function getMaxTokensPerCall() {
  const envOverride = Number(process.env.MAX_TOKENS_PER_CALL);
  return envOverride > 0 ? envOverride : claudeClient.DEFAULT_MAX_TOKENS;
}

// The total output-token budget for one orchestrator run (one runOrchestratorContract
// call), across every Claude call it makes. Same conservative-default/env-override
// convention as getMaxTokensPerCall().
function getMaxTokensPerRun() {
  const envOverride = Number(process.env.MAX_TOKENS_PER_RUN);
  return envOverride > 0 ? envOverride : getMaxTokensPerCall() * 4;
}

// Sums a Claude Messages API usage object ({ input_tokens, output_tokens }) into one
// total. Never guesses - missing/malformed usage counts as 0, not fabricated.
function totalTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  return input + output;
}

// Decides whether a Claude call may proceed given what's already been used this run.
// Never silently allows an over-budget call through: once the run's budget is
// exhausted, the call is denied outright (allowed: false); otherwise the requested
// max_tokens is capped to whatever is safe (the per-call ceiling and the remaining
// run budget), never trusted as-is.
function checkTokenBudget({ requestedMaxTokens, tokensUsedThisRun = 0 } = {}) {
  const perCallCeiling = getMaxTokensPerCall();
  const perRunBudget = getMaxTokensPerRun();

  if (tokensUsedThisRun >= perRunBudget) {
    return {
      allowed: false,
      capped_max_tokens: 0,
      reason: `This run has already used ${tokensUsedThisRun} tokens, at or beyond its budget of ${perRunBudget} - no further Claude calls are allowed this run.`,
    };
  }

  const remainingBudget = perRunBudget - tokensUsedThisRun;
  const cappedMaxTokens = Math.min(requestedMaxTokens || perCallCeiling, perCallCeiling, remainingBudget);

  return { allowed: true, capped_max_tokens: cappedMaxTokens, reason: null };
}

module.exports = {
  getMaxTokensPerCall,
  getMaxTokensPerRun,
  totalTokensFromUsage,
  checkTokenBudget,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - token controls:\n');
  console.log(`Per-call ceiling: ${getMaxTokensPerCall()} tokens`);
  console.log(`Per-run budget: ${getMaxTokensPerRun()} tokens`);
  console.log('\nExample checks:');
  console.log(JSON.stringify(checkTokenBudget({ requestedMaxTokens: 500, tokensUsedThisRun: 0 }), null, 2));
  console.log(JSON.stringify(checkTokenBudget({ requestedMaxTokens: 500, tokensUsedThisRun: getMaxTokensPerRun() }), null, 2));
}
