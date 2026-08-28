'use strict';

// Controlled retries for this project's two network-calling connection layers
// (integrations/adapters/shopifyClient.js's Admin GraphQL calls,
// agent/core/claudeClient.js's Messages API call). Every other "tool" in this
// codebase (agent/core/researchAgent.js, productAgent.js, seoAgent.js,
// marketingAgent.js, analyticsAgent.js) is a pure, deterministic in-memory function
// that either succeeds or throws a validation error - retrying those would never
// help and would just waste calls, so this module is deliberately narrow: it is
// consumed only by the two connection layers, never by
// agent/core/orchestratorExecutionContract.js's tool dispatch directly.
//
// agent/core/toolSelectionRules.js's existing handle_tool_failures rule already
// names "retrying silently forever" as prohibited - this module is the CONTROLLED
// counterpart: bounded attempts, explicit backoff, and only for a failure class the
// caller itself marks as transient (RetryableError) - a plain Error always
// propagates on the first attempt, never retried.
//
// Pure/no hidden state beyond env-var-configured ceilings, same convention as
// agent/core/tokenControls.js's getMaxTokensPerCall()/getMaxTokensPerRun() (a
// conservative safety default, not an asserted business policy).

// Thrown by a connection layer to mark one specific failure as worth retrying
// (network unreachable, HTTP 429, HTTP 5xx). Any other thrown error (4xx,
// not-configured, GraphQL-level error) is a plain Error and is never retried - it
// will deterministically fail again, so retrying it would only waste calls.
class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryableError';
    this.retryable = true;
  }
}

// Total attempts (including the first), overridable via MAX_NETWORK_RETRY_ATTEMPTS -
// mirrors tokenControls.js's MAX_TOKENS_PER_CALL env-override pattern.
function getMaxRetryAttempts() {
  const envOverride = Number(process.env.MAX_NETWORK_RETRY_ATTEMPTS);
  return envOverride > 0 ? envOverride : 3;
}

// Base delay in ms for exponential backoff (200ms, 400ms, 800ms, ...), overridable
// via NETWORK_RETRY_BASE_DELAY_MS - tests override this to 0 to stay fast.
function getRetryBaseDelayMs() {
  const envOverride = Number(process.env.NETWORK_RETRY_BASE_DELAY_MS);
  return Number.isFinite(envOverride) && envOverride >= 0 ? envOverride : 200;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls asyncFn() and returns its result. On a thrown RetryableError (err.retryable
// === true), retries with exponential backoff until getMaxRetryAttempts() is
// reached, then rethrows the last error. Any non-retryable error propagates
// immediately on the first attempt - never retried, matching
// toolSelectionRules.js's "never retry silently forever" rule by construction
// (bounded attempts) and by design (only transient failures are ever retried).
async function retryAsync(asyncFn) {
  const maxAttempts = getMaxRetryAttempts();
  const baseDelayMs = getRetryBaseDelayMs();
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await asyncFn();
    } catch (err) {
      lastError = err;
      if (!err || err.retryable !== true || attempt === maxAttempts) {
        throw err;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

module.exports = {
  RetryableError,
  getMaxRetryAttempts,
  getRetryBaseDelayMs,
  retryAsync,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - controlled network retry (bounded, explicit, transient-only):\n');
  console.log(`Max attempts: ${getMaxRetryAttempts()}`);
  console.log(`Base backoff delay: ${getRetryBaseDelayMs()}ms\n`);

  (async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls += 1;
      if (calls < 2) throw new RetryableError('simulated transient failure (placeholder)');
      return `succeeded on attempt ${calls}`;
    });
    console.log(`Transient-failure-then-success example: ${result}`);

    let nonRetryableCalls = 0;
    try {
      await retryAsync(async () => {
        nonRetryableCalls += 1;
        throw new Error('simulated non-transient failure (placeholder) - never retried');
      });
    } catch (err) {
      console.log(`Non-retryable example: failed after ${nonRetryableCalls} attempt(s) - "${err.message}"`);
    }
  })();
}
