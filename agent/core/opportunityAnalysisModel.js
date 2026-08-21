'use strict';

// The compact shape of one product opportunity analysis - the structured, evidence-based
// output produced by evaluating a candidate (see agent/core/productModel.js) across 8
// dimensions, after evidence has been gathered (see
// products/productResearchArchitecture.js and agent/core/researchRecordModel.js).
//
// Schema and a couple of pure helpers only - no scoring, ranking, or decision logic.
// Deliberately absent: any recommendation/score/verdict field. That is an automated
// decision, and this prompt explicitly does not build one yet.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');

// All 8 dimension fields share this uniform sub-shape, kept simple on purpose so one
// validator rule covers all of them:
//   { assessment: string, evidence: array, confidence: enum }
const DIMENSION_SUB_KEYS = ['assessment', 'evidence', 'confidence'];

const OPPORTUNITY_ANALYSIS_FIELDS = [
  {
    id: 'opportunity_reference',
    title: 'Opportunity reference',
    type: 'string',
    description: 'Which candidate this analysis is about (an agent/core/productModel.js product_identity value).',
  },
  {
    id: 'demand',
    title: 'Demand',
    type: 'object',
    description: 'Evidence-based assessment of customer demand for this opportunity.',
  },
  {
    id: 'competition',
    title: 'Competition',
    type: 'object',
    description: 'Evidence-based assessment of existing competitors or alternatives.',
  },
  {
    id: 'customer_fit',
    title: 'Customer fit',
    type: 'object',
    description: "Evidence-based assessment of fit with the business's target customer (agent/core/productModel.js target_customer).",
  },
  {
    id: 'differentiation',
    title: 'Differentiation',
    type: 'object',
    description: 'Evidence-based assessment of how this opportunity differs from existing alternatives.',
  },
  {
    id: 'market_relevance',
    title: 'Market relevance',
    type: 'object',
    description: "Evidence-based assessment of fit with the business's target markets (configuration/business.yaml; agent/core/productModel.js market).",
  },
  {
    id: 'commercial_potential',
    title: 'Commercial potential',
    type: 'object',
    description: 'Evidence-based assessment of this opportunity\'s commercial potential.',
  },
  {
    id: 'risks',
    title: 'Risks',
    type: 'object',
    description: 'Evidence-based assessment of identified risks for this opportunity.',
  },
  {
    id: 'evidence_quality',
    title: 'Evidence quality',
    type: 'object',
    description: 'Evidence-based assessment of how strong and complete the evidence gathered so far is.',
  },
];

const DIMENSION_FIELD_IDS = OPPORTUNITY_ANALYSIS_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function createEmptyDimension() {
  return { assessment: '', evidence: [], confidence: 'unassessed' };
}

// Returns a blank opportunity analysis record conforming to OPPORTUNITY_ANALYSIS_FIELDS.
// No real assessment data - callers fill it in as evidence is gathered and evaluated.
function createEmptyOpportunityAnalysis(opportunity_reference = '') {
  const record = { opportunity_reference };
  for (const id of DIMENSION_FIELD_IDS) {
    record[id] = createEmptyDimension();
  }
  return record;
}

// Checks that an opportunity analysis record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateOpportunityAnalysisShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = OPPORTUNITY_ANALYSIS_FIELDS.map((field) => field.id);
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

  for (const id of DIMENSION_FIELD_IDS) {
    if (!(id in record)) {
      continue;
    }
    const value = record[id];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${id} must be an object`);
      continue;
    }

    const subIds = Object.keys(value);
    for (const key of DIMENSION_SUB_KEYS) {
      if (!subIds.includes(key)) {
        errors.push(`${id} is missing sub-field: ${key}`);
      }
    }
    for (const key of subIds) {
      if (!DIMENSION_SUB_KEYS.includes(key)) {
        errors.push(`${id} has unexpected sub-field: ${key}`);
      }
    }

    if ('evidence' in value && !Array.isArray(value.evidence)) {
      errors.push(`${id}.evidence must be an array`);
    }
    if ('confidence' in value && !CONFIDENCE_LEVELS.includes(value.confidence)) {
      errors.push(`${id}.confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  OPPORTUNITY_ANALYSIS_FIELDS,
  DIMENSION_FIELD_IDS,
  DIMENSION_SUB_KEYS,
  createEmptyOpportunityAnalysis,
  validateOpportunityAnalysisShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - opportunity analysis model (schema only):\n');
  OPPORTUNITY_ANALYSIS_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyOpportunityAnalysis('(no opportunity set)'), null, 2));
  console.log('\nNo recommendation, score, or verdict field exists - this is not an automated decision.');
}
