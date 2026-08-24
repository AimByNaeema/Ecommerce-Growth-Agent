'use strict';

const assert = require('node:assert');
const {
  SOCIAL_ADVERTISING_CAPABILITIES,
  SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS,
  createEmptySocialAdvertisingAgentResult,
  validateSocialAdvertisingAgentResultShape,
} = require('../../agent/core/socialAdvertisingAgentResultModel');

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

test('SOCIAL_ADVERTISING_CAPABILITIES lists exactly the 11 requested capabilities, in the requested order', () => {
  assert.deepStrictEqual(SOCIAL_ADVERTISING_CAPABILITIES, [
    'instagram',
    'facebook',
    'tiktok',
    'pinterest',
    'youtube',
    'meta_ads',
    'google_ads',
    'tiktok_ads',
    'social_media_strategy',
    'content_generation',
    'content_calendar',
  ]);
});

test('every field has a non-empty title and description', () => {
  for (const field of SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySocialAdvertisingAgentResult() produces a record that passes validation', () => {
  const record = createEmptySocialAdvertisingAgentResult('instagram', '(no topic set)');
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptySocialAdvertisingAgentResult() defaults confidence to unassessed and verification_status to unverified', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  delete record.specialized_records;
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: specialized_records'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  record.click_through_rate = '5%';
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: click_through_rate'));
});

test('validator detects an invalid capability value', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  record.capability = 'not_a_real_capability';
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('capability must be one of')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  record.confidence = 'extremely high';
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  record.verification_status = 'confirmed';
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptySocialAdvertisingAgentResult();
  record.findings = 'not an array';
  const result = validateSocialAdvertisingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
