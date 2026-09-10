'use strict';

// The shape one customer-related global market opportunity research result conforms to -
// the output of workflows/customerMarketOpportunityWorkflow.js. Schema plus createEmpty*
// and validate*Shape only, following the exact convention of every other *Model.js file
// in this project; no research, scoring or ranking logic lives here.
//
// ADDITIVE, NOT A REPLACEMENT. This does not alter or wrap
// agent/core/productAgentResultModel.js, agent/core/opportunityAnalysisModel.js or
// agent/core/productOpportunityScoreModel.js - each of those keeps its exact existing
// shape and is carried INSIDE this result (see specialized_records on each opportunity),
// so nothing downstream that already consumes them has to change.
//
// EVERY QUANTITATIVE FIELD IS NULLABLE ON PURPOSE. This project has no search-volume
// provider, no trend API and no marketplace-insights feed; its only public-web capability
// is Anthropic's hosted web_search. So demand, competition, trend and price arrive as
// CITED QUALITATIVE evidence far more often than as numbers, and a missing number is
// represented as null with a stated reason - never as 0, and never as a plausible-looking
// figure. EVIDENCE_GRADES below is what keeps a measured fact and an inference visibly
// different from each other for the whole life of the record.

// How a value came to be known. Any claim that is not MEASURED must say which of the
// weaker grades it is, so an inference can never be read back as a measurement.
const EVIDENCE_GRADES = ['measured', 'estimated', 'derived', 'inferred', 'unknown'];

// The trend classifications this result may report. 'unknown' is a first-class answer:
// with no trend source available it is the only honest one, and a seasonal spike must be
// reported as 'seasonal' rather than promoted to 'growing'.
const TREND_CLASSIFICATIONS = ['growing', 'stable', 'seasonal', 'declining', 'emerging', 'unknown'];

const RESULT_STATUSES = ['complete', 'partial', 'needs_information'];

// One evidenced signal on an opportunity. `value` is null whenever no source supplied a
// figure - the presence of `source_url` proves only that something was READ, never that a
// number was reported.
const SIGNAL_SUB_KEYS = ['metric', 'value', 'unit', 'grade', 'assessment', 'source', 'source_url', 'retrieved_at', 'confidence'];

const OPPORTUNITY_SUB_KEYS = [
  'rank',
  'product',
  'customer_fit_reason',
  'market',
  'demand',
  'competition',
  'trend',
  'commercial',
  'scores',
  'compliance',
  'confidence',
  'evidence',
  'variant_names',
  'mention_count',
  'specialized_records',
];

const CUSTOMER_OPPORTUNITY_RESEARCH_FIELDS = [
  {
    id: 'status',
    title: 'Status',
    type: 'string',
    description: "'complete', 'partial', or 'needs_information' - the last of these when the business context was too thin to identify a niche, which is reported rather than guessed around.",
  },
  {
    id: 'customer_context',
    title: 'Customer context',
    type: 'object',
    description: "The real business this research is FOR: name, model, channels, product counts per channel, declared categories/segments/markets. Built by agent/core/customerMarketScopeEngine.js from configuration/business.yaml plus the business's own retrieved catalogue - never invented.",
  },
  {
    id: 'market_scope',
    title: 'Market scope',
    type: 'object',
    description: '{ primary_market, related_markets, buyer_intents, geographies, channels, excluded_categories } plus a *_basis string for each, stating how it was derived. Every value is a real string this business already uses.',
  },
  {
    id: 'candidate_count',
    title: 'Candidate count',
    type: 'object',
    description: '{ discovered, after_deduplication, compliance_eligible, ranked } - the funnel, reported as real counts so it is visible that the Top N was selected from a pool rather than being the first N found.',
  },
  {
    id: 'top_opportunities',
    title: 'Top opportunities',
    type: 'array',
    description: `Ranked opportunities, at most the requested limit and deliberately FEWER when fewer are genuinely supported. Each carries ${OPPORTUNITY_SUB_KEYS.join(', ')}.`,
  },
  {
    id: 'excluded_opportunities',
    title: 'Excluded opportunities',
    type: 'array',
    description: 'Candidates removed before ranking, each with the reason - a BLOCK compliance verdict, or too little evidence. Reported so an exclusion is a visible decision, never a silent absence.',
  },
  {
    id: 'research_summary',
    title: 'Research summary',
    type: 'object',
    description: '{ stages, sources_used, verified_source_count, model_calls, generated_at } - what the run actually did and which real sources it actually read.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'What this result does NOT establish, in plain words - including every metric that no available source could supply.',
  },
];

