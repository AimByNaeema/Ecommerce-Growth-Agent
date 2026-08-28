'use strict';

const assert = require('node:assert');
const {
  discoverProducts,
  validateProduct,
  analyzeProductOpportunity,
  buildDimension,
} = require('../../agent/core/productAgent');
const { validateProductAgentResultShape } = require('../../agent/core/productAgentResultModel');
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
  const validation = validateProductAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- discoverProducts (product discovery) -------------------------------------------

test('discoverProducts requires a non-empty entries array', () => {
  assert.throws(() => discoverProducts([]), /requires a non-empty `entries`/);
  assert.throws(() => discoverProducts(undefined), /requires a non-empty `entries`/);
});

test('discoverProducts requires each entry to have a productIdentity', () => {
  assert.throws(
    () => discoverProducts([{ category: 'apparel' }]),
    /requires a non-empty `productIdentity`/
  );
});

test('discoverProducts builds one validated product record per entry', () => {
  const records = discoverProducts([
    { productIdentity: 'A', category: 'apparel', source: ['s1'] },
    { productIdentity: 'B' },
  ]);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].product_identity, 'A');
  assert.strictEqual(records[0].category, 'apparel');
  assert.deepStrictEqual(records[0].source, ['s1']);
  for (const record of records) {
    assert.strictEqual(validateProductRecordShape(record).valid, true);
  }
});

test('discoverProducts never invents a candidate that was not supplied', () => {
  const records = discoverProducts([{ productIdentity: 'A' }]);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].description, '');
  assert.deepStrictEqual(records[0].source, []);
});

// --- validateProduct (product validation) -------------------------------------------

test('validateProduct reports full completeness when every qualitative field is present', () => {
  const [record] = discoverProducts([
    {
      productIdentity: 'A',
      category: 'apparel',
      description: 'desc',
      positioning: 'premium',
      targetCustomer: 'hikers',
      pricing: { price: '10' },
      source: ['s1'],
      researchStatus: 'researched',
    },
  ]);
  const result = validateProduct(record);
  assert.strictEqual(result.shape_valid, true);
  assert.deepStrictEqual(result.completeness, {
    category: true,
    description: true,
    positioning: true,
    target_customer: true,
    pricing: true,
    source: true,
  });
  assert.strictEqual(result.is_research_ready, true);
});

test('validateProduct reports missing completeness and is_research_ready=false for a bare record', () => {
  const [record] = discoverProducts([{ productIdentity: 'A' }]);
  const result = validateProduct(record);
  assert.strictEqual(result.shape_valid, true);
  assert.deepStrictEqual(result.completeness, {
    category: false,
    description: false,
    positioning: false,
    target_customer: false,
    pricing: false,
    source: false,
  });
  assert.strictEqual(result.is_research_ready, false);
});

test('validateProduct surfaces structural shape errors instead of guessing', () => {
  const [record] = discoverProducts([{ productIdentity: 'A' }]);
  delete record.category;
  const result = validateProduct(record);
  assert.strictEqual(result.shape_valid, false);
  assert.ok(result.shape_errors.includes('missing field: category'));
  assert.deepStrictEqual(result.completeness, {});
});

// --- analyzeProductOpportunity ---------------------------------------------------------

test('analyzeProductOpportunity requires a non-empty productIdentity', () => {
  assert.throws(() => analyzeProductOpportunity({}), /requires a non-empty `productIdentity`/);
});

test('dimension reports success when assessment, evidence, and confidence are all supplied', () => {
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'Strong signal.',
    demandEvidence: [{ topic: 'Search', finding: 'Rising interest.', source: ['s1'] }],
    demandConfidence: 'high',
  });
  assertValid(result);
  assert.strictEqual(result.demand.confidence, 'high');
  assert.deepStrictEqual(result.demand.evidence, ['Rising interest.', 's1']);
  assert.ok(result.opportunity_scoring.dimensions_evidence_backed_ids.includes('demand'));
});

