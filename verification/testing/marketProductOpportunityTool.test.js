'use strict';

const assert = require('node:assert');
const { runMarketProductOpportunityTool } = require('../../tools/marketProductOpportunityTool');
const { compareGlobalMarkets } = require('../../workflows/globalEcommerceMarketResearchWorkflow');

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

function buildRow(marketEntry) {
  return compareGlobalMarkets({ markets: [marketEntry] }).comparison[0];
}

test('failed: no researchParams supplied at all reports an honest error, never a fabricated result', () => {
  const outcome = runMarketProductOpportunityTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: missing marketRow', () => {
  const outcome = runMarketProductOpportunityTool({ productIdentity: 'Jacket' });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('requires a `marketRow` object'));
});

test('failed: product not found in the supplied market row', () => {
  const marketRow = buildRow({
    market: 'European Union',
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const outcome = runMarketProductOpportunityTool({ marketRow, productIdentity: 'Nonexistent product' });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('could not find product'));
});

test('empty: valid product, no market evidence and no caller-supplied assessments/confidence', () => {
  const marketRow = buildRow({
    market: 'European Union',
    products: [{ productIdentity: 'Jacket' }],
  });
  const outcome = runMarketProductOpportunityTool({ marketRow, productIdentity: 'Jacket' });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
});

test('empty: real evidence supplied, but no confidence explicitly asserted for any dimension', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    demandSignals: ['signal A'],
    trends: ['trend A'],
    evidence: ['market-evidence-1'],
    competitors: [{ competitor: 'A', positioning: 'Premium', source: ['comp-source-1'] }],
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const outcome = runMarketProductOpportunityTool({ marketRow, productIdentity: 'Jacket' });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
  // Evidence is real even though confidence was never asserted - never fabricated.
  assert.ok(outcome.result.opportunity_analysis.demand.evidence.length > 0);
  assert.strictEqual(outcome.result.opportunity_analysis.demand.confidence, 'unassessed');
});

test('partial: confidence explicitly asserted for only some of the 4 in-scope dimensions', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    demandSignals: ['signal A'],
    evidence: ['market-evidence-1'],
    competitors: [{ competitor: 'A', positioning: 'Premium', source: ['comp-source-1'] }],
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const outcome = runMarketProductOpportunityTool({
    marketRow,
    productIdentity: 'Jacket',
    demandAssessment: 'placeholder assessment',
    demandConfidence: 'medium',
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.error, null);
});

test('success: confidence explicitly asserted for every one of the 4 in-scope dimensions', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    demandSignals: ['signal A'],
    evidence: ['market-evidence-1'],
    competitors: [{ competitor: 'A', positioning: 'Premium', source: ['comp-source-1'] }],
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const outcome = runMarketProductOpportunityTool({
    marketRow,
    productIdentity: 'Jacket',
    demandAssessment: 'placeholder',
    demandConfidence: 'medium',
    competitionAssessment: 'placeholder',
    competitionConfidence: 'low',
    marketFitAssessment: 'placeholder',
    marketFitConfidence: 'medium',
    commercialPotentialAssessment: 'placeholder',
    commercialPotentialConfidence: 'low',
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.product_identity, 'Jacket');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
