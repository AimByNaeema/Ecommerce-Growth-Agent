'use strict';

const assert = require('node:assert');
const {
  RESEARCH_RECORD_FIELDS,
  createEmptyResearchRecord,
  validateResearchRecordShape,
} = require('../../agent/core/researchRecordModel');

const EXPECTED_ORDER = [
  'topic',
  'market',
  'date',
  'source',
  'finding',
  'confidence',
  'relevance',
  'summary',
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

test('exactly the 9 required research record fields exist, in the requested order', () => {
  assert.deepStrictEqual(
    RESEARCH_RECORD_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title, type, and description', () => {
  for (const field of RESEARCH_RECORD_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.type && field.type.trim() !== '', `${field.id} is missing a type`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyResearchRecord returns a shape that passes validateResearchRecordShape', () => {
  const empty = createEmptyResearchRecord('Test topic');
  const result = validateResearchRecordShape(empty);
  assert.strictEqual(result.valid, true, `unexpected errors: ${result.errors.join(', ')}`);
  assert.strictEqual(empty.topic, 'Test topic');
  assert.strictEqual(empty.confidence, 'unassessed');
  assert.strictEqual(empty.relevance, 'unassessed');
  assert.strictEqual(empty.verification_status, 'unverified');
});

test('validateResearchRecordShape reports missing fields', () => {
  const incomplete = createEmptyResearchRecord('x');
  delete incomplete.finding;
  delete incomplete.summary;
  const result = validateResearchRecordShape(incomplete);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.errors.sort(),
    ['missing field: finding', 'missing field: summary'].sort()
  );
});

test('validateResearchRecordShape reports unexpected extra fields', () => {
  const withExtra = { ...createEmptyResearchRecord('x'), full_transcript: ['hi'] };
  const result = validateResearchRecordShape(withExtra);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: full_transcript'));
});

test('validateResearchRecordShape reports wrong array type without guessing', () => {
  const wrongType = { ...createEmptyResearchRecord('x'), source: 'not an array' };
  const result = validateResearchRecordShape(wrongType);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('source must be an array'));
});

test('validateResearchRecordShape reports invalid enum values for confidence, relevance, and verification_status', () => {
  const badEnums = {
    ...createEmptyResearchRecord('x'),
    confidence: 'extremely-sure',
    relevance: 'super-relevant',
    verification_status: 'maybe',
  };
  const result = validateResearchRecordShape(badEnums);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
  assert.ok(result.errors.some((e) => e.startsWith('relevance must be one of')));
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
