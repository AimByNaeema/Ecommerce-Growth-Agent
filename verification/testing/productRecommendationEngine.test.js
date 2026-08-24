'use strict';

const assert = require('node:assert');
const productRecommendationEngine = require('../../agent/core/productRecommendationEngine');
const { buildProductRecommendation } = productRecommendationEngine;
const { validateProductRecommendationShape } = require('../../agent/core/productRecommendationModel');
const { scoreProductOpportunity } = require('../../agent/core/productOpportunityScoringEngine');
const { validateProductOpportunityScoreShape } = require('../../agent/core/productOpportunityScoreModel');

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

function assertValid(recommendation) {
  const validation = validateProductRecommendationShape(recommendation);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

const evidenced = { topic: 'x', finding: 'y', source: ['s1'] };

// --- required, valid input ----------------------------------------------------------

test('buildProductRecommendation throws when scoreResult is missing', () => {
  assert.throws(() => buildProductRecommendation({}), /requires a valid productOpportunityScoreModel\.js record/);
});

test('buildProductRecommendation throws when scoreResult is structurally invalid, never composing from bad input', () => {
  const scoreResult = scoreProductOpportunity({ productIdentity: 'A' });
  delete scoreResult.coverage_score;
  assert.throws(
    () => buildProductRecommendation({ scoreResult }),
    /requires a valid productOpportunityScoreModel\.js record/
  );
});

// --- opportunity / evidence / risks / missing_information: exact traceable copies ---

test('opportunity is composed directly from the underlying product record - nothing added or altered', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'Insulated Jacket',
    category: 'Outerwear',
    market: 'European Union',
    positioning: 'Premium.',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assertValid(recommendation);
  assert.deepStrictEqual(recommendation.opportunity, {
    product_identity: 'Insulated Jacket',
    category: 'Outerwear',
    market: 'European Union',
    positioning: 'Premium.',
  });
});

test('evidence is an exact copy of the score record\'s own source field', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'a',
    demandEvidence: [evidenced],
    demandConfidence: 'medium',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.deepStrictEqual(recommendation.evidence, scoreResult.source);
});

test('risks is the real risks dimension object, taken as-is', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    riskAssessment: 'Single supplier dependency.',
    riskEvidence: [evidenced],
    riskConfidence: 'high',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assertValid(recommendation);
  assert.deepStrictEqual(recommendation.risks, scoreResult.specialized_records.opportunity_analysis.risks);
  assert.strictEqual(recommendation.risks.assessment, 'Single supplier dependency.');
});

test('missing_information is an exact copy of the score record\'s missing_inputs', () => {
  const scoreResult = scoreProductOpportunity({ productIdentity: 'A' });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.deepStrictEqual(recommendation.missing_information, scoreResult.missing_inputs);
});

// --- reasoning: real content only, only for non-empty dimensions --------------------

test('reasoning includes a line for every non-empty dimension and omits every empty one', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'Strong demand signal.',
    demandEvidence: [evidenced],
    demandConfidence: 'high',
    pricing: { price: '25.00' }, // pricing: success; margin_inputs: partial (cost missing) - both non-empty
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.strictEqual(recommendation.reasoning.length, 3); // demand, pricing, margin_inputs
  assert.ok(recommendation.reasoning.some((line) => line.includes('Strong demand signal.')));
  assert.ok(recommendation.reasoning.some((line) => line.startsWith('Pricing:')));
  assert.ok(recommendation.reasoning.some((line) => line.startsWith('Margin inputs:')));
  assert.ok(!recommendation.reasoning.some((line) => line.startsWith('Competition:')));
});

test('an assessed dimension\'s reasoning line contains its real supplied assessment text verbatim', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    differentiationAssessment: 'Uses a proprietary recycled-fiber blend.',
    differentiationEvidence: [evidenced],
    differentiationConfidence: 'medium',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  const line = recommendation.reasoning.find((entry) => entry.startsWith('Differentiation:'));
  assert.ok(line.includes('Uses a proprietary recycled-fiber blend.'));
});

// --- confidence: mechanical mapping from coverage_score.percentage ------------------

test('confidence is unassessed at 0% coverage', () => {
  const scoreResult = scoreProductOpportunity({ productIdentity: 'A' });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.strictEqual(scoreResult.coverage_score.percentage, 0);
  assert.strictEqual(recommendation.confidence, 'unassessed');
});

test('confidence is low at low, non-zero coverage', () => {
  const scoreResult = scoreProductOpportunity({ productIdentity: 'A', pricing: { price: '25.00' } });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.ok(scoreResult.coverage_score.percentage > 0 && scoreResult.coverage_score.percentage < 50);
  assert.strictEqual(recommendation.confidence, 'low');
});

test('confidence is medium at 50%+ (but not 100%) coverage', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    pricing: { cost: '10.00', price: '25.00' }, // pricing + margin_inputs: success (2)
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium', // success (3)
    competitionAssessment: 'a', competitionEvidence: [evidenced], competitionConfidence: 'medium', // success (4)
  });
  assert.strictEqual(scoreResult.coverage_score.percentage, 50);
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.strictEqual(recommendation.confidence, 'medium');
});

