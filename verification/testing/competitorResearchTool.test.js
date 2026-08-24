'use strict';

const assert = require('node:assert');
const { runCompetitorResearchTool } = require('../../tools/competitorResearchTool');

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

test('failed: no researchParams supplied at all reports an honest error, never a fabricated result', () => {
  const outcome = runCompetitorResearchTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: a competitor entry missing the required competitor field', () => {
  const outcome = runCompetitorResearchTool({ competitors: [{ market: 'EU' }] });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a non-empty `competitor`'));
});

test('empty: every competitor has no evidence/source supplied', () => {
  const outcome = runCompetitorResearchTool({
    competitors: [{ competitor: 'A', strengths: ['fast'] }],
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
});

test('partial: some competitors evidenced, others not', () => {
  const outcome = runCompetitorResearchTool({
    competitors: [
      { competitor: 'A', strengths: ['fast'] },
      { competitor: 'B', strengths: ['cheap'], source: ['s1'] },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.error, null);
});

test('successful: every competitor has evidence/source supplied', () => {
  const outcome = runCompetitorResearchTool({
    competitors: [{ competitor: 'A', strengths: ['fast'], source: ['s1'] }],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
