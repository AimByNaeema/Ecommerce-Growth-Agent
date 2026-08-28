'use strict';

const assert = require('node:assert');
const {
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES,
  analyzeProductOpportunityFromMarket,
} = require('../../workflows/productOpportunityAnalysisWorkflow');
const { validateMarketConnectedOpportunityShape } = require('../../agent/core/marketConnectedOpportunityModel');
const { compareGlobalMarkets } = require('../../workflows/globalEcommerceMarketResearchWorkflow');

const EXPECTED_ORDER = [
  'assess_demand',
  'assess_competition',
  'assess_customer_fit',
  'assess_differentiation',
  'assess_market_relevance',
  'assess_commercial_potential',
  'assess_risks',
  'assess_evidence_quality',
];

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

test('the workflow has exactly the 8 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.map((stage) => stage.id),
    EXPECTED_ORDER
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of PRODUCT_OPPORTUNITY_ANALYSIS_STAGES) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(stage.description && stage.description.trim() !== '', `${stage.id} is missing a description`);
  }
});

test('stage ids are unique', () => {
  const ids = PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------------
// analyzeProductOpportunityFromMarket - Market -> Category -> Trend -> Product ->
// Competition -> Economics -> Opportunity
// ---------------------------------------------------------------------------------

function buildRow(marketEntry) {
  return compareGlobalMarkets({ markets: [marketEntry] }).comparison[0];
}

function assertValidResult(result) {
  const validation = validateMarketConnectedOpportunityShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

test('analyzeProductOpportunityFromMarket requires a marketRow object', () => {
  assert.throws(
    () => analyzeProductOpportunityFromMarket({ productIdentity: 'Jacket' }),
    /requires a `marketRow` object/
  );
});

test('analyzeProductOpportunityFromMarket requires marketRow.market to be a non-empty string', () => {
  assert.throws(
    () => analyzeProductOpportunityFromMarket({ marketRow: {}, productIdentity: 'Jacket' }),
    /requires `marketRow.market`/
  );
});

test('analyzeProductOpportunityFromMarket throws when the product is not in the market row', () => {
  const marketRow = buildRow({ market: 'European Union', products: [{ productIdentity: 'Jacket' }] });
  assert.throws(
    () => analyzeProductOpportunityFromMarket({ marketRow, productIdentity: 'Gloves' }),
    /could not find product "Gloves"/
  );
});

test('no-evidence case: every in-scope dimension is honestly empty', () => {
  const marketRow = buildRow({ market: 'European Union', products: [{ productIdentity: 'Jacket' }] });
  const result = analyzeProductOpportunityFromMarket({ marketRow, productIdentity: 'Jacket' });
  assertValidResult(result);
  for (const id of ['demand', 'competition', 'market_relevance', 'commercial_potential']) {
    assert.deepStrictEqual(result.opportunity_analysis[id], { assessment: '', evidence: [], confidence: 'unassessed' });
  }
});

test('full-evidence case: Category/Trend/Competition/Economics evidence flows into the right dimensions', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    demandSignals: ['Rising search interest.'],
    trends: ['Recycled materials trend.'],
    evidence: ['market-evidence-1'],
    competitors: [{ competitor: 'Rival Co.', positioning: 'Premium.', source: ['comp-source-1'] }],
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const result = analyzeProductOpportunityFromMarket({
    marketRow,
    productIdentity: 'Jacket',
    demandConfidence: 'medium',
    competitionConfidence: 'low',
    marketFitConfidence: 'medium',
    commercialPotentialConfidence: 'low',
  });
  assertValidResult(result);
  assert.ok(result.opportunity_analysis.demand.evidence.includes('Recycled materials trend.'));
  assert.ok(result.opportunity_analysis.demand.evidence.includes('Rising search interest.'));
  assert.ok(result.opportunity_analysis.competition.evidence.includes('Premium.'));
  assert.ok(result.opportunity_analysis.market_relevance.evidence.includes('outdoor apparel'));
  assert.ok(result.opportunity_analysis.commercial_potential.evidence.length > 0);
  for (const id of ['demand', 'competition', 'market_relevance', 'commercial_potential']) {
    assert.notStrictEqual(result.opportunity_analysis[id].confidence, 'unassessed');
  }
});

test('mixed/partial case: some dimensions evidence-backed, others honestly empty', () => {
  const marketRow = buildRow({
    market: 'European Union',
    demandSignals: ['Rising search interest.'],
    evidence: ['market-evidence-1'],
    products: [{ productIdentity: 'Jacket' }],
  });
  const result = analyzeProductOpportunityFromMarket({
    marketRow,
    productIdentity: 'Jacket',
    demandConfidence: 'medium',
  });
  assertValidResult(result);
  assert.notStrictEqual(result.opportunity_analysis.demand.confidence, 'unassessed');
  assert.strictEqual(result.opportunity_analysis.competition.confidence, 'unassessed');
  assert.deepStrictEqual(result.opportunity_analysis.competition.evidence, []);
});

test('assessment stays empty unless explicitly supplied by the caller - never invented from evidence', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    evidence: ['market-evidence-1'],
    products: [{ productIdentity: 'Jacket' }],
  });
  const result = analyzeProductOpportunityFromMarket({ marketRow, productIdentity: 'Jacket' });
  assert.strictEqual(result.opportunity_analysis.market_relevance.assessment, '');
  assert.ok(result.opportunity_analysis.market_relevance.evidence.length > 0);

  const withAssessment = analyzeProductOpportunityFromMarket({
    marketRow,
    productIdentity: 'Jacket',
    marketFitAssessment: 'Caller-supplied placeholder assessment.',
  });
  assert.strictEqual(withAssessment.opportunity_analysis.market_relevance.assessment, 'Caller-supplied placeholder assessment.');
});

