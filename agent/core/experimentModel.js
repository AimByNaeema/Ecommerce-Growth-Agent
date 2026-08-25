'use strict';

// The shape of one Experiment record - a reusable A/B-test lifecycle schema used
// identically across all 8 growth surfaces named in the prompt this answers: products,
// pricing, listing, SEO, offers, marketing, social, advertising. Schema and a couple of
// pure helpers only, following the exact convention of every existing *Model.js file
// (field list + createEmpty* + validate*Shape + CLI printer) - the lifecycle logic
// itself (creating, running, deciding an experiment) lives in
// agent/core/experimentEngine.js.
//
// EXPERIMENT_DOMAINS is the fixed set of 8 growth surfaces an experiment can be tagged
// with, reusing the same "one schema, generic `domain` enum" pattern
// agent/core/growthOpportunityEngineModel.js's OPPORTUNITY_CATEGORIES already
// establishes - no per-domain experiment files.
//
// EXPERIMENT_STATUSES is a temporal lifecycle (draft -> running -> completed), always
// mechanically derived by agent/core/experimentEngine.js from what evidence has
// actually been supplied (start_date presence, then result presence) - never
// caller-set directly, the same "status is derived, not asserted" discipline
// agent/core/salesGrowthPlanModel.js's domain_status and
// agent/core/conversionOptimizationCheckModel.js's dimension_status already use,
// adapted from a coverage checklist to a run lifecycle.
//
// DECISION_OUTCOMES covers the possible calls a human can make once an experiment has
// evidence. `ship_variant` and `keep_control` are the two conclusive,
// production-affecting outcomes - agent/core/experimentEngine.js's decideExperiment()
// downgrades either one to 'inconclusive' (and records why in `limitations`) if
// asserted before `status` is 'completed', the same downgrade-and-record honesty guard
// agent/core/salesGrowthPlanner.js's DOWNGRADED_SEVERITIES already applies to
// bottleneck severity. `decision.approval_requirement` reuses
// agent/core/growthOpportunityEngineModel.js's exact APPROVAL_REQUIREMENT_SUB_KEYS
// shape (imported, not duplicated) so every decision is tagged with one of
// approvals/approvalArchitecture.js's 4 classifications via a caller-supplied
// actionClassification, exactly like every recommended_action in
// agent/core/salesGrowthPlanner.js already is.
//
// `result` is always caller-supplied fact, never computed or predicted by this
// project - there is no statistics library here and no invented significance
// calculation, the same "never invent a business-impact number" rule
// agent/core/conversionOptimizationCheckModel.js's quality_score and
// agent/core/growthOpportunityEngineModel.js's rank_score already establish for other
// kinds of numbers.
//
// Distinct from agent/core/salesGrowthPlanModel.js's existing `experiment_ideas` field
// - that field is a one-line idea stub ({domain, hypothesis, test_description,
// expected_outcome, evidence}) with no control/variant, no duration, no result, and no
// decision. This module is the fuller run-to-decision lifecycle record; the existing
// field is left untouched and out of scope here.

const { APPROVAL_REQUIREMENT_SUB_KEYS } = require('./growthOpportunityEngineModel');
const { ACTION_CLASSIFICATIONS } = require('../../approvals/approvalArchitecture');

const EXPERIMENT_DOMAINS = ['products', 'pricing', 'listing', 'seo', 'offers', 'marketing', 'social', 'advertising'];
const EXPERIMENT_STATUSES = ['draft', 'running', 'completed'];
const DECISION_OUTCOMES = ['not_yet_decided', 'ship_variant', 'keep_control', 'iterate', 'inconclusive'];
const ACTION_CLASSIFICATION_IDS = ACTION_CLASSIFICATIONS.map((entry) => entry.id);

const CONTROL_VARIANT_SUB_KEYS = ['description', 'evidence'];
const DURATION_SUB_KEYS = ['start_date', 'end_date', 'planned_duration_days'];
const RESULT_SUB_KEYS = ['control_value', 'variant_value', 'observed_effect', 'statistical_significance', 'evidence'];
const DECISION_SUB_KEYS = ['outcome', 'rationale', 'evidence', 'approval_requirement'];

