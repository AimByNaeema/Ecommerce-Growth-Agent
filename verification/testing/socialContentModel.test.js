'use strict';

const assert = require('node:assert');
const {
  SOCIAL_PLATFORMS,
  SOCIAL_CONTENT_FIELDS,
  createEmptySocialContentRecord,
  validateSocialContentShape,
} = require('../../agent/core/socialContentModel');

const EXPECTED_FIELD_ORDER = [
  'platform',
  'content_reference',
  'content_type',
  'objective',
  'target_audience',
  'caption',
  'hashtags',
  'posting_schedule',
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

test('SOCIAL_PLATFORMS lists exactly the 5 requested platforms, in the requested order', () => {
  assert.deepStrictEqual(SOCIAL_PLATFORMS, ['instagram', 'facebook', 'tiktok', 'pinterest', 'youtube']);
});

test('the record has exactly the 11 required fields, in the requested order', () => {
  assert.deepStrictEqual(SOCIAL_CONTENT_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of SOCIAL_CONTENT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySocialContentRecord() produces a record that passes validation', () => {
  const record = createEmptySocialContentRecord('instagram', '(no content set)');
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptySocialContentRecord() defaults hashtags/evidence to empty arrays and verification_status to unverified', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  assert.deepStrictEqual(record.hashtags, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  delete record.caption;
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: caption'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  record.likes = 1000;
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: likes'));
});

test('validator detects a wrong array type (hashtags)', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  record.hashtags = 'not an array';
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('hashtags must be an array'));
});

test('validator rejects a platform outside the 5 in-scope platforms', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  record.platform = 'snapchat';
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('platform must be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptySocialContentRecord('instagram', '(example)');
  record.verification_status = 'confirmed';
  const result = validateSocialContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no post/publish/schedule function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/socialContentModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'SOCIAL_PLATFORMS',
    'SOCIAL_CONTENT_FIELDS',
    'createEmptySocialContentRecord',
    'validateSocialContentShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
