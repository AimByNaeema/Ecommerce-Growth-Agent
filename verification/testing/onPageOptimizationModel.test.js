'use strict';

const assert = require('node:assert');
const {
  SUBJECT_TYPES,
  ON_PAGE_OPTIMIZATION_FIELDS,
  createEmptyOnPageOptimizationRecord,
  validateOnPageOptimizationShape,
} = require('../../agent/core/onPageOptimizationModel');

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

test('SUBJECT_TYPES is collection and content only', () => {
  assert.deepStrictEqual(SUBJECT_TYPES, ['collection', 'content']);
});

test('createEmptyOnPageOptimizationRecord has exactly the fields in ON_PAGE_OPTIMIZATION_FIELDS', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'my-collection');
  const expectedIds = ON_PAGE_OPTIMIZATION_FIELDS.map((field) => field.id);
  assert.deepStrictEqual(Object.keys(record), expectedIds);
});

test('createEmptyOnPageOptimizationRecord is valid by construction', () => {
  const record = createEmptyOnPageOptimizationRecord('content', 'my-blog-post');
  assert.strictEqual(validateOnPageOptimizationShape(record).valid, true);
});

test('validateOnPageOptimizationShape rejects a missing field', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'x');
  delete record.subject_title;
  const result = validateOnPageOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('missing field: subject_title')));
});

test('validateOnPageOptimizationShape rejects an unexpected field', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'x');
  record.unexpected = 'oops';
  const result = validateOnPageOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unexpected field: unexpected')));
});

test('validateOnPageOptimizationShape rejects a non-array value for an array field', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'x');
  record.keywords = 'not an array';
  const result = validateOnPageOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('keywords must be an array')));
});

test('validateOnPageOptimizationShape rejects a non-object value for the metadata field', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'x');
  record.metadata = 'not an object';
  const result = validateOnPageOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('metadata must be an object')));
});

test('validateOnPageOptimizationShape rejects an invalid subject_type', () => {
  const record = createEmptyOnPageOptimizationRecord('collection', 'x');
  record.subject_type = 'not_a_real_subject_type';
  const result = validateOnPageOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('subject_type must be one of')));
});

test('validateOnPageOptimizationShape rejects a non-object record', () => {
  assert.strictEqual(validateOnPageOptimizationShape(null).valid, false);
  assert.strictEqual(validateOnPageOptimizationShape([]).valid, false);
  assert.strictEqual(validateOnPageOptimizationShape('x').valid, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
