'use strict';

const assert = require('node:assert');
const {
  LISTING_CONTENT_FIELDS,
  createEmptyListingContentRecord,
  validateListingContentShape,
} = require('../../agent/core/listingContentModel');

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

test('LISTING_CONTENT_FIELDS lists exactly the 10 requested fields, in the requested order', () => {
  assert.deepStrictEqual(
    LISTING_CONTENT_FIELDS.map((field) => field.id),
    [
      'product_reference',
      'product_title',
      'description',
      'benefits',
      'features',
      'selling_points',
      'faqs',
      'attributes',
      'variants',
      'cta',
    ]
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of LISTING_CONTENT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyListingContentRecord() produces a record that passes validation', () => {
  const record = createEmptyListingContentRecord('(no product set)');
  const result = validateListingContentShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyListingContentRecord() defaults every array field to empty', () => {
  const record = createEmptyListingContentRecord('x');
  assert.deepStrictEqual(record.benefits, []);
  assert.deepStrictEqual(record.features, []);
  assert.deepStrictEqual(record.selling_points, []);
  assert.deepStrictEqual(record.faqs, []);
  assert.deepStrictEqual(record.attributes, []);
  assert.deepStrictEqual(record.variants, []);
});

test('createEmptyListingContentRecord() defaults cta to an empty string', () => {
  const record = createEmptyListingContentRecord('x');
  assert.strictEqual(record.cta, '');
});

test('createEmptyListingContentRecord() sets product_reference from its argument', () => {
  const record = createEmptyListingContentRecord('(Example jacket)');
  assert.strictEqual(record.product_reference, '(Example jacket)');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyListingContentRecord();
  delete record.benefits;
  const result = validateListingContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: benefits'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyListingContentRecord();
  record.price = 19.99;
  const result = validateListingContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: price'));
});

test('validator detects a wrong array type (faqs)', () => {
  const record = createEmptyListingContentRecord();
  record.faqs = 'not an array';
  const result = validateListingContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('faqs must be an array'));
});

test('validator detects a wrong array type (variants)', () => {
  const record = createEmptyListingContentRecord();
  record.variants = 'not an array';
  const result = validateListingContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('variants must be an array'));
});

test('validator rejects a non-object record', () => {
  const result = validateListingContentShape(null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('record must be a plain object'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
