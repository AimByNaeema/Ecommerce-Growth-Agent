'use strict';

// The shape of one analytics snapshot, covering the requested categories: sales,
// traffic, conversion, product performance, inventory, customer behavior, marketing
// performance, advertising performance, SEO performance, retention, growth
// opportunities. Schema and a couple of pure helpers only - no fetch/pull/sync logic,
// no scoring, no dashboards (the pull itself lives in
// integrations/adapters/shopifyClient.js and tools/analyticsDataTool.js; this file
// only defines the shape the pulled/caller-supplied data is composed into).
//
// No analytics provider (e.g. Google Analytics, Meta) is named or assumed anywhere in
// this file - agent/core/ never depends on integrations/ or tools/ (see
// tools/productDataRetrievalTool.js's own header for this project's standing rule).
// The only live connection is the read-only Shopify Admin API via
// integrations/adapters/shopifyClient.js, reached through tools/analyticsDataTool.js.
//
// Each category's sub-shape distinguishes 4 kinds of statement, per
// workflows/analyticsInsightWorkflow.js's own STATEMENT_TYPES taxonomy - never blurred
// together, and never presented as more certain than its kind allows:
//   - `actual_metrics`    - observed_fact: a value read directly off a real source
//                           (a live Shopify pull, or caller-supplied), with no
//                           arithmetic applied.
//   - `calculated_metrics` - calculated_result: a value mechanically derived from
//                           actual_metrics by a defined formula (e.g.
//                           agent/core/analyticsMetricsCalculator.js's
//                           calculateSalesMetrics) - objective, but derived, and only
//                           as complete as the actual data it was computed from (a
//                           capped/paginated pull may undercount; see that module's
//                           own header).
//   - `estimated_metrics`  - hypothesis: a value that additionally requires an
//                           assumption or extrapolation beyond the literal calculated
//                           data (e.g. a monthly revenue projection scaled from a
//                           partial period, or days-of-inventory-remaining assuming a
//                           steady sales rate) - always labeled as approximate, and the
//                           assumption is always caller-supplied (e.g. `periodDays`),
//                           never invented internally.
//   - "recommended" is deliberately NOT a 4th sub-field here - it stays only in
//                           agent/core/analyticsAgentResultModel.js's own
//                           `recommendations` field, the same separation
//                           agent/core/advertisingPerformanceModel.js's header already
//                           established for actual/calculated vs. recommendations.
// Each metrics array stays empty by default; real values only get filled in by a
// caller (agent/core/analyticsAgent.js) - never invented here.
//
// `advertising_performance` and `inventory` are additive fields (this file originally
// shipped with 9 categories, then gained `advertising_performance` as a 10th; this is
// the next later, explicitly-scoped prompt its own header already anticipated).
// `advertising_performance` is kept distinct from `marketing_performance`: Marketing
// and Social & Advertising are already two separate specialists in this project with
// two separate schemas (agent/core/marketingAnalysisModel.js vs.
// agent/core/advertisingStrategyModel.js/agent/core/advertisingPerformanceModel.js),
// so their analytics stay equally separate here. `inventory` is kept distinct from
// `product_performance`: inventory (stock levels, per location) was named as its own
// requested category, separate from product-level performance.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, following the same
// cross-schema reuse precedent as agent/core/marketingAnalysisModel.js and
// agent/core/growthOpportunityModel.js - analytics data is objective/measured, not
// judged, so verification_status (not confidence) is the right fit.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

// All category fields share this uniform sub-shape, kept simple on purpose so one
// validator rule covers all of them:
//   { summary: string, actual_metrics: array, calculated_metrics: array,
//     estimated_metrics: array, verification_status: enum }
const CATEGORY_SUB_KEYS = ['summary', 'actual_metrics', 'calculated_metrics', 'estimated_metrics', 'verification_status'];
const METRICS_SUB_KEYS = ['actual_metrics', 'calculated_metrics', 'estimated_metrics'];

