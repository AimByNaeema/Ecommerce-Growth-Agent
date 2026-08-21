'use strict';

// The shape one competitor research record conforms to - another specialization of
// agent/core/researchRecordModel.js's generic research record, the same way
// agent/core/marketResearchModel.js specializes it for markets. Schema and a couple of
// pure helpers only - no scraping/lookup logic (no research engine).
//
// No competitor data is invented here: every field defaults empty, source holds
// references (not full documents), and the CLI's example record uses an obviously
// fictional placeholder for competitor - never a real company.

const COMPETITOR_RESEARCH_FIELDS = [
  {
    id: 'competitor',
    title: 'Competitor',
    type: 'string',
    description: "The competitor's name or identifier - no real competitor invented here.",
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this record applies to - echoes agent/core/marketResearchModel.js market / configuration/business.yaml target_markets.',
  },
  {
    id: 'product_category',
    title: 'Product/category',
    type: 'string',
    description: 'The product category this competitor is being researched in - echoes agent/core/productModel.js category.',
  },
  {
    id: 'positioning',
    title: 'Positioning',
    type: 'string',
    description: "The competitor's positioning - echoes agent/core/productModel.js positioning.",
  },
  {
    id: 'pricing_evidence',
    title: 'Pricing evidence',
    type: 'array',
    description: 'Observed pricing evidence - not full documents.',
  },
  {
    id: 'strengths',
    title: 'Strengths',
    type: 'array',
    description: "Identified strengths of this competitor.",
  },
  {
    id: 'weaknesses',
    title: 'Weaknesses',
    type: 'array',
    description: "Identified weaknesses of this competitor.",
  },
  {
    id: 'marketing_signals',
    title: 'Marketing signals',
    type: 'array',
    description: "Signals about this competitor's marketing activity.",
  },
  {
    id: 'seo_signals',
    title: 'SEO signals',
    type: 'array',
    description: "Signals about this competitor's SEO/search visibility.",
  },
  {
    id: 'opportunities',
    title: 'Opportunities',
    type: 'array',
    description: 'Identified opportunities relative to this competitor.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'References/sources backing this record (e.g. URLs, listings) - not full documents.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this research was conducted or last confirmed valid (ISO date).',
  },
];

const ARRAY_FIELD_IDS = COMPETITOR_RESEARCH_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank competitor research record conforming to COMPETITOR_RESEARCH_FIELDS.
// No real competitor data - callers fill it in.
function createEmptyCompetitorResearchRecord(competitor = '') {
  return {
    competitor,
    market: '',
    product_category: '',
    positioning: '',
    pricing_evidence: [],
    strengths: [],
    weaknesses: [],
    marketing_signals: [],
    seo_signals: [],
    opportunities: [],
    source: [],
    research_date: '',
  };
}

// Checks that a competitor research record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateCompetitorResearchShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = COMPETITOR_RESEARCH_FIELDS.map((field) => field.id);
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  COMPETITOR_RESEARCH_FIELDS,
  createEmptyCompetitorResearchRecord,
  validateCompetitorResearchShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - competitor research model (schema only):\n');
  COMPETITOR_RESEARCH_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyCompetitorResearchRecord('(no competitor set)'), null, 2));
  console.log('\nNo competitor data is invented here - real values come only from cited source evidence.');
}