test('dimension confidence is downgraded to unassessed when asserted without evidence (honesty guard)', () => {
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    competitionAssessment: 'Looks weak.',
    competitionConfidence: 'high',
  });
  assertValid(result);
  assert.strictEqual(result.competition.confidence, 'unassessed');
  assert.ok(
    result.limitations.some((l) => l.includes('Competition confidence was downgraded to unassessed'))
  );
});

test('dimension reports empty (no assessment, no evidence) honestly when nothing is supplied', () => {
  const result = analyzeProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.strictEqual(result.market_fit.confidence, 'unassessed');
  assert.deepStrictEqual(result.market_fit.evidence, []);
  assert.ok(result.limitations.some((l) => l.includes('Market fit has no evidence-backed assessment')));
});

// --- opportunity_scoring (structural coverage, never a verdict) ------------------------

test('opportunity_scoring is empty when no dimension is evidence-backed', () => {
  const result = analyzeProductOpportunity({ productIdentity: 'A' });
  assert.deepStrictEqual(result.opportunity_scoring, {
    dimensions_total: 4,
    dimensions_evidence_backed: 0,
    dimensions_evidence_backed_ids: [],
    status: 'empty',
  });
});

test('opportunity_scoring is partial when some but not all dimensions are evidence-backed', () => {
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    demandEvidence: [{ topic: 'x', finding: 'y', source: ['s1'] }],
    demandConfidence: 'medium',
  });
  assert.strictEqual(result.opportunity_scoring.status, 'partial');
  assert.strictEqual(result.opportunity_scoring.dimensions_evidence_backed, 1);
});

test('opportunity_scoring is success when all 4 dimensions are evidence-backed', () => {
  const entry = { topic: 'x', finding: 'y', source: ['s1'] };
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    demandEvidence: [entry],
    demandConfidence: 'medium',
    competitionEvidence: [entry],
    competitionConfidence: 'medium',
    marketFitEvidence: [entry],
    marketFitConfidence: 'medium',
    productRiskEvidence: [entry],
    productRiskConfidence: 'medium',
  });
  assert.strictEqual(result.opportunity_scoring.status, 'success');
  assert.strictEqual(result.opportunity_scoring.dimensions_evidence_backed, 4);
  assert.deepStrictEqual(result.opportunity_scoring.dimensions_evidence_backed_ids, [
    'demand',
    'competition',
    'market_fit',
    'product_risk',
  ]);
});

// --- profitability_inputs (inputs only, never a computed margin) -----------------------

test('profitability_inputs passes through pricing and cost evidence without computing a margin', () => {
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    pricing: { currency: 'EUR', cost: '10', price: '25' },
    costComponents: [{ topic: 'Shipping', finding: 'Costs 3 EUR per unit.', source: ['s1'] }],
  });
  assertValid(result);
  assert.deepStrictEqual(result.profitability_inputs.pricing, { currency: 'EUR', cost: '10', price: '25' });
  assert.deepStrictEqual(result.profitability_inputs.evidence, ['Costs 3 EUR per unit.']);
  assert.deepStrictEqual(result.profitability_inputs.source, ['s1']);
  assert.ok(
    !('margin' in result.profitability_inputs) && !('profitability' in result.profitability_inputs),
    'profitability_inputs must never contain a computed margin/profitability field'
  );
});

test('profitability_inputs is empty (not invented) when no cost evidence is supplied', () => {
  const result = analyzeProductOpportunity({ productIdentity: 'A' });
  assertValid(result);
  assert.deepStrictEqual(result.profitability_inputs.cost_components, []);
  assert.deepStrictEqual(result.profitability_inputs.evidence, []);
});

// --- specialized_records (traceability, real reuse of existing schemas) ----------------

