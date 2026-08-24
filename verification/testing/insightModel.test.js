'use strict';

const assert = require('node:assert');
const {
  INSIGHT_FIELDS,
  createEmptyInsightRecord,
  validateInsightShape,
} = require('../../agent/core/insightModel');

const EXPECTED_ORDER = [
  'metric',
  'current_state',
  'comparison',
  'possible_cause',
  'opportunity',
  'recommendation',
  'confidence',
  'evidence',
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

test('the record has exactly the 9 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    INSIGHT_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of INSIGHT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyInsightRecord() produces a record that passes validation', () => {
  const record = createEmptyInsightRecord('total_revenue');
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyInsightRecord() defaults confidence to unassessed and verification_status to unverified', () => {
  const record = createEmptyInsightRecord();
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
  assert.deepStrictEqual(record.evidence, []);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyInsightRecord('total_revenue');
  delete record.possible_cause;
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: possible_cause'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyInsightRecord('total_revenue');
  record.confirmed_cause = 'not allowed';
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: confirmed_cause'));
});

test('validator detects a wrong array type (evidence)', () => {
  const record = createEmptyInsightRecord('total_revenue');
  record.evidence = 'not an array';
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyInsightRecord('total_revenue');
  record.confidence = 'extremely high';
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyInsightRecord('total_revenue');
  record.verification_status = 'confirmed';
  const result = validateInsightShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('this schema has no separate confirmed-cause field - possible_cause is the only causal field, always labeled a possibility', () => {
  const ids = INSIGHT_FIELDS.map((field) => field.id);
  assert.ok(ids.includes('possible_cause'));
  assert.ok(!ids.some((id) => id.includes('confirmed') || id === 'cause'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
