'use strict';

const assert = require('node:assert');
const { calculateAdvertisingPerformanceMetrics } = require('../../agent/core/advertisingPerformanceCalculator');

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

test('calculates every ratio when all raw inputs are present', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({
    impressions: 10000,
    clicks: 250,
    spend: 500,
    conversions: 20,
    revenue: 1000,
  });
  assert.strictEqual(calculated.ctr, 0.025);
  assert.strictEqual(calculated.cpc, 2);
  assert.strictEqual(calculated.cpm, 50);
  assert.strictEqual(calculated.cpa, 25);
  assert.strictEqual(calculated.roas, 2);
});

test('calculates only what its required inputs allow, omitting the rest entirely (never a fabricated 0/null)', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({ impressions: 10000, clicks: 250 });
  assert.deepStrictEqual(Object.keys(calculated).sort(), ['ctr']);
  assert.strictEqual(calculated.ctr, 0.025);
});

test('returns an empty object when no inputs are supplied at all', () => {
  assert.deepStrictEqual(calculateAdvertisingPerformanceMetrics({}), {});
  assert.deepStrictEqual(calculateAdvertisingPerformanceMetrics(), {});
});

test('never recomputes a metric the caller already supplied directly', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({
    impressions: 10000,
    clicks: 250,
    ctr: 0.03,
  });
  assert.strictEqual('ctr' in calculated, false);
});

test('never divides by a zero denominator - a zero denominator is treated as insufficient input, not a fabricated Infinity', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({ impressions: 0, clicks: 0, spend: 500 });
  assert.strictEqual('ctr' in calculated, false);
  assert.strictEqual('cpm' in calculated, false);
});

test('ignores a non-numeric or negative raw input rather than fabricating a result from it', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({ impressions: '10000', clicks: 250 });
  assert.strictEqual('ctr' in calculated, false);

  const calculatedNegative = calculateAdvertisingPerformanceMetrics({ impressions: -10000, clicks: 250 });
  assert.strictEqual('ctr' in calculatedNegative, false);
});

test('rounds calculated values to avoid floating-point noise', () => {
  const calculated = calculateAdvertisingPerformanceMetrics({ impressions: 3, clicks: 1 });
  assert.strictEqual(calculated.ctr, 0.3333);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
