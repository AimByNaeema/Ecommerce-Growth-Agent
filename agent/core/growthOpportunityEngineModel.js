'use strict';

// The shape of one ranked growth opportunity record - the output of
// agent/core/growthOpportunityEngine.js's cross-domain ranking pass. Schema and a
// couple of pure helpers only, following the exact convention of every existing
// *Model.js file (field list + createEmpty* + validate*Shape + CLI printer) - no
// ranking/scoring logic lives here.
//
// This is distinct from agent/core/growthOpportunityModel.js, which is a narrower,
// product-anchored schema for one of five relationship types (upsell/cross-sell/
// retention/repeat-purchase/re-engagement). This model instead spans the nine growth
// surfaces named in the prompt this engine answers - products, pricing, listings, seo,
// marketing, social, advertising, conversion, retention - and is deliberately generic
// across all of them, not product-anchored.
//
// OPPORTUNITY_CATEGORIES is the fixed set of 9 domains a candidate must be tagged
// with. IMPACT_CATEGORIES is a fixed, standard e-commerce taxonomy for what business
// dimension an opportunity is expected to affect - both are closed enums; the engine
// never accepts or invents a value outside them. CONFIDENCE_MULTIPLIERS documents the
// exact ICE-style weighting (impact x confidence) the engine uses to compute
// rank_score - confidence itself reuses agent/core/researchRecordModel.js's
// CONFIDENCE_LEVELS enum rather than redefining it, following this project's standard
// cross-schema reuse precedent. approval_requirement.classification reuses the 4 ids
// from approvals/approvalArchitecture.js's ACTION_CLASSIFICATIONS - no new approval
// classification system is invented here.
//
// rank_score is a mechanical, auditable ranking score (impact magnitude x confidence
// multiplier) - never a hidden or subjective judgment of "goodness"; the exact formula
// is documented in agent/core/growthOpportunityEngine.js's `methodology` output field.

const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { ACTION_CLASSIFICATIONS } = require('../../approvals/approvalArchitecture');

const OPPORTUNITY_CATEGORIES = [
  'products',
  'pricing',
  'listings',
  'seo',
  'marketing',
  'social',
  'advertising',
  'conversion',
  'retention',
];

const IMPACT_CATEGORIES = [
  'revenue',
  'margin',
  'conversion_rate',
  'customer_retention',
  'customer_acquisition',
  'traffic_visibility',
  'operational_efficiency',
  'brand_trust',
];

const ACTION_CLASSIFICATION_IDS = ACTION_CLASSIFICATIONS.map((entry) => entry.id);

// Confidence -> ICE-score multiplier. unassessed contributes nothing to rank_score,
// since no confidence has actually been asserted for that opportunity.
const CONFIDENCE_MULTIPLIERS = {
  unassessed: 0,
  low: 0.33,
  medium: 0.66,
  high: 1,
};

const APPROVAL_REQUIREMENT_SUB_KEYS = ['classification', 'title', 'description', 'requires_human_approval'];

const RANKED_OPPORTUNITY_FIELDS = [
  {
    id: 'category',
    title: 'Category',
    type: `enum: ${OPPORTUNITY_CATEGORIES.join(' | ')}`,
    description: 'Which growth surface this opportunity belongs to - never invented, always caller-asserted.',
  },
  {
    id: 'opportunity',
    title: 'Opportunity',
    type: 'string',
    description: 'A short description of the growth opportunity - caller-supplied, never invented.',
  },
  {
    id: 'reason',
    title: 'Reason',
    type: 'string',
    description: 'Why this is an opportunity - grounded in the evidence field, caller-supplied.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'Real data backing the reason - references, not full documents.',
  },
  {
    id: 'expected_impact_category',
    title: 'Expected impact category',
    type: `enum: ${IMPACT_CATEGORIES.join(' | ')}`,
    description: 'Which business dimension this opportunity is expected to affect.',
  },
  {
    id: 'expected_impact_magnitude',
    title: 'Expected impact magnitude',
    type: 'number',
    description: 'A caller-asserted estimate of the opportunity\'s size, 1 (smallest) to 5 (largest) - required, never defaulted or invented.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much this opportunity is trusted - caller-asserted, then honesty-graded (forced to unassessed if evidence is empty; see agent/core/growthOpportunityEngine.js).',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this opportunity has been checked against real, configured data - downgraded to unverified if asserted verified with no evidence.',
  },
  {
    id: 'required_action',
    title: 'Required action',
    type: 'string',
    description: 'The suggested action for a human to consider - a suggestion only; nothing here executes it.',
  },
  {
    id: 'approval_requirement',
    title: 'Approval requirement',
    type: 'object',
    description: '{ classification, title, description, requires_human_approval } - looked up from approvals/approvalArchitecture.js\'s ACTION_CLASSIFICATIONS via the caller-supplied classification id.',
  },
  {
    id: 'rank',
    title: 'Rank',
    type: 'number',
    description: '1-based position after ranking (1 = highest rank_score).',
  },
  {
    id: 'rank_score',
    title: 'Rank score',
    type: 'number',
    description: 'expected_impact_magnitude x CONFIDENCE_MULTIPLIERS[confidence] - a mechanical, auditable score, never a hidden judgment.',
  },
];

