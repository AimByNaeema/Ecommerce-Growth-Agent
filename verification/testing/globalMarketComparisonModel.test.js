'use strict';

const assert = require('node:assert');
const {
  GLOBAL_MARKET_COMPARISON_FIELDS,
  createEmptyGlobalMarketComparison,
  validateGlobalMarketComparisonShape,
} = require('../../agent/core/globalMarketComparisonModel');

const EXPECTED_ORDER = ['topic', 'markets_compared', 'comparison', 'limitations', 'research_date'];

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

test('the record has exactly the 5 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    GLOBAL_MARKET_COMPARISON_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of GLOBAL_MARKET_COMPARISON_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyGlobalMarketComparison() produces a record that passes validation', () => {
  const record = createEmptyGlobalMarketComparison('(no topic set)');
  const result = validateGlobalMarketComparisonShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyGlobalMarketComparison() defaults every array field to empty - nothing assumed', () => {
  const record = createEmptyGlobalMarketComparison('topic');
  assert.deepStrictEqual(record.markets_compared, []);
  assert.deepStrictEqual(record.comparison, []);
  assert.deepStrictEqual(record.limitations, []);
  assert.strictEqual(record.research_date, '');
});

test('validator detects a missing field', () => {
  const record = createEmptyGlobalMarketComparison('topic');
  delete record.limitations;
  const result = validateGlobalMarketComparisonShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: limitations'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyGlobalMarketComparison('topic');
  record.score = 10;
  const result = validateGlobalMarketComparisonShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (comparison)', () => {
  const record = createEmptyGlobalMarketComparison('topic');
  record.comparison = 'not an array';
  const result = validateGlobalMarketComparisonShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('comparison must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
