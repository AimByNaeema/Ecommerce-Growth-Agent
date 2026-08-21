'use strict';

// The shape of one marketing analysis record. Schema and a couple of pure helpers
// only - no campaign execution, scheduling, or sending logic. No external marketing
// action (sending a message, launching a campaign, posting an ad) is ever taken here -
// nothing in this module reads external marketing platforms or writes to one; there is
// no execute/send/publish function to gate.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, extending the
// cross-schema reuse precedent already established by
// agent/core/opportunityAnalysisModel.js, agent/core/customerSegmentResearchModel.js,
// and agent/core/seoResearchModel.js.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const MARKETING_ANALYSIS_FIELDS = [
  {
    id: 'marketing_channel',
    title: 'Marketing channel',
    type: 'string',
    description: 'Which marketing channel this analysis is about - from configuration/business.yaml marketing_channels or explicit task requirements, never hardcoded.',
  },
  {
    id: 'target_segment',
    title: 'Target segment',
    type: 'string',
    description: 'Which customer segment this analysis targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'product',
    title: 'Product',
    type: 'string',
    description: 'Which product this analysis is about, echoing agent/core/productModel.js product_identity.',
  },
  {
    id: 'campaign',
    title: 'Campaign',
    type: 'string',
    description: 'A name or identifier for the campaign this analysis is about - no campaign invented here.',
  },
  {
    id: 'objective',
    title: 'Objective',
    type: 'string',
    description: 'The goal this campaign/message is meant to achieve.',
  },
  {
    id: 'message',
    title: 'Message',
    type: 'string',
    description: 'The core marketing message.',
  },
  {
    id: 'offer',
    title: 'Offer',
    type: 'string',
    description: 'Any offer or promotion associated with this campaign/message.',
  },
  {
    id: 'timing',
    title: 'Timing',
    type: 'string',
    description: 'When this campaign/message is planned or was run.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this analysis (e.g. prior campaign results, research records), not full documents.',
  },
  {
    id: 'expected_outcome',
    title: 'Expected outcome',
    type: 'string',
    description: 'A qualitative statement of what this campaign/message is expected to achieve - not a fabricated performance number.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this analysis has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = MARKETING_ANALYSIS_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank marketing analysis record conforming to MARKETING_ANALYSIS_FIELDS.
// No real marketing data - callers fill it in.
function createEmptyMarketingAnalysisRecord(marketing_channel = '', campaign = '') {
  return {
    marketing_channel,
    target_segment: '',
    product: '',
    campaign,
    objective: '',
    message: '',
    offer: '',
    timing: '',
    evidence: [],
    expected_outcome: '',
    verification_status: 'unverified',
  };
}

// Checks that a marketing analysis record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateMarketingAnalysisShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = MARKETING_ANALYSIS_FIELDS.map((field) => field.id);
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

  if (
    'verification_status' in record &&
    !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)
  ) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  MARKETING_ANALYSIS_FIELDS,
  createEmptyMarketingAnalysisRecord,
  validateMarketingAnalysisShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - marketing analysis model (schema only):\n');
  MARKETING_ANALYSIS_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyMarketingAnalysisRecord('(no channel set)', '(no campaign set)'), null, 2));
  console.log('\nNo external marketing action is ever executed here - this is analysis only.');
}
