'use strict';

// The shape one Offer Recommendation result conforms to - the output of
// agent/core/offerRecommendationEngine.js. Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (createEmpty* +
// validate*Shape + CLI printer) - no recommendation logic lives here.
//
// OFFER_RECOMMENDATION_TYPES is the fixed set of 7 dimensions this result always
// reports on: bundle, discount, upsell, cross_sell, incentive, value_proposition,
// objection_handling. Every result carries a status for all 7, whether or not real
// input exists for each - dimension_status mirrors
// agent/core/productOpportunityScoreModel.js's own convention exactly (a structural
// audit, never an invented judgment), reusing its DIMENSION_STATUSES enum rather than
// redefining it.
//
// coverage_score is a mechanical evidence-coverage measurement (how many of the 7
// dimensions have real, evidenced input) - never a judgment about whether an offer is
// good or will convert. confidence is mechanically derived from coverage_score the
// same way agent/core/productRecommendationEngine.js derives its own confidence field -
// never a business judgment.
//
// unsupported_claims_flagged is a dedicated, always-present field naming any
// absolute/superlative claim phrase (e.g. "guaranteed", "best", "100%") found in a
// value proposition or objection response that was not backed by supplied evidence -
// the structural mechanism behind this engine's "do not create unsupported guarantees
// or claims" requirement. Detection reuses
// agent/core/listingQualityChecker.js's own CLAIM_TRIGGER_PHRASES/containsText rather
// than redefining the phrase list.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');
const { DIMENSION_STATUSES } = require('./productOpportunityScoreModel');

const OFFER_RECOMMENDATION_TYPES = [
  'bundle',
  'discount',
  'upsell',
  'cross_sell',
  'incentive',
  'value_proposition',
  'objection_handling',
];

// How a related product connects to the anchor product - constrains
// specialized_records.related_products entries. 'bundle_candidate' feeds the bundle
// dimension, 'higher_tier' feeds upsell, 'complementary'/'accessory' feed cross_sell.
const RELATIONSHIP_TYPES = ['bundle_candidate', 'complementary', 'accessory', 'higher_tier'];

const MISSING_INFORMATION_SUB_KEYS = ['dimension', 'reason'];
const COVERAGE_SCORE_SUB_KEYS = [
  'dimensions_total',
  'dimensions_success',
  'dimensions_partial',
  'dimensions_empty',
  'percentage',
  'status',
];
const SPECIALIZED_RECORDS_SUB_KEYS = [
  'pricing',
  'discount_constraints',
  'related_products',
  'incentive_options',
  'value_propositions',
  'objections',
];

const OFFER_RECOMMENDATION_FIELDS = [
  {
    id: 'product_reference',
    title: 'Product reference',
    type: 'string',
    description: 'The real product this offer recommendation is anchored to (an agent/core/productModel.js product_identity value) - never invented.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this result applies to - from configuration/business.yaml or explicit task requirements, never hardcoded.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this result was produced (ISO date).',
  },
  {
    id: 'dimension_status',
    title: 'Dimension status',
    type: 'object',
    description: "One status per dimension in OFFER_RECOMMENDATION_TYPES - 'empty' (no input supplied), 'partial' (input supplied but not fully evidenced or not fully computable), or 'success' (input supplied and evidenced/computable). A structural audit, never an invented judgment.",
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Flattened, human-readable, labeled facts about each dimension (e.g. how many candidates were supplied, current margin) - mechanical, never a fabricated business insight.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    type: 'array',
    description: 'Flattened, labeled suggested offer actions, composed only from caller-supplied product/business data - never a fabricated product, price, or claim.',
  },
  {
    id: 'missing_information',
    title: 'Missing information',
    type: 'array',
    description: '[{ dimension, reason }] - one entry per dimension not at \'success\', naming exactly what input is missing, never guessed or filled in.',
  },
  {
    id: 'unsupported_claims_flagged',
    title: 'Unsupported claims flagged',
    type: 'array',
    description: 'Absolute/superlative claim phrases found in a value proposition or objection response with no supporting evidence - flagged, never silently included or invented.',
  },
  {
    id: 'coverage_score',
    title: 'Coverage score',
    type: 'object',
    description: '{ dimensions_total, dimensions_success, dimensions_partial, dimensions_empty, percentage, status } - a mechanical evidence-coverage measurement across the 7 dimensions, never a judgment about offer quality.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'Mechanically derived from coverage_score\'s percentage - never a business judgment.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'The flattened union of every dimension entry\'s own evidence, for quick top-level access.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ pricing, discount_constraints, related_products, incentive_options, value_propositions, objections } - the real, normalized, caller-supplied inputs this result was computed from, for full traceability.',
  },
];

