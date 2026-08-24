'use strict';

const assert = require('node:assert');
const {
  MARKETPLACE_LISTING_FORMAT_FIELDS,
  createEmptyMarketplaceListingFormatRecord,
  validateMarketplaceListingFormatShape,
} = require('../../agent/core/marketplaceListingFormatModel');

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

test('MARKETPLACE_LISTING_FORMAT_FIELDS lists exactly the 6 expected fields, in order', () => {
  assert.deepStrictEqual(
    MARKETPLACE_LISTING_FORMAT_FIELDS.map((field) => field.id),
    [
      'marketplace',
      'product_reference',
      'formatted_title',
      'formatted_description',
      'formatted_attributes',
      'format_constraints_applied',
    ]
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of MARKETPLACE_LISTING_FORMAT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('marketplace field is documented as free-form, not a hardcoded enum', () => {
  const marketplaceField = MARKETPLACE_LISTING_FORMAT_FIELDS.find((field) => field.id === 'marketplace');
  assert.strictEqual(marketplaceField.type, 'string');
});

test('createEmptyMarketplaceListingFormatRecord() produces a record that passes validation', () => {
  const record = createEmptyMarketplaceListingFormatRecord('etsy', '(no product set)');
  const result = validateMarketplaceListingFormatShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyMarketplaceListingFormatRecord() sets marketplace/product_reference from arguments', () => {
  const record = createEmptyMarketplaceListingFormatRecord('etsy', '(Example jacket)');
  assert.strictEqual(record.marketplace, 'etsy');
  assert.strictEqual(record.product_reference, '(Example jacket)');
});

test('createEmptyMarketplaceListingFormatRecord() defaults array fields to empty', () => {
  const record = createEmptyMarketplaceListingFormatRecord();
  assert.deepStrictEqual(record.formatted_attributes, []);
  assert.deepStrictEqual(record.format_constraints_applied, []);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyMarketplaceListingFormatRecord();
  delete record.formatted_title;
  const result = validateMarketplaceListingFormatShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: formatted_title'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyMarketplaceListingFormatRecord();
  record.channel_id = '12345';
  const result = validateMarketplaceListingFormatShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: channel_id'));
});

test('validator detects a wrong array type (format_constraints_applied)', () => {
  const record = createEmptyMarketplaceListingFormatRecord();
  record.format_constraints_applied = 'not an array';
  const result = validateMarketplaceListingFormatShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('format_constraints_applied must be an array'));
});

test('validator rejects a non-object record', () => {
  const result = validateMarketplaceListingFormatShape(undefined);
  assert.strictEqual(result.valid, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