test('customer_fit, differentiation, and evidence_quality stay untouched/empty - outside this pipeline\'s named scope', () => {
  const marketRow = buildRow({
    market: 'European Union',
    category: 'outdoor apparel',
    demandSignals: ['signal'],
    evidence: ['market-evidence-1'],
    competitors: [{ competitor: 'Rival Co.', source: ['comp-source-1'] }],
    products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
  });
  const result = analyzeProductOpportunityFromMarket({
    marketRow,
    productIdentity: 'Jacket',
    demandConfidence: 'high',
    competitionConfidence: 'high',
    marketFitConfidence: 'high',
    commercialPotentialConfidence: 'high',
  });
  for (const id of ['customer_fit', 'differentiation', 'evidence_quality']) {
    assert.deepStrictEqual(result.opportunity_analysis[id], { assessment: '', evidence: [], confidence: 'unassessed' });
  }
});

test('commercial_potential (Economics) never contains a computed margin/profitability field', () => {
  const marketRow = buildRow({
    market: 'European Union',
    products: [{ productIdentity: 'Jacket', pricing: { currency: 'EUR', cost: '40', price: '90' } }],
    competitors: [{ competitor: 'Rival Co.', pricingEvidence: ['pricing page ref'], source: ['comp-source-1'] }],
  });
  const result = analyzeProductOpportunityFromMarket({ marketRow, productIdentity: 'Jacket' });
  assert.ok(!('margin' in result.opportunity_analysis.commercial_potential));
  assert.ok(!('profitability' in result.opportunity_analysis.commercial_potential));
  assert.strictEqual(typeof result.opportunity_analysis.commercial_potential.evidence, 'object');
  assert.ok(Array.isArray(result.opportunity_analysis.commercial_potential.evidence));
  for (const item of result.opportunity_analysis.commercial_potential.evidence) {
    assert.strictEqual(typeof item, 'string');
  }
});

test('specialized_records carries traceable market_row, product_record, and product_agent_result', () => {
  const marketRow = buildRow({ market: 'European Union', products: [{ productIdentity: 'Jacket' }] });
  const result = analyzeProductOpportunityFromMarket({ marketRow, productIdentity: 'Jacket' });
  assert.strictEqual(result.specialized_records.market_row.market, 'European Union');
  assert.strictEqual(result.specialized_records.product_record.product_identity, 'Jacket');
  assert.strictEqual(result.specialized_records.product_agent_result.product_identity, 'Jacket');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
