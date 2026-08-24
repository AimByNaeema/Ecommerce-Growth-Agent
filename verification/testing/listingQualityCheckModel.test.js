'use strict';

const assert = require('node:assert');
const {
  LISTING_QUALITY_DIMENSIONS,
  DIMENSION_STATUSES,
  LISTING_QUALITY_CHECK_FIELDS,
  createEmptyListingQualityCheck,
  validateListingQualityCheckShape,
} = require('../../agent/core/listingQualityCheckModel');

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

test('LISTING_QUALITY_DIMENSIONS lists exactly the 8 requested dimensions, in the requested order', () => {
  assert.deepStrictEqual(LISTING_QUALITY_DIMENSIONS, [
    'completeness',
    'clarity',
    'accuracy',
    'conversion_quality',
    'seo_compatibility',
    'customer_objections',
    'missing_information',
    'unsupported_claims',
  ]);
});

test('every field has a non-empty title and description', () => {
  for (const field of LISTING_QUALITY_CHECK_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyListingQualityCheck() produces a record that passes validation', () => {
  const record = createEmptyListingQualityCheck('(no subject set)');
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyListingQualityCheck() defaults every dimension to empty and quality_score to 0%', () => {
  const record = createEmptyListingQualityCheck('x');
  for (const dimension of LISTING_QUALITY_DIMENSIONS) {
    assert.strictEqual(record.dimension_status[dimension], 'empty');
  }
  assert.strictEqual(record.quality_score.percentage, 0);
  assert.strictEqual(record.quality_score.status, 'empty');
  assert.strictEqual(record.quality_score.dimensions_empty, LISTING_QUALITY_DIMENSIONS.length);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyListingQualityCheck();
  delete record.quality_score;
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: quality_score'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyListingQualityCheck();
  record.conversion_prediction = '5%';
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: conversion_prediction'));
});

test('validator detects a missing dimension in dimension_status', () => {
  const record = createEmptyListingQualityCheck();
  delete record.dimension_status.clarity;
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status is missing dimension: clarity'));
});

test('validator detects an unexpected dimension in dimension_status', () => {
  const record = createEmptyListingQualityCheck();
  record.dimension_status.not_a_real_dimension = 'success';
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status has unexpected dimension: not_a_real_dimension'));
});

test('validator detects an invalid dimension_status value', () => {
  const record = createEmptyListingQualityCheck();
  record.dimension_status.clarity = 'excellent';
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('dimension_status.clarity must be one of')));
});

test('validator detects a malformed dimension_gaps entry', () => {
  const record = createEmptyListingQualityCheck();
  record.dimension_gaps = [{ dimension: 'clarity' }];
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_gaps[0] is missing sub-field: reason'));
});

test('validator detects a missing sub-field in quality_score', () => {
  const record = createEmptyListingQualityCheck();
  delete record.quality_score.percentage;
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('quality_score is missing sub-field: percentage'));
});

test('validator detects an invalid quality_score.status value', () => {
  const record = createEmptyListingQualityCheck();
  record.quality_score.status = 'excellent';
  const result = validateListingQualityCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('quality_score.status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptyListingQualityCheck();
  record.findings = 'not an array';
  const result = validateListingQualityCheckShape(record);
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