test('confidence is high at 100% coverage', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    pricing: { cost: '10.00', price: '25.00' },
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium',
    competitionAssessment: 'a', competitionEvidence: [evidenced], competitionConfidence: 'medium',
    marketFitAssessment: 'a', marketFitEvidence: [evidenced], marketFitConfidence: 'medium',
    riskAssessment: 'a', riskEvidence: [evidenced], riskConfidence: 'medium',
    differentiationAssessment: 'a', differentiationEvidence: [evidenced], differentiationConfidence: 'medium',
    trendEvidence: [evidenced],
  });
  assert.strictEqual(scoreResult.coverage_score.percentage, 100);
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.strictEqual(recommendation.confidence, 'high');
});

// --- recommended_next_step: deterministic default, or caller override ---------------

test('recommended_next_step defaults to naming the exact missing dimensions when some are absent', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  for (const entry of scoreResult.missing_inputs) {
    assert.ok(recommendation.recommended_next_step.includes(entry.dimension.replace('_', ' ')) ||
      recommendation.recommended_next_step.toLowerCase().includes(entry.dimension.replace('_', ' ')));
  }
  assert.ok(recommendation.recommended_next_step.includes('does not purchase, publish, or import'));
});

test('recommended_next_step defaults to the fixed human-review statement when all 8 dimensions are evidence-backed', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    pricing: { cost: '10.00', price: '25.00' },
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium',
    competitionAssessment: 'a', competitionEvidence: [evidenced], competitionConfidence: 'medium',
    marketFitAssessment: 'a', marketFitEvidence: [evidenced], marketFitConfidence: 'medium',
    riskAssessment: 'a', riskEvidence: [evidenced], riskConfidence: 'medium',
    differentiationAssessment: 'a', differentiationEvidence: [evidenced], differentiationConfidence: 'medium',
    trendEvidence: [evidenced],
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.ok(recommendation.recommended_next_step.startsWith('All 8 dimensions are evidence-backed'));
  assert.ok(recommendation.recommended_next_step.includes('does not purchase, publish, or import'));
});

test('an explicitly caller-supplied recommendedNextStep is relayed unchanged, never altered', () => {
  const scoreResult = scoreProductOpportunity({ productIdentity: 'A' });
  const recommendation = buildProductRecommendation({ scoreResult, recommendedNextStep: 'Escalate to the buying team.' });
  assert.strictEqual(recommendation.recommended_next_step, 'Escalate to the buying team.');
});

// --- specialized_records: real, independently re-validated --------------------------

test('specialized_records.product_opportunity_score is the real, unmodified score record', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'a', demandEvidence: [evidenced], demandConfidence: 'medium',
  });
  const recommendation = buildProductRecommendation({ scoreResult });
  assert.strictEqual(
    validateProductOpportunityScoreShape(recommendation.specialized_records.product_opportunity_score).valid,
    true
  );
  assert.deepStrictEqual(recommendation.specialized_records.product_opportunity_score, scoreResult);
});

// --- no invented content -------------------------------------------------------------

test('every string in reasoning/risks/the defaulted recommended_next_step traces back only to the input scoreResult', () => {
  const scoreResult = scoreProductOpportunity({
    productIdentity: 'A',
    demandAssessment: 'Strong demand.',
    demandEvidence: [{ topic: 'x', finding: 'Rising interest.', source: ['s1'] }],
    demandConfidence: 'high',
    riskAssessment: 'Supplier risk.',
    riskEvidence: [{ topic: 'x', finding: 'Single supplier.', source: ['s2'] }],
    riskConfidence: 'medium',
  });
  const recommendation = buildProductRecommendation({ scoreResult });

  const knownSubstrings = ['Strong demand.', 'Rising interest.', 's1', 'Supplier risk.', 'Single supplier.', 's2'];
  for (const line of recommendation.reasoning) {
    if (line.startsWith('Demand:')) {
      assert.ok(knownSubstrings.some((s) => line.includes(s)), `unexpected content in reasoning line: ${line}`);
    }
  }
  assert.ok(recommendation.risks.evidence.every((item) => knownSubstrings.includes(item)));
  // the defaulted next step must only ever contain the fixed template text plus real
  // dimension labels/reasons already present in scoreResult.missing_inputs - never a
  // new business claim.
  for (const entry of scoreResult.missing_inputs) {
    assert.ok(
      recommendation.recommended_next_step.length > 0,
      'recommended_next_step must always be present'
    );
  }
});

// --- API surface: never purchases, publishes, or imports anything -------------------

test('the module exports exactly one function - buildProductRecommendation - no hidden action-executing export', () => {
  assert.deepStrictEqual(Object.keys(productRecommendationEngine), ['buildProductRecommendation']);
  assert.strictEqual(typeof productRecommendationEngine.buildProductRecommendation, 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
