'use strict';

const assert = require('node:assert');
const { runReasoningCompletion } = require('../../tools/aiReasoningCompletion');
const claudeClient = require('../../agent/core/claudeClient');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');

// aiReasoningCompletion.js calls claudeClient.sendMessage(...) via the required
// module object (not a destructured binding), which is what makes it possible to
// substitute a mocked implementation here without a mocking framework - see that
// file's header comment. Every mock is installed and restored within a single test's
// try/finally so no mock ever leaks into another test.

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

test('exports the expected function', () => {
  assert.strictEqual(typeof runReasoningCompletion, 'function');
});

(async () => {
  await testAsync('rejects a missing/empty instruction without touching Claude at all', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be called for an invalid instruction');
    };
    try {
      await assert.rejects(() => runReasoningCompletion({}), /non-empty `instruction` string/);
      await assert.rejects(() => runReasoningCompletion({ instruction: '   ' }), /non-empty `instruction` string/);
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('throws the clear not-configured error when ANTHROPIC_API_KEY is unset (real claudeClient, no mock)', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        () => runReasoningCompletion({ instruction: 'draft a product description' }),
        /ANTHROPIC_API_KEY is not set/
      );
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('refuses to call Claude at all once the run token budget is exhausted', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be called once the run budget is exhausted');
    };
    try {
      await assert.rejects(
        () => runReasoningCompletion({
          instruction: 'draft a product description',
          tokensUsedThisRun: getMaxTokensPerRun(),
        }),
        /budget/
      );
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: returns a structured result built from a mocked Claude response, never the raw envelope', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;

    let receivedRequest = null;
    claudeClient.sendMessage = async (request) => {
      receivedRequest = request;
      return {
        text: 'Here is a mocked product description.',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
        raw: { id: 'msg_mocked', type: 'message', content: [{ type: 'text', text: 'Here is a mocked product description.' }] },
      };
    };

    try {
      const result = await runReasoningCompletion({
        instruction: 'Draft a short product description.',
        context: 'The product is a reusable water bottle.',
      });

      // Structured output only - no `raw` field, no leaking the mocked API envelope.
      assert.deepStrictEqual(Object.keys(result).sort(), ['model', 'stopReason', 'text', 'tokensUsed'].sort());
      assert.strictEqual(result.text, 'Here is a mocked product description.');
      assert.strictEqual(result.model, 'claude-sonnet-5');
      assert.strictEqual(result.stopReason, 'end_turn');
      assert.strictEqual(result.tokensUsed, 20);

      // Structured input was actually passed through to the (mocked) client - the
      // instruction/context were combined into one user message, not left as two
      // separate ad hoc arguments the client wouldn't understand.
      assert.strictEqual(receivedRequest.messages.length, 1);
      assert.strictEqual(receivedRequest.messages[0].role, 'user');
      assert.ok(receivedRequest.messages[0].content.includes('Draft a short product description.'));
      assert.ok(receivedRequest.messages[0].content.includes('reusable water bottle'));
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('MOCKED: a requested maxTokens beyond the per-call ceiling is capped before reaching Claude', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;

    let receivedRequest = null;
    claudeClient.sendMessage = async (request) => {
      receivedRequest = request;
      return { text: 'ok', model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, raw: {} };
    };

    try {
      await runReasoningCompletion({ instruction: 'summarize this', maxTokens: 999999999 });
      assert.ok(receivedRequest.maxTokens < 999999999);
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
