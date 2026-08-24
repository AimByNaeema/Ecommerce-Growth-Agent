'use strict';

// The compact shape of one Research Agent result - the structured envelope
// research/researchAgent.js returns for any of the 6 supported research types. This is
// a schema and a couple of pure helpers only - no lookup/search/synthesis logic (no
// research engine) - matching every other *Model.js file in agent/core/.
//
// This wraps existing per-type records (agent/core/marketResearchModel.js,
// agent/core/competitorResearchModel.js, agent/core/customerSegmentResearchModel.js,
// agent/core/researchRecordModel.js) rather than duplicating their fields - see
// specialized_records below. It exists because no single existing model covers all 6
// research types with one common shape, and none of them has a `limitations` or
// `recommendations` field - adding those directly to the shared per-record schemas
// would leak them into every other consumer of those schemas (e.g. Product's
// evidence-collection stage reuses researchRecordModel.js directly).
//
// confidence and verification_status reuse agent/core/researchRecordModel.js's
// existing enums rather than redefining them - both default to the same
// unassessed/unverified starting point as every other research schema in this
// project: nothing here is ever upgraded or invented by this shape's own logic.

const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const RESEARCH_TYPES = [
  'market_research',
  'global_market_research',
  'competitor_research',
  'trend_research',
  'customer_market_intelligence',
  'opportunity_discovery',
];

const RESEARCH_AGENT_RESULT_FIELDS = [
  {
    id: 'research_type',
    title: 'Research type',
    type: `enum: ${RESEARCH_TYPES.join(' | ')}`,
    description: 'Which of the Research Agent\'s supported research types this result is for.',
  },
  {
    id: 'topic',
    title: 'Topic',
    type: 'string',
    description: 'What was researched - a question or subject, not a full report title.',
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
    description: 'Flattened reference/source entries (e.g. URLs, report names) drawn from the underlying specialized_records.',
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
    description: 'Honest gaps/caveats about this result (e.g. no external research source configured, missing evidence) - always populated, never omitted.',
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
    description: 'The underlying per-type model record(s) this result was composed from (e.g. agent/core/marketResearchModel.js records) - so this envelope wraps existing schemas rather than duplicating them.',
  },
];

const ARRAY_FIELD_IDS = RESEARCH_AGENT_RESULT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank Research Agent result conforming to RESEARCH_AGENT_RESULT_FIELDS. No
// real research data - callers fill it in.
function createEmptyResearchAgentResult(researchType = null, topic = '') {
  return {
    research_type: researchType,
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

// Checks that a Research Agent result has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateResearchAgentResultShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = RESEARCH_AGENT_RESULT_FIELDS.map((field) => field.id);
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

  if ('research_type' in record && !RESEARCH_TYPES.includes(record.research_type)) {
    errors.push(`research_type must be one of: ${RESEARCH_TYPES.join(', ')}`);
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
  RESEARCH_TYPES,
  RESEARCH_AGENT_RESULT_FIELDS,
  createEmptyResearchAgentResult,
  validateResearchAgentResultShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - research agent result model (schema only):\n');
  RESEARCH_AGENT_RESULT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty result:');
  console.log(JSON.stringify(createEmptyResearchAgentResult('market_research', '(no topic set)'), null, 2));
}
