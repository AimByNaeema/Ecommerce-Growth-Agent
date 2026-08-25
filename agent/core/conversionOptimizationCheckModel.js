'use strict';

// The shape one Conversion Optimization Check result conforms to - the output of
// agent/core/conversionOptimizationChecker.js. Schema and a couple of pure helpers
// only, following the exact convention of every existing *Model.js file
// (createEmpty* + validate*Shape + CLI printer) - no checking/scoring logic lives
// here.
//
// CONVERSION_OPTIMIZATION_DIMENSIONS is the fixed set of 8 dimensions this result
// always reports on (the exact 8 named in the prompt this checker answers): product
// pages, landing pages, offers, CTA, trust signals, checkout friction, mobile
// experience, pricing presentation. Every result carries a status for all 8, whether
// or not real input exists for each - mirroring agent/core/seoQualityCheckModel.js's
// dimension_status convention: a structural, mechanical audit, never an invented
// judgment about design quality, persuasiveness, or an actual conversion-rate
// prediction.
//
// This is distinct from agent/core/analyticsModel.js's `conversion` snapshot category
// (a numeric-metrics pass-through, e.g. conversion_rate values) and from
// agent/core/marketingAgent.js's `conversion_opportunities` capability (which composes
// agent/core/growthOpportunityModel.js upsell/cross-sell/retention records) - this
// schema is a UX/structural CRO audit of a store's pages and checkout flow, a
// different concern from either.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 8
// dimensions' structural checks passed) - never a claim about actual conversion-rate
// impact. All 8 dimensions are weighted equally; no unjustified weighting scheme
// exists here (same convention as agent/core/seoQualityCheckModel.js's own header).
//
// prioritized_recommendations tags each recommendation with a fixed, documented
// SEVERITY_LEVELS tier (critical/high/medium/low) assigned per specific mechanical
// check in agent/core/conversionOptimizationChecker.js (e.g. "checkout requires
// account creation" is a well-documented cart-abandonment cause, tiered above "no
// compare-at price shown") - the same epistemic honesty
// agent/core/seoQualityChecker.js's conventional length-guideline constants already
// use: a labeled, conventional heuristic, never a per-instance invented business-impact
// estimate (no dollar amount, no percentage-lift claim).

const CONVERSION_OPTIMIZATION_DIMENSIONS = [
  'product_pages',
  'landing_pages',
  'offers',
  'cta',
  'trust_signals',
  'checkout_friction',
  'mobile_experience',
  'pricing_presentation',
];

const DIMENSION_STATUSES = ['empty', 'partial', 'success'];
const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low'];

const QUALITY_SCORE_SUB_KEYS = [
  'dimensions_total',
  'dimensions_success',
  'dimensions_partial',
  'dimensions_empty',
  'percentage',
  'status',
];
const DIMENSION_GAP_SUB_KEYS = ['dimension', 'reason'];
const PRIORITIZED_RECOMMENDATION_SUB_KEYS = ['dimension', 'recommendation', 'severity'];

const CONVERSION_OPTIMIZATION_CHECK_FIELDS = [
  {
    id: 'subject_reference',
    title: 'Subject reference',
    type: 'string',
    description: 'Which store/page/product this audit is about - never invented; comes only from explicit task requirements.',
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
    description: "One status per dimension in CONVERSION_OPTIMIZATION_DIMENSIONS - 'empty' (no evidence supplied, or every applicable check failed), 'partial' (some checks passed), or 'success' (every applicable check passed). A structural, mechanical audit, never an invented judgment.",
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Flattened, human-readable, per-dimension facts this check actually found (e.g. image counts, boolean presence checks) - each traceable to a concrete structural check, never a subjective opinion.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    type: 'array',
    description: 'Flattened, actionable suggestions, one per failed/partial check - always mechanically derived from a specific finding above, never invented independently. Nothing here executes or publishes anything - every suggestion requires a separate, human-approved action to apply to a real page.',
  },
  {
    id: 'prioritized_recommendations',
    title: 'Prioritized recommendations',
    type: 'array',
    description: '{ dimension, recommendation, severity } per flagged issue, sorted by a fixed severity tier (critical > high > medium > low, ties broken by dimension order then check order) - a mechanical, auditable prioritization, never a hidden judgment or invented impact estimate.',
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
    description: '{ dimensions_total, dimensions_success, dimensions_partial, dimensions_empty, percentage, status } - a mechanical checklist-coverage measurement across the 8 dimensions, never a conversion-rate prediction.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: 'The raw, per-dimension caller-supplied evidence objects this check was computed from (one key per dimension id, null when not supplied), so every finding is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = CONVERSION_OPTIMIZATION_CHECK_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = CONVERSION_OPTIMIZATION_CHECK_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDimensionStatus() {
  const status = {};
  for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
    status[dimension] = 'empty';
  }
  return status;
}

function emptyQualityScore() {
  return {
    dimensions_total: CONVERSION_OPTIMIZATION_DIMENSIONS.length,
    dimensions_success: 0,
    dimensions_partial: 0,
    dimensions_empty: CONVERSION_OPTIMIZATION_DIMENSIONS.length,
    percentage: 0,
    status: 'empty',
  };
}

function emptySpecializedRecords() {
  const records = {};
  for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
    records[dimension] = null;
  }
  return records;
}

