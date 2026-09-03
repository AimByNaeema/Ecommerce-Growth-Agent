'use strict';

const assert = require('node:assert');
const {
  sendMessage,
  isConfigured,
  extractText,
  extractWebSearchResultUrls,
  extractCitations,
  loadEnvOnce,
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

// --- extractWebSearchResultUrls / extractCitations (tools/webCompetitorResearchTool.js's
// ground-truth verification inputs) ------------------------------------------------

test('extractWebSearchResultUrls returns the real URLs a web_search_tool_result block actually returned', () => {
  const content = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'acme candles competitor' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        { type: 'web_search_result', url: 'https://example.com/a', title: 'A', page_age: 'May 1, 2026' },
        { type: 'web_search_result', url: 'https://example.com/b', title: 'B' },
      ],
    },
    { type: 'text', text: 'Found two competitors.' },
  ];
  assert.deepStrictEqual(extractWebSearchResultUrls(content), ['https://example.com/a', 'https://example.com/b']);
});

test('extractWebSearchResultUrls dedupes repeated URLs and ignores non-result blocks/entries', () => {
  const content = [
    {
      type: 'web_search_tool_result',
      tool_use_id: 'x',
      content: [
        { type: 'web_search_result', url: 'https://example.com/a' },
        { type: 'web_search_result', url: 'https://example.com/a' },
      ],
    },
    { type: 'web_search_tool_result', tool_use_id: 'y', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'no results in the error case' },
  ];
  assert.deepStrictEqual(extractWebSearchResultUrls(content), ['https://example.com/a']);
});

test('extractWebSearchResultUrls returns an empty array for missing/invalid content', () => {
  assert.deepStrictEqual(extractWebSearchResultUrls(undefined), []);
  assert.deepStrictEqual(extractWebSearchResultUrls(null), []);
  assert.deepStrictEqual(extractWebSearchResultUrls('not an array'), []);
  assert.deepStrictEqual(extractWebSearchResultUrls([{ type: 'text', text: 'no search happened' }]), []);
});

test('extractCitations returns unique { url, title } pairs from text block citations only', () => {
  const content = [
    {
      type: 'text',
      text: 'Acme Candles undercuts on price.',
      citations: [
        { type: 'web_search_result_location', url: 'https://example.com/a', title: 'Acme Candles', cited_text: '...' },
        { type: 'web_search_result_location', url: 'https://example.com/a', title: 'Acme Candles', cited_text: '...' },
      ],
    },
    { type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'q' } },
  ];
  assert.deepStrictEqual(extractCitations(content), [{ url: 'https://example.com/a', title: 'Acme Candles' }]);
});

test('extractCitations returns an empty array for missing/invalid content or text blocks with no citations', () => {
  assert.deepStrictEqual(extractCitations(undefined), []);
  assert.deepStrictEqual(extractCitations([{ type: 'text', text: 'no citations here' }]), []);
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
    // Force the one-time .env load to happen before the delete below - loadEnvOnce()
    // is a no-op on every later call (see agent/core/claudeClient.js's
    // envLoadAttempted guard), so without this, a real ANTHROPIC_API_KEY in the local
    // .env file would get (re-)populated by isConfigured()'s own internal
    // loadEnvOnce() call, right after the delete, making this test flake against real
    // local configuration (matches the identical fix already applied to
    // geminiClient.test.js).
    loadEnvOnce();
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

  // --- Invalid/malformed responses never become a fabricated reply -----------------

  await testAsync('sendMessage throws a clear error instead of a fabricated empty reply when content is missing', async () => {
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { model: 'claude-sonnet-5', stop_reason: 'end_turn' }),
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
        async () => jsonResponse(200, { content: 'not an array', model: 'claude-sonnet-5' }),
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

  // --- tools passthrough (additive - see tools/webCompetitorResearchTool.js) --------

  await testAsync('sendMessage omits `tools` from the request body entirely when not supplied - every existing caller unaffected', async () => {
    let receivedBody = null;
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async (url, init) => {
          receivedBody = JSON.parse(init.body);
          return jsonResponse(200, SAMPLE_MESSAGE_RESPONSE);
        },
        () => sendMessage({ messages: [{ role: 'user', content: 'hi' }] })
      )
    );
    assert.ok(!('tools' in receivedBody), 'body must not carry a tools key when none was requested');
  });

  await testAsync('sendMessage passes a supplied `tools` array through to the request body verbatim', async () => {
    let receivedBody = null;
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    await withApiKeyConfigured(() =>
      withMockedFetch(
        async (url, init) => {
          receivedBody = JSON.parse(init.body);
          return jsonResponse(200, SAMPLE_MESSAGE_RESPONSE);
        },
        () => sendMessage({ messages: [{ role: 'user', content: 'hi' }], tools })
      )
    );
    assert.deepStrictEqual(receivedBody.tools, tools);
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
                /Could not reach the Claude API.*timed out after 20ms/
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
