'use strict';

const assert = require('node:assert');
const {
  SEO_QUALITY_DIMENSIONS,
  DIMENSION_STATUSES,
  SEO_QUALITY_CHECK_FIELDS,
  createEmptySeoQualityCheck,
  validateSeoQualityCheckShape,
} = require('../../agent/core/seoQualityCheckModel');

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

test('SEO_QUALITY_DIMENSIONS lists exactly the 9 requested dimensions, in the requested order', () => {
  assert.deepStrictEqual(SEO_QUALITY_DIMENSIONS, [
    'keyword_targeting',
    'search_intent',
    'title',
    'metadata',
    'content_quality',
    'product_accuracy',
    'missing_information',
    'over_optimization',
    'internal_linking_opportunities',
  ]);
});

test('every field has a non-empty title and description', () => {
  for (const field of SEO_QUALITY_CHECK_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySeoQualityCheck() produces a record that passes validation', () => {
  const record = createEmptySeoQualityCheck('(no subject set)');
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptySeoQualityCheck() defaults every dimension to empty and quality_score to 0%', () => {
  const record = createEmptySeoQualityCheck('x');
  for (const dimension of SEO_QUALITY_DIMENSIONS) {
    assert.strictEqual(record.dimension_status[dimension], 'empty');
  }
  assert.strictEqual(record.quality_score.percentage, 0);
  assert.strictEqual(record.quality_score.status, 'empty');
  assert.strictEqual(record.quality_score.dimensions_empty, SEO_QUALITY_DIMENSIONS.length);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptySeoQualityCheck();
  delete record.quality_score;
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: quality_score'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptySeoQualityCheck();
  record.ranking_prediction = '#1';
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: ranking_prediction'));
});

test('validator detects a missing dimension in dimension_status', () => {
  const record = createEmptySeoQualityCheck();
  delete record.dimension_status.title;
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status is missing dimension: title'));
});

test('validator detects an unexpected dimension in dimension_status', () => {
  const record = createEmptySeoQualityCheck();
  record.dimension_status.not_a_real_dimension = 'success';
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status has unexpected dimension: not_a_real_dimension'));
});

test('validator detects an invalid dimension_status value', () => {
  const record = createEmptySeoQualityCheck();
  record.dimension_status.title = 'excellent';
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('dimension_status.title must be one of')));
});

test('validator detects a malformed dimension_gaps entry', () => {
  const record = createEmptySeoQualityCheck();
  record.dimension_gaps = [{ dimension: 'title' }];
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_gaps[0] is missing sub-field: reason'));
});

test('validator detects a missing sub-field in quality_score', () => {
  const record = createEmptySeoQualityCheck();
  delete record.quality_score.percentage;
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('quality_score is missing sub-field: percentage'));
});

test('validator detects an invalid quality_score.status value', () => {
  const record = createEmptySeoQualityCheck();
  record.quality_score.status = 'excellent';
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('quality_score.status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptySeoQualityCheck();
  record.findings = 'not an array';
  const result = validateSeoQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

test('DIMENSION_STATUSES is exactly empty/partial/success', () => {
  assert.deepStrictEqual(DIMENSION_STATUSES, ['empty', 'partial', 'success']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
