'use strict';

// The shape one Product Agent result conforms to - the output of
// agent/core/productAgent.js's analyzeProductOpportunity(). Schema and a couple of
// pure helpers only, following the exact convention of every existing *Model.js file
// (createEmpty* + validate*Shape + CLI printer) - no analysis logic lives here.
//
// Reuses, never duplicates: agent/core/opportunityAnalysisModel.js's dimension
// sub-shape ({assessment, evidence, confidence}) for demand/competition/market_fit/
// product_risk (market_fit and product_risk are this result's names for that model's
// market_relevance and risks dimensions - see specialized_records.opportunity_analysis
// for the real, validated agent/core/opportunityAnalysisModel.js record they were
// built from), and agent/core/productModel.js for the underlying product record (see
// specialized_records.product_record).
//
// opportunity_scoring is a structural coverage count (how many of the 4 assessed
// dimensions are evidence-backed), never a business judgment about whether the
// opportunity is good - same honesty convention as
// agent/core/competitorIntelligenceModel.js's data_availability.

const { DIMENSION_SUB_KEYS } = require('./opportunityAnalysisModel');

const VALIDATION_SUB_KEYS = ['shape_valid', 'shape_errors', 'completeness', 'is_research_ready'];
const PROFITABILITY_INPUTS_SUB_KEYS = ['pricing', 'cost_components', 'evidence', 'source'];
const OPPORTUNITY_SCORING_SUB_KEYS = [
  'dimensions_total',
  'dimensions_evidence_backed',
  'dimensions_evidence_backed_ids',
  'status',
];
const OPPORTUNITY_SCORING_STATUSES = ['empty', 'partial', 'success'];

// The 4 dimensions this result assesses, matching
// agent/core/opportunityAnalysisModel.js's field ids one-for-one (market_fit and
// product_risk are this result's own names for market_relevance and risks).
const DIMENSION_RESULT_IDS = ['demand', 'competition', 'market_fit', 'product_risk'];

