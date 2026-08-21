'use strict';

const assert = require('node:assert');
const {
  PRODUCT_FIELDS,
  createEmptyProductRecord,
  validateProductRecordShape,
} = require('../../agent/core/productModel');

const EXPECTED_ORDER = [
  'product_identity',
  'category',
  'product_model',
  'description',
  'positioning',
  'target_customer',
  'market',
  'pricing',
  'availability',
  'source',
  'research_status',
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

test('exactly the 11 required product fields exist, in the requested order', () => {
  assert.deepStrictEqual(
    PRODUCT_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title, type, and description', () => {
  for (const field of PRODUCT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.type && field.type.trim() !== '', `${field.id} is missing a type`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyProductRecord returns a shape that passes validateProductRecordShape', () => {
  const empty = createEmptyProductRecord('Test product');
  const result = validateProductRecordShape(empty);
  assert.strictEqual(result.valid, true, `unexpected errors: ${result.errors.join(', ')}`);
  assert.strictEqual(empty.product_identity, 'Test product');
  assert.strictEqual(empty.availability, 'unknown');
  assert.strictEqual(empty.research_status, 'not_researched');
  assert.deepStrictEqual(empty.pricing, { currency: '', cost: '', price: '' });
});

test('validateProductRecordShape reports missing fields', () => {
  const incomplete = createEmptyProductRecord('x');
  delete incomplete.description;
  delete incomplete.positioning;
  const result = validateProductRecordShape(incomplete);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.errors.sort(),
    ['missing field: description', 'missing field: positioning'].sort()
  );
});

test('validateProductRecordShape reports unexpected extra fields', () => {
  const withExtra = { ...createEmptyProductRecord('x'), supplier_secret_contract: 'nope' };
  const result = validateProductRecordShape(withExtra);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: supplier_secret_contract'));
});

test('validateProductRecordShape reports wrong array type without guessing', () => {
  const wrongType = { ...createEmptyProductRecord('x'), market: 'not an array', source: 'also not an array' };
  const result = validateProductRecordShape(wrongType);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('market must be an array'));
  assert.ok(result.errors.includes('source must be an array'));
});

test('validateProductRecordShape reports wrong object type for pricing', () => {
  const wrongType = { ...createEmptyProductRecord('x'), pricing: 'not an object' };
  const result = validateProductRecordShape(wrongType);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('pricing must be an object'));
});

test('validateProductRecordShape reports invalid enum values for availability and research_status', () => {
  const badEnums = {
    ...createEmptyProductRecord('x'),
    availability: 'extremely-available',
    research_status: 'kind-of-researched',
  };
  const result = validateProductRecordShape(badEnums);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('availability must be one of')));
  assert.ok(result.errors.some((e) => e.startsWith('research_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