const ARRAY_FIELD_IDS = OFFER_RECOMMENDATION_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = OFFER_RECOMMENDATION_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDimensionStatus() {
  const status = {};
  for (const dimension of OFFER_RECOMMENDATION_TYPES) {
    status[dimension] = 'empty';
  }
  return status;
}

function emptyCoverageScore() {
  return {
    dimensions_total: OFFER_RECOMMENDATION_TYPES.length,
    dimensions_success: 0,
    dimensions_partial: 0,
    dimensions_empty: OFFER_RECOMMENDATION_TYPES.length,
    percentage: 0,
    status: 'empty',
  };
}

function emptySpecializedRecords() {
  return {
    pricing: null,
    discount_constraints: null,
    related_products: [],
    incentive_options: [],
    value_propositions: [],
    objections: [],
  };
}

// Returns a blank Offer Recommendation record. No real recommendation - callers
// (agent/core/offerRecommendationEngine.js) fill it in.
function createEmptyOfferRecommendation(product_reference = '') {
  return {
    product_reference,
    market: '',
    research_date: '',
    dimension_status: emptyDimensionStatus(),
    findings: [],
    recommendations: [],
    missing_information: [],
    unsupported_claims_flagged: [],
    coverage_score: emptyCoverageScore(),
    confidence: 'unassessed',
    evidence: [],
    specialized_records: emptySpecializedRecords(),
  };
}

// Checks that an Offer Recommendation record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateOfferRecommendationShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = OFFER_RECOMMENDATION_FIELDS.map((field) => field.id);
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
    for (const dimension of OFFER_RECOMMENDATION_TYPES) {
      if (!(dimension in status)) {
        errors.push(`dimension_status is missing dimension: ${dimension}`);
      }
    }
    for (const dimension of Object.keys(status)) {
      if (!OFFER_RECOMMENDATION_TYPES.includes(dimension)) {
        errors.push(`dimension_status has unexpected dimension: ${dimension}`);
      }
    }
    for (const [dimension, value] of Object.entries(status)) {
      if (!DIMENSION_STATUSES.includes(value)) {
        errors.push(`dimension_status.${dimension} must be one of: ${DIMENSION_STATUSES.join(', ')}`);
      }
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

  if ('specialized_records' in record && typeof record.specialized_records === 'object' && record.specialized_records !== null) {
    const subIds = Object.keys(record.specialized_records);
    for (const key of SPECIALIZED_RECORDS_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`specialized_records is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!SPECIALIZED_RECORDS_SUB_KEYS.includes(key)) errors.push(`specialized_records has unexpected sub-field: ${key}`);
    }
  }

  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  OFFER_RECOMMENDATION_TYPES,
  RELATIONSHIP_TYPES,
  OFFER_RECOMMENDATION_FIELDS,
  createEmptyOfferRecommendation,
  validateOfferRecommendationShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Offer Recommendation model (schema only):\n');
  OFFER_RECOMMENDATION_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyOfferRecommendation('(no product reference set)'), null, 2));
  console.log('\nNo offer, discount, or claim is ever invented here - coverage_score is a mechanical evidence-coverage measurement, never a quality judgment.');
}
