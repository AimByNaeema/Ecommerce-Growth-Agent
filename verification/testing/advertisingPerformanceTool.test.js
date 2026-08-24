'use strict';

const assert = require('node:assert');
const { runAdvertisingPerformanceTool } = require('../../tools/advertisingPerformanceTool');

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

test('runAdvertisingPerformanceTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runAdvertisingPerformanceTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runAdvertisingPerformanceTool returns failed status when a required field is missing', () => {
  const outcome = runAdvertisingPerformanceTool({ performanceReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runAdvertisingPerformanceTool returns failed status for an unknown metric key', () => {
  const outcome = runAdvertisingPerformanceTool({
    performanceReference: '(Example performance)',
    actualMetrics: { likes: 500 },
  });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('invalid advertising performance record'));
});

test('runAdvertisingPerformanceTool returns empty status when no evidence is supplied', () => {
  const outcome = runAdvertisingPerformanceTool({
    performanceReference: '(Example winter jacket launch - week 1 performance)',
    actualMetrics: { impressions: 10000, clicks: 250 },
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.capability, 'advertising_performance');
});

test('runAdvertisingPerformanceTool returns success status when evidence is supplied', () => {
  const outcome = runAdvertisingPerformanceTool({
    performanceReference: '(Example winter jacket launch - week 1 performance)',
    actualMetrics: { impressions: 10000, clicks: 250 },
    evidence: ['(placeholder Meta Ads Manager export)'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runAdvertisingPerformanceTool separates actual metrics from calculated metrics in the composed record', () => {
  const outcome = runAdvertisingPerformanceTool({
    performanceReference: '(Example performance)',
    actualMetrics: { impressions: 10000, clicks: 250, spend: 500, conversions: 20, revenue: 1000 },
    evidence: ['prior report'],
  });
  const record = outcome.result.specialized_records[0];
  assert.deepStrictEqual(record.actual_metrics, {
    impressions: 10000,
    clicks: 250,
    spend: 500,
    conversions: 20,
    revenue: 1000,
  });
  assert.deepStrictEqual(record.calculated_metrics, {
    ctr: 0.025,
    cpc: 2,
    cpm: 50,
    cpa: 25,
    roas: 2,
  });
});

test('runAdvertisingPerformanceTool never fabricates a metric it cannot calculate - the gap is named in limitations, not silently filled in', () => {
  const outcome = runAdvertisingPerformanceTool({
    performanceReference: '(Example performance)',
    actualMetrics: { impressions: 10000, clicks: 250 },
    evidence: ['prior report'],
  });
  const record = outcome.result.specialized_records[0];
  assert.deepStrictEqual(record.calculated_metrics, { ctr: 0.025 });
  assert.ok(
    outcome.result.limitations.some(
      (l) => l.includes('could not be calculated') && l.includes('cpc') && l.includes('cpm') && l.includes('cpa') && l.includes('roas')
    )
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
