'use strict';

const assert = require('node:assert');
const {
  PLATFORM_CONTENT_FIELDS,
  createEmptyPlatformContentRecord,
  validatePlatformContentShape,
} = require('../../agent/core/platformContentModel');

const EXPECTED_FIELD_ORDER = [
  'platform',
  'content_reference',
  'objective',
  'target_audience',
  'hooks',
  'captions',
  'ctas',
  'content_ideas',
  'short_form_video_concepts',
  'carousel_concepts',
  'creative_briefs',
  'platform_adaptation_notes',
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

test('the record has exactly the 14 required fields, in the requested order', () => {
  assert.deepStrictEqual(PLATFORM_CONTENT_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of PLATFORM_CONTENT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyPlatformContentRecord() produces a record that passes validation', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(no content set)');
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyPlatformContentRecord() defaults every content-type array to empty and verification_status to unverified', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  assert.deepStrictEqual(record.hooks, []);
  assert.deepStrictEqual(record.captions, []);
  assert.deepStrictEqual(record.ctas, []);
  assert.deepStrictEqual(record.content_ideas, []);
  assert.deepStrictEqual(record.short_form_video_concepts, []);
  assert.deepStrictEqual(record.carousel_concepts, []);
  assert.deepStrictEqual(record.creative_briefs, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  delete record.hooks;
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: hooks'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  record.views = 10000;
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: views'));
});

test('validator detects a wrong array type (short_form_video_concepts)', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  record.short_form_video_concepts = 'not an array';
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('short_form_video_concepts must be an array'));
});

test('validator rejects a platform outside the 5 in-scope social platforms', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  record.platform = 'snapchat';
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('platform must be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyPlatformContentRecord('instagram', '(example)');
  record.verification_status = 'confirmed';
  const result = validatePlatformContentShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no post/publish/schedule function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/platformContentModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'PLATFORM_CONTENT_FIELDS',
    'createEmptyPlatformContentRecord',
    'validatePlatformContentShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
