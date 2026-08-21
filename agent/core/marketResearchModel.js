'use strict';

// The shape one market research record conforms to - a market-level specialization of
// agent/core/researchRecordModel.js's generic research record, the same way
// agent/core/productModel.js specializes it for products. Schema and a couple of pure
// helpers only - no lookup/search logic (no research engine).
//
// country and market are deliberately plain strings with no enum: this project must
// never hard-code a fixed list of real countries or markets (e.g. USA, UK). Real values
// come only from configuration/business.yaml's countries/target_markets lists (see
// configuration/business.example.yaml) or explicit task requirements - never invented
// here.
//
// evidence holds references (e.g. URLs, report names), not full documents - same
// convention as agent/core/researchRecordModel.js's source field.

const MARKET_RESEARCH_FIELDS = [
  {
    id: 'country',
    title: 'Country',
    type: 'string',
    description: 'A single country this record applies to - from configuration/business.yaml countries or explicit task requirements, never hardcoded.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this record applies to - from configuration/business.yaml target_markets or explicit task requirements, never hardcoded.',
  },
  {
    id: 'category',
    title: 'Category',
    type: 'string',
    description: 'The product category this research applies to (configuration/business.yaml product_categories; agent/core/productModel.js category).',
  },
  {
    id: 'customer_segment',
    title: 'Customer segment',
    type: 'string',
    description: 'The customer segment this research applies to (configuration/business.yaml customer_segments).',
  },
  {
    id: 'demand_signals',
    title: 'Demand signals',
    type: 'array',
    description: 'Signals indicating customer demand.',
  },
  {
    id: 'competitors',
    title: 'Competitors',
    type: 'array',
    description: 'Identified competitors or alternatives.',
  },
  {
    id: 'trends',
    title: 'Trends',
    type: 'array',
    description: 'Identified trends relevant to this market/category.',
  },
  {
    id: 'opportunities',
    title: 'Opportunities',
    type: 'array',
    description: 'Identified opportunities.',
  },
  {
    id: 'risks',
    title: 'Risks',
    type: 'array',
    description: 'Identified risks.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References/sources backing this record (e.g. URLs, report names) - not full documents.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this research was conducted or last confirmed valid (ISO date).',
  },
];

const ARRAY_FIELD_IDS = MARKET_RESEARCH_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank market research record conforming to MARKET_RESEARCH_FIELDS. No real
// country/market/business data - callers fill it in.
function createEmptyMarketResearchRecord(country = '', market = '') {
  return {
    country,
    market,
    category: '',
    customer_segment: '',
    demand_signals: [],
    competitors: [],
    trends: [],
    opportunities: [],
    risks: [],
    evidence: [],
    research_date: '',
  };
}

// Checks that a market research record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateMarketResearchShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = MARKET_RESEARCH_FIELDS.map((field) => field.id);
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
  MARKET_RESEARCH_FIELDS,
  createEmptyMarketResearchRecord,
  validateMarketResearchShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - market research model (schema only):\n');
  MARKET_RESEARCH_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyMarketResearchRecord('(no country set)', '(no market set)'), null, 2));
  console.log('\nNo country or market is hardcoded here - real values come only from');
  console.log('configuration/business.yaml or explicit task requirements.');
}