// Returns a blank Conversion Optimization Check record. No real check has run -
// callers (agent/core/conversionOptimizationChecker.js) fill it in.
function createEmptyConversionOptimizationCheck(subject_reference = '') {
  return {
    subject_reference,
    research_date: '',
    dimension_status: emptyDimensionStatus(),
    findings: [],
    recommendations: [],
    prioritized_recommendations: [],
    dimension_gaps: [],
    quality_score: emptyQualityScore(),
    specialized_records: emptySpecializedRecords(),
  };
}

// Checks that a Conversion Optimization Check record has exactly the expected keys,
// with the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateConversionOptimizationCheckShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = CONVERSION_OPTIMIZATION_CHECK_FIELDS.map((field) => field.id);
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
    for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
      if (!(dimension in status)) {
        errors.push(`dimension_status is missing dimension: ${dimension}`);
      }
    }
    for (const dimension of Object.keys(status)) {
      if (!CONVERSION_OPTIMIZATION_DIMENSIONS.includes(dimension)) {
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

  if (Array.isArray(record.prioritized_recommendations)) {
    record.prioritized_recommendations.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`prioritized_recommendations[${index}] must be an object`);
        return;
      }
      const subIds = Object.keys(entry);
      for (const key of PRIORITIZED_RECOMMENDATION_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`prioritized_recommendations[${index}] is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!PRIORITIZED_RECOMMENDATION_SUB_KEYS.includes(key)) {
          errors.push(`prioritized_recommendations[${index}] has unexpected sub-field: ${key}`);
        }
      }
      if ('dimension' in entry && !CONVERSION_OPTIMIZATION_DIMENSIONS.includes(entry.dimension)) {
        errors.push(`prioritized_recommendations[${index}].dimension must be one of: ${CONVERSION_OPTIMIZATION_DIMENSIONS.join(', ')}`);
      }
      if ('severity' in entry && !SEVERITY_LEVELS.includes(entry.severity)) {
        errors.push(`prioritized_recommendations[${index}].severity must be one of: ${SEVERITY_LEVELS.join(', ')}`);
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

  if ('specialized_records' in record && typeof record.specialized_records === 'object' && record.specialized_records !== null) {
    const records = record.specialized_records;
    const subIds = Object.keys(records);
    for (const dimension of CONVERSION_OPTIMIZATION_DIMENSIONS) {
      if (!subIds.includes(dimension)) errors.push(`specialized_records is missing dimension: ${dimension}`);
    }
    for (const dimension of subIds) {
      if (!CONVERSION_OPTIMIZATION_DIMENSIONS.includes(dimension)) {
        errors.push(`specialized_records has unexpected dimension: ${dimension}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  CONVERSION_OPTIMIZATION_DIMENSIONS,
  DIMENSION_STATUSES,
  SEVERITY_LEVELS,
  CONVERSION_OPTIMIZATION_CHECK_FIELDS,
  createEmptyConversionOptimizationCheck,
  validateConversionOptimizationCheckShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Conversion Optimization Check model (schema only):\n');
  CONVERSION_OPTIMIZATION_CHECK_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyConversionOptimizationCheck('(no subject set)'), null, 2));
  console.log('\nquality_score is a mechanical checklist-coverage measurement only, never a conversion-rate prediction.');
}
