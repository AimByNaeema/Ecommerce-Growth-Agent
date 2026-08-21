'use strict';

// The shape of one SEO keyword research record. Schema and a couple of pure helpers
// only - no keyword lookup, no live keyword API call, no search-volume/rank-tracking
// logic. No keyword API is configured or called today; if one is configured in a
// later, explicitly-scoped prompt, this schema is what its results would be recorded
// as - never invented data.
//
// A flat specialization of agent/core/researchRecordModel.js for one keyword, the
// same way agent/core/marketResearchModel.js specializes it for one market.
// `relevance` and `confidence` reuse researchRecordModel.js's existing enums rather
// than redefining them.

const { RELEVANCE_LEVELS, CONFIDENCE_LEVELS } = require('./researchRecordModel');

const SEO_RESEARCH_FIELDS = [
  {
    id: 'keyword',
    title: 'Keyword',
    type: 'string',
    description: 'The keyword or phrase this record is about.',
  },
  {
    id: 'search_intent',
    title: 'Search intent',
    type: 'string',
    description: 'The intent behind this keyword, backed by evidence - no fixed taxonomy assumed.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this keyword applies to - from configuration/business.yaml target_markets or explicit task requirements, never hardcoded.',
  },
  {
    id: 'language',
    title: 'Language',
    type: 'string',
    description: 'Which language this keyword/record applies to - from configuration or explicit task requirements, never hardcoded.',
  },
  {
    id: 'relevance',
    title: 'Relevance',
    type: `enum: ${RELEVANCE_LEVELS.join(' | ')}`,
    description: 'How applicable this keyword is to current business/objectives.',
  },
  {
    id: 'competition',
    title: 'Competition',
    type: 'string',
    description: 'Qualitative competition assessment for this keyword, backed by evidence.',
  },
  {
    id: 'opportunity',
    title: 'Opportunity',
    type: 'string',
    description: 'Qualitative opportunity assessment for this keyword, backed by evidence.',
  },
  {
    id: 'source',
    title: 'Source/evidence',
    type: 'array',
    description: 'Where this record\'s evidence came from (references, e.g. URLs or report names) - not full documents.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this record was researched or last confirmed valid (ISO date).',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much this record is trusted; defaults to unassessed - never assumed.',
  },
];

const ARRAY_FIELD_IDS = SEO_RESEARCH_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank SEO research record conforming to SEO_RESEARCH_FIELDS. No real
// keyword data - callers fill it in.
function createEmptySeoResearchRecord(keyword = '') {
  return {
    keyword,
    search_intent: '',
    market: '',
    language: '',
    relevance: 'unassessed',
    competition: '',
    opportunity: '',
    source: [],
    research_date: '',
    confidence: 'unassessed',
  };
}

// Checks that an SEO research record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateSeoResearchShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SEO_RESEARCH_FIELDS.map((field) => field.id);
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

  if ('relevance' in record && !RELEVANCE_LEVELS.includes(record.relevance)) {
    errors.push(`relevance must be one of: ${RELEVANCE_LEVELS.join(', ')}`);
  }
  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SEO_RESEARCH_FIELDS,
  createEmptySeoResearchRecord,
  validateSeoResearchShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - SEO research model (schema only):\n');
  SEO_RESEARCH_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptySeoResearchRecord('(no keyword set)'), null, 2));
}
