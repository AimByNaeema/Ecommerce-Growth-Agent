'use strict';

const assert = require('node:assert');
const {
  CONTENT_CALENDAR_FIELDS,
  createEmptyContentCalendarRecord,
  validateContentCalendarShape,
} = require('../../agent/core/contentCalendarModel');

const EXPECTED_FIELD_ORDER = [
  'entry_reference',
  'date',
  'platform',
  'content_type',
  'topic',
  'hook',
  'cta',
  'campaign',
  'product',
  'kpi',
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

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(CONTENT_CALENDAR_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of CONTENT_CALENDAR_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyContentCalendarRecord() produces a record that passes validation', () => {
  const record = createEmptyContentCalendarRecord('(no entry set)', '(no date set)', 'instagram');
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyContentCalendarRecord() defaults kpi/evidence to empty arrays and verification_status to unverified', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  assert.deepStrictEqual(record.kpi, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  delete record.campaign;
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: campaign'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  record.impressions = 5000;
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: impressions'));
});

test('validator detects a wrong array type (kpi)', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  record.kpi = 'not an array';
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('kpi must be an array'));
});

test('validator rejects a platform outside the 5 in-scope social platforms', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  record.platform = 'snapchat';
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('platform must be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyContentCalendarRecord('(example)', '2026-11-14', 'instagram');
  record.verification_status = 'confirmed';
  const result = validateContentCalendarShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no post/publish/schedule function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/contentCalendarModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'CONTENT_CALENDAR_FIELDS',
    'createEmptyContentCalendarRecord',
    'validateContentCalendarShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
