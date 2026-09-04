'use strict';

// Focused tests for tools/aiReasoningCompletion.js honoring AI_PROVIDER
// (agent/core/aiProviderSelector.js) instead of calling one hardcoded client.
//
// The shared reasoning tool is the Chief/Orchestrator's only model path, so whichever
// provider it picks is the provider EVERY orchestrated reasoning call uses - including
// /ask. These tests pin AI_PROVIDER explicitly rather than relying on whatever the
// developer's own .env says, so they assert real behavior on any machine.
//
// No real API call is ever made: claudeClient.sendMessage and geminiClient.sendMessage
// are monkey-patched on the shared cached module instances, which is exactly what
// aiProviderSelector resolves to at call time.

const assert = require('node:assert');

const claudeClient = require('../../agent/core/claudeClient');
const geminiClient = require('../../agent/core/geminiClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const { runReasoningCompletion } = require('../../tools/aiReasoningCompletion');
const { normalizeUsage, totalTokensFromUsage } = require('../../agent/core/tokenControls');

let passed = 0;
let failed = 0;

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

// A real Claude Messages API usage shape and a real Gemini generateContent usage shape.
// These field names are the whole point of the normalization under test.
const CLAUDE_USAGE = { input_tokens: 120, output_tokens: 80 };
const GEMINI_USAGE = { promptTokenCount: 120, candidatesTokenCount: 80, totalTokenCount: 200 };

// Stubs BOTH clients and records which one was actually reached, so "gemini was used"
// is proven by Claude staying untouched rather than merely by a return value.
async function withBothClientsStubbed(fn, { claudeUsage = CLAUDE_USAGE, geminiUsage = GEMINI_USAGE } = {}) {
  const savedClaude = claudeClient.sendMessage;
  const savedGemini = geminiClient.sendMessage;
  const calls = { claude: 0, gemini: 0, lastArgs: null };

  claudeClient.sendMessage = async (args) => {
    calls.claude += 1;
    calls.lastArgs = args;
    return { text: 'claude answered', model: 'claude-test', stopReason: 'end_turn', usage: claudeUsage };
  };
  geminiClient.sendMessage = async (args) => {
    calls.gemini += 1;
    calls.lastArgs = args;
    return { text: 'gemini answered', model: 'gemini-test', stopReason: 'STOP', usage: geminiUsage };
  };

  try {
    return await fn(calls);
  } finally {
    claudeClient.sendMessage = savedClaude;
    geminiClient.sendMessage = savedGemini;
  }
}

// AI_PROVIDER set on process.env before the selector reads it takes precedence over the
// repo's own .env (Node's loadEnvFile does not overwrite an already-set variable), so
// these tests are deterministic regardless of local configuration.
async function withProvider(value, fn) {
  const saved = process.env.AI_PROVIDER;
  if (value === null) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
  }
}