test('specialized_records holds real, independently-valid productModel.js and opportunityAnalysisModel.js records', () => {
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    market: 'European Union',
    demandEvidence: [{ topic: 'x', finding: 'y', source: ['s1'] }],
    demandConfidence: 'medium',
  });
  assertValid(result);
  assert.strictEqual(
    validateProductRecordShape(result.specialized_records.product_record).valid,
    true
  );
  assert.strictEqual(
    validateOpportunityAnalysisShape(result.specialized_records.opportunity_analysis).valid,
    true
  );
  assert.strictEqual(result.specialized_records.opportunity_analysis.market_relevance.confidence, 'unassessed');
  assert.strictEqual(result.specialized_records.opportunity_analysis.demand.confidence, 'medium');
});

// --- structural check: no computed statistic outside opportunity_scoring's counts ------

test('no field anywhere in the result is a computed number, except opportunity_scoring\'s own counts', () => {
  const entry = { topic: 'x', finding: 'y', source: ['s1'] };
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    market: 'European Union',
    pricing: { currency: 'EUR', cost: '10', price: '25' },
    demandAssessment: 'Strong.',
    demandEvidence: [entry],
    demandConfidence: 'high',
    costComponents: [entry],
    recommendations: ['not a real field, should not appear'],
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

  const { opportunity_scoring, ...rest } = result;
  assertNoNumericField(rest, 'result');
  assert.strictEqual(typeof opportunity_scoring.dimensions_total, 'number');
  assert.strictEqual(typeof opportunity_scoring.dimensions_evidence_backed, 'number');
});

// --- buildDimension (exported, reused by workflows/productOpportunityAnalysisWorkflow.js
//     for commercial_potential / "Economics" - never one of analyzeProductOpportunity's
//     own 4 assessed dimensions) --------------------------------------------------------

test('buildDimension builds a real, evidence-backed commercial_potential dimension', () => {
  const built = buildDimension(
    {
      commercialPotentialAssessment: 'Placeholder assessment.',
      commercialPotentialEvidence: [{ topic: 'Pricing', finding: 'Priced above competitors.', source: ['s1'] }],
      commercialPotentialConfidence: 'medium',
    },
    'commercial_potential',
    'test'
  );
  assert.strictEqual(built.dimension.assessment, 'Placeholder assessment.');
  assert.deepStrictEqual(built.dimension.evidence, ['Priced above competitors.', 's1']);
  assert.strictEqual(built.dimension.confidence, 'medium');
  assert.strictEqual(built.limitation, null);
});

test('buildDimension downgrades commercial_potential confidence to unassessed when asserted without evidence', () => {
  const built = buildDimension(
    { commercialPotentialAssessment: 'Looks strong.', commercialPotentialConfidence: 'high' },
    'commercial_potential',
    'test'
  );
  assert.strictEqual(built.dimension.confidence, 'unassessed');
  assert.ok(built.limitation.includes('Commercial potential confidence was downgraded to unassessed'));
});

test('buildDimension reports commercial_potential honestly empty when nothing is supplied', () => {
  const built = buildDimension({}, 'commercial_potential', 'test');
  assert.deepStrictEqual(built.dimension, { assessment: '', evidence: [], confidence: 'unassessed' });
  assert.ok(built.limitation.includes('Commercial potential has no evidence-backed assessment'));
});

test('adding commercial_potential to DIMENSION_LABELS/DIMENSION_PARAM_KEYS does not change analyzeProductOpportunity\'s existing 4-dimension behavior (regression check)', () => {
  const entry = { topic: 'x', finding: 'y', source: ['s1'] };
  const result = analyzeProductOpportunity({
    productIdentity: 'A',
    demandEvidence: [entry],
    demandConfidence: 'medium',
    competitionEvidence: [entry],
    competitionConfidence: 'medium',
    marketFitEvidence: [entry],
    marketFitConfidence: 'medium',
    productRiskEvidence: [entry],
    productRiskConfidence: 'medium',
  });
  assert.strictEqual(result.opportunity_scoring.dimensions_total, 4);
  assert.strictEqual(result.opportunity_scoring.status, 'success');
  assert.ok(!('commercial_potential' in result));
  assert.strictEqual(result.specialized_records.opportunity_analysis.commercial_potential.confidence, 'unassessed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
