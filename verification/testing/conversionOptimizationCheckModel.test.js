'use strict';

const assert = require('node:assert');
const {
  CONVERSION_OPTIMIZATION_DIMENSIONS,
  DIMENSION_STATUSES,
  SEVERITY_LEVELS,
  CONVERSION_OPTIMIZATION_CHECK_FIELDS,
  createEmptyConversionOptimizationCheck,
  validateConversionOptimizationCheckShape,
} = require('../../agent/core/conversionOptimizationCheckModel');

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

test('CONVERSION_OPTIMIZATION_DIMENSIONS lists exactly the 8 requested dimensions, in the requested order', () => {
  assert.deepStrictEqual(CONVERSION_OPTIMIZATION_DIMENSIONS, [
    'product_pages',
    'landing_pages',
    'offers',
    'cta',
    'trust_signals',
    'checkout_friction',
    'mobile_experience',
    'pricing_presentation',
  ]);
});

test('SEVERITY_LEVELS is exactly critical/high/medium/low', () => {
  assert.deepStrictEqual(SEVERITY_LEVELS, ['critical', 'high', 'medium', 'low']);
});

test('DIMENSION_STATUSES is exactly empty/partial/success', () => {
  assert.deepStrictEqual(DIMENSION_STATUSES, ['empty', 'partial', 'success']);
});

test('every field has a non-empty title and description', () => {
  for (const field of CONVERSION_OPTIMIZATION_CHECK_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyConversionOptimizationCheck() produces a record that passes validation', () => {
  const record = createEmptyConversionOptimizationCheck('(no subject set)');
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyConversionOptimizationCheck() defaults every dimension to empty and quality_score to 0%', () => {
  const record = createEmptyConversionOptimizationCheck('x');
  for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
    assert.strictEqual(record.dimension_status[dimension], 'empty');
  }
  assert.strictEqual(record.quality_score.percentage, 0);
  assert.strictEqual(record.quality_score.status, 'empty');
  assert.strictEqual(record.quality_score.dimensions_empty, CONVERSION_OPTIMIZATION_DIMENSIONS.length);
});

test('createEmptyConversionOptimizationCheck() defaults specialized_records to null for every dimension', () => {
  const record = createEmptyConversionOptimizationCheck('x');
  for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
    assert.strictEqual(record.specialized_records[dimension], null);
  }
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyConversionOptimizationCheck();
  delete record.quality_score;
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: quality_score'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.conversion_rate_prediction = '12%';
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: conversion_rate_prediction'));
});

test('validator detects a missing dimension in dimension_status', () => {
  const record = createEmptyConversionOptimizationCheck();
  delete record.dimension_status.cta;
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status is missing dimension: cta'));
});

test('validator detects an unexpected dimension in dimension_status', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.dimension_status.not_a_real_dimension = 'success';
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_status has unexpected dimension: not_a_real_dimension'));
});

test('validator detects an invalid dimension_status value', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.dimension_status.cta = 'excellent';
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('dimension_status.cta must be one of')));
});

test('validator detects a malformed dimension_gaps entry', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.dimension_gaps = [{ dimension: 'cta' }];
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('dimension_gaps[0] is missing sub-field: reason'));
});

test('validator detects a malformed prioritized_recommendations entry with a bad dimension', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.prioritized_recommendations = [{ dimension: 'not_real', recommendation: 'x', severity: 'high' }];
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('prioritized_recommendations[0].dimension must be one of')));
});

test('validator detects a malformed prioritized_recommendations entry with a bad severity', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.prioritized_recommendations = [{ dimension: 'cta', recommendation: 'x', severity: 'urgent' }];
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('prioritized_recommendations[0].severity must be one of')));
});

test('validator detects a missing sub-field in quality_score', () => {
  const record = createEmptyConversionOptimizationCheck();
  delete record.quality_score.percentage;
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('quality_score is missing sub-field: percentage'));
});

test('validator detects an invalid quality_score.status value', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.quality_score.status = 'excellent';
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('quality_score.status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptyConversionOptimizationCheck();
  record.findings = 'not an array';
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

test('validator detects a missing dimension in specialized_records', () => {
  const record = createEmptyConversionOptimizationCheck();
  delete record.specialized_records.cta;
  const result = validateConversionOptimizationCheckShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('specialized_records is missing dimension: cta'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
