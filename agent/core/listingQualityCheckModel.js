'use strict';

// The shape one Listing Quality Check result conforms to - the output of
// agent/core/listingQualityChecker.js. Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (createEmpty* +
// validate*Shape + CLI printer) - no checking/scoring logic lives here.
//
// LISTING_QUALITY_DIMENSIONS is the fixed set of 8 dimensions this result always
// reports on: completeness, clarity, accuracy, conversion quality, SEO compatibility,
// customer objections, missing information, unsupported claims. Every result carries a
// status for all 8, whether or not real input exists for each - mirroring
// agent/core/seoQualityCheckModel.js's dimension_status convention: a structural,
// mechanical audit, never an invented judgment about writing quality, tone,
// persuasiveness, or actual conversion/ranking performance.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 8
// dimensions' structural checks passed) - never a claim about actual conversion,
// ranking, or sales performance. All 8 dimensions are weighted equally; no unjustified
// weighting scheme exists here. Distinct from
// agent/core/productOpportunityScoreModel.js's coverage_score (which measures evidence
// *availability*, not check *pass/fail*) - same shape, different meaning,
// intentionally not shared/reused since the two measure different things.

const LISTING_QUALITY_DIMENSIONS = [
  'completeness',
  'clarity',
  'accuracy',
  'conversion_quality',
  'seo_compatibility',
  'customer_objections',
  'missing_information',
  'unsupported_claims',
];

const DIMENSION_STATUSES = ['empty', 'partial', 'success'];
const QUALITY_SCORE_SUB_KEYS = [
  'dimensions_total',
  'dimensions_success',
  'dimensions_partial',
  'dimensions_empty',
  'percentage',
  'status',
];
const DIMENSION_GAP_SUB_KEYS = ['dimension', 'reason'];

const LISTING_QUALITY_CHECK_FIELDS = [
  {
    id: 'subject_reference',
    title: 'Subject reference',
    type: 'string',
    description: 'Which product/listing this check is about (the checked record\'s product_reference).',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this check was run (ISO date).',
  },
  {
    id: 'dimension_status',
    title: 'Dimension status',
    type: 'object',
    description: "One status per dimension in LISTING_QUALITY_DIMENSIONS - 'empty' (nothing to check, or every check failed), 'partial' (some checks passed), or 'success' (every applicable check passed). A structural, mechanical audit, never an invented judgment.",
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Flattened, human-readable, per-dimension facts this check actually found (e.g. character counts, phrase presence/absence) - each traceable to a concrete structural check, never a subjective opinion.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    type: 'array',
    description: 'Flattened, actionable suggestions, one per failed/partial check - always mechanically derived from a specific finding above, never invented independently.',
  },
  {
    id: 'dimension_gaps',
    title: 'Dimension gaps',
    type: 'array',
    description: 'One entry per dimension not at \'success\': { dimension, reason } - names exactly what is missing or failing, never guessed or filled in.',
  },
  {
    id: 'quality_score',
    title: 'Quality score',
    type: 'object',
    description: '{ dimensions_total, dimensions_success, dimensions_partial, dimensions_empty, percentage, status } - a mechanical checklist-coverage measurement across the 8 dimensions, never a conversion/ranking/performance prediction.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'The flattened union of the underlying keyword records\' source entries, for quick top-level access.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ listing_record, keyword_records } - the full underlying validated agent/core/listingContentModel.js and agent/core/seoResearchModel.js records this check was computed from, so every finding is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = LISTING_QUALITY_CHECK_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = LISTING_QUALITY_CHECK_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDimensionStatus() {
  const status = {};
  for (const dimension of LISTING_QUALITY_DIMENSIONS) {
    status[dimension] = 'empty';
  }
  return status;
}

function emptyQualityScore() {
  return {
    dimensions_total: LISTING_QUALITY_DIMENSIONS.length,
    dimensions_success: 0,
    dimensions_partial: 0,
    dimensions_empty: LISTING_QUALITY_DIMENSIONS.length,
    percentage: 0,
    status: 'empty',
  };
}

// Returns a blank Listing Quality Check record. No real check has run - callers
// (agent/core/listingQualityChecker.js) fill it in.
function createEmptyListingQualityCheck(subject_reference = '') {
  return {
    subject_reference,
    research_date: '',
    dimension_status: emptyDimensionStatus(),
    findings: [],
    recommendations: [],
    dimension_gaps: [],
    quality_score: emptyQualityScore(),
    source: [],
    specialized_records: { listing_record: null, keyword_records: [] },
  };
}

// Checks that a Listing Quality Check record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateListingQualityCheckShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = LISTING_QUALITY_CHECK_FIELDS.map((field) => field.id);
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
    for (const dimension of LISTING_QUALITY_DIMENSIONS) {
      if (!(dimension in status)) {
        errors.push(`dimension_status is missing dimension: ${dimension}`);
      }
    }
    for (const dimension of Object.keys(status)) {
      if (!LISTING_QUALITY_DIMENSIONS.includes(dimension)) {
        errors.push(`dimension_status has unexpected dimension: ${dimension}`);
      }
    }
    for (const [dimension, value] of Object.entries(status)) {
      if (!DIMENSION_STATUSES.includes(value)) {
        errors.push(`dimension_status.${dimension} must be one of: ${DIMENSION_STATUSES.join(', ')}`);
      }
    }
  }

  if (Array.isArray(record.dimension_gaps)) {
    record.dimension_gaps.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`dimension_gaps[${index}] must be an object`);
        return;
      }
      const subIds = Object.keys(entry);
      for (const key of DIMENSION_GAP_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`dimension_gaps[${index}] is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!DIMENSION_GAP_SUB_KEYS.includes(key)) errors.push(`dimension_gaps[${index}] has unexpected sub-field: ${key}`);
      }
    });
  }

  if ('quality_score' in record && typeof record.quality_score === 'object' && record.quality_score !== null) {
    const score = record.quality_score;
    const subIds = Object.keys(score);
    for (const key of QUALITY_SCORE_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`quality_score is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!QUALITY_SCORE_SUB_KEYS.includes(key)) errors.push(`quality_score has unexpected sub-field: ${key}`);
    }
    if ('status' in score && !DIMENSION_STATUSES.includes(score.status)) {
      errors.push(`quality_score.status must be one of: ${DIMENSION_STATUSES.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  LISTING_QUALITY_DIMENSIONS,
  DIMENSION_STATUSES,
  LISTING_QUALITY_CHECK_FIELDS,
  createEmptyListingQualityCheck,
  validateListingQualityCheckShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Listing Quality Check model (schema only):\n');
  LISTING_QUALITY_CHECK_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyListingQualityCheck('(no subject set)'), null, 2));
  console.log('\nquality_score is a mechanical checklist-coverage measurement only, never a conversion/ranking/performance prediction.');
}
