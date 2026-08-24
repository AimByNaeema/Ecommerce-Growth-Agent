'use strict';

// Pure calculation logic for agent/core/advertisingPerformanceModel.js's
// `calculated_metrics` field. Deterministic only - no fetch, no estimation, no
// invented value. Standard, widely-documented ad-metric formulas applied mechanically
// to caller-supplied actual_metrics:
//   CTR  = clicks / impressions
//   CPC  = spend / clicks
//   CPM  = (spend / impressions) * 1000
//   CPA  = spend / conversions
//   ROAS = revenue / spend
//
// Never fabricates an unavailable metric: a formula is only evaluated when every
// input it needs is present in actual_metrics as a finite, non-negative number (with
// the denominator strictly greater than zero, to avoid a division-by-zero result) -
// otherwise that metric is simply omitted from the returned object, not defaulted to
// 0/null/NaN. Also never recomputes a metric the caller already supplied directly in
// actual_metrics - see agent/core/advertisingPerformanceModel.js's header for why
// actual and calculated stay separate, never duplicated.
//
// Standalone, reusable pure function - not tied to agent/core/socialAdvertisingAgent.js
// specifically, so it can be exercised/tested independently of the agent's composition
// logic, the same separation-of-concerns agent/core/listingQualityChecker.js and
// agent/core/offerRecommendationEngine.js already established between calculation
// logic and their respective *Model.js schemas.

const { CALCULABLE_METRICS } = require('./advertisingPerformanceModel');

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveDenominator(value) {
  return isFiniteNonNegativeNumber(value) && value > 0;
}

// Rounds to a fixed precision to avoid floating-point noise (e.g. 0.025000000000000005)
// in the output - a formatting convention only, never a business rounding rule.
const RESULT_PRECISION = 4;
function round(value) {
  return Math.round(value * 10 ** RESULT_PRECISION) / 10 ** RESULT_PRECISION;
}

const CALCULATION_RULES = {
  ctr: (actual) =>
    isFiniteNonNegativeNumber(actual.clicks) && isPositiveDenominator(actual.impressions)
      ? actual.clicks / actual.impressions
      : undefined,
  cpc: (actual) =>
    isFiniteNonNegativeNumber(actual.spend) && isPositiveDenominator(actual.clicks)
      ? actual.spend / actual.clicks
      : undefined,
  cpm: (actual) =>
    isFiniteNonNegativeNumber(actual.spend) && isPositiveDenominator(actual.impressions)
      ? (actual.spend / actual.impressions) * 1000
      : undefined,
  cpa: (actual) =>
    isFiniteNonNegativeNumber(actual.spend) && isPositiveDenominator(actual.conversions)
      ? actual.spend / actual.conversions
      : undefined,
  roas: (actual) =>
    isFiniteNonNegativeNumber(actual.revenue) && isPositiveDenominator(actual.spend)
      ? actual.revenue / actual.spend
      : undefined,
};

// Computes every calculable metric not already present in actualMetrics, skipping any
// whose required inputs are missing - never fabricates, never overwrites a
// caller-supplied actual value with a computed one.
function calculateAdvertisingPerformanceMetrics(actualMetrics = {}) {
  const calculated = {};
  for (const metric of CALCULABLE_METRICS) {
    if (metric in actualMetrics) continue;
    const value = CALCULATION_RULES[metric](actualMetrics);
    if (value !== undefined) {
      calculated[metric] = round(value);
    }
  }
  return calculated;
}

module.exports = {
  calculateAdvertisingPerformanceMetrics,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - advertising performance calculator (deterministic, mechanical formulas only):\n');

  const cases = {
    'full inputs (every ratio calculable)': {
      impressions: 10000,
      clicks: 250,
      spend: 500,
      conversions: 20,
      revenue: 1000,
    },
    'partial inputs (CTR, CPC, and CPM calculable - CPA and ROAS are not)': {
      impressions: 10000,
      clicks: 250,
      spend: 500,
    },
    'caller already supplied ctr directly (never recomputed)': {
      impressions: 10000,
      clicks: 250,
      ctr: 0.03,
    },
    'no inputs at all': {},
  };

  for (const [label, actualMetrics] of Object.entries(cases)) {
    console.log(`--- ${label} ---`);
    console.log(`actual_metrics: ${JSON.stringify(actualMetrics)}`);
    console.log(`calculated_metrics: ${JSON.stringify(calculateAdvertisingPerformanceMetrics(actualMetrics))}`);
    console.log('');
  }

  console.log('No metric above is fabricated - every calculated value is a mechanical formula applied only when its required inputs are present.');
}
