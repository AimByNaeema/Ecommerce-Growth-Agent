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
//
// retryAfterMs (optional): when a 429 response names a concrete wait time via its
// Retry-After header (see parseRetryAfterMs below), the caller attaches it here so
// retryAsync honors the server's own instructed wait instead of guessing via
// exponential backoff - bounded by getMaxRetryAfterDelayMs() so one large header
// value can never stall a run indefinitely.
class RetryableError extends Error {
  constructor(message, { retryAfterMs } = {}) {
    super(message);
    this.name = 'RetryableError';
    this.retryable = true;
    this.retryAfterMs = typeof retryAfterMs === 'number' && retryAfterMs >= 0 ? retryAfterMs : null;
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

// How long a single connection-layer request (agent/core/claudeClient.js,
// integrations/adapters/shopifyClient.js) is allowed to hang before it's treated as a
// (retryable) failure instead of waiting forever - overridable via
// NETWORK_REQUEST_TIMEOUT_MS. Without this, a stalled fetch() never resolves or
// rejects, so retryAsync never gets a chance to run and the whole orchestrator run
// (which never throws on its own - see agent/core/orchestratorExecutionContract.js)
// simply hangs.
function getRequestTimeoutMs() {
  const envOverride = Number(process.env.NETWORK_REQUEST_TIMEOUT_MS);
  return envOverride > 0 ? envOverride : 30000;
}

// Upper bound on how long a server-instructed Retry-After wait is ever honored for -
// overridable via MAX_RETRY_AFTER_DELAY_MS. Respecting the header is more correct
// than a blind guess, but an unbounded wait would break this project's "controlled,
// bounded" execution model (see agent/core/executionBounds.js/usageLimits.js).
function getMaxRetryAfterDelayMs() {
  const envOverride = Number(process.env.MAX_RETRY_AFTER_DELAY_MS);
  return envOverride > 0 ? envOverride : 30000;
}

// Reads a Retry-After response header (seconds form or HTTP-date form) and returns
// the wait time in ms, or null when absent/unparseable/there's no headers accessor at
// all (e.g. a hand-built mock response in tests that doesn't model headers) - never
// guessed when the header itself is missing.
function parseRetryAfterMs(response) {
  const header = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls asyncFn() and returns its result. On a thrown RetryableError (err.retryable
// === true), retries until getMaxRetryAttempts() is reached, then rethrows the last
// error. The wait before the next attempt is the server-instructed Retry-After value
// (bounded by getMaxRetryAfterDelayMs()) when the error carries one, otherwise
// exponential backoff. Any non-retryable error propagates immediately on the first
// attempt - never retried, matching toolSelectionRules.js's "never retry silently
// forever" rule by construction (bounded attempts) and by design (only transient
// failures are ever retried).
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
      const delay = typeof err.retryAfterMs === 'number'
        ? Math.min(err.retryAfterMs, getMaxRetryAfterDelayMs())
        : baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

// Races fetchFn(signal) against a timer bounded by timeoutMs (default
// getRequestTimeoutMs()). fetchFn receives an AbortController's signal so a real
// in-flight request is actually cancelled on timeout, not just abandoned; the race
// (rather than relying solely on AbortError) also makes this deterministically
// testable against a mocked fetch that never inspects the signal. Throws a plain,
// clear Error naming the timeout - the caller's own try/catch (see claudeClient.js/
// shopifyClient.js) is what decides whether that's retryable, same as any other
// thrown fetch() failure.
async function withTimeout(fetchFn, timeoutMs = getRequestTimeoutMs()) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    // Deliberately NOT unref'd: unref would let Node exit before this timer ever
    // fires whenever nothing else is pinning the event loop (e.g. a hung request
    // with no other pending I/O) - exactly the case this timeout exists to catch.
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchFn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  RetryableError,
  getMaxRetryAttempts,
  getRetryBaseDelayMs,
  getRequestTimeoutMs,
  getMaxRetryAfterDelayMs,
  parseRetryAfterMs,
  retryAsync,
  withTimeout,
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
