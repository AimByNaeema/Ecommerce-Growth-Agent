'use strict';

const assert = require('node:assert');
const { scoreProductOpportunity } = require('../../agent/core/productOpportunityScoringEngine');
const { validateProductOpportunityScoreShape } = require('../../agent/core/productOpportunityScoreModel');
const { validateProductRecordShape } = require('../../agent/core/productModel');
const { validateOpportunityAnalysisShape } = require('../../agent/core/opportunityAnalysisModel');

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

function assertValid(result) {
  const validation = validateProductOpportunityScoreShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

function missingInput(result, dimension) {
  return result.missing_inputs.find((entry) => entry.dimension === dimension);
}

// --- required input --------------------------------------------------------------

test('scoreProductOpportunity requires a non-empty productIdentity', () => {
  assert.throws(() => scoreProductOpportunity({}), /requires a non-empty `productIdentity`/);
});

// --- opportunityAnalysisModel-backed dimensions (demand/competition/market_fit/risk/differentiation) ---

test('an assessed dimension is empty when nothing is supplied', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.strictEqual(result.dimension_status.demand, 'empty');
  assert.ok(missingInput(result, 'demand'));
});

test('an assessed dimension is empty (not partial) when only assessment text is supplied without evidence', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    competitionAssessment: 'Looks weak.',
    competitionConfidence: 'high',
  });
  assertValid(result);
  assert.strictEqual(result.dimension_status.competition, 'empty');
  assert.strictEqual(result.specialized_records.opportunity_analysis.competition.confidence, 'unassessed');
});

test('an assessed dimension is partial when evidence is supplied without an asserted confidence', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    riskEvidence: [{ topic: 'Supply chain', finding: 'Single supplier dependency.', source: ['s1'] }],
  });
  assertValid(result);
  assert.strictEqual(result.dimension_status.risk, 'partial');
  assert.ok(missingInput(result, 'risk'));
});

test('an assessed dimension is success when evidence and a real confidence are both supplied', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    differentiationAssessment: 'Recycled materials, no direct competitor offers this.',
    differentiationEvidence: [{ topic: 'Materials', finding: 'Uses recycled polyester.', source: ['s1'] }],
    differentiationConfidence: 'high',
  });
  assertValid(result);
  assert.strictEqual(result.dimension_status.differentiation, 'success');
  assert.strictEqual(missingInput(result, 'differentiation'), undefined);
});

// --- trend (generic records, list-style status) -----------------------------------

test('trend is empty when no entries are supplied', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.strictEqual(result.dimension_status.trend, 'empty');
  assert.deepStrictEqual(result.specialized_records.trend_records, []);
});

test('trend is partial when some but not all entries are evidenced', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    trendEvidence: [
      { topic: 'A', finding: 'finding A', source: ['s1'] },
      { topic: 'B', finding: 'finding B' },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.dimension_status.trend, 'partial');
});

test('trend is success when every entry is evidenced', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    trendEvidence: [{ topic: 'A', finding: 'finding A', source: ['s1'] }],
  });
  assertValid(result);
  assert.strictEqual(result.dimension_status.trend, 'success');
});

// --- pricing / margin_inputs (raw facts from productModel.js's pricing field) -----

test('pricing is empty when no price is set', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.strictEqual(result.dimension_status.pricing, 'empty');
  assert.strictEqual(missingInput(result, 'pricing').reason, 'No price is set on the product record (pricing.price).');
});

test('pricing is success when a price is set', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A', pricing: { price: '25.00' } });
  assertValid(result);
  assert.strictEqual(result.dimension_status.pricing, 'success');
});

test('margin_inputs is empty when neither cost nor price is set', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.strictEqual(result.dimension_status.margin_inputs, 'empty');
});

test('margin_inputs is partial when only one of cost/price is set, and names exactly which is missing', () => {
  const costOnly = scoreProductOpportunity({ productIdentity: 'A', pricing: { cost: '10.00' } });
  assert.strictEqual(costOnly.dimension_status.margin_inputs, 'partial');
  assert.strictEqual(
    missingInput(costOnly, 'margin_inputs').reason,
    'Margin cannot be computed - missing: price (pricing.price).'
  );

  const priceOnly = scoreProductOpportunity({ productIdentity: 'A', pricing: { price: '25.00' } });
  assert.strictEqual(priceOnly.dimension_status.margin_inputs, 'partial');
  assert.strictEqual(
    missingInput(priceOnly, 'margin_inputs').reason,
    'Margin cannot be computed - missing: cost (pricing.cost).'
  );
});

test('margin_inputs is success when both cost and price are set, and no margin figure is ever computed', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A', pricing: { cost: '10.00', price: '25.00' } });
  assertValid(result);
  assert.strictEqual(result.dimension_status.margin_inputs, 'success');
  assert.strictEqual(missingInput(result, 'margin_inputs'), undefined);
  assert.ok(
    !('margin' in result) && !JSON.stringify(result).includes('"margin":'),
    'no margin figure should ever be computed'
  );
});

// --- missing_inputs (identify the missing input, never invent it) -----------------

