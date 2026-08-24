'use strict';

// Pure calculation + significance-detection logic backing agent/core/insightModel.js's
// `comparison` field, and the filter that decides which metrics are "significant"
// enough to surface as an insight at all. agent/core/analyticsAgent.js's
// analyzeInsights() capability calls this before composing/grading any record - the
// composition, the causation-honesty guard, and the common result envelope all live
// there, not here (same calculator/composition split as
// agent/core/advertisingPerformanceCalculator.js vs. agent/core/socialAdvertisingAgent.js).
// Deterministic only - no fetch, no synthesis of a cause/opportunity/recommendation
// (those are always caller-supplied hypotheses).
//
// Significance is a mechanical, defined rule: the absolute percent change between
// currentValue and comparisonValue meets or exceeds a threshold
// (DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT, overridable per call via thresholdPercent) -
// never a judgment call, and never invented from thin air. A metric whose change falls
// under the threshold isn't "unimportant" in some judged sense, it simply doesn't
// clear this specific, visible, adjustable bar.
//
// Never fabricates a result: percent change is only computed when both currentValue
// and comparisonValue are finite numbers and comparisonValue is non-zero (division by
// zero is not a percent change) - the same "only compute when every needed input is
// present" discipline as agent/core/advertisingPerformanceCalculator.js.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Rounds to a fixed precision to avoid floating-point noise - a formatting convention
// only, never a business rounding rule.
const RESULT_PRECISION = 2;
function round(value) {
  return Math.round(value * 10 ** RESULT_PRECISION) / 10 ** RESULT_PRECISION;
}

const DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT = 10;

// Returns the percent change from comparisonValue to currentValue, or undefined when
// it can't be mechanically computed (non-numeric input, or a zero comparisonValue -
// division by zero is not a percent change, never fabricated as Infinity).
function calculatePercentChange(currentValue, comparisonValue) {
  if (!isFiniteNumber(currentValue) || !isFiniteNumber(comparisonValue) || comparisonValue === 0) {
    return undefined;
  }
  return round(((currentValue - comparisonValue) / Math.abs(comparisonValue)) * 100);
}

// True only when a percent change was actually computable and its magnitude meets or
// exceeds the threshold - an undefined percentChange is never treated as significant.
function isSignificantChange(percentChange, thresholdPercent = DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT) {
  return isFiniteNumber(percentChange) && isFiniteNumber(thresholdPercent) && Math.abs(percentChange) >= thresholdPercent;
}

// A plain, mechanical comparison sentence built only from the real numbers supplied -
// never a judgment about whether the change is good or bad (that's what possible_cause/
// opportunity are for, and only ever as caller-supplied hypotheses).
function formatComparisonText(currentValue, comparisonValue, comparisonLabel, unit, percentChange) {
  const direction = percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'unchanged';
  const unitSuffix = unit ? ` ${unit}` : '';
  const labelSuffix = comparisonLabel ? ` vs ${comparisonLabel}` : '';
  return `${direction} ${Math.abs(percentChange)}%${labelSuffix} (from ${comparisonValue}${unitSuffix} to ${currentValue}${unitSuffix})`;
}

// The engine's one entry point: given a raw metric-comparison entry, decides whether
// it clears the significance bar and, if so, returns the computed comparison fields.
// Returns null when it doesn't clear the bar or can't be computed - callers
// (agent/core/analyticsAgent.js) skip that entry entirely rather than composing a
// record with a fabricated/absent comparison.
function evaluateMetricSignificance({ currentValue, comparisonValue, comparisonLabel = '', unit = '', thresholdPercent } = {}) {
  const percentChange = calculatePercentChange(currentValue, comparisonValue);
  if (!isSignificantChange(percentChange, thresholdPercent)) {
    return null;
  }
  return {
    percentChange,
    comparisonText: formatComparisonText(currentValue, comparisonValue, comparisonLabel, unit, percentChange),
  };
}

module.exports = {
  DEFAULT_SIGNIFICANCE_THRESHOLD_PERCENT,
  calculatePercentChange,
  isSignificantChange,
  formatComparisonText,
  evaluateMetricSignificance,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - insight engine (deterministic significance detection, mechanical arithmetic only):\n');

  const cases = {
    'significant increase (18% up, clears the default 10% bar)': { currentValue: 128400, comparisonValue: 109000, comparisonLabel: 'previous quarter', unit: 'USD' },
    'insignificant change (2% up, does not clear the default bar)': { currentValue: 102000, comparisonValue: 100000, comparisonLabel: 'previous quarter', unit: 'USD' },
    'significant decrease (25% down)': { currentValue: 75, comparisonValue: 100, comparisonLabel: 'target', unit: 'orders' },
    'custom lower threshold (5%) picks up a smaller change': { currentValue: 105, comparisonValue: 100, comparisonLabel: 'previous week', unit: 'sessions', thresholdPercent: 5 },
    'zero comparisonValue - division by zero is never fabricated': { currentValue: 50, comparisonValue: 0 },
    'non-numeric input - never fabricated': { currentValue: 'not-a-number', comparisonValue: 100 },
  };

  for (const [label, params] of Object.entries(cases)) {
    console.log(`--- ${label} ---`);
    console.log(JSON.stringify(evaluateMetricSignificance(params)));
    console.log('');
  }

  console.log('No comparison above is fabricated - each is either a mechanical arithmetic result over real numbers, or null when it cannot be computed or does not clear the significance bar.');
}
