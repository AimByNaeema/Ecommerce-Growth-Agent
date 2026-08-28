'use strict';

const assert = require('node:assert');
const {
  sendMessage,
  isConfigured,
  extractText,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} = require('../../agent/core/claudeClient');

// This test never makes a real network call - it only checks the connection
// layer's structure and its error handling, matching the project's convention of
// never inventing a result. Whether ANTHROPIC_API_KEY is actually set is
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

test('extractText joins text blocks and ignores non-text blocks', () => {
  const content = [
    { type: 'text', text: 'hello' },
    { type: 'tool_use', id: 'x' },
    { type: 'text', text: 'world' },
  ];
  assert.strictEqual(extractText(content), 'hello\nworld');
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
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
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
  content: [{ type: 'text', text: 'ok' }],
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

(async () => {
  await testAsync('sendMessage rejects a missing/empty messages array', async () => {
    await assert.rejects(() => sendMessage({}), /non-empty `messages` array/);
    await assert.rejects(() => sendMessage({ messages: [] }), /non-empty `messages` array/);
  });

  await testAsync('sendMessage throws a clear error when no API key is configured', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.strictEqual(isConfigured(), false);
      await assert.rejects(
        () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] }),
        /ANTHROPIC_API_KEY is not set/
      );
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('isConfigured reflects a real ANTHROPIC_API_KEY being set', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    try {
      assert.strictEqual(isConfigured(), true);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
