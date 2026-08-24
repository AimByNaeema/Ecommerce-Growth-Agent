'use strict';

const assert = require('node:assert');
const { runKeywordResearchTool } = require('../../tools/keywordResearchTool');

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
  const outcome = runKeywordResearchTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: researchParams missing the required keywords field', () => {
  const outcome = runKeywordResearchTool({});
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a non-empty `keywords`'));
});

test('empty: valid keywords with no source supplied', () => {
  const outcome = runKeywordResearchTool({ keywords: [{ keyword: 'insulated hiking jacket' }] });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
  assert.deepStrictEqual(outcome.result.source, []);
});

test('successful: valid keywords with source supplied', () => {
  const outcome = runKeywordResearchTool({
    keywords: [{ keyword: 'insulated hiking jacket', source: ['source A'] }],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.deepStrictEqual(outcome.result.source, ['source A']);
});

test('partial: some but not all keywords have source', () => {
  const outcome = runKeywordResearchTool({
    keywords: [
      { keyword: 'a', source: ['source A'] },
      { keyword: 'b' },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
});

test('seoCapability search_intent_analysis dispatches to analyzeSearchIntent', () => {
  const outcome = runKeywordResearchTool({
    seoCapability: 'search_intent_analysis',
    keywords: [{ keyword: 'a', searchIntent: 'informational' }],
  });
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'search_intent_analysis');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