const EXPERIMENT_FIELDS = [
  {
    id: 'experiment_id',
    title: 'Experiment ID',
    type: 'string',
    description: 'Caller-supplied unique identifier for this experiment - never generated or guessed by this module.',
  },
  {
    id: 'domain',
    title: 'Domain',
    type: `enum: ${EXPERIMENT_DOMAINS.join(' | ')}`,
    description: 'Which growth surface this experiment belongs to - never invented, always caller-asserted.',
  },
  {
    id: 'subject_reference',
    title: 'Subject reference',
    type: 'string',
    description: 'Which store/page/product/campaign this experiment is about - never invented; comes only from explicit task requirements.',
  },
  {
    id: 'hypothesis',
    title: 'Hypothesis',
    type: 'string',
    description: 'What change is expected to produce what effect, and why - caller-supplied, never invented.',
  },
  {
    id: 'variable',
    title: 'Variable',
    type: 'string',
    description: 'The single independent variable being tested (e.g. "checkout step count", "headline copy", "price point").',
  },
  {
    id: 'control',
    title: 'Control',
    type: 'object',
    description: '{ description, evidence } - the current/baseline experience the variant is tested against.',
  },
  {
    id: 'variant',
    title: 'Variant',
    type: 'object',
    description: '{ description, evidence } - the changed experience being tested against the control.',
  },
  {
    id: 'target_metric',
    title: 'Target metric',
    type: 'string',
    description: 'The single metric this experiment is measured by (e.g. "conversion_rate", "add_to_cart_rate").',
  },
  {
    id: 'duration',
    title: 'Duration',
    type: 'object',
    description: '{ start_date, end_date, planned_duration_days } - start_date/end_date are ISO dates, filled in as the experiment actually progresses; planned_duration_days is the caller-asserted intended run length.',
  },
  {
    id: 'success_criteria',
    title: 'Success criteria',
    type: 'string',
    description: 'The caller-defined bar the result must clear for this experiment to be a win - never inferred or invented.',
  },
  {
    id: 'status',
    title: 'Status',
    type: `enum: ${EXPERIMENT_STATUSES.join(' | ')}`,
    description: "Mechanically derived by agent/core/experimentEngine.js from what evidence exists - 'draft' (not started), 'running' (started, no result yet), or 'completed' (result recorded). Never caller-set directly.",
  },
  {
    id: 'result',
    title: 'Result',
    type: 'object',
    description: '{ control_value, variant_value, observed_effect, statistical_significance, evidence } - always caller-supplied fact; this module never computes or predicts a result.',
  },
  {
    id: 'decision',
    title: 'Decision',
    type: 'object',
    description: "{ outcome, rationale, evidence, approval_requirement } - outcome is one of DECISION_OUTCOMES; ship_variant/keep_control are honesty-downgraded to 'inconclusive' if asserted before status is 'completed'.",
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Caveats and honesty-guard downgrades applied while composing this experiment record.',
  },
  {
    id: 'created_date',
    title: 'Created date',
    type: 'string',
    description: 'When this experiment record was last composed (ISO date).',
  },
];

const ARRAY_FIELD_IDS = EXPERIMENT_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = EXPERIMENT_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

function emptyControlVariant() {
  return { description: '', evidence: [] };
}

function emptyDuration() {
  return { start_date: '', end_date: '', planned_duration_days: 0 };
}

function emptyResult() {
  return { control_value: '', variant_value: '', observed_effect: '', statistical_significance: '', evidence: [] };
}

function emptyApprovalRequirement() {
  return { classification: '', title: '', description: '', requires_human_approval: false };
}

function emptyDecision() {
  return { outcome: 'not_yet_decided', rationale: '', evidence: [], approval_requirement: emptyApprovalRequirement() };
}

// Returns a blank Experiment record conforming to EXPERIMENT_FIELDS. No real
// experiment data - callers (agent/core/experimentEngine.js) fill it in.
function createEmptyExperiment(subject_reference = '', domain = '') {
  return {
    experiment_id: '',
    domain,
    subject_reference,
    hypothesis: '',
    variable: '',
    control: emptyControlVariant(),
    variant: emptyControlVariant(),
    target_metric: '',
    duration: emptyDuration(),
    success_criteria: '',
    status: 'draft',
    result: emptyResult(),
    decision: emptyDecision(),
    limitations: [],
    created_date: '',
  };
}

