'use strict';

// The shape one global market comparison result conforms to - the output of
// workflows/globalEcommerceMarketResearchWorkflow.js. Schema and a couple of pure
// helpers only, following the exact convention of every existing *Model.js file
// (createEmpty* + validate*Shape + CLI printer) - no comparison logic lives here.
//
// Shallow validation only (exact top-level key set + array-type checks), matching
// agent/core/researchAgentResultModel.js's own convention for its specialized_records
// field: each row's underlying market/competitor/product record is already validated
// by its own model's validator during retrieval (agent/core/marketResearchModel.js,
// agent/core/competitorResearchModel.js, agent/core/productModel.js) - this envelope
// does not re-validate them.

const GLOBAL_MARKET_COMPARISON_FIELDS = [
  {
    id: 'topic',
    title: 'Topic',
    type: 'string',
    description: 'A short label for what this comparison is about.',
  },
  {
    id: 'markets_compared',
    title: 'Markets compared',
    type: 'array',
    description: 'Market labels, in row order - what workflows/globalEcommerceMarketResearchWorkflow.js compared.',
  },
  {
    id: 'comparison',
    title: 'Comparison rows',
    type: 'array',
    description:
      'One row per market. Each row carries the country/market identity plus 9 evidence-backed facets (category, demand_signals, trends, risks, opportunities, competition, pricing, customer_need, products) and the underlying specialized_records it was built from - see workflows/globalEcommerceMarketResearchWorkflow.js.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest gaps/caveats - always includes a base "no external source configured" entry plus one entry per row-level gap.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this comparison was produced (ISO date).',
  },
];

const ARRAY_FIELD_IDS = GLOBAL_MARKET_COMPARISON_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank global market comparison record. No real market data - callers
// (workflows/globalEcommerceMarketResearchWorkflow.js) fill it in.
function createEmptyGlobalMarketComparison(topic = '') {
  return {
    topic,
    markets_compared: [],
    comparison: [],
    limitations: [],
    research_date: '',
  };
}

// Checks that a global market comparison record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateGlobalMarketComparisonShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = GLOBAL_MARKET_COMPARISON_FIELDS.map((field) => field.id);
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
  GLOBAL_MARKET_COMPARISON_FIELDS,
  createEmptyGlobalMarketComparison,
  validateGlobalMarketComparisonShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - global market comparison model (schema only):\n');
  GLOBAL_MARKET_COMPARISON_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyGlobalMarketComparison('(no topic set)'), null, 2));
}
