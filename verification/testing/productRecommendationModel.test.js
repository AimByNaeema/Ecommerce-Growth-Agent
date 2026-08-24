'use strict';

const assert = require('node:assert');
const {
  PRODUCT_RECOMMENDATION_FIELDS,
  OPPORTUNITY_SUB_KEYS,
  MISSING_INFORMATION_SUB_KEYS,
  createEmptyProductRecommendation,
  validateProductRecommendationShape,
} = require('../../agent/core/productRecommendationModel');

const EXPECTED_FIELD_ORDER = [
  'opportunity',
  'research_date',
  'reasoning',
  'evidence',
  'risks',
  'missing_information',
  'confidence',
  'recommended_next_step',
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

test('the record has exactly the 9 required fields, in the requested order', () => {
  assert.deepStrictEqual(PRODUCT_RECOMMENDATION_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('opportunity and missing_information sub-key sets are as expected', () => {
  assert.deepStrictEqual(OPPORTUNITY_SUB_KEYS, ['product_identity', 'category', 'market', 'positioning']);
  assert.deepStrictEqual(MISSING_INFORMATION_SUB_KEYS, ['dimension', 'reason']);
});

test('every field has a non-empty title and description', () => {
  for (const field of PRODUCT_RECOMMENDATION_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyProductRecommendation() produces a record that passes validation', () => {
  const record = createEmptyProductRecommendation('(no product identity set)');
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyProductRecommendation() defaults to unassessed confidence and empty lists - nothing assumed', () => {
  const record = createEmptyProductRecommendation('product');
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.risks.confidence, 'unassessed');
  assert.deepStrictEqual(record.reasoning, []);
  assert.deepStrictEqual(record.missing_information, []);
  assert.strictEqual(record.recommended_next_step, '');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyProductRecommendation('product');
  delete record.evidence;
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: evidence'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyProductRecommendation('product');
  record.score = 99;
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a missing sub-field in opportunity', () => {
  const record = createEmptyProductRecommendation('product');
  delete record.opportunity.category;
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('opportunity is missing sub-field: category'));
});

test('validator detects an unexpected sub-field in opportunity', () => {
  const record = createEmptyProductRecommendation('product');
  record.opportunity.score = 5;
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('opportunity has unexpected sub-field: score'));
});

test('validator detects a missing sub-field in risks', () => {
  const record = createEmptyProductRecommendation('product');
  delete record.risks.confidence;
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('risks is missing sub-field: confidence'));
});

test('validator detects an invalid risks.confidence value', () => {
  const record = createEmptyProductRecommendation('product');
  record.risks.confidence = 'certain';
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('risks.confidence must be one of')));
});

test('validator detects a malformed missing_information entry', () => {
  const record = createEmptyProductRecommendation('product');
  record.missing_information = [{ dimension: 'demand' }];
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing_information[0] is missing sub-field: reason'));
});

test('validator detects an invalid top-level confidence value', () => {
  const record = createEmptyProductRecommendation('product');
  record.confidence = 'certain';
  const result = validateProductRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('confidence must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
