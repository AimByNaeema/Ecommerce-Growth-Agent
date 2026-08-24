'use strict';

const assert = require('node:assert');
const {
  AD_PLATFORMS,
  AD_CAMPAIGN_FIELDS,
  createEmptyAdCampaignRecord,
  validateAdCampaignShape,
} = require('../../agent/core/adCampaignModel');

const EXPECTED_FIELD_ORDER = [
  'platform',
  'campaign_reference',
  'objective',
  'audience',
  'budget',
  'ad_creative',
  'bidding_strategy',
  'cta',
  'kpi',
  'measurement_plan',
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

test('AD_PLATFORMS lists exactly the 3 requested platforms, in the requested order', () => {
  assert.deepStrictEqual(AD_PLATFORMS, ['meta_ads', 'google_ads', 'tiktok_ads']);
});

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(AD_CAMPAIGN_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of AD_CAMPAIGN_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyAdCampaignRecord() produces a record that passes validation', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(no campaign set)');
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyAdCampaignRecord() defaults kpi/measurement_plan/evidence to empty arrays and verification_status to unverified', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  assert.deepStrictEqual(record.kpi, []);
  assert.deepStrictEqual(record.measurement_plan, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  delete record.bidding_strategy;
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: bidding_strategy'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  record.impressions = 10000;
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: impressions'));
});

test('validator detects a wrong array type (kpi)', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  record.kpi = 'not an array';
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('kpi must be an array'));
});

test('validator rejects a platform outside the 3 in-scope platforms', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  record.platform = 'snapchat_ads';
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('platform must be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyAdCampaignRecord('meta_ads', '(example)');
  record.verification_status = 'confirmed';
  const result = validateAdCampaignShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no execute/launch/spend function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/adCampaignModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'AD_PLATFORMS',
    'AD_CAMPAIGN_FIELDS',
    'createEmptyAdCampaignRecord',
    'validateAdCampaignShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
