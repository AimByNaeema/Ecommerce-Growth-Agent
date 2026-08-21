'use strict';

// The shape of one analytics snapshot, covering the requested categories: sales,
// traffic, conversion, product performance, customer behavior, marketing performance,
// SEO performance, retention, growth opportunities. Schema and a couple of pure
// helpers only - no fetch/pull/sync logic, no scoring, no dashboards.
//
// No analytics provider (e.g. Google Analytics, Shopify Analytics, Meta) is named or
// assumed anywhere in this file, and no integration exists yet - nothing to gate.
// Each category's `metrics` array stays empty by default; real metric values only get
// filled in once a specific, explicitly-configured integration exists, in a later,
// explicitly-scoped prompt - never invented here.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, following the same
// cross-schema reuse precedent as agent/core/marketingAnalysisModel.js and
// agent/core/growthOpportunityModel.js - analytics data is objective/measured, not
// judged, so verification_status (not confidence) is the right fit.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

// All 9 category fields share this uniform sub-shape, kept simple on purpose so one
// validator rule covers all of them:
//   { summary: string, metrics: array, verification_status: enum }
const CATEGORY_SUB_KEYS = ['summary', 'metrics', 'verification_status'];

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
    description: 'Sales data for the reporting period.',
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
  return { summary: '', metrics: [], verification_status: 'unverified' };
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

    if ('metrics' in value && !Array.isArray(value.metrics)) {
      errors.push(`${id}.metrics must be an array`);
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
  console.log('\nNo analytics provider is assumed and no integration exists - all metrics stay empty until a real, configured source is connected.');
}
