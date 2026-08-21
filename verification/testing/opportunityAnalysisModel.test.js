'use strict';

const assert = require('node:assert');
const {
  OPPORTUNITY_ANALYSIS_FIELDS,
  DIMENSION_FIELD_IDS,
  createEmptyOpportunityAnalysis,
  validateOpportunityAnalysisShape,
} = require('../../agent/core/opportunityAnalysisModel');

const EXPECTED_ORDER = [
  'opportunity_reference',
  'demand',
  'competition',
  'customer_fit',
  'differentiation',
  'market_relevance',
  'commercial_potential',
  'risks',
  'evidence_quality',
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

test('the record has exactly the 9 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    OPPORTUNITY_ANALYSIS_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of OPPORTUNITY_ANALYSIS_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyOpportunityAnalysis() produces a record that passes validation', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  delete record.demand;
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: demand'));
});

test('validator detects an unexpected top-level field', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  record.recommendation = 'buy';
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: recommendation'));
});

test('validator detects a dimension missing a sub-field', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  delete record.demand.evidence;
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('demand is missing sub-field: evidence'));
});

test('validator detects a dimension with an unexpected sub-field', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  record.demand.score = 10;
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('demand has unexpected sub-field: score'));
});

test('validator detects a non-array evidence value', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  record.competition.evidence = 'not an array';
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('competition.evidence must be an array'));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyOpportunityAnalysis('candidate-1');
  record.risks.confidence = 'certain';
  const result = validateOpportunityAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('risks.confidence must be one of:')));
});

test('all 8 dimension field ids are covered by DIMENSION_FIELD_IDS', () => {
  assert.deepStrictEqual(DIMENSION_FIELD_IDS, EXPECTED_ORDER.slice(1));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
