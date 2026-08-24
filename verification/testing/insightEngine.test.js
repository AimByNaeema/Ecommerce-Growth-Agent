'use strict';

const assert = require('node:assert');
const {
  DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT,
  calculatePercentChange,
  isSignificantChange,
  formatComparisonText,
  evaluateMetricSignificance,
} = require('../../agent/core/insightEngine');

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

// --- calculatePercentChange ------------------------------------------------------------

test('calculatePercentChange computes a positive percent change', () => {
  assert.strictEqual(calculatePercentChange(120, 100), 20);
});

test('calculatePercentChange computes a negative percent change', () => {
  assert.strictEqual(calculatePercentChange(75, 100), -25);
});

test('calculatePercentChange uses the absolute value of comparisonValue as the denominator (a negative baseline never flips the sign incorrectly) - going from -100 to -50 is a genuine +50% increase', () => {
  assert.strictEqual(calculatePercentChange(-50, -100), 50);
});

test('calculatePercentChange returns undefined for a zero comparisonValue - never fabricates Infinity', () => {
  assert.strictEqual(calculatePercentChange(50, 0), undefined);
});

test('calculatePercentChange returns undefined for non-numeric input', () => {
  assert.strictEqual(calculatePercentChange('120', 100), undefined);
  assert.strictEqual(calculatePercentChange(120, '100'), undefined);
  assert.strictEqual(calculatePercentChange(NaN, 100), undefined);
});

test('calculatePercentChange rounds to avoid floating-point noise', () => {
  assert.strictEqual(calculatePercentChange(1, 3), -66.67);
});

// --- isSignificantChange ----------------------------------------------------------------

test('isSignificantChange uses the default 10% threshold when none is supplied', () => {
  assert.strictEqual(DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT, 10);
  assert.strictEqual(isSignificantChange(10), true);
  assert.strictEqual(isSignificantChange(9.99), false);
  assert.strictEqual(isSignificantChange(-10), true);
});

test('isSignificantChange honors a caller-supplied threshold', () => {
  assert.strictEqual(isSignificantChange(5, 5), true);
  assert.strictEqual(isSignificantChange(4.99, 5), false);
});

test('isSignificantChange is false for an undefined percentChange - never treated as significant', () => {
  assert.strictEqual(isSignificantChange(undefined), false);
});

// --- formatComparisonText ---------------------------------------------------------------

test('formatComparisonText renders an "up" comparison with a label and unit', () => {
  const text = formatComparisonText(120, 100, 'previous quarter', 'USD', 20);
  assert.strictEqual(text, 'up 20% vs previous quarter (from 100 USD to 120 USD)');
});

test('formatComparisonText renders a "down" comparison using the absolute percent value', () => {
  const text = formatComparisonText(75, 100, 'target', 'orders', -25);
  assert.strictEqual(text, 'down 25% vs target (from 100 orders to 75 orders)');
});

test('formatComparisonText omits the label/unit suffix when not supplied', () => {
  const text = formatComparisonText(120, 100, '', '', 20);
  assert.strictEqual(text, 'up 20% (from 100 to 120)');
});

// --- evaluateMetricSignificance (the engine's one entry point) --------------------------

test('evaluateMetricSignificance returns computed fields for a change that clears the default threshold', () => {
  const result = evaluateMetricSignificance({ currentValue: 128400, comparisonValue: 109000, comparisonLabel: 'previous quarter', unit: 'USD' });
  assert.ok(result);
  assert.strictEqual(result.percentChange, 17.8);
  assert.strictEqual(result.comparisonText, 'up 17.8% vs previous quarter (from 109000 USD to 128400 USD)');
});

test('evaluateMetricSignificance returns null for a change that does not clear the default threshold', () => {
  assert.strictEqual(evaluateMetricSignificance({ currentValue: 102000, comparisonValue: 100000 }), null);
});

test('evaluateMetricSignificance honors a caller-supplied thresholdPercent, picking up a smaller change', () => {
  const result = evaluateMetricSignificance({ currentValue: 105, comparisonValue: 100, thresholdPercent: 5 });
  assert.ok(result);
  assert.strictEqual(result.percentChange, 5);
});

test('evaluateMetricSignificance returns null when the comparison cannot be computed at all (zero/non-numeric)', () => {
  assert.strictEqual(evaluateMetricSignificance({ currentValue: 50, comparisonValue: 0 }), null);
  assert.strictEqual(evaluateMetricSignificance({ currentValue: 'not-a-number', comparisonValue: 100 }), null);
  assert.strictEqual(evaluateMetricSignificance(), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
