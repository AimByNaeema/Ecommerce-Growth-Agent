'use strict';

const assert = require('node:assert');
const {
  RAW_INPUT_METRICS,
  CALCULABLE_METRICS,
  ADVERTISING_PERFORMANCE_METRICS,
  ADVERTISING_PERFORMANCE_FIELDS,
  createEmptyAdvertisingPerformanceRecord,
  validateAdvertisingPerformanceShape,
} = require('../../agent/core/advertisingPerformanceModel');

const EXPECTED_FIELD_ORDER = [
  'performance_reference',
  'campaign_reference',
  'actual_metrics',
  'calculated_metrics',
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

test('the record has exactly the 6 required fields, in the requested order', () => {
  assert.deepStrictEqual(ADVERTISING_PERFORMANCE_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of ADVERTISING_PERFORMANCE_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('RAW_INPUT_METRICS and CALCULABLE_METRICS combine into ADVERTISING_PERFORMANCE_METRICS, matching the 7 requested metrics plus their required raw inputs', () => {
  assert.deepStrictEqual(RAW_INPUT_METRICS, ['impressions', 'clicks', 'spend', 'conversions', 'revenue']);
  assert.deepStrictEqual(CALCULABLE_METRICS, ['ctr', 'cpc', 'cpm', 'cpa', 'roas']);
  assert.deepStrictEqual(ADVERTISING_PERFORMANCE_METRICS, [...RAW_INPUT_METRICS, ...CALCULABLE_METRICS]);
  for (const requested of ['impressions', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'roas']) {
    assert.ok(ADVERTISING_PERFORMANCE_METRICS.includes(requested), `missing requested metric: ${requested}`);
  }
});

test('createEmptyAdvertisingPerformanceRecord() produces a record that passes validation', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(no analysis set)', '(no campaign set)');
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyAdvertisingPerformanceRecord() defaults actual_metrics/calculated_metrics to empty objects, evidence to an empty array, and verification_status to unverified', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  assert.deepStrictEqual(record.actual_metrics, {});
  assert.deepStrictEqual(record.calculated_metrics, {});
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  delete record.actual_metrics;
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: actual_metrics'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.fabricated_forecast = 9999;
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: fabricated_forecast'));
});

test('validator rejects actual_metrics that is not an object', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.actual_metrics = 'not an object';
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('actual_metrics must be an object'));
});

test('validator rejects an unknown metric key in actual_metrics', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.actual_metrics = { likes: 500 };
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('actual_metrics has an unexpected metric key: likes')));
});

test('validator rejects a non-numeric metric value', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.actual_metrics = { impressions: '10000' };
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('actual_metrics.impressions must be a finite number'));
});

test('validator rejects a raw-input-only metric key in calculated_metrics', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.calculated_metrics = { impressions: 10000 };
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('calculated_metrics has an unexpected metric key: impressions')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyAdvertisingPerformanceRecord('(example)');
  record.verification_status = 'confirmed';
  const result = validateAdvertisingPerformanceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

test('this module has no fetch/pull/sync/calculation function - only schema helpers are exported', () => {
  const exported = require('../../agent/core/advertisingPerformanceModel');
  assert.deepStrictEqual(Object.keys(exported).sort(), [
    'RAW_INPUT_METRICS',
    'CALCULABLE_METRICS',
    'ADVERTISING_PERFORMANCE_METRICS',
    'ADVERTISING_PERFORMANCE_FIELDS',
    'OBJECT_FIELD_IDS',
    'createEmptyAdvertisingPerformanceRecord',
    'validateAdvertisingPerformanceShape',
  ].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