const ANALYTICS_FIELDS = [
  {
    id: 'reporting_period',
    title: 'Reporting period',
    type: 'string',
    description: 'The time range this snapshot covers - never invented; comes only from explicit task requirements.',
  },
  {
    id: 'sales',
    title: 'Sales',
    type: 'object',
    description: 'Sales data for the reporting period (orders and revenue).',
  },
  {
    id: 'traffic',
    title: 'Traffic',
    type: 'object',
    description: 'Store/site traffic data for the reporting period.',
  },
  {
    id: 'conversion',
    title: 'Conversion',
    type: 'object',
    description: 'Conversion data for the reporting period.',
  },
  {
    id: 'product_performance',
    title: 'Product performance',
    type: 'object',
    description: 'Per-product or catalog-wide performance data, echoing agent/core/productModel.js records.',
  },
  {
    id: 'inventory',
    title: 'Inventory',
    type: 'object',
    description: 'Stock-level data (per product/variant, per location), echoing integrations/adapters/shopifyClient.js\'s getInventoryLevels().',
  },
  {
    id: 'customer_behavior',
    title: 'Customer behavior',
    type: 'object',
    description: 'Customer behavior data, echoing agent/core/customerSegmentResearchModel.js segments.',
  },
  {
    id: 'marketing_performance',
    title: 'Marketing performance',
    type: 'object',
    description: 'Marketing performance data, echoing agent/core/marketingAnalysisModel.js campaigns/channels.',
  },
  {
    id: 'advertising_performance',
    title: 'Advertising performance',
    type: 'object',
    description: 'Paid advertising performance data, echoing agent/core/advertisingPerformanceModel.js actual/calculated metrics.',
  },
  {
    id: 'seo_performance',
    title: 'SEO performance',
    type: 'object',
    description: 'SEO performance data, echoing agent/core/seoResearchModel.js keywords.',
  },
  {
    id: 'retention',
    title: 'Retention',
    type: 'object',
    description: 'Customer retention data for the reporting period.',
  },
  {
    id: 'growth_opportunities',
    title: 'Growth opportunities',
    type: 'object',
    description: 'Growth-opportunity performance data, echoing agent/core/growthOpportunityModel.js records.',
  },
];

const CATEGORY_FIELD_IDS = ANALYTICS_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function createEmptyCategory() {
  return {
    summary: '',
    actual_metrics: [],
    calculated_metrics: [],
    estimated_metrics: [],
    verification_status: 'unverified',
  };
}

// Returns a blank analytics snapshot conforming to ANALYTICS_FIELDS. No real metric
// data and no provider assumed - callers fill it in once a real, configured
// integration exists.
function createEmptyAnalyticsSnapshot(reporting_period = '') {
  const record = { reporting_period };
  for (const id of CATEGORY_FIELD_IDS) {
    record[id] = createEmptyCategory();
  }
  return record;
}

// Checks that an analytics snapshot has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateAnalyticsSnapshotShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = ANALYTICS_FIELDS.map((field) => field.id);
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

  for (const id of CATEGORY_FIELD_IDS) {
    if (!(id in record)) {
      continue;
    }
    const value = record[id];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${id} must be an object`);
      continue;
    }

    const subIds = Object.keys(value);
    for (const key of CATEGORY_SUB_KEYS) {
      if (!subIds.includes(key)) {
        errors.push(`${id} is missing sub-field: ${key}`);
      }
    }
    for (const key of subIds) {
      if (!CATEGORY_SUB_KEYS.includes(key)) {
        errors.push(`${id} has unexpected sub-field: ${key}`);
      }
    }

    for (const metricsKey of METRICS_SUB_KEYS) {
      if (metricsKey in value && !Array.isArray(value[metricsKey])) {
        errors.push(`${id}.${metricsKey} must be an array`);
      }
    }
    if (
      'verification_status' in value &&
      !RESEARCH_VERIFICATION_STATUSES.includes(value.verification_status)
    ) {
      errors.push(`${id}.verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ANALYTICS_FIELDS,
  CATEGORY_FIELD_IDS,
  CATEGORY_SUB_KEYS,
  METRICS_SUB_KEYS,
  createEmptyAnalyticsSnapshot,
  validateAnalyticsSnapshotShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - analytics model (schema only):\n');
  ANALYTICS_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyAnalyticsSnapshot('(no reporting period set)'), null, 2));
  console.log('\nNo analytics provider is assumed here - all metrics stay empty until a real, configured source is connected (see integrations/adapters/shopifyClient.js and tools/analyticsDataTool.js).');
}