async function run() {
  // --- Provider selection ---

  await testAsync('AI_PROVIDER=gemini routes the shared reasoning call to the Gemini client', async () => {
    await withProvider('gemini', async () => {
      await withBothClientsStubbed(async (calls) => {
        const result = await runReasoningCompletion({ instruction: 'what should I focus on' });
        assert.strictEqual(calls.gemini, 1, 'the Gemini client must receive the call');
        assert.strictEqual(calls.claude, 0, 'the Claude client must not be called at all');
        assert.strictEqual(result.text, 'gemini answered');
        assert.strictEqual(result.model, 'gemini-test');
      });
    });
  });

  await testAsync('AI_PROVIDER=claude routes the shared reasoning call to the Claude client', async () => {
    await withProvider('claude', async () => {
      await withBothClientsStubbed(async (calls) => {
        const result = await runReasoningCompletion({ instruction: 'what should I focus on' });
        assert.strictEqual(calls.claude, 1, 'the Claude client must receive the call');
        assert.strictEqual(calls.gemini, 0, 'the Gemini client must not be called at all');
        assert.strictEqual(result.text, 'claude answered');
        assert.strictEqual(result.model, 'claude-test');
      });
    });
  });

  await testAsync('an unset AI_PROVIDER falls back to the selector default (gemini)', async () => {
    await withProvider(null, async () => {
      await withBothClientsStubbed(async (calls) => {
        const result = await runReasoningCompletion({ instruction: 'hello' });
        assert.strictEqual(aiProviderSelector.DEFAULT_PROVIDER, 'gemini');
        assert.strictEqual(calls.gemini, 1);
        assert.strictEqual(calls.claude, 0);
        assert.strictEqual(result.text, 'gemini answered');
      });
    });
  });

  await testAsync('an unrecognized AI_PROVIDER fails loudly instead of silently picking one', async () => {
    await withProvider('not-a-provider', async () => {
      await withBothClientsStubbed(async (calls) => {
        await assert.rejects(
          () => runReasoningCompletion({ instruction: 'hello' }),
          /Unrecognized AI_PROVIDER/
        );
        assert.strictEqual(calls.claude + calls.gemini, 0, 'no client may be called on a bad config');
      });
    });
  });

  // --- Token accounting across both providers ---
  // The regression these guard: reading Claude's field names off a Gemini response
  // reported 0 tokens, which left the orchestrator's run budget permanently at 0.

  await testAsync('normalizeUsage understands both providers usage shapes', async () => {
    assert.deepStrictEqual(normalizeUsage(CLAUDE_USAGE), { input: 120, output: 80 });
    assert.deepStrictEqual(normalizeUsage(GEMINI_USAGE), { input: 120, output: 80 });
    assert.strictEqual(totalTokensFromUsage(CLAUDE_USAGE), 200);
    assert.strictEqual(totalTokensFromUsage(GEMINI_USAGE), 200);
    // Never fabricates a number for missing/malformed usage.
    assert.deepStrictEqual(normalizeUsage(undefined), { input: 0, output: 0 });
    assert.deepStrictEqual(normalizeUsage({}), { input: 0, output: 0 });
    assert.strictEqual(totalTokensFromUsage(null), 0);
  });

  await testAsync('a Gemini reply reports real, non-zero token usage', async () => {
    await withProvider('gemini', async () => {
      await withBothClientsStubbed(async () => {
        const result = await runReasoningCompletion({ instruction: 'hello' });
        assert.strictEqual(result.tokensUsed, 200, 'a real Gemini cost must not be reported as 0');
        assert.strictEqual(result.inputTokens, 120);
        assert.strictEqual(result.outputTokens, 80);
      });
    });
  });

  await testAsync('a Claude reply still reports the same token usage as before', async () => {
    await withProvider('claude', async () => {
      await withBothClientsStubbed(async () => {
        const result = await runReasoningCompletion({ instruction: 'hello' });
        assert.strictEqual(result.tokensUsed, 200);
        assert.strictEqual(result.inputTokens, 120);
        assert.strictEqual(result.outputTokens, 80);
      });
    });
  });

  // --- Existing controls still apply on both providers ---

  await testAsync('the token budget still refuses an over-budget call before any provider is reached', async () => {
    for (const provider of ['gemini', 'claude']) {
      await withProvider(provider, async () => {
        await withBothClientsStubbed(async (calls) => {
          await assert.rejects(
            () => runReasoningCompletion({ instruction: 'hello', tokensUsedThisRun: 10_000_000 }),
            /budget/i,
            `${provider} should be refused when the run budget is exhausted`
          );
          assert.strictEqual(calls.claude + calls.gemini, 0, `${provider}: no client may be reached over budget`);
        });
      });
    }
  });

  await testAsync('the per-call token ceiling is applied on both providers', async () => {
    const savedPerCall = process.env.MAX_TOKENS_PER_CALL;
    process.env.MAX_TOKENS_PER_CALL = '64';
    try {
      for (const provider of ['gemini', 'claude']) {
        await withProvider(provider, async () => {
          await withBothClientsStubbed(async (calls) => {
            await runReasoningCompletion({ instruction: 'hello', maxTokens: 999999 });
            assert.strictEqual(calls.lastArgs.maxTokens, 64, `${provider}: the request must be capped, not trusted`);
          });
        });
      }
    } finally {
      if (savedPerCall === undefined) delete process.env.MAX_TOKENS_PER_CALL;
      else process.env.MAX_TOKENS_PER_CALL = savedPerCall;
    }
  });

  await testAsync('a missing instruction is still rejected before any provider is reached', async () => {
    await withProvider('gemini', async () => {
      await withBothClientsStubbed(async (calls) => {
        await assert.rejects(() => runReasoningCompletion({ instruction: '' }), /non-empty `instruction`/);
        assert.strictEqual(calls.claude + calls.gemini, 0);
      });
    });
  });

  await testAsync('businessId and the composed context still reach the active provider', async () => {
    await withProvider('gemini', async () => {
      await withBothClientsStubbed(async (calls) => {
        await runReasoningCompletion({
          instruction: 'the instruction',
          context: 'the supporting context',
          businessId: 'acme',
        });
        assert.strictEqual(calls.lastArgs.businessId, 'acme');
        const sent = calls.lastArgs.messages[0].content;
        assert.ok(sent.includes('the instruction'));
        assert.ok(sent.includes('the supporting context'));
      });
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
