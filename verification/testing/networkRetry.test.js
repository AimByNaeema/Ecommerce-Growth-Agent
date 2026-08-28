'use strict';

const assert = require('node:assert');
const { RetryableError, getMaxRetryAttempts, getRetryBaseDelayMs, retryAsync } = require('../../agent/core/networkRetry');

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
