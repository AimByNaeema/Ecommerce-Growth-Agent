'use strict';

const assert = require('node:assert');
const {
  STRATEGY_PLATFORMS,
  SOCIAL_MEDIA_STRATEGY_FIELDS,
  createEmptySocialMediaStrategyRecord,
  validateSocialMediaStrategyShape,
} = require('../../agent/core/socialMediaStrategyModel');

const EXPECTED_FIELD_ORDER = [
  'strategy_reference',
  'objective',
  'audience',
  'content_pillars',
  'platform_selection',
  'posting_strategy',
  'content_themes',
  'campaign_themes',
  'kpis',
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

test('STRATEGY_PLATFORMS is the union of the 5 social and 3 ad platforms already in scope', () => {
  assert.deepStrictEqual(STRATEGY_PLATFORMS, [
    'instagram',
    'facebook',
    'tiktok',
    'pinterest',
    'youtube',
    'meta_ads',
    'google_ads',
    'tiktok_ads',
  ]);
});

test('the record has exactly the 11 required fields, in the requested order', () => {
  assert.deepStrictEqual(SOCIAL_MEDIA_STRATEGY_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of SOCIAL_MEDIA_STRATEGY_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySocialMediaStrategyRecord() produces a record that passes validation', () => {
  const record = createEmptySocialMediaStrategyRecord('(no strategy set)');
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptySocialMediaStrategyRecord() defaults every array field to empty and verification_status to unverified', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  assert.deepStrictEqual(record.content_pillars, []);
  assert.deepStrictEqual(record.platform_selection, []);
  assert.deepStrictEqual(record.content_themes, []);
  assert.deepStrictEqual(record.campaign_themes, []);
  assert.deepStrictEqual(record.kpis, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  delete record.posting_strategy;
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: posting_strategy'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  record.follower_count = 5000;
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: follower_count'));
});

test('validator detects a wrong array type (content_pillars)', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  record.content_pillars = 'not an array';
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('content_pillars must be an array'));
});

test('validator accepts a platform_selection drawn from the 8 in-scope platforms', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  record.platform_selection = ['instagram', 'meta_ads'];
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('validator rejects a platform_selection entry outside the 8 in-scope platforms', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  record.platform_selection = ['instagram', 'snapchat'];
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('platform_selection entries must each be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptySocialMediaStrategyRecord('(example)');
  record.verification_status = 'confirmed';
  const result = validateSocialMediaStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no execute/launch/publish function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/socialMediaStrategyModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'STRATEGY_PLATFORMS',
    'SOCIAL_MEDIA_STRATEGY_FIELDS',
    'createEmptySocialMediaStrategyRecord',
    'validateSocialMediaStrategyShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
