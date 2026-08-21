'use strict';

// The shape of one growth opportunity record, covering the requested categories:
// upselling, cross-selling, retention, repeat purchases, customer re-engagement.
// Schema and a couple of pure helpers only - no automated targeting, messaging, or
// execution logic.
//
// Every product/offer reference here must point at real, already-configured data
// (agent/core/productModel.js records, configuration/business.yaml) - never invented.
// `recommendation` is a suggestion only; there is no execute/send/target function
// anywhere in this module, so no customer-facing action is ever taken automatically -
// acting on a recommendation is a separate, human-approved action via approvals/ (see
// approvals/README.md).
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, following the same
// cross-schema reuse precedent as agent/core/marketingAnalysisModel.js.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const GROWTH_OPPORTUNITY_TYPES = [
  'unclassified',
  'upselling',
  'cross_selling',
  'retention',
  'repeat_purchases',
  'customer_reengagement',
];

const GROWTH_OPPORTUNITY_FIELDS = [
  {
    id: 'opportunity_type',
    title: 'Opportunity type',
    type: `enum: ${GROWTH_OPPORTUNITY_TYPES.join(' | ')}`,
    description: 'Which growth opportunity category this record represents. Defaults to unclassified - never assumed.',
  },
  {
    id: 'product_reference',
    title: 'Product reference',
    type: 'string',
    description: 'The real product this opportunity is anchored to (an agent/core/productModel.js product_identity value) - never invented.',
  },
  {
    id: 'related_products',
    title: 'Related products',
    type: 'array',
    description: 'Other real products involved (e.g. an upsell or cross-sell target) - references to agent/core/productModel.js records, never invented.',
  },
  {
    id: 'target_segment',
    title: 'Target segment',
    type: 'string',
    description: 'Which customer segment this opportunity targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'offer',
    title: 'Offer',
    type: 'string',
    description: 'A real, already-configured offer or promotion associated with this opportunity - never invented.',
  },
  {
    id: 'recommendation',
    title: 'Recommendation',
    type: 'string',
    description: 'The suggested growth action (e.g. recommend product B alongside product A) - a suggestion only; nothing here executes it.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'Real data backing this opportunity (e.g. references to product, customer segment, or purchase-history records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this opportunity has been checked against real, configured data.',
  },
];

const ARRAY_FIELD_IDS = GROWTH_OPPORTUNITY_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank growth opportunity record conforming to GROWTH_OPPORTUNITY_FIELDS.
// No real product/offer data - callers fill it in from real, configured sources.
function createEmptyGrowthOpportunityRecord(opportunity_type = 'unclassified', product_reference = '') {
  return {
    opportunity_type,
    product_reference,
    related_products: [],
    target_segment: '',
    offer: '',
    recommendation: '',
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that a growth opportunity record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateGrowthOpportunityShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = GROWTH_OPPORTUNITY_FIELDS.map((field) => field.id);
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

  if ('opportunity_type' in record && !GROWTH_OPPORTUNITY_TYPES.includes(record.opportunity_type)) {
    errors.push(`opportunity_type must be one of: ${GROWTH_OPPORTUNITY_TYPES.join(', ')}`);
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
  GROWTH_OPPORTUNITY_TYPES,
  GROWTH_OPPORTUNITY_FIELDS,
  createEmptyGrowthOpportunityRecord,
  validateGrowthOpportunityShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - growth opportunity model (schema only):\n');
  GROWTH_OPPORTUNITY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyGrowthOpportunityRecord('unclassified', '(no product set)'), null, 2));
  console.log('\nNo product or offer is ever invented, and no customer-facing action is executed here.');
}
