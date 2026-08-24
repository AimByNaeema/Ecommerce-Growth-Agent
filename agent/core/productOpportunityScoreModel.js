'use strict';

// The shape one Product Opportunity score conforms to - the output of
// agent/core/productOpportunityScoringEngine.js. Schema and a couple of pure helpers
// only, following the exact convention of every existing *Model.js file (createEmpty*
// + validate*Shape + CLI printer) - no scoring logic lives here.
//
// PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS is the fixed set of 8 dimensions this result
// always reports on: demand, competition, market_fit, pricing, margin_inputs, trend,
// risk, differentiation. Every result carries a status for all 8, whether or not real
// input exists for each - see dimension_status, which mirrors
// agent/core/competitorIntelligenceModel.js's data_availability convention exactly: a
// structural audit, never an invented judgment.
//
// coverage_score is a mechanical evidence-coverage measurement (how many of the 8
// dimensions have real, evidenced input) - never a judgment about whether the
// opportunity is good. All 8 dimensions are weighted equally; no scoring/ranking
// logic beyond a plain count/percentage exists anywhere in this file.
//
// This is a standalone deliverable, distinct from
// agent/core/productAgentResultModel.js's own opportunity_scoring field (a narrower,
// 4-dimension coverage count) - that field is untouched by this module.

const PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS = [
  'demand',
  'competition',
  'market_fit',
  'pricing',
  'margin_inputs',
  'trend',
  'risk',
  'differentiation',
];

const DIMENSION_STATUSES = ['empty', 'partial', 'success'];
const COVERAGE_SCORE_SUB_KEYS = [
  'dimensions_total',
  'dimensions_available',
  'dimensions_partial',
  'dimensions_missing',
  'percentage',
  'status',
];
const MISSING_INPUT_SUB_KEYS = ['dimension', 'reason'];

const PRODUCT_OPPORTUNITY_SCORE_FIELDS = [
  {
    id: 'product_identity',
    title: 'Product identity',
    type: 'string',
    description: 'Which product this score is about (an agent/core/productModel.js product_identity value).',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this score was produced (ISO date).',
  },
  {
    id: 'dimension_status',
    title: 'Dimension status',
    type: 'object',
    description: "One status per dimension in PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS - 'empty' (no input), 'partial' (input supplied but not fully evidenced), or 'success' (input supplied and evidenced). A structural audit, never an invented judgment.",
  },
  {
    id: 'missing_inputs',
    title: 'Missing inputs',
    type: 'array',
    description: 'One entry per dimension not at \'success\': { dimension, reason } - names exactly what input is missing, never guessed or filled in.',
  },
  {
    id: 'coverage_score',
    title: 'Coverage score',
    type: 'object',
    description: '{ dimensions_total, dimensions_available, dimensions_partial, dimensions_missing, percentage, status } - a mechanical evidence-coverage measurement across the 8 dimensions, never a judgment about opportunity quality.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'The flattened union of every dimension\'s evidence, for quick top-level access.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ product_record, opportunity_analysis, trend_records } - the full underlying validated agent/core/productModel.js and agent/core/opportunityAnalysisModel.js records, and generic trend records, this score was computed from, so every status is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = PRODUCT_OPPORTUNITY_SCORE_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = PRODUCT_OPPORTUNITY_SCORE_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDimensionStatus() {
  const status = {};
  for (const dimension of PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS) {
    status[dimension] = 'empty';
  }
  return status;
}

function emptyCoverageScore() {
  return {
    dimensions_total: PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.length,
    dimensions_available: 0,
    dimensions_partial: 0,
    dimensions_missing: PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.length,
    percentage: 0,
    status: 'empty',
  };
}

// Returns a blank Product Opportunity score record. No real score - callers
// (agent/core/productOpportunityScoringEngine.js) fill it in.
function createEmptyProductOpportunityScore(product_identity = '') {
  return {
    product_identity,
    research_date: '',
    dimension_status: emptyDimensionStatus(),
    missing_inputs: [],
    coverage_score: emptyCoverageScore(),
    source: [],
    specialized_records: { product_record: null, opportunity_analysis: null, trend_records: [] },
  };
}

// Checks that a Product Opportunity score record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateProductOpportunityScoreShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = PRODUCT_OPPORTUNITY_SCORE_FIELDS.map((field) => field.id);
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

  if ('dimension_status' in record && typeof record.dimension_status === 'object' && record.dimension_status !== null) {
    const status = record.dimension_status;
    for (const dimension of PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS) {
      if (!(dimension in status)) {
        errors.push(`dimension_status is missing dimension: ${dimension}`);
      }
    }
    for (const dimension of Object.keys(status)) {
      if (!PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.includes(dimension)) {
        errors.push(`dimension_status has unexpected dimension: ${dimension}`);
      }
    }
    for (const [dimension, value] of Object.entries(status)) {
      if (!DIMENSION_STATUSES.includes(value)) {
        errors.push(`dimension_status.${dimension} must be one of: ${DIMENSION_STATUSES.join(', ')}`);
      }
    }
  }

  if (Array.isArray(record.missing_inputs)) {
    record.missing_inputs.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`missing_inputs[${index}] must be an object`);
        return;
      }
      const subIds = Object.keys(entry);
      for (const key of MISSING_INPUT_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`missing_inputs[${index}] is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!MISSING_INPUT_SUB_KEYS.includes(key)) errors.push(`missing_inputs[${index}] has unexpected sub-field: ${key}`);
      }
    });
  }

  if ('coverage_score' in record && typeof record.coverage_score === 'object' && record.coverage_score !== null) {
    const coverage = record.coverage_score;
    const subIds = Object.keys(coverage);
    for (const key of COVERAGE_SCORE_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`coverage_score is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!COVERAGE_SCORE_SUB_KEYS.includes(key)) errors.push(`coverage_score has unexpected sub-field: ${key}`);
    }
    if ('status' in coverage && !DIMENSION_STATUSES.includes(coverage.status)) {
      errors.push(`coverage_score.status must be one of: ${DIMENSION_STATUSES.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS,
  DIMENSION_STATUSES,
  PRODUCT_OPPORTUNITY_SCORE_FIELDS,
  createEmptyProductOpportunityScore,
  validateProductOpportunityScoreShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Product Opportunity score model (schema only):\n');
  PRODUCT_OPPORTUNITY_SCORE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyProductOpportunityScore('(no product identity set)'), null, 2));
  console.log('\nNo value is ever invented here - coverage_score is a mechanical evidence-coverage measurement, never a quality judgment.');
}
