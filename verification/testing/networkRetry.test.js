'use strict';

const assert = require('node:assert');
const {
  RetryableError,
  getMaxRetryAttempts,
  getRetryBaseDelayMs,
  getRequestTimeoutMs,
  getMaxRetryAfterDelayMs,
  parseRetryAfterMs,
  retryAsync,
  withTimeout,
} = require('../../agent/core/networkRetry');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

// Keeps every test in this file fast regardless of the real default backoff -
// exercises the retry COUNT/GATING logic, not real wall-clock timing.
function withZeroDelay(fn) {
  const saved = process.env.NETWORK_RETRY_BASE_DELAY_MS;
  process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
      else process.env.NETWORK_RETRY_BASE_DELAY_MS = saved;
    });
}

function withMaxAttempts(n, fn) {
  const saved = process.env.MAX_NETWORK_RETRY_ATTEMPTS;
  process.env.MAX_NETWORK_RETRY_ATTEMPTS = String(n);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.MAX_NETWORK_RETRY_ATTEMPTS;
      else process.env.MAX_NETWORK_RETRY_ATTEMPTS = saved;
    });
}

test('getMaxRetryAttempts and getRetryBaseDelayMs return sane defaults', () => {
  assert.ok(getMaxRetryAttempts() >= 1);
  assert.ok(getRetryBaseDelayMs() >= 0);
});

test('getMaxRetryAttempts respects a MAX_NETWORK_RETRY_ATTEMPTS env override', () => {
  const saved = process.env.MAX_NETWORK_RETRY_ATTEMPTS;
  process.env.MAX_NETWORK_RETRY_ATTEMPTS = '5';
  try {
    assert.strictEqual(getMaxRetryAttempts(), 5);
  } finally {
    if (saved === undefined) delete process.env.MAX_NETWORK_RETRY_ATTEMPTS;
    else process.env.MAX_NETWORK_RETRY_ATTEMPTS = saved;
  }
});

test('getRetryBaseDelayMs respects a NETWORK_RETRY_BASE_DELAY_MS env override, including 0', () => {
  const saved = process.env.NETWORK_RETRY_BASE_DELAY_MS;
  process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
  try {
    assert.strictEqual(getRetryBaseDelayMs(), 0);
  } finally {
    if (saved === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
    else process.env.NETWORK_RETRY_BASE_DELAY_MS = saved;
  }
});

test('getRequestTimeoutMs returns a sane default and respects a NETWORK_REQUEST_TIMEOUT_MS env override', () => {
  assert.ok(getRequestTimeoutMs() > 0);
  const saved = process.env.NETWORK_REQUEST_TIMEOUT_MS;
  process.env.NETWORK_REQUEST_TIMEOUT_MS = '5000';
  try {
    assert.strictEqual(getRequestTimeoutMs(), 5000);
  } finally {
    if (saved === undefined) delete process.env.NETWORK_REQUEST_TIMEOUT_MS;
    else process.env.NETWORK_REQUEST_TIMEOUT_MS = saved;
  }
});

test('getMaxRetryAfterDelayMs returns a sane default and respects a MAX_RETRY_AFTER_DELAY_MS env override', () => {
  assert.ok(getMaxRetryAfterDelayMs() > 0);
  const saved = process.env.MAX_RETRY_AFTER_DELAY_MS;
  process.env.MAX_RETRY_AFTER_DELAY_MS = '10000';
  try {
    assert.strictEqual(getMaxRetryAfterDelayMs(), 10000);
  } finally {
    if (saved === undefined) delete process.env.MAX_RETRY_AFTER_DELAY_MS;
    else process.env.MAX_RETRY_AFTER_DELAY_MS = saved;
  }
});

test('parseRetryAfterMs returns null when there is no headers accessor at all', () => {
  assert.strictEqual(parseRetryAfterMs({}), null);
  assert.strictEqual(parseRetryAfterMs(null), null);
});

test('parseRetryAfterMs parses a seconds-form Retry-After header', () => {
  const response = { headers: { get: (name) => (name === 'retry-after' ? '2' : null) } };
  assert.strictEqual(parseRetryAfterMs(response), 2000);
});

test('parseRetryAfterMs parses an HTTP-date-form Retry-After header', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const response = { headers: { get: (name) => (name === 'retry-after' ? future : null) } };
  const parsed = parseRetryAfterMs(response);
  assert.ok(parsed !== null && parsed > 0 && parsed <= 6000, `expected ~5000ms, got ${parsed}`);
});

test('parseRetryAfterMs returns null for a missing or unparseable header', () => {
  const missing = { headers: { get: () => null } };
  const garbage = { headers: { get: () => 'not-a-valid-value' } };
  assert.strictEqual(parseRetryAfterMs(missing), null);
  assert.strictEqual(parseRetryAfterMs(garbage), null);
});

