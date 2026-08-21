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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
