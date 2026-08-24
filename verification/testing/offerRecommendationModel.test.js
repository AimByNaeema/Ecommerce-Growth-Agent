'use strict';

const assert = require('node:assert');
const {
  OFFER_RECOMMENDATION_TYPES,
  RELATIONSHIP_TYPES,
  OFFER_RECOMMENDATION_FIELDS,
  createEmptyOfferRecommendation,
  validateOfferRecommendationShape,
} = require('../../agent/core/offerRecommendationModel');

const EXPECTED_TYPES = ['bundle', 'discount', 'upsell', 'cross_sell', 'incentive', 'value_proposition', 'objection_handling'];
const EXPECTED_RELATIONSHIP_TYPES = ['bundle_candidate', 'complementary', 'accessory', 'higher_tier'];
const EXPECTED_FIELD_ORDER = [
  'product_reference',
  'market',
  'research_date',
  'dimension_status',
  'findings',
  'recommendations',
  'missing_information',
  'unsupported_claims_flagged',
  'coverage_score',
  'confidence',
  'evidence',
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

test('all 7 offer recommendation types are defined, in the requested order', () => {
  assert.deepStrictEqual(OFFER_RECOMMENDATION_TYPES, EXPECTED_TYPES);
});

test('all 4 relationship types are defined', () => {
  assert.deepStrictEqual(RELATIONSHIP_TYPES, EXPECTED_RELATIONSHIP_TYPES);
});

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(OFFER_RECOMMENDATION_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of OFFER_RECOMMENDATION_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyOfferRecommendation() produces a record that passes validation', () => {
  const record = createEmptyOfferRecommendation('(no product reference set)');
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyOfferRecommendation() defaults every dimension to empty and confidence to unassessed', () => {
  const record = createEmptyOfferRecommendation('(example product)');
  for (const type of OFFER_RECOMMENDATION_TYPES) {
    assert.strictEqual(record.dimension_status[type], 'empty');
  }
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.coverage_score.status, 'empty');
  assert.strictEqual(record.coverage_score.dimensions_total, 7);
});

test('validator detects a missing field', () => {
  const record = createEmptyOfferRecommendation('(example)');
  delete record.evidence;
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: evidence'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyOfferRecommendation('(example)');
  record.score = 10;
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a missing dimension in dimension_status', () => {
  const record = createEmptyOfferRecommendation('(example)');
  delete record.dimension_status.bundle;
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status is missing dimension: bundle'));
});

test('validator detects an invalid dimension_status value', () => {
  const record = createEmptyOfferRecommendation('(example)');
  record.dimension_status.bundle = 'great';
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('dimension_status.bundle must be one of:')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyOfferRecommendation('(example)');
  record.confidence = 'certain';
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of:')));
});

test('validator detects a malformed missing_information entry', () => {
  const record = createEmptyOfferRecommendation('(example)');
  record.missing_information = [{ dimension: 'bundle' }];
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing_information[0] is missing sub-field: reason'));
});

test('validator detects a malformed coverage_score object', () => {
  const record = createEmptyOfferRecommendation('(example)');
  delete record.coverage_score.percentage;
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('coverage_score is missing sub-field: percentage'));
});

test('validator detects a malformed specialized_records object', () => {
  const record = createEmptyOfferRecommendation('(example)');
  delete record.specialized_records.pricing;
  const result = validateOfferRecommendationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('specialized_records is missing sub-field: pricing'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
