'use strict';

const assert = require('node:assert');
const { runGlobalMarketOpportunityTool } = require('../../tools/globalMarketOpportunityTool');

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
  const outcome = runGlobalMarketOpportunityTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: a markets entry missing the required market field', () => {
  const outcome = runGlobalMarketOpportunityTool({ markets: [{ country: 'DE' }] });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a non-empty `market`'));
});

test('empty: a single market row with no evidence in any of its 9 facets', () => {
  const outcome = runGlobalMarketOpportunityTool({
    markets: [{ market: 'European Union', category: 'outdoor apparel' }],
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
});

test('partial: one fully-evidenced row and one fully-empty row', () => {
  const outcome = runGlobalMarketOpportunityTool({
    markets: [
      {
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['signal A'],
        trends: ['trend A'],
        risks: ['risk A'],
        opportunities: ['opportunity A'],
        evidence: ['market-evidence-1'],
        customerSegments: [{ segmentDefinition: 'Segment A', needs: ['need A'], evidence: ['seg-evidence-1'] }],
        competitors: [{ competitor: 'A', strengths: ['fast'], pricingEvidence: ['p1'], source: ['comp-source-1'] }],
        products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
      },
      { market: 'North America' },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.error, null);
});

test('partial: a single row with some facets evidenced and others not', () => {
  const outcome = runGlobalMarketOpportunityTool({
    markets: [
      {
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['signal A'],
        evidence: ['market-evidence-1'],
      },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.error, null);
});

test('success: every row has evidence in every one of its 9 facets', () => {
  const outcome = runGlobalMarketOpportunityTool({
    markets: [
      {
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['signal A'],
        trends: ['trend A'],
        risks: ['risk A'],
        opportunities: ['opportunity A'],
        evidence: ['market-evidence-1'],
        customerSegments: [{ segmentDefinition: 'Segment A', needs: ['need A'], evidence: ['seg-evidence-1'] }],
        competitors: [{ competitor: 'A', strengths: ['fast'], pricingEvidence: ['p1'], source: ['comp-source-1'] }],
        products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
      },
    ],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.comparison.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
