'use strict';

// The shape one SEO Quality Check result conforms to - the output of
// agent/core/seoQualityChecker.js. Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (createEmpty* +
// validate*Shape + CLI printer) - no checking/scoring logic lives here.
//
// SEO_QUALITY_DIMENSIONS is the fixed set of 9 dimensions this result always reports
// on: keyword targeting, search intent, title, metadata, content quality, product
// accuracy, missing information, over-optimization, internal linking opportunities.
// Every result carries a status for all 9, whether or not real input exists for each -
// mirroring agent/core/productOpportunityScoreModel.js's dimension_status convention:
// a structural, mechanical audit, never an invented judgment about writing quality,
// tone, persuasiveness, or actual ranking impact.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 9
// dimensions' structural checks passed) - never a claim about SEO performance or
// ranking. All 9 dimensions are weighted equally; no unjustified weighting scheme
// exists here. Distinct from agent/core/productOpportunityScoreModel.js's
// coverage_score (which measures evidence *availability*, not check *pass/fail*) -
// same shape, different meaning, intentionally not shared/reused since the two
// measure different things.

const SEO_QUALITY_DIMENSIONS = [
  'keyword_targeting',
  'search_intent',
  'title',
  'metadata',
  'content_quality',
  'product_accuracy',
  'missing_information',
  'over_optimization',
  'internal_linking_opportunities',
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

const SEO_QUALITY_CHECK_FIELDS = [
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
    description: "One status per dimension in SEO_QUALITY_DIMENSIONS - 'empty' (nothing to check, or every check failed), 'partial' (some checks passed), or 'success' (every applicable check passed). A structural, mechanical audit, never an invented judgment.",
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Flattened, human-readable, per-dimension facts this check actually found (e.g. character counts, keyword presence/absence) - each traceable to a concrete structural check, never a subjective opinion.',
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
    description: '{ dimensions_total, dimensions_success, dimensions_partial, dimensions_empty, percentage, status } - a mechanical checklist-coverage measurement across the 9 dimensions, never a ranking or performance prediction.',
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
    description: '{ listing_record, keyword_records } - the full underlying validated agent/core/listingOptimizationModel.js and agent/core/seoResearchModel.js records this check was computed from, so every finding is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = SEO_QUALITY_CHECK_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = SEO_QUALITY_CHECK_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDimensionStatus() {
  const status = {};
  for (const dimension of SEO_QUALITY_DIMENSIONS) {
    status[dimension] = 'empty';
  }
  return status;
}

function emptyQualityScore() {
  return {
    dimensions_total: SEO_QUALITY_DIMENSIONS.length,
    dimensions_success: 0,
    dimensions_partial: 0,
    dimensions_empty: SEO_QUALITY_DIMENSIONS.length,
    percentage: 0,
    status: 'empty',
  };
}

// Returns a blank SEO Quality Check record. No real check has run - callers
// (agent/core/seoQualityChecker.js) fill it in.
function createEmptySeoQualityCheck(subject_reference = '') {
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

// Checks that an SEO Quality Check record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateSeoQualityCheckShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SEO_QUALITY_CHECK_FIELDS.map((field) => field.id);
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
    for (const dimension of SEO_QUALITY_DIMENSIONS) {
      if (!(dimension in status)) {
        errors.push(`dimension_status is missing dimension: ${dimension}`);
      }
    }
    for (const dimension of Object.keys(status)) {
      if (!SEO_QUALITY_DIMENSIONS.includes(dimension)) {
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
  SEO_QUALITY_DIMENSIONS,
  DIMENSION_STATUSES,
  SEO_QUALITY_CHECK_FIELDS,
  createEmptySeoQualityCheck,
  validateSeoQualityCheckShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - SEO Quality Check model (schema only):\n');
  SEO_QUALITY_CHECK_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptySeoQualityCheck('(no subject set)'), null, 2));
  console.log('\nquality_score is a mechanical checklist-coverage measurement only, never a ranking or performance prediction.');
}
