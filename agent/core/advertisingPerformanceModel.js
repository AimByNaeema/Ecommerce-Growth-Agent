'use strict';

// The shape one structured advertising performance analysis record conforms to.
// Schema and a couple of pure helpers only - no fetch/pull/sync logic, no live
// advertising platform API (none is configured or called anywhere in this project).
// Callers supply already-measured metric values; this module never invents one.
//
// Gets its own dedicated schema rather than widening agent/core/adCampaignModel.js or
// agent/core/advertisingStrategyModel.js, because this is a distinct concern -
// analyzing a campaign's *actual, already-measured* results, not planning one - the
// same dedicated-schema-when-the-field-set-genuinely-differs precedent every other
// capability in this file already established.
//
// `actual_metrics` and `calculated_metrics` are kept as two separate object fields
// (not one merged bag) precisely because the task requires separating them:
//   - actual_metrics: caller-supplied, already-known values (e.g. straight off an ad
//     platform's own reporting) - never computed by this module.
//   - calculated_metrics: values agent/core/advertisingPerformanceCalculator.js
//     derives itself from actual_metrics via standard ad-metric formulas - only ever
//     populated when the required inputs are present, never fabricated.
// Both are restricted to ADVERTISING_PERFORMANCE_METRICS below - no arbitrary key is
// accepted as a "metric".
//
// The 7 metrics named in the task (impressions, CTR, CPC, CPM, conversions, CPA, ROAS)
// are supported directly; CLICKS, SPEND, and REVENUE are also accepted as actual-only
// inputs because CTR/CPC/CPM/CPA/ROAS are standard ratios that mathematically require
// them (CTR = clicks/impressions, CPC = spend/clicks, CPM = spend/impressions*1000,
// CPA = spend/conversions, ROAS = revenue/spend) - without accepting these raw counts,
// none of the 5 ratio metrics could ever be calculated from anything, only ever
// asserted directly as an actual value. This is a mechanical consequence of the
// requested calculation behavior, not a new business assumption.
//
// Recommendations are deliberately NOT a field on this record - exactly like every
// other capability here, they live only in the common
// agent/core/socialAdvertisingAgentResultModel.js envelope's own `recommendations`
// field (caller-supplied only), keeping them structurally separate from both metric
// groups, per the task's "separate actual metrics from calculated metrics and
// recommendations" requirement.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent every other model in this project already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

// Raw, directly-measurable counts (accepted as actual-only inputs - never appear in
// calculated_metrics) plus the 5 standard derived ratios (may appear in either group -
// see the model header above).
const RAW_INPUT_METRICS = ['impressions', 'clicks', 'spend', 'conversions', 'revenue'];
const CALCULABLE_METRICS = ['ctr', 'cpc', 'cpm', 'cpa', 'roas'];
const ADVERTISING_PERFORMANCE_METRICS = [...RAW_INPUT_METRICS, ...CALCULABLE_METRICS];

const ADVERTISING_PERFORMANCE_FIELDS = [
  {
    id: 'performance_reference',
    title: 'Performance reference',
    type: 'string',
    description: 'A name or identifier for the performance analysis this record is for - no analysis invented here.',
  },
  {
    id: 'campaign_reference',
    title: 'Campaign reference',
    type: 'string',
    description: 'Which campaign (e.g. agent/core/adCampaignModel.js campaign_reference) this performance data measures - caller-supplied only, may be empty.',
  },
  {
    id: 'actual_metrics',
    title: 'Actual metrics',
    type: 'object',
    description: `Already-measured metric values as caller-supplied - never computed by this module. Keys must each be one of: ${ADVERTISING_PERFORMANCE_METRICS.join(', ')}.`,
  },
  {
    id: 'calculated_metrics',
    title: 'Calculated metrics',
    type: 'object',
    description: `Metric values derived from actual_metrics via agent/core/advertisingPerformanceCalculator.js - only ever populated when the required inputs are present, never fabricated. Keys must each be one of: ${CALCULABLE_METRICS.join(', ')}.`,
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this performance data (e.g. an ad platform report, an export), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this performance record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = ADVERTISING_PERFORMANCE_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = ADVERTISING_PERFORMANCE_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

// Returns a blank advertising performance record conforming to
// ADVERTISING_PERFORMANCE_FIELDS. No real metrics - callers fill it in.
function createEmptyAdvertisingPerformanceRecord(performance_reference = '', campaign_reference = '') {
  return {
    performance_reference,
    campaign_reference,
    actual_metrics: {},
    calculated_metrics: {},
    evidence: [],
    verification_status: 'unverified',
  };
}

function validateMetricsObject(value, allowedKeys, fieldId, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${fieldId} must be an object`);
    return;
  }
  for (const [key, metricValue] of Object.entries(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${fieldId} has an unexpected metric key: ${key} - must be one of: ${allowedKeys.join(', ')}`);
    }
    if (typeof metricValue !== 'number' || !Number.isFinite(metricValue)) {
      errors.push(`${fieldId}.${key} must be a finite number`);
    }
  }
}

// Checks that an advertising performance record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateAdvertisingPerformanceShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = ADVERTISING_PERFORMANCE_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) {
      errors.push(`missing field: ${id}`);
    }
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) {
      errors.push(`unexpected field: ${id}`);
    }
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) {
      errors.push(`${id} must be an array`);
    }
  }

  if ('actual_metrics' in record) {
    validateMetricsObject(record.actual_metrics, ADVERTISING_PERFORMANCE_METRICS, 'actual_metrics', errors);
  }
  if ('calculated_metrics' in record) {
    validateMetricsObject(record.calculated_metrics, CALCULABLE_METRICS, 'calculated_metrics', errors);
  }

  if (
    'verification_status' in record &&
    !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)
  ) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  RAW_INPUT_METRICS,
  CALCULABLE_METRICS,
  ADVERTISING_PERFORMANCE_METRICS,
  ADVERTISING_PERFORMANCE_FIELDS,
  OBJECT_FIELD_IDS,
  createEmptyAdvertisingPerformanceRecord,
  validateAdvertisingPerformanceShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - advertising performance model (schema only):\n');
  ADVERTISING_PERFORMANCE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyAdvertisingPerformanceRecord('(no analysis set)', '(no campaign set)'), null, 2));
  console.log('\nNo metric is ever fabricated here - this module has no fetch/pull/sync/calculation logic of any kind (see agent/core/advertisingPerformanceCalculator.js for the calculation).');
}
