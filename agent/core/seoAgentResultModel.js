'use strict';

// The compact shape of one SEO Agent result - the structured envelope
// agent/core/seoAgent.js returns for any of its 7 supported capabilities. Schema and a
// couple of pure helpers only - no lookup/search/synthesis logic, matching every other
// *Model.js file in agent/core/ and mirroring agent/core/researchAgentResultModel.js's
// own design exactly.
//
// This wraps existing per-capability records (agent/core/seoResearchModel.js,
// agent/core/listingOptimizationModel.js, agent/core/onPageOptimizationModel.js)
// rather than duplicating their fields - see specialized_records below. It exists
// because no single existing model covers all 7 capabilities with one common shape,
// and none of them has a `limitations` or `recommendations` field - adding those
// directly to the shared per-record schemas would leak them into every other consumer
// of those schemas.
//
// confidence and verification_status reuse agent/core/researchRecordModel.js's
// existing enums rather than redefining them - both default to the same
// unassessed/unverified starting point as every other schema in this project: nothing
// here is ever upgraded or invented by this shape's own logic.

const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const SEO_CAPABILITIES = [
  'keyword_research',
  'search_intent_analysis',
  'product_seo',
  'collection_seo',
  'content_seo',
  'on_page_seo',
  'seo_opportunity_analysis',
  // Real-question gap detection: which questions people actually ask that competitors
  // answer poorly or not at all (agent/core/informationGapEngine.js). Composes
  // agent/core/informationGapModel.js records into this same envelope, the same way the
  // 7 above compose their own per-capability schemas.
  'information_gap_analysis',
  // The evidence-ACQUISITION capability upstream of information_gap_analysis
  // (tools/marketQuestionDiscoveryTool.js). Listed here because it is a real capability
  // of the SEO specialist - agent/core/specialistCapabilityRegistry.js's SEO task list
  // is kept exactly in step with this enum - but note it is the one SEO capability
  // agent/core/seoAgent.js does NOT run: acquisition is an I/O concern executed by its
  // own tool, and its output is an agent/core/questionEvidenceModel.js record rather
  // than this envelope. runSeoAgent() therefore rejects it, which is correct.
  'market_question_discovery',
  // The stage after information_gap_analysis: a validated opportunity becomes a content
  // brief and draft (tools/seoContentGenerationTool.js). Like market_question_discovery
  // above, it is tool-executed rather than composed by agent/core/seoAgent.js - its
  // output is an agent/core/contentBriefModel.js result, not this envelope.
  'seo_content_generation',
];

const SEO_AGENT_RESULT_FIELDS = [
  {
    id: 'capability',
    title: 'Capability',
    type: `enum: ${SEO_CAPABILITIES.join(' | ')}`,
    description: 'Which of the SEO Agent\'s supported capabilities this result is for.',
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
    description: 'Honest gaps/caveats about this result (e.g. no live keyword API configured, missing evidence) - always populated, never omitted.',
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
    description: 'The underlying per-capability model record(s) this result was composed from (e.g. agent/core/seoResearchModel.js records) - so this envelope wraps existing schemas rather than duplicating them.',
  },
];

const ARRAY_FIELD_IDS = SEO_AGENT_RESULT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank SEO Agent result conforming to SEO_AGENT_RESULT_FIELDS. No real
// analysis - callers (agent/core/seoAgent.js) fill it in.
function createEmptySeoAgentResult(capability = null, topic = '') {
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

// Checks that an SEO Agent result has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateSeoAgentResultShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SEO_AGENT_RESULT_FIELDS.map((field) => field.id);
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

  if ('capability' in record && !SEO_CAPABILITIES.includes(record.capability)) {
    errors.push(`capability must be one of: ${SEO_CAPABILITIES.join(', ')}`);
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
  SEO_CAPABILITIES,
  SEO_AGENT_RESULT_FIELDS,
  createEmptySeoAgentResult,
  validateSeoAgentResultShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - SEO agent result model (schema only):\n');
  SEO_AGENT_RESULT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty result:');
  console.log(JSON.stringify(createEmptySeoAgentResult('keyword_research', '(no topic set)'), null, 2));
}
