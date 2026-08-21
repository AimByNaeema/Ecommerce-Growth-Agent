'use strict';

// The compact shape of one reusable research record. This is a schema and a couple of
// pure helpers only - no lookup, search, or duplicate-detection logic (no research
// engine). Actual records are meant to be saved under research/ (see
// agent/core/contextBoundaries.js's research_context boundary) once persistence is
// implemented in a later, explicitly-scoped prompt.
//
// The point of this shape is to make "avoid repeating valid research unnecessarily"
// possible later: topic + market + date + verification_status give a future step
// enough to judge whether existing research already answers a question, without
// re-researching it from scratch.

const CONFIDENCE_LEVELS = ['unassessed', 'low', 'medium', 'high'];
const RELEVANCE_LEVELS = ['unassessed', 'low', 'medium', 'high'];
const RESEARCH_VERIFICATION_STATUSES = ['unverified', 'verified', 'outdated'];

const RESEARCH_RECORD_FIELDS = [
  {
    id: 'topic',
    title: 'Research topic',
    type: 'string',
    description: 'What was investigated - a question or subject, not a full report title.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this research applies to (see configuration/business.yaml target_markets).',
  },
  {
    id: 'date',
    title: 'Date',
    type: 'string',
    description: 'When this research was conducted or last confirmed valid (ISO date) - used to judge staleness.',
  },
  {
    id: 'source',
    title: 'Source/evidence',
    type: 'array',
    description: 'Where the evidence came from (references, e.g. URLs or report names) - not full documents.',
  },
  {
    id: 'finding',
    title: 'Finding',
    type: 'string',
    description: 'The core finding, stated plainly.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much the finding is trusted, independent of how relevant it is.',
  },
  {
    id: 'relevance',
    title: 'Relevance',
    type: `enum: ${RELEVANCE_LEVELS.join(' | ')}`,
    description: 'How applicable the finding is to current business/objectives, independent of confidence.',
  },
  {
    id: 'summary',
    title: 'Summary',
    type: 'string',
    description: 'A compact summary combining topic + finding - what a future task actually reads (see agent/core/memoryRules.js research_summaries).',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = RESEARCH_RECORD_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank research record conforming to RESEARCH_RECORD_FIELDS. No real
// research data - callers fill it in.
function createEmptyResearchRecord(topic = '') {
  return {
    topic,
    market: '',
    date: '',
    source: [],
    finding: '',
    confidence: 'unassessed',
    relevance: 'unassessed',
    summary: '',
    verification_status: 'unverified',
  };
}

// Checks that a research record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateResearchRecordShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = RESEARCH_RECORD_FIELDS.map((field) => field.id);
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

  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if ('relevance' in record && !RELEVANCE_LEVELS.includes(record.relevance)) {
    errors.push(`relevance must be one of: ${RELEVANCE_LEVELS.join(', ')}`);
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
  RESEARCH_RECORD_FIELDS,
  CONFIDENCE_LEVELS,
  RELEVANCE_LEVELS,
  RESEARCH_VERIFICATION_STATUSES,
  createEmptyResearchRecord,
  validateResearchRecordShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - research record model (schema only):\n');
  RESEARCH_RECORD_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyResearchRecord('(no topic set)'), null, 2));
}
