'use strict';

const assert = require('node:assert');
const {
  sendMessage,
  isConfigured,
  extractText,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} = require('../../agent/core/geminiClient');

// This test never makes a real network call - it only checks the connection
// layer's structure and its error handling, matching the project's convention of
// never inventing a result. Whether GEMINI_API_KEY is actually set is
// environment-dependent, so the API-key test below saves/restores it rather than
// assuming either state.

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

test('exports the expected connection-layer functions and constants', () => {
  assert.strictEqual(typeof sendMessage, 'function');
  assert.strictEqual(typeof isConfigured, 'function');
  assert.strictEqual(typeof extractText, 'function');
  assert.strictEqual(typeof DEFAULT_MODEL, 'string');
  assert.ok(DEFAULT_MODEL.trim() !== '');
  assert.strictEqual(typeof DEFAULT_MAX_TOKENS, 'number');
  assert.ok(DEFAULT_MAX_TOKENS > 0);
});

test('extractText joins text parts and ignores non-text parts', () => {
  const candidates = [
    {
      content: {
        parts: [{ text: 'hello' }, { functionCall: { name: 'x' } }, { text: 'world' }],
      },
    },
  ];
  assert.strictEqual(extractText(candidates), 'hello\nworld');
});

test('extractText returns an empty string for missing/invalid content', () => {
  assert.strictEqual(extractText(undefined), '');
  assert.strictEqual(extractText(null), '');
  assert.strictEqual(extractText('not an array'), '');
});

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
    });
}

function withZeroRetryDelay(fn) {
  const saved = process.env.NETWORK_RETRY_BASE_DELAY_MS;
  process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
      else process.env.NETWORK_RETRY_BASE_DELAY_MS = saved;
    });
}

function withApiKeyConfigured(fn) {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaSyTestKeyNotReal00000000000000000';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status text',
    json: async () => body,
  };
}

const SAMPLE_MESSAGE_RESPONSE = {
  candidates: [
    { content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
};

(async () => {
  await testAsync('sendMessage rejects a missing/empty messages array', async () => {
    await assert.rejects(() => sendMessage({}), /non-empty `messages` array/);
    await assert.rejects(() => sendMessage({ messages: [] }), /non-empty `messages` array/);
  });

  await testAsync('sendMessage throws a clear error when no API key is configured', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.strictEqual(isConfigured(), false);
      await assert.rejects(
        () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
        /GEMINI_API_KEY is not set/
      );
    } finally {
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
    }
  });

  await testAsync('isConfigured reflects a real GEMINI_API_KEY being set', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyTestKeyNotReal00000000000000000';
    try {
      assert.strictEqual(isConfigured(), true);
    } finally {
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
    }
  });

  // --- Controlled retries (agent/core/networkRetry.js) ------------------------------

  await testAsync('sendMessage retries a transient 500-then-200 sequence and succeeds (fetch called twice)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withApiKeyConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            if (calls === 1) return jsonResponse(500, { error: { message: 'Internal error' } });
            return jsonResponse(200, SAMPLE_MESSAGE_RESPONSE);
          },
          async () => {
            const result = await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
            assert.strictEqual(result.text, 'ok');
          }
        )
      )
    );
    assert.strictEqual(calls, 2, 'a 500 followed by a 200 should be retried once, not more');
  });

  await testAsync('sendMessage retries on HTTP 429 (rate limit)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withApiKeyConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            if (calls === 1) return jsonResponse(429, { error: { message: 'Rate limited' } });
            return jsonResponse(200, SAMPLE_MESSAGE_RESPONSE);
          },
          () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] })
        )
      )
    );
    assert.strictEqual(calls, 2);
  });

  await testAsync('sendMessage never retries a 4xx response (fetch called exactly once)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withApiKeyConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(401, { error: { message: 'Invalid API key' } });
          },
          () =>
            assert.rejects(
              () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
              /request failed \(401\)/
            )
        )
      )
    );
    assert.strictEqual(calls, 1, 'a 4xx response will deterministically fail again - it must never be retried');
  });

  await testAsync('sendMessage exhausts retries and throws the last error when every attempt is a transient failure', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withApiKeyConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(503, { error: { message: 'Service unavailable' } });
          },
          () =>
            assert.rejects(
              () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
              /request failed \(503\)/
            )
        )
      )
    );
    assert.strictEqual(calls, 3, 'should attempt exactly the default max (3), never more');
  });

  // --- Invalid/malformed responses never become a fabricated reply -----------------

  await testAsync('sendMessage throws a clear error instead of a fabricated empty reply when content is missing', async () => {
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { usageMetadata: {} }),
        () =>
          assert.rejects(
            () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
            /unexpected\/missing content shape/
          )
      )
    );
  });

  await testAsync('sendMessage throws a clear error instead of a fabricated empty reply when content is not an array', async () => {
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { candidates: 'not an array' }),
        () =>
          assert.rejects(
            () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
            /unexpected\/missing content shape/
          )
      )
    );
  });

  await testAsync('sendMessage throws a clear error instead of crashing when the response body fails to parse as JSON', async () => {
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('bad json'); } }),
        () =>
          assert.rejects(
            () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
            /unexpected\/missing content shape/
          )
      )
    );
  });

  await testAsync('sendMessage still succeeds normally when content is a valid (non-empty) array', async () => {
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, SAMPLE_MESSAGE_RESPONSE),
        async () => {
          const result = await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
          assert.strictEqual(result.text, 'ok');
        }
      )
    );
  });

  // --- Timeouts ----------------------------------------------------------------------

  await testAsync('sendMessage rejects with a clear timeout error when the request never resolves', async () => {
    const savedTimeout = process.env.NETWORK_REQUEST_TIMEOUT_MS;
    process.env.NETWORK_REQUEST_TIMEOUT_MS = '20';
    try {
      await withZeroRetryDelay(() =>
        withApiKeyConfigured(() =>
          withMockedFetch(
            () => new Promise(() => {}),
            () =>
              assert.rejects(
                () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
                /Could not reach the Gemini API.*timed out after 20ms/
              )
          )
        )
      );
    } finally {
      if (savedTimeout === undefined) delete process.env.NETWORK_REQUEST_TIMEOUT_MS;
      else process.env.NETWORK_REQUEST_TIMEOUT_MS = savedTimeout;
    }
  });

  // --- Rate limits: Retry-After is honored, bounded ----------------------------------

  await testAsync('sendMessage honors a Retry-After header on a 429 instead of guessing via backoff', async () => {
    let calls = 0;
    const timestamps = [];
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => {
          calls += 1;
          timestamps.push(Date.now());
          if (calls === 1) {
            return {
              ok: false,
              status: 429,
              statusText: 'Too Many Requests',
              headers: { get: (name) => (name === 'retry-after' ? '0.05' : null) },
              json: async () => ({ error: { message: 'Rate limited' } }),
            };
          }
          return jsonResponse(200, SAMPLE_MESSAGE_RESPONSE);
        },
        () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] })
      )
    );
    assert.strictEqual(calls, 2);
    assert.ok(timestamps[1] - timestamps[0] >= 40, 'should wait ~50ms per the Retry-After header, not a shorter guess');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
