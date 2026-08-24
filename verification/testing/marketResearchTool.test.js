'use strict';

const assert = require('node:assert');
const { runMarketResearchTool } = require('../../tools/marketResearchTool');

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
  const outcome = runMarketResearchTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: researchParams missing the required market field', () => {
  const outcome = runMarketResearchTool({ demandSignals: ['x'] });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a non-empty `market`'));
});

test('empty: valid market with no evidence/source supplied', () => {
  const outcome = runMarketResearchTool({ market: 'European Union', demandSignals: ['x'] });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
  assert.deepStrictEqual(outcome.result.evidence, []);
});

test('successful: valid market with evidence supplied', () => {
  const outcome = runMarketResearchTool({
    market: 'European Union',
    demandSignals: ['x'],
    evidence: ['source A'],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.deepStrictEqual(outcome.result.evidence, ['source A']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
