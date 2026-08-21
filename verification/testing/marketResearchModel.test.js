'use strict';

const assert = require('node:assert');
const {
  MARKET_RESEARCH_FIELDS,
  createEmptyMarketResearchRecord,
  validateMarketResearchShape,
} = require('../../agent/core/marketResearchModel');

const EXPECTED_ORDER = [
  'country',
  'market',
  'category',
  'customer_segment',
  'demand_signals',
  'competitors',
  'trends',
  'opportunities',
  'risks',
  'evidence',
  'research_date',
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

test('the record has exactly the 11 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    MARKET_RESEARCH_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of MARKET_RESEARCH_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyMarketResearchRecord() produces a record that passes validation', () => {
  const record = createEmptyMarketResearchRecord();
  const result = validateMarketResearchShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('validator detects a missing field', () => {
  const record = createEmptyMarketResearchRecord();
  delete record.trends;
  const result = validateMarketResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: trends'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyMarketResearchRecord();
  record.score = 10;
  const result = validateMarketResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (competitors)', () => {
  const record = createEmptyMarketResearchRecord();
  record.competitors = 'not an array';
  const result = validateMarketResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('competitors must be an array'));
});

test('validator detects a wrong array type (evidence)', () => {
  const record = createEmptyMarketResearchRecord();
  record.evidence = 'not an array';
  const result = validateMarketResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

test('no field defines a fixed enum of real countries or markets', () => {
  for (const field of MARKET_RESEARCH_FIELDS) {
    assert.ok(
      !field.type.startsWith('enum:'),
      `${field.id} unexpectedly defines an enum - country/market must never be a hardcoded list`
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
