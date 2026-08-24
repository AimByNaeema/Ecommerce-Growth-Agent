'use strict';

// The shape one structured product recommendation conforms to - the output of
// agent/core/productRecommendationEngine.js, the final layer of the Product pipeline
// (discovery/validation -> agent/core/productAgent.js; 8-dimension evidence scoring ->
// agent/core/productOpportunityScoringEngine.js; this recommendation layer). Schema
// and a couple of pure helpers only, following the exact convention of every existing
// *Model.js file (createEmpty* + validate*Shape + CLI printer) - no recommendation
// logic lives here.
//
// Every field is either reused as-is from an already-validated
// agent/core/productOpportunityScoreModel.js record, or mechanically derived from it
// (confidence, the default recommended_next_step) - nothing here is a fabricated
// business judgment. This module (together with productRecommendationEngine.js) makes
// no external calls of any kind: it never purchases, publishes, or imports a product.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');
const { DIMENSION_SUB_KEYS } = require('./opportunityAnalysisModel');

const OPPORTUNITY_SUB_KEYS = ['product_identity', 'category', 'market', 'positioning'];
const MISSING_INFORMATION_SUB_KEYS = ['dimension', 'reason'];

const PRODUCT_RECOMMENDATION_FIELDS = [
  {
    id: 'opportunity',
    title: 'Opportunity',
    type: 'object',
    description: '{ product_identity, category, market, positioning } - composed directly from the underlying agent/core/productModel.js record, never invented.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this recommendation was produced (ISO date).',
  },
  {
    id: 'reasoning',
    title: 'Reasoning',
    type: 'array',
    description: 'Plain-language lines composed only from real, caller-supplied assessment text plus structural dimension status - never a fabricated business insight.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'The flattened evidence backing this recommendation - a direct copy of the underlying score record\'s own source field.',
  },
  {
    id: 'risks',
    title: 'Risks',
    type: 'object',
    description: '{ assessment, evidence, confidence } - agent/core/opportunityAnalysisModel.js\'s real risks dimension, taken as-is, never re-assessed.',
  },
  {
    id: 'missing_information',
    title: 'Missing information',
    type: 'array',
    description: '[{ dimension, reason }] - a direct reuse of the underlying score record\'s missing_inputs; names exactly what is missing, never guessed or filled in.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'Mechanically derived from the underlying score record\'s coverage_score percentage - never a business judgment.',
  },
  {
    id: 'recommended_next_step',
    title: 'Recommended next step',
    type: 'string',
    description: 'Caller-suppliable; when omitted, falls back to a deterministic, structural default (close named evidence gaps, or route to a human for a go/no-go decision). Never a specific fabricated business action, and this module never purchases, publishes, or imports anything itself.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ product_opportunity_score } - the full, real, already-validated agent/core/productOpportunityScoreModel.js record this recommendation was composed from, for full traceability.',
  },
];

const ARRAY_FIELD_IDS = PRODUCT_RECOMMENDATION_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = PRODUCT_RECOMMENDATION_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyOpportunity() {
  return { product_identity: '', category: '', market: '', positioning: '' };
}

function emptyRisks() {
  return { assessment: '', evidence: [], confidence: 'unassessed' };
}

// Returns a blank product recommendation record. No real recommendation - callers
// (agent/core/productRecommendationEngine.js) fill it in.
function createEmptyProductRecommendation(product_identity = '') {
  const opportunity = emptyOpportunity();
  opportunity.product_identity = product_identity;
  return {
    opportunity,
    research_date: '',
    reasoning: [],
    evidence: [],
    risks: emptyRisks(),
    missing_information: [],
    confidence: 'unassessed',
    recommended_next_step: '',
    specialized_records: { product_opportunity_score: null },
  };
}

// Checks that a product recommendation record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateProductRecommendationShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = PRODUCT_RECOMMENDATION_FIELDS.map((field) => field.id);
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

  if ('opportunity' in record && typeof record.opportunity === 'object' && record.opportunity !== null) {
    const subIds = Object.keys(record.opportunity);
    for (const key of OPPORTUNITY_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`opportunity is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!OPPORTUNITY_SUB_KEYS.includes(key)) errors.push(`opportunity has unexpected sub-field: ${key}`);
    }
  }

  if ('risks' in record && typeof record.risks === 'object' && record.risks !== null) {
    const subIds = Object.keys(record.risks);
    for (const key of DIMENSION_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`risks is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!DIMENSION_SUB_KEYS.includes(key)) errors.push(`risks has unexpected sub-field: ${key}`);
    }
    if ('evidence' in record.risks && !Array.isArray(record.risks.evidence)) {
      errors.push('risks.evidence must be an array');
    }
    if ('confidence' in record.risks && !CONFIDENCE_LEVELS.includes(record.risks.confidence)) {
      errors.push(`risks.confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
    }
  }

  if (Array.isArray(record.missing_information)) {
    record.missing_information.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`missing_information[${index}] must be an object`);
        return;
      }
      const subIds = Object.keys(entry);
      for (const key of MISSING_INFORMATION_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`missing_information[${index}] is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!MISSING_INFORMATION_SUB_KEYS.includes(key)) errors.push(`missing_information[${index}] has unexpected sub-field: ${key}`);
      }
    });
  }

  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  PRODUCT_RECOMMENDATION_FIELDS,
  OPPORTUNITY_SUB_KEYS,
  MISSING_INFORMATION_SUB_KEYS,
  createEmptyProductRecommendation,
  validateProductRecommendationShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product recommendation model (schema only):\n');
  PRODUCT_RECOMMENDATION_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyProductRecommendation('(no product identity set)'), null, 2));
  console.log('\nThis module never purchases, publishes, or imports a product - it only composes an already-computed score record into a structured recommendation.');
}