function createEmptyCustomerOpportunityResearch() {
  return {
    status: 'needs_information',
    customer_context: {},
    market_scope: {},
    candidate_count: { discovered: 0, after_deduplication: 0, compliance_eligible: 0, ranked: 0 },
    top_opportunities: [],
    excluded_opportunities: [],
    research_summary: { stages: [], sources_used: [], verified_source_count: 0, model_calls: 0, generated_at: null },
    limitations: [],
  };
}

// Structural validation only - never a judgment about whether the research was any good.
// Returns { valid, errors } exactly like every other validate*Shape in this project.
function validateCustomerOpportunityResearchShape(result) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, errors: ['Result must be a plain object.'] };
  }
  if (!RESULT_STATUSES.includes(result.status)) {
    errors.push(`status must be one of: ${RESULT_STATUSES.join(', ')}.`);
  }
  for (const key of ['customer_context', 'market_scope', 'candidate_count', 'research_summary']) {
    if (!result[key] || typeof result[key] !== 'object' || Array.isArray(result[key])) {
      errors.push(`${key} must be an object.`);
    }
  }
  for (const key of ['top_opportunities', 'excluded_opportunities', 'limitations']) {
    if (!Array.isArray(result[key])) errors.push(`${key} must be an array.`);
  }

  for (const [index, opportunity] of (Array.isArray(result.top_opportunities) ? result.top_opportunities : []).entries()) {
    const label = `top_opportunities[${index}]`;
    if (!opportunity || typeof opportunity !== 'object') {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (opportunity.rank !== index + 1) errors.push(`${label}.rank must be ${index + 1} (ranked list must be contiguous and ordered).`);
    if (typeof opportunity.product !== 'string' || opportunity.product.trim() === '') {
      errors.push(`${label}.product must be a non-empty string.`);
    }
    if (!Array.isArray(opportunity.evidence) || opportunity.evidence.length === 0) {
      errors.push(`${label}.evidence must be a non-empty array - an unevidenced opportunity may never be ranked.`);
    }
    if (opportunity.trend && !TREND_CLASSIFICATIONS.includes(opportunity.trend.classification)) {
      errors.push(`${label}.trend.classification must be one of: ${TREND_CLASSIFICATIONS.join(', ')}.`);
    }
    // A BLOCKED opportunity must never reach the ranked list at all.
    if (opportunity.compliance && opportunity.compliance.status === 'BLOCK') {
      errors.push(`${label} carries a BLOCK compliance verdict and must not appear in top_opportunities.`);
    }
    // Every signal must grade itself, and must not carry a number it calls unknown.
    for (const key of ['demand', 'competition', 'trend', 'commercial']) {
      const signal = opportunity[key];
      if (!signal || typeof signal !== 'object') continue;
      if (signal.grade !== undefined && !EVIDENCE_GRADES.includes(signal.grade)) {
        errors.push(`${label}.${key}.grade must be one of: ${EVIDENCE_GRADES.join(', ')}.`);
      }
      if (signal.grade === 'unknown' && signal.value !== null && signal.value !== undefined) {
        errors.push(`${label}.${key} is graded 'unknown' but carries a value - an unknown metric must be null.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  EVIDENCE_GRADES,
  TREND_CLASSIFICATIONS,
  RESULT_STATUSES,
  SIGNAL_SUB_KEYS,
  OPPORTUNITY_SUB_KEYS,
  CUSTOMER_OPPORTUNITY_RESEARCH_FIELDS,
  createEmptyCustomerOpportunityResearch,
  validateCustomerOpportunityResearchShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer opportunity research result model:\n');
  for (const field of CUSTOMER_OPPORTUNITY_RESEARCH_FIELDS) {
    console.log(`${field.id} (${field.type}) - ${field.title}`);
    console.log(`  ${field.description}\n`);
  }
  console.log(`Evidence grades      : ${EVIDENCE_GRADES.join(', ')}`);
  console.log(`Trend classifications: ${TREND_CLASSIFICATIONS.join(', ')}`);
  const empty = createEmptyCustomerOpportunityResearch();
  console.log(`\nEmpty result validates: ${JSON.stringify(validateCustomerOpportunityResearchShape(empty))}`);
}
