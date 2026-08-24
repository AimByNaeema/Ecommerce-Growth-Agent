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

test('defaults to segment_research mode when customerResearchMode is omitted', () => {
  const outcome = runCustomerResearchTool({
    segments: [{ segmentDefinition: 'Budget shoppers', needs: ['low price'], evidence: ['survey'] }],
  });
  assert.strictEqual(outcome.result.research_type, 'customer_market_intelligence');
});

test('failed: an unknown customerResearchMode reports an honest error', () => {
  const outcome = runCustomerResearchTool({ customerResearchMode: 'not_a_real_mode' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown customerResearchMode'));
});

test('customer_segmentation mode: failed when segmentReference is missing', () => {
  const outcome = runCustomerResearchTool({ customerResearchMode: 'customer_segmentation' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty `segmentReference`'));
});

test('customer_segmentation mode: empty when no evidence is supplied', () => {
  const outcome = runCustomerResearchTool({
    customerResearchMode: 'customer_segmentation',
    segmentReference: '(Example cohort)',
    orderFrequency: { orderCount: 6, daysSinceLastOrder: 100 },
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.research_type, 'customer_segmentation');
});

test('customer_segmentation mode: success when evidence is supplied', () => {
  const outcome = runCustomerResearchTool({
    customerResearchMode: 'customer_segmentation',
    segmentReference: '(Example cohort)',
    orderFrequency: { orderCount: 6, daysSinceLastOrder: 100 },
    evidence: ['Shopify order history export'],
  });
  assert.strictEqual(outcome.status, 'success');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
