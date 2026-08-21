'use strict';

const assert = require('node:assert');
const {
  MARKETING_ANALYSIS_FIELDS,
  createEmptyMarketingAnalysisRecord,
  validateMarketingAnalysisShape,
} = require('../../agent/core/marketingAnalysisModel');

const EXPECTED_ORDER = [
  'marketing_channel',
  'target_segment',
  'product',
  'campaign',
  'objective',
  'message',
  'offer',
  'timing',
  'evidence',
  'expected_outcome',
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

test('the record has exactly the 11 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    MARKETING_ANALYSIS_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of MARKETING_ANALYSIS_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyMarketingAnalysisRecord() produces a record that passes validation', () => {
  const record = createEmptyMarketingAnalysisRecord('(no channel set)', '(no campaign set)');
  const result = validateMarketingAnalysisShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('a default-empty record has verification_status "unverified" - never assumed', () => {
  const record = createEmptyMarketingAnalysisRecord();
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyMarketingAnalysisRecord();
  delete record.offer;
  const result = validateMarketingAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: offer'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyMarketingAnalysisRecord();
  record.projected_roi = '3x';
  const result = validateMarketingAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: projected_roi'));
});

test('validator detects a wrong array type (evidence)', () => {
  const record = createEmptyMarketingAnalysisRecord();
  record.evidence = 'not an array';
  const result = validateMarketingAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyMarketingAnalysisRecord();
  record.verification_status = 'confirmed';
  const result = validateMarketingAnalysisShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
