'use strict';

// The compact shape of one Marketing Agent result - the structured envelope
// agent/core/marketingAgent.js returns for any of its 8 supported capabilities.
// Schema and a couple of pure helpers only - no lookup/search/synthesis logic,
// matching every other *Model.js file in agent/core/ and mirroring
// agent/core/seoAgentResultModel.js's own design exactly.
//
// This wraps existing per-capability records (agent/core/marketingAnalysisModel.js,
// agent/core/growthOpportunityModel.js, agent/core/customerSegmentResearchModel.js)
// rather than duplicating their fields - see specialized_records below.
//
// confidence and verification_status reuse agent/core/researchRecordModel.js's
// existing enums rather than redefining them - both default to the same
// unassessed/unverified starting point as every other schema in this project: nothing
// here is ever upgraded or invented by this shape's own logic.

const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const MARKETING_CAPABILITIES = [
  'marketing_strategy',
  'audience_segmentation',
  'offers',
  'promotions',
  'retention',
  'campaign_planning',
  'email_strategy',
  'conversion_opportunities',
  'marketing_opportunity_ranking',
];

const MARKETING_AGENT_RESULT_FIELDS = [
  {
    id: 'capability',
    title: 'Capability',
    type: `enum: ${MARKETING_CAPABILITIES.join(' | ')}`,
    description: 'Which of the Marketing Agent\'s supported capabilities this result is for.',
  },
  {
    id: 'topic',
    title: 'Topic',
    type: 'string',
    description: 'What this result is about - a question or subject, not a full report title.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this result applies to - from configuration/business.yaml or explicit task requirements, never hardcoded. May be empty for results spanning multiple markets.',
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Flattened, human-readable finding statements drawn from the underlying specialized_records.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'Flattened supporting evidence entries drawn from the underlying specialized_records.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'Flattened reference/source entries (e.g. prior campaign results, research records) drawn from the underlying specialized_records.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much this result is trusted - only ever what the caller explicitly asserted, never inferred or upgraded here.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest gaps/caveats about this result (e.g. no live marketing platform configured, missing evidence) - always populated, never omitted.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    type: 'array',
    description: 'Suggestions for a human to consider - only ever what the caller explicitly supplied, never invented here.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this result has been checked against current reality - only ever what the caller explicitly asserted, downgraded to unverified if asserted verified with no evidence.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this result was produced (ISO date).',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'array',
    description: 'The underlying per-capability model record(s) this result was composed from (e.g. agent/core/marketingAnalysisModel.js records) - so this envelope wraps existing schemas rather than duplicating them.',
  },
];

const ARRAY_FIELD_IDS = MARKETING_AGENT_RESULT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank Marketing Agent result conforming to MARKETING_AGENT_RESULT_FIELDS.
// No real analysis - callers (agent/core/marketingAgent.js) fill it in.
function createEmptyMarketingAgentResult(capability = null, topic = '') {
  return {
    capability,
    topic,
    market: '',
    findings: [],
    evidence: [],
    source: [],
    confidence: 'unassessed',
    limitations: [],
    recommendations: [],
    verification_status: 'unverified',
    research_date: '',
    specialized_records: [],
  };
}

// Checks that a Marketing Agent result has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateMarketingAgentResultShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = MARKETING_AGENT_RESULT_FIELDS.map((field) => field.id);
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

  if ('capability' in record && !MARKETING_CAPABILITIES.includes(record.capability)) {
    errors.push(`capability must be one of: ${MARKETING_CAPABILITIES.join(', ')}`);
  }
  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
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
  MARKETING_CAPABILITIES,
  MARKETING_AGENT_RESULT_FIELDS,
  createEmptyMarketingAgentResult,
  validateMarketingAgentResultShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Marketing agent result model (schema only):\n');
  MARKETING_AGENT_RESULT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty result:');
  console.log(JSON.stringify(createEmptyMarketingAgentResult('marketing_strategy', '(no topic set)'), null, 2));
}
