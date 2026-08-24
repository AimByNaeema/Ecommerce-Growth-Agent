'use strict';

const assert = require('node:assert');
const {
  PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS,
  DIMENSION_STATUSES,
  PRODUCT_OPPORTUNITY_SCORE_FIELDS,
  createEmptyProductOpportunityScore,
  validateProductOpportunityScoreShape,
} = require('../../agent/core/productOpportunityScoreModel');

const EXPECTED_DIMENSIONS = [
  'demand',
  'competition',
  'market_fit',
  'pricing',
  'margin_inputs',
  'trend',
  'risk',
  'differentiation',
];

const EXPECTED_FIELD_ORDER = [
  'product_identity',
  'research_date',
  'dimension_status',
  'missing_inputs',
  'coverage_score',
  'source',
  'specialized_records',
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

test('the 8 dimensions are in the requested order', () => {
  assert.deepStrictEqual(PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS, EXPECTED_DIMENSIONS);
});

test('the record has exactly the 7 required fields, in the requested order', () => {
  assert.deepStrictEqual(PRODUCT_OPPORTUNITY_SCORE_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('dimension statuses are empty/partial/success', () => {
  assert.deepStrictEqual(DIMENSION_STATUSES, ['empty', 'partial', 'success']);
});

test('every field has a non-empty title and description', () => {
  for (const field of PRODUCT_OPPORTUNITY_SCORE_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyProductOpportunityScore() produces a record that passes validation', () => {
  const record = createEmptyProductOpportunityScore('(no product identity set)');
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyProductOpportunityScore() defaults every dimension to empty - nothing assumed', () => {
  const record = createEmptyProductOpportunityScore('product');
  for (const dimension of EXPECTED_DIMENSIONS) {
    assert.strictEqual(record.dimension_status[dimension], 'empty');
  }
  assert.deepStrictEqual(record.missing_inputs, []);
  assert.strictEqual(record.coverage_score.dimensions_available, 0);
  assert.strictEqual(record.coverage_score.percentage, 0);
  assert.strictEqual(record.coverage_score.status, 'empty');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyProductOpportunityScore('product');
  delete record.source;
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: source'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyProductOpportunityScore('product');
  record.score = 99;
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a missing dimension in dimension_status', () => {
  const record = createEmptyProductOpportunityScore('product');
  delete record.dimension_status.pricing;
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status is missing dimension: pricing'));
});

test('validator detects an unexpected dimension in dimension_status', () => {
  const record = createEmptyProductOpportunityScore('product');
  record.dimension_status.not_a_real_dimension = 'empty';
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status has unexpected dimension: not_a_real_dimension'));
});

test('validator detects an invalid dimension_status value', () => {
  const record = createEmptyProductOpportunityScore('product');
  record.dimension_status.demand = 'great';
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('dimension_status.demand must be one of')));
});

test('validator detects a malformed missing_inputs entry', () => {
  const record = createEmptyProductOpportunityScore('product');
  record.missing_inputs = [{ dimension: 'demand' }];
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing_inputs[0] is missing sub-field: reason'));
});

test('validator detects a missing sub-field in coverage_score', () => {
  const record = createEmptyProductOpportunityScore('product');
  delete record.coverage_score.percentage;
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('coverage_score is missing sub-field: percentage'));
});

test('validator detects an invalid coverage_score.status value', () => {
  const record = createEmptyProductOpportunityScore('product');
  record.coverage_score.status = 'great';
  const result = validateProductOpportunityScoreShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('coverage_score.status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
