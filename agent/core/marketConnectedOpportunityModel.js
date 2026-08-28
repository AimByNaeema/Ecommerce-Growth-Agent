'use strict';

// The shape one market-connected product opportunity analysis conforms to - the
// output of workflows/productOpportunityAnalysisWorkflow.js's
// analyzeProductOpportunityFromMarket(). Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (createEmpty* +
// validate*Shape + CLI printer) - no composition logic lives here.
//
// Shallow validation only (exact top-level key set + array-type checks), matching
// agent/core/globalMarketComparisonModel.js's own convention: the real content lives
// in `opportunity_analysis`, a full agent/core/opportunityAnalysisModel.js record
// already validated by its own validator - this envelope does not re-validate it.
// `specialized_records` is similarly traceability only, carrying already-validated
// records from workflows/globalEcommerceMarketResearchWorkflow.js and
// agent/core/productAgent.js.

const MARKET_CONNECTED_OPPORTUNITY_FIELDS = [
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this analysis applies to (from the global market intelligence row).',
  },
  {
    id: 'country',
    title: 'Country',
    type: 'string',
    description: 'Which country this analysis applies to (from the global market intelligence row).',
  },
  {
    id: 'product_identity',
    title: 'Product identity',
    type: 'string',
    description: 'Which product candidate this analysis is about (an agent/core/productModel.js product_identity value).',
  },
  {
    id: 'opportunity_analysis',
    title: 'Opportunity analysis',
    type: 'object',
    description:
      'A full, validated agent/core/opportunityAnalysisModel.js record - demand, competition, market_relevance, risks, and commercial_potential populated from market-intelligence-derived evidence; customer_fit, differentiation, and evidence_quality left at their honest empty default, outside this pipeline\'s scope.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest gaps/caveats, including a disclaimer that no field here is a computed statistic.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this analysis was produced (ISO date).',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description:
      '{ market_row, product_record, product_agent_result } - the underlying global market intelligence row, the agent/core/productModel.js record evaluated, and the full agent/core/productAgent.js result it was composed from, so every claim is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = MARKET_CONNECTED_OPPORTUNITY_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank market-connected opportunity record. No real analysis - callers
// (workflows/productOpportunityAnalysisWorkflow.js) fill it in.
function createEmptyMarketConnectedOpportunity(product_identity = '') {
  return {
    market: '',
    country: '',
    product_identity,
    opportunity_analysis: null,
    limitations: [],
    research_date: '',
    specialized_records: { market_row: null, product_record: null, product_agent_result: null },
  };
}

// Checks that a market-connected opportunity record has exactly the expected keys,
// with the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateMarketConnectedOpportunityShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = MARKET_CONNECTED_OPPORTUNITY_FIELDS.map((field) => field.id);
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
  MARKET_CONNECTED_OPPORTUNITY_FIELDS,
  createEmptyMarketConnectedOpportunity,
  validateMarketConnectedOpportunityShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - market-connected opportunity model (schema only):\n');
  MARKET_CONNECTED_OPPORTUNITY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyMarketConnectedOpportunity('(no product identity set)'), null, 2));
}