const ARRAY_FIELD_IDS = RANKED_OPPORTUNITY_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = RANKED_OPPORTUNITY_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

function emptyApprovalRequirement() {
  return { classification: '', title: '', description: '', requires_human_approval: false };
}

// Returns a blank ranked growth opportunity record conforming to
// RANKED_OPPORTUNITY_FIELDS. No real opportunity data - callers (
// agent/core/growthOpportunityEngine.js) fill it in from caller-supplied input.
function createEmptyRankedGrowthOpportunity(category = '', opportunity = '') {
  return {
    category,
    opportunity,
    reason: '',
    evidence: [],
    expected_impact_category: '',
    expected_impact_magnitude: 0,
    confidence: 'unassessed',
    verification_status: 'unverified',
    required_action: '',
    approval_requirement: emptyApprovalRequirement(),
    rank: 0,
    rank_score: 0,
  };
}

// Checks that a ranked growth opportunity record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateRankedGrowthOpportunityShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = RANKED_OPPORTUNITY_FIELDS.map((field) => field.id);
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

  // Empty string is the honest "not yet set" sentinel for these two fields (there is
  // no natural "unclassified" member in either fixed 9/8-value enum) - only a
  // non-empty value is checked against the enum, matching the same truthy-guard
  // pattern used below for approval_requirement.classification.
  if (record.category && !OPPORTUNITY_CATEGORIES.includes(record.category)) {
    errors.push(`category must be one of: ${OPPORTUNITY_CATEGORIES.join(', ')}`);
  }
  if (record.expected_impact_category && !IMPACT_CATEGORIES.includes(record.expected_impact_category)) {
    errors.push(`expected_impact_category must be one of: ${IMPACT_CATEGORIES.join(', ')}`);
  }
  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (
    'verification_status' in record &&
    !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)
  ) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  if ('approval_requirement' in record && typeof record.approval_requirement === 'object' && record.approval_requirement !== null) {
    const approval = record.approval_requirement;
    const subIds = Object.keys(approval);
    for (const key of APPROVAL_REQUIREMENT_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`approval_requirement is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!APPROVAL_REQUIREMENT_SUB_KEYS.includes(key)) errors.push(`approval_requirement has unexpected sub-field: ${key}`);
    }
    if ('classification' in approval && approval.classification && !ACTION_CLASSIFICATION_IDS.includes(approval.classification)) {
      errors.push(`approval_requirement.classification must be one of: ${ACTION_CLASSIFICATION_IDS.join(', ')}`);
    }
    if ('requires_human_approval' in approval && typeof approval.requires_human_approval !== 'boolean') {
      errors.push('approval_requirement.requires_human_approval must be a boolean');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  OPPORTUNITY_CATEGORIES,
  IMPACT_CATEGORIES,
  CONFIDENCE_MULTIPLIERS,
  APPROVAL_REQUIREMENT_SUB_KEYS,
  RANKED_OPPORTUNITY_FIELDS,
  createEmptyRankedGrowthOpportunity,
  validateRankedGrowthOpportunityShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - growth opportunity engine model (schema only):\n');
  RANKED_OPPORTUNITY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyRankedGrowthOpportunity('(no category set)', '(no opportunity set)'), null, 2));
  console.log('\nNo opportunity, reason, evidence, or impact estimate is ever invented - rank_score is a mechanical, auditable formula, never a hidden judgment.');
}
