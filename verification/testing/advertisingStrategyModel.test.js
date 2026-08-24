'use strict';

const assert = require('node:assert');
const {
  ADVERTISING_STRATEGY_FIELDS,
  createEmptyAdvertisingStrategyRecord,
  validateAdvertisingStrategyShape,
} = require('../../agent/core/advertisingStrategyModel');

const EXPECTED_FIELD_ORDER = [
  'strategy_reference',
  'campaign_objective',
  'audience',
  'offer',
  'creative_angle',
  'ad_copy',
  'cta',
  'budget_recommendation',
  'kpi',
  'testing_plan',
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
  assert.deepStrictEqual(ADVERTISING_STRATEGY_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of ADVERTISING_STRATEGY_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyAdvertisingStrategyRecord() produces a record that passes validation', () => {
  const record = createEmptyAdvertisingStrategyRecord('(no strategy set)');
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyAdvertisingStrategyRecord() defaults ad_copy/kpi/testing_plan/evidence to empty arrays and verification_status to unverified', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  assert.deepStrictEqual(record.ad_copy, []);
  assert.deepStrictEqual(record.kpi, []);
  assert.deepStrictEqual(record.testing_plan, []);
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  delete record.offer;
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: offer'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  record.spend_committed = 500;
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: spend_committed'));
});

test('validator detects a wrong array type (ad_copy)', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  record.ad_copy = 'not an array';
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('ad_copy must be an array'));
});

test('validator detects a wrong array type (testing_plan)', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  record.testing_plan = 'not an array';
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('testing_plan must be an array'));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyAdvertisingStrategyRecord('(example)');
  record.verification_status = 'confirmed';
  const result = validateAdvertisingStrategyShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no execute/launch/spend function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/advertisingStrategyModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'ADVERTISING_STRATEGY_FIELDS',
    'createEmptyAdvertisingStrategyRecord',
    'validateAdvertisingStrategyShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