function validateSubKeyedObject(value, pathLabel, expectedSubKeys, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  const subIds = Object.keys(value);
  for (const key of expectedSubKeys) {
    if (!subIds.includes(key)) errors.push(`${pathLabel} is missing sub-field: ${key}`);
  }
  for (const key of subIds) {
    if (!expectedSubKeys.includes(key)) errors.push(`${pathLabel} has unexpected sub-field: ${key}`);
  }
}

function validateApprovalRequirementShape(approval, pathLabel, errors) {
  validateSubKeyedObject(approval, pathLabel, APPROVAL_REQUIREMENT_SUB_KEYS, errors);
  if (!approval || typeof approval !== 'object') return;
  if ('classification' in approval && approval.classification && !ACTION_CLASSIFICATION_IDS.includes(approval.classification)) {
    errors.push(`${pathLabel}.classification must be one of: ${ACTION_CLASSIFICATION_IDS.join(', ')}`);
  }
  if ('requires_human_approval' in approval && typeof approval.requires_human_approval !== 'boolean') {
    errors.push(`${pathLabel}.requires_human_approval must be a boolean`);
  }
}

// Checks that an Experiment record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateExperimentShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = EXPERIMENT_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  for (const id of OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if ('domain' in record && record.domain && !EXPERIMENT_DOMAINS.includes(record.domain)) {
    errors.push(`domain must be one of: ${EXPERIMENT_DOMAINS.join(', ')}`);
  }
  if ('status' in record && !EXPERIMENT_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${EXPERIMENT_STATUSES.join(', ')}`);
  }

  if (record.control && typeof record.control === 'object' && !Array.isArray(record.control)) {
    validateSubKeyedObject(record.control, 'control', CONTROL_VARIANT_SUB_KEYS, errors);
    if ('evidence' in record.control && !Array.isArray(record.control.evidence)) {
      errors.push('control.evidence must be an array');
    }
  }
  if (record.variant && typeof record.variant === 'object' && !Array.isArray(record.variant)) {
    validateSubKeyedObject(record.variant, 'variant', CONTROL_VARIANT_SUB_KEYS, errors);
    if ('evidence' in record.variant && !Array.isArray(record.variant.evidence)) {
      errors.push('variant.evidence must be an array');
    }
  }
  if (record.duration && typeof record.duration === 'object' && !Array.isArray(record.duration)) {
    validateSubKeyedObject(record.duration, 'duration', DURATION_SUB_KEYS, errors);
  }
  if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
    validateSubKeyedObject(record.result, 'result', RESULT_SUB_KEYS, errors);
    if ('evidence' in record.result && !Array.isArray(record.result.evidence)) {
      errors.push('result.evidence must be an array');
    }
  }
  if (record.decision && typeof record.decision === 'object' && !Array.isArray(record.decision)) {
    validateSubKeyedObject(record.decision, 'decision', DECISION_SUB_KEYS, errors);
    if ('outcome' in record.decision && !DECISION_OUTCOMES.includes(record.decision.outcome)) {
      errors.push(`decision.outcome must be one of: ${DECISION_OUTCOMES.join(', ')}`);
    }
    if ('evidence' in record.decision && !Array.isArray(record.decision.evidence)) {
      errors.push('decision.evidence must be an array');
    }
    if ('approval_requirement' in record.decision) {
      validateApprovalRequirementShape(record.decision.approval_requirement, 'decision.approval_requirement', errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  EXPERIMENT_DOMAINS,
  EXPERIMENT_STATUSES,
  DECISION_OUTCOMES,
  CONTROL_VARIANT_SUB_KEYS,
  DURATION_SUB_KEYS,
  RESULT_SUB_KEYS,
  DECISION_SUB_KEYS,
  EXPERIMENT_FIELDS,
  createEmptyExperiment,
  validateExperimentShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Experiment model (schema only):\n');
  EXPERIMENT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyExperiment('(no subject set)', 'pricing'), null, 2));
  console.log('\nresult and decision are always caller-supplied fact, never computed or predicted by this module.');
}