test('RetryableError carries an optional retryAfterMs, defaulting to null', () => {
  const withRetryAfter = new RetryableError('rate limited', { retryAfterMs: 1500 });
  assert.strictEqual(withRetryAfter.retryAfterMs, 1500);
  const withoutRetryAfter = new RetryableError('transient failure');
  assert.strictEqual(withoutRetryAfter.retryAfterMs, null);
});

(async () => {
  await testAsync('retryAsync succeeds immediately when the first attempt succeeds (call count 1)', async () => {
    await withZeroDelay(async () => {
      let calls = 0;
      const result = await retryAsync(async () => {
        calls += 1;
        return 'ok';
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(result, 'ok');
    });
  });

  await testAsync('retryAsync retries a RetryableError and succeeds once the underlying call recovers', async () => {
    await withZeroDelay(async () => {
      let calls = 0;
      const result = await retryAsync(async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError('simulated transient failure');
        return `succeeded on attempt ${calls}`;
      });
      assert.strictEqual(calls, 3);
      assert.strictEqual(result, 'succeeded on attempt 3');
    });
  });

  await testAsync('retryAsync exhausts MAX_NETWORK_RETRY_ATTEMPTS and rethrows the last error when every attempt fails', async () => {
    await withZeroDelay(() =>
      withMaxAttempts(3, async () => {
        let calls = 0;
        await assert.rejects(
          () =>
            retryAsync(async () => {
              calls += 1;
              throw new RetryableError(`attempt ${calls} failed`);
            }),
          /attempt 3 failed/
        );
        assert.strictEqual(calls, 3, 'should attempt exactly the configured max, never more');
      })
    );
  });

  await testAsync('withTimeout rejects with a clear message once timeoutMs elapses (fetch never resolves)', async () => {
    const neverResolves = () => new Promise(() => {});
    await assert.rejects(() => withTimeout(neverResolves, 20), /timed out after 20ms/);
  });

  await testAsync('withTimeout resolves normally when the underlying call finishes first', async () => {
    const result = await withTimeout(async () => 'ok', 5000);
    assert.strictEqual(result, 'ok');
  });

  await testAsync('retryAsync waits the server-instructed Retry-After delay (bounded by getMaxRetryAfterDelayMs) instead of exponential backoff', async () => {
    const savedMaxRetryAfter = process.env.MAX_RETRY_AFTER_DELAY_MS;
    process.env.MAX_RETRY_AFTER_DELAY_MS = '10000';
    try {
      await withZeroDelay(async () => {
        let calls = 0;
        const start = Date.now();
        const result = await retryAsync(async () => {
          calls += 1;
          if (calls === 1) throw new RetryableError('rate limited', { retryAfterMs: 50 });
          return 'ok';
        });
        const elapsed = Date.now() - start;
        assert.strictEqual(result, 'ok');
        assert.strictEqual(calls, 2);
        assert.ok(elapsed >= 45, `expected to wait ~50ms per retryAfterMs, only waited ${elapsed}ms`);
      });
    } finally {
      if (savedMaxRetryAfter === undefined) delete process.env.MAX_RETRY_AFTER_DELAY_MS;
      else process.env.MAX_RETRY_AFTER_DELAY_MS = savedMaxRetryAfter;
    }
  });

  await testAsync('retryAsync caps a Retry-After delay at getMaxRetryAfterDelayMs', async () => {
    const savedMaxRetryAfter = process.env.MAX_RETRY_AFTER_DELAY_MS;
    process.env.MAX_RETRY_AFTER_DELAY_MS = '30';
    try {
      await withZeroDelay(async () => {
        let calls = 0;
        const start = Date.now();
        await retryAsync(async () => {
          calls += 1;
          if (calls === 1) throw new RetryableError('rate limited', { retryAfterMs: 5000 });
          return 'ok';
        });
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 1000, `expected the 5000ms Retry-After to be capped near 30ms, waited ${elapsed}ms`);
      });
    } finally {
      if (savedMaxRetryAfter === undefined) delete process.env.MAX_RETRY_AFTER_DELAY_MS;
      else process.env.MAX_RETRY_AFTER_DELAY_MS = savedMaxRetryAfter;
    }
  });

  await testAsync('retryAsync never retries a plain (non-RetryableError) error - call count 1', async () => {
    await withZeroDelay(async () => {
      let calls = 0;
      await assert.rejects(
        () =>
          retryAsync(async () => {
            calls += 1;
            throw new Error('deterministic failure - retrying would never help');
          }),
        /deterministic failure/
      );
      assert.strictEqual(calls, 1, 'a non-retryable error must fail on the first attempt, never retried');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
