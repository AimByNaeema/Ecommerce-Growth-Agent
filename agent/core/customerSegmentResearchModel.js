'use strict';

// The shape one customer segment research record conforms to - another specialization
// of agent/core/researchRecordModel.js's generic research record, the same way
// agent/core/marketResearchModel.js specializes it for markets. Schema and a couple of
// pure helpers only - no survey/interview/lookup logic (no research engine).
//
// No customer research is invented here, and no assumption is ever treated as fact:
// every field defaults empty, and confidence (reusing
// agent/core/researchRecordModel.js's CONFIDENCE_LEVELS) defaults to 'unassessed' -
// a record only earns higher confidence once real evidence backs it.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');

const CUSTOMER_SEGMENT_RESEARCH_FIELDS = [
  {
    id: 'segment_definition',
    title: 'Segment definition',
    type: 'string',
    description: 'Who this segment is - echoes configuration/business.yaml customer_segments or explicit task requirements, never invented here.',
  },
  {
    id: 'needs',
    title: 'Needs',
    type: 'array',
    description: 'Needs identified for this segment.',
  },
  {
    id: 'problems',
    title: 'Problems',
    type: 'array',
    description: 'Problems identified for this segment.',
  },
  {
    id: 'buying_motivations',
    title: 'Buying motivations',
    type: 'array',
    description: 'What motivates this segment to buy.',
  },
  {
    id: 'objections',
    title: 'Objections',
    type: 'array',
    description: 'Objections or hesitations this segment has.',
  },
  {
    id: 'preferences',
    title: 'Preferences',
    type: 'array',
    description: 'Preferences this segment has (e.g. channel, format, price point).',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this segment research applies to - echoes agent/core/marketResearchModel.js market / configuration/business.yaml target_markets, never hardcoded.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References/sources backing this record (e.g. surveys, interviews, reviews) - not full documents.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much this record is trusted - defaults to unassessed, never assumed.',
  },
];

const ARRAY_FIELD_IDS = CUSTOMER_SEGMENT_RESEARCH_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank customer segment research record conforming to
// CUSTOMER_SEGMENT_RESEARCH_FIELDS. No invented customer research - callers fill it in.
function createEmptyCustomerSegmentResearchRecord(segment_definition = '') {
  return {
    segment_definition,
    needs: [],
    problems: [],
    buying_motivations: [],
    objections: [],
    preferences: [],
    market: '',
    evidence: [],
    confidence: 'unassessed',
  };
}

// Checks that a customer segment research record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateCustomerSegmentResearchShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = CUSTOMER_SEGMENT_RESEARCH_FIELDS.map((field) => field.id);
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  CUSTOMER_SEGMENT_RESEARCH_FIELDS,
  createEmptyCustomerSegmentResearchRecord,
  validateCustomerSegmentResearchShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer segment research model (schema only):\n');
  CUSTOMER_SEGMENT_RESEARCH_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyCustomerSegmentResearchRecord('(no segment defined)'), null, 2));
  console.log('\nNo customer research is invented here, and confidence defaults to unassessed -');
  console.log('an assumption is never claimed as a fact.');
}
