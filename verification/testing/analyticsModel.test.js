'use strict';

const assert = require('node:assert');
const {
  ANALYTICS_FIELDS,
  CATEGORY_FIELD_IDS,
  METRICS_SUB_KEYS,
  createEmptyAnalyticsSnapshot,
  validateAnalyticsSnapshotShape,
} = require('../../agent/core/analyticsModel');

const EXPECTED_ORDER = [
  'reporting_period',
  'sales',
  'traffic',
  'conversion',
  'product_performance',
  'inventory',
  'customer_behavior',
  'marketing_performance',
  'advertising_performance',
  'seo_performance',
  'retention',
  'growth_opportunities',
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
  assert.deepStrictEqual(
    ANALYTICS_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('METRICS_SUB_KEYS lists exactly actual/calculated/estimated metrics, distinct from recommendations', () => {
  assert.deepStrictEqual(METRICS_SUB_KEYS, ['actual_metrics', 'calculated_metrics', 'estimated_metrics']);
});

test('every field has a non-empty title and description', () => {
  for (const field of ANALYTICS_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyAnalyticsSnapshot() produces a record that passes validation', () => {
  const record = createEmptyAnalyticsSnapshot('2026-Q1');
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('a default-empty record has every category at verification_status "unverified" with no actual/calculated/estimated metrics - never assumed', () => {
  const record = createEmptyAnalyticsSnapshot();
  for (const id of CATEGORY_FIELD_IDS) {
    assert.strictEqual(record[id].verification_status, 'unverified', `${id}.verification_status`);
    for (const metricsKey of METRICS_SUB_KEYS) {
      assert.deepStrictEqual(record[id][metricsKey], [], `${id}.${metricsKey}`);
    }
  }
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyAnalyticsSnapshot();
  delete record.retention;
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: retention'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyAnalyticsSnapshot();
  record.projected_revenue = '$500';
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: projected_revenue'));
});

test('validator detects a category field that is not an object', () => {
  const record = createEmptyAnalyticsSnapshot();
  record.sales = 'not an object';
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('sales must be an object'));
});

test('validator detects a missing sub-field inside a category object', () => {
  const record = createEmptyAnalyticsSnapshot();
  delete record.traffic.summary;
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('traffic is missing sub-field: summary'));
});

test('validator detects an unexpected extra sub-field inside a category object', () => {
  const record = createEmptyAnalyticsSnapshot();
  record.conversion.rate = '3%';
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('conversion has unexpected sub-field: rate'));
});

test('validator detects a wrong array type for each of actual_metrics/calculated_metrics/estimated_metrics', () => {
  for (const metricsKey of METRICS_SUB_KEYS) {
    const record = createEmptyAnalyticsSnapshot();
    record.seo_performance[metricsKey] = 'not an array';
    const result = validateAnalyticsSnapshotShape(record);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.includes(`seo_performance.${metricsKey} must be an array`));
  }
});

test('validator keeps actual/calculated/estimated metrics fully independent - populating one never satisfies another', () => {
  const record = createEmptyAnalyticsSnapshot();
  record.sales.actual_metrics = [{ label: 'orders_count', value: 12 }];
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.deepStrictEqual(record.sales.calculated_metrics, []);
  assert.deepStrictEqual(record.sales.estimated_metrics, []);
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyAnalyticsSnapshot();
  record.growth_opportunities.verification_status = 'confirmed';
  const result = validateAnalyticsSnapshotShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('growth_opportunities.verification_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
