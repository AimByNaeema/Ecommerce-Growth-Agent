'use strict';

const assert = require('node:assert');
const {
  LISTING_OPTIMIZATION_FIELDS,
  createEmptyListingOptimizationRecord,
  validateListingOptimizationShape,
} = require('../../agent/core/listingOptimizationModel');

const EXPECTED_ORDER = [
  'product_reference',
  'product_title',
  'description',
  'keywords',
  'keyword_usage',
  'search_intent',
  'structure',
  'headings',
  'metadata',
  'internal_links',
  'internal_optimization_opportunities',
  'conversion_considerations',
  'supporting_content',
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

test('the record has exactly the 13 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    LISTING_OPTIMIZATION_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of LISTING_OPTIMIZATION_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyListingOptimizationRecord() produces a record that passes validation', () => {
  const record = createEmptyListingOptimizationRecord('(no product set)');
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('validator detects a missing field', () => {
  const record = createEmptyListingOptimizationRecord();
  delete record.metadata;
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: metadata'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyListingOptimizationRecord();
  record.expected_ranking_change = '+10%';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: expected_ranking_change'));
});

test('validator detects a wrong array type (keywords)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.keywords = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('keywords must be an array'));
});

test('validator detects a wrong array type (conversion_considerations)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.conversion_considerations = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('conversion_considerations must be an array'));
});

test('validator detects a wrong object type (metadata)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.metadata = 'not an object';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('metadata must be an object'));
});

test('createEmptyListingOptimizationRecord() defaults every new field to an empty array', () => {
  const record = createEmptyListingOptimizationRecord('x');
  assert.deepStrictEqual(record.keyword_usage, []);
  assert.deepStrictEqual(record.headings, []);
  assert.deepStrictEqual(record.internal_links, []);
  assert.deepStrictEqual(record.supporting_content, []);
});

test('validator detects a wrong array type (headings)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.headings = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('headings must be an array'));
});

test('validator detects a wrong array type (internal_links)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.internal_links = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('internal_links must be an array'));
});

test('validator detects a wrong array type (keyword_usage)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.keyword_usage = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('keyword_usage must be an array'));
});

test('validator detects a wrong array type (supporting_content)', () => {
  const record = createEmptyListingOptimizationRecord();
  record.supporting_content = 'not an array';
  const result = validateListingOptimizationShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('supporting_content must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
