'use strict';

const assert = require('node:assert');
const {
  sendMessage,
  isConfigured,
  getActiveProvider,
  DEFAULT_PROVIDER,
} = require('../../agent/core/aiProviderSelector');
const { loadEnvOnce: loadGeminiEnvOnce } = require('../../agent/core/geminiClient');

// This test never makes a real network call - the sendMessage-delegation tests mock
// global.fetch the same way claudeClient.test.js/geminiClient.test.js already do. It
// only checks that aiProviderSelector.js correctly resolves AI_PROVIDER and delegates
// to the matching client unchanged - never reimplementing either client's own logic.

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

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
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

const CLAUDE_SAMPLE_RESPONSE = {
  content: [{ type: 'text', text: 'claude-ok' }],
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

const GEMINI_SAMPLE_RESPONSE = {
  candidates: [
    { content: { parts: [{ text: 'gemini-ok' }], role: 'model' }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
};

test('exports the expected selector functions and constants', () => {
  assert.strictEqual(typeof sendMessage, 'function');
  assert.strictEqual(typeof isConfigured, 'function');
  assert.strictEqual(typeof getActiveProvider, 'function');
  assert.strictEqual(DEFAULT_PROVIDER, 'gemini');
});

test('getActiveProvider defaults to "gemini" when AI_PROVIDER is unset', () => {
  const saved = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;
  try {
    assert.strictEqual(getActiveProvider(), 'gemini');
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
});

test('getActiveProvider defaults to "gemini" when AI_PROVIDER is blank/whitespace-only', () => {
  const saved = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = '   ';
  try {
    assert.strictEqual(getActiveProvider(), 'gemini');
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
});

test('getActiveProvider returns "claude" when AI_PROVIDER=claude, normalizing case/whitespace', () => {
  const saved = process.env.AI_PROVIDER;
  try {
    process.env.AI_PROVIDER = 'claude';
    assert.strictEqual(getActiveProvider(), 'claude');
    process.env.AI_PROVIDER = 'CLAUDE';
    assert.strictEqual(getActiveProvider(), 'claude');
    process.env.AI_PROVIDER = '  claude  ';
    assert.strictEqual(getActiveProvider(), 'claude');
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
});

test('getActiveProvider returns "gemini" when AI_PROVIDER=gemini, normalizing case/whitespace', () => {
  const saved = process.env.AI_PROVIDER;
  try {
    process.env.AI_PROVIDER = 'gemini';
    assert.strictEqual(getActiveProvider(), 'gemini');
    process.env.AI_PROVIDER = 'Gemini';
    assert.strictEqual(getActiveProvider(), 'gemini');
    process.env.AI_PROVIDER = '  gemini  ';
    assert.strictEqual(getActiveProvider(), 'gemini');
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
});

test('getActiveProvider throws a clear error for an unrecognized AI_PROVIDER value', () => {
  const saved = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'chatgpt';
  try {
    assert.throws(() => getActiveProvider(), /Unrecognized AI_PROVIDER value 'chatgpt'/);
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
});

(async () => {
  await testAsync('isConfigured delegates to Claude when AI_PROVIDER=claude', async () => {
    await withEnv({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined }, async () => {
      assert.strictEqual(isConfigured(), false);
      await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-key-not-real' }, async () => {
        assert.strictEqual(isConfigured(), true);
      });
    });
  });

  await testAsync('isConfigured delegates to Gemini when AI_PROVIDER=gemini', async () => {
    // Force geminiClient.js's one-time .env load to happen before GEMINI_API_KEY is
    // deleted below - otherwise, if this is the first call into geminiClient.js in
    // this process, isConfigured()'s own internal loadEnvOnce() would reload a real
    // GEMINI_API_KEY from the local .env file right after the delete.
    loadGeminiEnvOnce();
    await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: undefined }, async () => {
      assert.strictEqual(isConfigured(), false);
      await withEnv({ GEMINI_API_KEY: 'AIzaSyTestKeyNotReal00000000000000000' }, async () => {
        assert.strictEqual(isConfigured(), true);
      });
    });
  });

  await testAsync('sendMessage delegates to Claude and returns its result unchanged when AI_PROVIDER=claude', async () => {
    await withEnv({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test-key-not-real' }, () =>
      withMockedFetch(
        async () => jsonResponse(200, CLAUDE_SAMPLE_RESPONSE),
        async () => {
          const result = await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
          assert.strictEqual(result.text, 'claude-ok');
        }
      )
    );
  });

  await testAsync('sendMessage delegates to Gemini and returns its result unchanged when AI_PROVIDER=gemini', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIzaSyTestKeyNotReal00000000000000000' }, () =>
      withMockedFetch(
        async () => jsonResponse(200, GEMINI_SAMPLE_RESPONSE),
        async () => {
          const result = await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
          assert.strictEqual(result.text, 'gemini-ok');
        }
      )
    );
  });

  await testAsync('sendMessage propagates the underlying client\'s own validation error unchanged', async () => {
    await withEnv({ AI_PROVIDER: 'claude' }, async () => {
      await assert.rejects(() => sendMessage({ messages: [] }), /non-empty `messages` array/);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
