'use strict';

const assert = require('node:assert');
const { runCustomerResearchTool } = require('../../tools/customerResearchTool');

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
  const outcome = runCustomerResearchTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: a segment entry missing the required segmentDefinition field', () => {
  const outcome = runCustomerResearchTool({ segments: [{ needs: ['x'] }] });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a non-empty `segmentDefinition`'));
});

test('empty: every segment has no evidence supplied', () => {
  const outcome = runCustomerResearchTool({
    segments: [{ segmentDefinition: 'Budget shoppers', needs: ['low price'] }],
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
});

test('partial: some segments evidenced, others not', () => {
  const outcome = runCustomerResearchTool({
    segments: [
      { segmentDefinition: 'Budget shoppers', needs: ['low price'] },
      { segmentDefinition: 'Premium shoppers', needs: ['quality'], evidence: ['survey'] },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.error, null);
});

test('successful: every segment has evidence supplied', () => {
  const outcome = runCustomerResearchTool({
    segments: [{ segmentDefinition: 'Budget shoppers', needs: ['low price'], evidence: ['survey'] }],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
