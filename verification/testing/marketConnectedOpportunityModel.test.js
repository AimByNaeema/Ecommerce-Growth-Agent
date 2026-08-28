'use strict';

const assert = require('node:assert');
const {
  MARKET_CONNECTED_OPPORTUNITY_FIELDS,
  createEmptyMarketConnectedOpportunity,
  validateMarketConnectedOpportunityShape,
} = require('../../agent/core/marketConnectedOpportunityModel');

const EXPECTED_ORDER = [
  'market',
  'country',
  'product_identity',
  'opportunity_analysis',
  'limitations',
  'research_date',
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

test('the record has exactly the 7 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    MARKET_CONNECTED_OPPORTUNITY_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of MARKET_CONNECTED_OPPORTUNITY_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyMarketConnectedOpportunity() produces a record that passes validation', () => {
  const record = createEmptyMarketConnectedOpportunity('(no product identity set)');
  const result = validateMarketConnectedOpportunityShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyMarketConnectedOpportunity() defaults every field honestly - nothing assumed', () => {
  const record = createEmptyMarketConnectedOpportunity('product');
  assert.strictEqual(record.market, '');
  assert.strictEqual(record.country, '');
  assert.strictEqual(record.product_identity, 'product');
  assert.strictEqual(record.opportunity_analysis, null);
  assert.deepStrictEqual(record.limitations, []);
  assert.strictEqual(record.research_date, '');
  assert.deepStrictEqual(record.specialized_records, {
    market_row: null,
    product_record: null,
    product_agent_result: null,
  });
});

test('validator detects a missing field', () => {
  const record = createEmptyMarketConnectedOpportunity('product');
  delete record.limitations;
  const result = validateMarketConnectedOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: limitations'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyMarketConnectedOpportunity('product');
  record.score = 10;
  const result = validateMarketConnectedOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (limitations)', () => {
  const record = createEmptyMarketConnectedOpportunity('product');
  record.limitations = 'not an array';
  const result = validateMarketConnectedOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('limitations must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
