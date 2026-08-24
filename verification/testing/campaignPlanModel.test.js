'use strict';

const assert = require('node:assert');
const {
  CAMPAIGN_PLAN_FIELDS,
  createEmptyCampaignPlanRecord,
  validateCampaignPlanShape,
} = require('../../agent/core/campaignPlanModel');

const EXPECTED_FIELD_ORDER = [
  'campaign_reference',
  'objective',
  'audience',
  'offer',
  'message',
  'channel',
  'creative_direction',
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

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(CAMPAIGN_PLAN_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of CAMPAIGN_PLAN_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyCampaignPlanRecord() produces a record that passes validation', () => {
  const record = createEmptyCampaignPlanRecord('(no campaign set)');
  const result = validateCampaignPlanShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyCampaignPlanRecord() defaults kpi/measurement_plan/evidence to empty arrays and verification_status to unverified', () => {
  const record = createEmptyCampaignPlanRecord('(example)');
  assert.deepStrictEqual(record.kpi, []);
  assert.deepStrictEqual(record.measurement_plan, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyCampaignPlanRecord('(example)');
  delete record.cta;
  const result = validateCampaignPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: cta'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyCampaignPlanRecord('(example)');
  record.budget = 1000;
  const result = validateCampaignPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: budget'));
});

test('validator detects a wrong array type (kpi)', () => {
  const record = createEmptyCampaignPlanRecord('(example)');
  record.kpi = 'not an array';
  const result = validateCampaignPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('kpi must be an array'));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyCampaignPlanRecord('(example)');
  record.verification_status = 'confirmed';
  const result = validateCampaignPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no execute/send/launch function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/campaignPlanModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'CAMPAIGN_PLAN_FIELDS',
    'createEmptyCampaignPlanRecord',
    'validateCampaignPlanShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