test('missing_inputs is empty only when all 8 dimensions are success', () => {
  const evidenced = { topic: 'x', finding: 'y', source: ['s1'] };
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    pricing: { cost: '10.00', price: '25.00' },
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium',
    competitionAssessment: 'a', competitionEvidence: [evidenced], competitionConfidence: 'medium',
    marketFitAssessment: 'a', marketFitEvidence: [evidenced], marketFitConfidence: 'medium',
    riskAssessment: 'a', riskEvidence: [evidenced], riskConfidence: 'medium',
    differentiationAssessment: 'a', differentiationEvidence: [evidenced], differentiationConfidence: 'medium',
    trendEvidence: [evidenced],
  });
  assertValid(result);
  assert.deepStrictEqual(result.missing_inputs, []);
  assert.strictEqual(result.coverage_score.status, 'success');
});

test('missing_inputs names every non-success dimension exactly once, with a non-empty reason', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  const dimensions = result.missing_inputs.map((entry) => entry.dimension);
  assert.deepStrictEqual(
    [...dimensions].sort(),
    ['competition', 'demand', 'differentiation', 'margin_inputs', 'market_fit', 'pricing', 'risk', 'trend']
  );
  for (const entry of result.missing_inputs) {
    assert.ok(entry.reason && entry.reason.trim() !== '', `${entry.dimension} has an empty reason`);
  }
});

// --- coverage_score (mechanical counts, never a quality judgment) -----------------

test('coverage_score is 0%/empty when nothing is supplied', () => {
  const result = scoreProductOpportunity({ productIdentity: 'A' });
  assert.deepStrictEqual(result.coverage_score, {
    dimensions_total: 8,
    dimensions_available: 0,
    dimensions_partial: 0,
    dimensions_missing: 8,
    percentage: 0,
    status: 'empty',
  });
});

test('coverage_score counts partial and available dimensions correctly and rounds the percentage', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    pricing: { price: '25.00' }, // pricing: success; margin_inputs: partial (cost missing)
    demandAssessment: 'a',
    demandEvidence: [{ topic: 'x', finding: 'y', source: ['s1'] }],
    demandConfidence: 'medium', // demand: success
    riskEvidence: [{ topic: 'x', finding: 'y', source: ['s1'] }], // risk: partial (no confidence asserted)
  });
  // available: demand, pricing (2). partial: risk, margin_inputs (2). missing: the remaining 4.
  assert.strictEqual(result.coverage_score.dimensions_available, 2);
  assert.strictEqual(result.coverage_score.dimensions_partial, 2);
  assert.strictEqual(result.coverage_score.dimensions_missing, 4);
  assert.strictEqual(result.coverage_score.percentage, 25); // 2/8 = 25%
  assert.strictEqual(result.coverage_score.status, 'partial');
});

// --- specialized_records (traceability, real reuse of existing schemas) -----------

test('specialized_records holds real, independently-valid productModel.js and opportunityAnalysisModel.js records', () => {
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    market: 'European Union',
    demandAssessment: 'a',
    demandEvidence: [{ topic: 'x', finding: 'y', source: ['s1'] }],
    demandConfidence: 'medium',
  });
  assertValid(result);
  assert.strictEqual(validateProductRecordShape(result.specialized_records.product_record).valid, true);
  assert.strictEqual(validateOpportunityAnalysisShape(result.specialized_records.opportunity_analysis).valid, true);
  assert.strictEqual(result.specialized_records.opportunity_analysis.demand.confidence, 'medium');
  // opportunityAnalysisModel's other 3 dimensions (not part of this engine) stay untouched
  assert.strictEqual(result.specialized_records.opportunity_analysis.customer_fit.confidence, 'unassessed');
  assert.strictEqual(result.specialized_records.opportunity_analysis.commercial_potential.confidence, 'unassessed');
  assert.strictEqual(result.specialized_records.opportunity_analysis.evidence_quality.confidence, 'unassessed');
});

// --- no invented values ------------------------------------------------------------

test('every piece of evidence in the result traces back only to caller-supplied content - nothing is invented', () => {
  const suppliedStrings = new Set([
    'Rising interest.',
    's1',
    'placeholder trend finding',
    's2',
  ]);
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'Strong.',
    demandEvidence: [{ topic: 'x', finding: 'Rising interest.', source: ['s1'] }],
    demandConfidence: 'high',
    trendEvidence: [{ topic: 'y', finding: 'placeholder trend finding', source: ['s2'] }],
  });
  for (const item of result.source) {
    assert.ok(suppliedStrings.has(item), `unexpected, non-caller-supplied evidence item: ${item}`);
  }
});

// --- structural check: no computed statistic outside coverage_score ----------------

test('no field anywhere in the result is a computed number, except coverage_score\'s own counts/percentage', () => {
  const evidenced = { topic: 'x', finding: 'y', source: ['s1'] };
  const result = scoreProductOpportunity({
    productIdentity: 'A',
    market: 'European Union',
    pricing: { cost: '10.00', price: '25.00' },
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'high',
    trendEvidence: [evidenced],
  });

  function assertNoNumericField(value, path) {
    if (typeof value === 'number') {
      throw new Error(`found an unexpected numeric field at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoNumericField(item, `${path}[${index}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assertNoNumericField(child, `${path}.${key}`);
      }
    }
  }

  const { coverage_score, ...rest } = result;
  assertNoNumericField(rest, 'result');
  assert.strictEqual(typeof coverage_score.dimensions_total, 'number');
  assert.strictEqual(typeof coverage_score.percentage, 'number');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
