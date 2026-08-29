'use strict';

const assert = require('node:assert');
const {
  ORDER_FIELDS,
  ORDER_FINANCIAL_STATUSES,
  ORDER_FULFILLMENT_STATUSES,
  createEmptyOrderRecord,
  validateOrderRecordShape,
} = require('../../agent/core/orderModel');

const EXPECTED_ORDER = [
  'order_reference',
  'placed_at',
  'financial_status',
  'fulfillment_status',
  'pricing',
  'line_items',
  'customer_reference',
  'source',
  'verification_status',
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

test('exactly the 9 required order fields exist, in the requested order', () => {
  assert.deepStrictEqual(
    ORDER_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title, type, and description', () => {
  for (const field of ORDER_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.type && field.type.trim() !== '', `${field.id} is missing a type`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('no field name or description contains Shopify-specific vocabulary', () => {
  const shopifySpecificTerms = ['shopify', 'graphql', 'admin_graphql_api_id', 'edges', 'handle', 'myshopify'];
  for (const field of ORDER_FIELDS) {
    const haystack = `${field.id} ${field.title} ${field.description}`.toLowerCase();
    for (const term of shopifySpecificTerms) {
      assert.ok(!haystack.includes(term), `${field.id} must not reference "${term}"`);
    }
  }
});

test('createEmptyOrderRecord returns a shape that passes validateOrderRecordShape', () => {
  const empty = createEmptyOrderRecord('Test order #1001');
  const result = validateOrderRecordShape(empty);
  assert.strictEqual(result.valid, true, `unexpected errors: ${result.errors.join(', ')}`);
  assert.strictEqual(empty.order_reference, 'Test order #1001');
  assert.strictEqual(empty.financial_status, 'unknown');
  assert.strictEqual(empty.fulfillment_status, 'unknown');
  assert.strictEqual(empty.verification_status, 'unverified');
  assert.deepStrictEqual(empty.pricing, { currency: '', total: '' });
  assert.deepStrictEqual(empty.line_items, []);
});

test('validateOrderRecordShape reports missing fields', () => {
  const incomplete = createEmptyOrderRecord('x');
  delete incomplete.placed_at;
  delete incomplete.pricing;
  const result = validateOrderRecordShape(incomplete);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.errors.sort(),
    ['missing field: placed_at', 'missing field: pricing'].sort()
  );
});

test('validateOrderRecordShape reports unexpected extra fields', () => {
  const withExtra = { ...createEmptyOrderRecord('x'), admin_graphql_api_id: 'nope' };
  const result = validateOrderRecordShape(withExtra);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: admin_graphql_api_id'));
});

test('validateOrderRecordShape reports wrong array type without guessing', () => {
  const wrongType = { ...createEmptyOrderRecord('x'), line_items: 'not an array', source: 'also not an array' };
  const result = validateOrderRecordShape(wrongType);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('line_items must be an array'));
  assert.ok(result.errors.includes('source must be an array'));
});

test('validateOrderRecordShape reports wrong object type for pricing', () => {
  const wrongType = { ...createEmptyOrderRecord('x'), pricing: 'not an object' };
  const result = validateOrderRecordShape(wrongType);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('pricing must be an object'));
});

test('validateOrderRecordShape reports invalid enum values for financial_status, fulfillment_status, verification_status', () => {
  const badEnums = {
    ...createEmptyOrderRecord('x'),
    financial_status: 'extremely-paid',
    fulfillment_status: 'kind-of-shipped',
    verification_status: 'sort-of-verified',
  };
  const result = validateOrderRecordShape(badEnums);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('financial_status must be one of')));
  assert.ok(result.errors.some((e) => e.startsWith('fulfillment_status must be one of')));
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('ORDER_FINANCIAL_STATUSES and ORDER_FULFILLMENT_STATUSES are the expected enums', () => {
  assert.deepStrictEqual(ORDER_FINANCIAL_STATUSES, [
    'unknown', 'pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided',
  ]);
  assert.deepStrictEqual(ORDER_FULFILLMENT_STATUSES, [
    'unknown', 'unfulfilled', 'partial', 'fulfilled', 'restocked',
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