const PRODUCT_AGENT_RESULT_FIELDS = [
  {
    id: 'product_identity',
    title: 'Product identity',
    type: 'string',
    description: 'Which product this result is about (an agent/core/productModel.js product_identity value).',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this result applies to.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this result was produced (ISO date).',
  },
  {
    id: 'validation',
    title: 'Validation',
    type: 'object',
    description: '{ shape_valid, shape_errors, completeness, is_research_ready } - structural product validation, never a quality judgment.',
  },
  {
    id: 'demand',
    title: 'Demand',
    type: 'object',
    description: '{ assessment, evidence, confidence } - evidence-based assessment of customer demand.',
  },
  {
    id: 'competition',
    title: 'Competition',
    type: 'object',
    description: '{ assessment, evidence, confidence } - evidence-based assessment of existing competitors or alternatives.',
  },
  {
    id: 'market_fit',
    title: 'Market fit',
    type: 'object',
    description: '{ assessment, evidence, confidence } - evidence-based assessment of fit with target markets/customers.',
  },
  {
    id: 'product_risk',
    title: 'Product risk',
    type: 'object',
    description: '{ assessment, evidence, confidence } - evidence-based assessment of identified risks.',
  },
  {
    id: 'profitability_inputs',
    title: 'Profitability inputs',
    type: 'object',
    description: '{ pricing, cost_components, evidence, source } - raw pricing/cost inputs only; no margin or profitability figure is ever computed here.',
  },
  {
    id: 'opportunity_scoring',
    title: 'Opportunity scoring',
    type: 'object',
    description: '{ dimensions_total, dimensions_evidence_backed, dimensions_evidence_backed_ids, status } - a structural coverage count across the 4 dimensions above, never a judgment about opportunity quality.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest gaps/caveats.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'The flattened union of every section\'s evidence, for quick top-level access.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ product_record, opportunity_analysis } - the full underlying validated agent/core/productModel.js and agent/core/opportunityAnalysisModel.js records this result was composed from, so every claim is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = PRODUCT_AGENT_RESULT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = PRODUCT_AGENT_RESULT_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

// Mirrors agent/core/opportunityAnalysisModel.js's own (unexported) createEmptyDimension -
// duplicated as a one-line helper rather than reaching into that module's internals,
// consistent with this codebase's existing convention of small local helpers over a
// shared-utils module (see e.g. agent/core/competitorIntelligenceAgent.js).
function createEmptyDimension() {
  return { assessment: '', evidence: [], confidence: 'unassessed' };
}

function createEmptyValidation() {
  return { shape_valid: false, shape_errors: [], completeness: {}, is_research_ready: false };
}

function createEmptyProfitabilityInputs() {
  return { pricing: { currency: '', cost: '', price: '' }, cost_components: [], evidence: [], source: [] };
}

function createEmptyOpportunityScoring() {
  return {
    dimensions_total: DIMENSION_RESULT_IDS.length,
    dimensions_evidence_backed: 0,
    dimensions_evidence_backed_ids: [],
    status: 'empty',
  };
}

// Returns a blank Product Agent result record conforming to PRODUCT_AGENT_RESULT_FIELDS.
// No real analysis - callers (agent/core/productAgent.js) fill it in.
function createEmptyProductAgentResult(product_identity = '') {
  return {
    product_identity,
    market: '',
    research_date: '',
    validation: createEmptyValidation(),
    demand: createEmptyDimension(),
    competition: createEmptyDimension(),
    market_fit: createEmptyDimension(),
    product_risk: createEmptyDimension(),
    profitability_inputs: createEmptyProfitabilityInputs(),
    opportunity_scoring: createEmptyOpportunityScoring(),
    limitations: [],
    source: [],
    specialized_records: { product_record: null, opportunity_analysis: null },
  };
}

// Checks that a Product Agent result has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateProductAgentResultShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = PRODUCT_AGENT_RESULT_FIELDS.map((field) => field.id);
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
  for (const id of OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  for (const id of DIMENSION_RESULT_IDS) {
    if (!(id in record) || typeof record[id] !== 'object' || record[id] === null) continue;
    const subIds = Object.keys(record[id]);
    for (const key of DIMENSION_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`${id} is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!DIMENSION_SUB_KEYS.includes(key)) errors.push(`${id} has unexpected sub-field: ${key}`);
    }
    if ('evidence' in record[id] && !Array.isArray(record[id].evidence)) {
      errors.push(`${id}.evidence must be an array`);
    }
  }

  if ('validation' in record && typeof record.validation === 'object' && record.validation !== null) {
    const subIds = Object.keys(record.validation);
    for (const key of VALIDATION_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`validation is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!VALIDATION_SUB_KEYS.includes(key)) errors.push(`validation has unexpected sub-field: ${key}`);
    }
    if ('shape_errors' in record.validation && !Array.isArray(record.validation.shape_errors)) {
      errors.push('validation.shape_errors must be an array');
    }
  }

  if (
    'profitability_inputs' in record &&
    typeof record.profitability_inputs === 'object' &&
    record.profitability_inputs !== null
  ) {
    const subIds = Object.keys(record.profitability_inputs);
    for (const key of PROFITABILITY_INPUTS_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`profitability_inputs is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!PROFITABILITY_INPUTS_SUB_KEYS.includes(key)) errors.push(`profitability_inputs has unexpected sub-field: ${key}`);
    }
  }

  if (
    'opportunity_scoring' in record &&
    typeof record.opportunity_scoring === 'object' &&
    record.opportunity_scoring !== null
  ) {
    const scoring = record.opportunity_scoring;
    const subIds = Object.keys(scoring);
    for (const key of OPPORTUNITY_SCORING_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`opportunity_scoring is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!OPPORTUNITY_SCORING_SUB_KEYS.includes(key)) errors.push(`opportunity_scoring has unexpected sub-field: ${key}`);
    }
    if ('status' in scoring && !OPPORTUNITY_SCORING_STATUSES.includes(scoring.status)) {
      errors.push(`opportunity_scoring.status must be one of: ${OPPORTUNITY_SCORING_STATUSES.join(', ')}`);
    }
    if ('dimensions_evidence_backed_ids' in scoring && !Array.isArray(scoring.dimensions_evidence_backed_ids)) {
      errors.push('opportunity_scoring.dimensions_evidence_backed_ids must be an array');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  DIMENSION_RESULT_IDS,
  OPPORTUNITY_SCORING_STATUSES,
  PRODUCT_AGENT_RESULT_FIELDS,
  createEmptyProductAgentResult,
  validateProductAgentResultShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Product Agent result model (schema only):\n');
  PRODUCT_AGENT_RESULT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyProductAgentResult('(no product identity set)'), null, 2));
  console.log('\nNo product data is invented here - real values come only from cited source evidence.');
}
