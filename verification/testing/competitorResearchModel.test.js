'use strict';

const assert = require('node:assert');
const {
  COMPETITOR_RESEARCH_FIELDS,
  createEmptyCompetitorResearchRecord,
  validateCompetitorResearchShape,
} = require('../../agent/core/competitorResearchModel');

const EXPECTED_ORDER = [
  'competitor',
  'market',
  'product_category',
  'positioning',
  'pricing_evidence',
  'strengths',
  'weaknesses',
  'marketing_signals',
  'seo_signals',
  'opportunities',
  'source',
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

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    COMPETITOR_RESEARCH_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of COMPETITOR_RESEARCH_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyCompetitorResearchRecord() produces a record that passes validation', () => {
  const record = createEmptyCompetitorResearchRecord('(no competitor set)');
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('validator detects a missing field', () => {
  const record = createEmptyCompetitorResearchRecord();
  delete record.strengths;
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: strengths'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyCompetitorResearchRecord();
  record.market_share = '30%';
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: market_share'));
});

test('validator detects a wrong array type (pricing_evidence)', () => {
  const record = createEmptyCompetitorResearchRecord();
  record.pricing_evidence = 'not an array';
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('pricing_evidence must be an array'));
});

test('validator detects a wrong array type (seo_signals)', () => {
  const record = createEmptyCompetitorResearchRecord();
  record.seo_signals = 'not an array';
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('seo_signals must be an array'));
});

test('validator detects a wrong array type (source)', () => {
  const record = createEmptyCompetitorResearchRecord();
  record.source = 'not an array';
  const result = validateCompetitorResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('source must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
