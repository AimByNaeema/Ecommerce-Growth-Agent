'use strict';

const assert = require('node:assert');
const {
  getMaxTokensPerCall,
  getMaxTokensPerRun,
  totalTokensFromUsage,
  checkTokenBudget,
} = require('../../agent/core/tokenControls');

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

test('getMaxTokensPerCall and getMaxTokensPerRun return positive numbers by default', () => {
  assert.ok(getMaxTokensPerCall() > 0);
  assert.ok(getMaxTokensPerRun() > 0);
  assert.ok(getMaxTokensPerRun() >= getMaxTokensPerCall());
});

test('getMaxTokensPerCall respects a MAX_TOKENS_PER_CALL env override', () => {
  const saved = process.env.MAX_TOKENS_PER_CALL;
  process.env.MAX_TOKENS_PER_CALL = '777';
  try {
    assert.strictEqual(getMaxTokensPerCall(), 777);
  } finally {
    if (saved === undefined) delete process.env.MAX_TOKENS_PER_CALL;
    else process.env.MAX_TOKENS_PER_CALL = saved;
  }
});

test('totalTokensFromUsage sums input and output tokens', () => {
  assert.strictEqual(totalTokensFromUsage({ input_tokens: 10, output_tokens: 5 }), 15);
});

test('totalTokensFromUsage never fabricates a count for missing/malformed usage', () => {
  assert.strictEqual(totalTokensFromUsage(undefined), 0);
  assert.strictEqual(totalTokensFromUsage(null), 0);
  assert.strictEqual(totalTokensFromUsage('not an object'), 0);
  assert.strictEqual(totalTokensFromUsage({}), 0);
});

test('checkTokenBudget allows a call within budget and caps it to the per-call ceiling', () => {
  const result = checkTokenBudget({ requestedMaxTokens: getMaxTokensPerCall() + 10000, tokensUsedThisRun: 0 });
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.capped_max_tokens, getMaxTokensPerCall());
});

test('checkTokenBudget caps a request to whatever remains of the run budget, not just the per-call ceiling', () => {
  const perRunBudget = getMaxTokensPerRun();
  const alreadyUsed = perRunBudget - 100;
  const result = checkTokenBudget({ requestedMaxTokens: getMaxTokensPerCall(), tokensUsedThisRun: alreadyUsed });
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.capped_max_tokens, 100);
});

test('checkTokenBudget denies outright once the run budget is exhausted, never silently allowing 0 tokens through', () => {
  const perRunBudget = getMaxTokensPerRun();
  const result = checkTokenBudget({ requestedMaxTokens: 100, tokensUsedThisRun: perRunBudget });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.capped_max_tokens, 0);
  assert.ok(/budget/.test(result.reason));
});

test('checkTokenBudget defaults to the per-call ceiling when no maxTokens is requested', () => {
  const result = checkTokenBudget({ tokensUsedThisRun: 0 });
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.capped_max_tokens, getMaxTokensPerCall());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
