'use strict';

// The shape of one Sales Growth Plan - a cross-domain synthesis combining product,
// customer, analytics, SEO, marketing, social, and advertising data into one report:
// current state, bottlenecks, opportunities, recommended actions, KPIs, experiment
// ideas, and approval requirements. Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (field list +
// createEmpty* + validate*Shape + CLI printer) - the synthesis logic itself lives in
// agent/core/salesGrowthPlanner.js.
//
// This is the first module in the codebase that combines real structured records
// from MULTIPLE specialist domains into one report (every existing module -
// agent/core/growthOpportunityEngine.js included - either stays within one
// specialist's domain, or is domain-agnostic by schema without importing another
// domain's real data). It follows agent/core/growthOpportunityEngine.js's standalone
// precedent: the caller (a workflow, the orchestrator, or a human) gathers structured
// evidence from each domain first and hands it in - this module never calls another
// agent, fetches a live page, or invents a business fact.
//
// SALES_GROWTH_PLAN_DOMAINS is the fixed set of 7 domains the plan covers, in the
// order requested. DOMAIN_STATUSES reuses agent/core/conversionOptimizationCheckModel.js's
// exact 3-state convention (empty/partial/success) rather than redefining it -
// 'empty' is reserved strictly for "no evidence supplied for this domain", never
// conflated with "evidence supplied and unfavorable". SEVERITY_LEVELS is reused from
// the same module for bottleneck tiers.
//
// `current_state` reuses agent/core/analyticsModel.js's exact per-category sub-shape
// (summary/actual_metrics/calculated_metrics/estimated_metrics/verification_status) -
// the same actual/calculated/estimated honesty split every analytics category already
// uses, keyed by domain instead of by analytics category.
//
// `opportunities` is a direct pass-through of agent/core/growthOpportunityEngine.js's
// ranked output (RANKED_OPPORTUNITY_FIELDS-shaped records) - this module does not
// reimplement ICE-style ranking; it composes it. `bottlenecks`, `recommended_actions`,
// `kpis`, and `experiment_ideas` are always caller-supplied hypotheses/facts - the
// same "never invent an explanation, an action, or a target value" rule
// agent/core/insightModel.js's possible_cause/opportunity/recommendation fields
// already establish. `recommended_actions` reuses the same
// actionClassification -> approval_requirement pattern as growthOpportunityEngine.js
// (agent/core/growthOpportunityEngine.js's buildApprovalRequirement, reused not
// duplicated) so every action is tagged with one of approvals/approvalArchitecture.js's
// 4 classifications. `approval_requirements` is a mechanical rollup of every
// opportunity/recommended_action that requires human approval - never a separate,
// independently-asserted judgment.
//
// `domain_coverage` is a mechanical checklist-coverage percentage across the 7
// domains, mirroring agent/core/conversionOptimizationCheckModel.js's quality_score -
// never a performance/growth-rate prediction.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { CATEGORY_SUB_KEYS, METRICS_SUB_KEYS } = require('./analyticsModel');
const { DIMENSION_STATUSES, SEVERITY_LEVELS } = require('./conversionOptimizationCheckModel');
const { APPROVAL_REQUIREMENT_SUB_KEYS } = require('./growthOpportunityEngineModel');
const { ACTION_CLASSIFICATIONS } = require('../../approvals/approvalArchitecture');

const SALES_GROWTH_PLAN_DOMAINS = ['product', 'customer', 'analytics', 'seo', 'marketing', 'social', 'advertising'];
const DOMAIN_STATUSES = DIMENSION_STATUSES;
const ACTION_CLASSIFICATION_IDS = ACTION_CLASSIFICATIONS.map((entry) => entry.id);
const APPROVAL_SOURCE_TYPES = ['opportunity', 'recommended_action'];

const BOTTLENECK_SUB_KEYS = ['domain', 'description', 'evidence', 'severity'];
const RECOMMENDED_ACTION_SUB_KEYS = ['domain', 'action', 'rationale', 'evidence', 'approval_requirement'];
const KPI_SUB_KEYS = ['domain', 'metric', 'current_value', 'target_value', 'rationale'];
const EXPERIMENT_IDEA_SUB_KEYS = ['domain', 'hypothesis', 'test_description', 'expected_outcome', 'evidence'];
const APPROVAL_REQUIREMENT_SUMMARY_SUB_KEYS = ['source', 'reference', 'classification', 'title', 'description', 'requires_human_approval'];
const DOMAIN_GAP_SUB_KEYS = ['domain', 'reason'];
const DOMAIN_COVERAGE_SUB_KEYS = ['domains_total', 'domains_success', 'domains_partial', 'domains_empty', 'percentage', 'status'];

const SALES_GROWTH_PLAN_FIELDS = [
  {
    id: 'subject_reference',
    title: 'Subject reference',
    type: 'string',
    description: 'Which store/business this plan is about - never invented; comes only from explicit task requirements.',
  },
  {
    id: 'plan_date',
    title: 'Plan date',
    type: 'string',
    description: 'When this plan was generated (ISO date).',
  },
  {
    id: 'domain_status',
    title: 'Domain status',
    type: 'object',
    description: 'One of empty/partial/success per domain, based on whether current_state evidence was supplied for it.',
  },
  {
    id: 'current_state',
    title: 'Current state',
    type: 'object',
    description: 'Per-domain current state: { summary, actual_metrics, calculated_metrics, estimated_metrics, verification_status } - the same shape as agent/core/analyticsModel.js\'s categories, keyed by domain.',
  },
  {
    id: 'bottlenecks',
    title: 'Bottlenecks',
    type: 'array',
    description: 'Caller-supplied growth bottlenecks: { domain, description, evidence, severity } - never inferred from a threshold; severity is honesty-graded down without evidence (see agent/core/salesGrowthPlanner.js).',
  },
  {
    id: 'opportunities',
    title: 'Opportunities',
    type: 'array',
    description: 'Ranked growth opportunity records - a direct pass-through of agent/core/growthOpportunityEngine.js\'s rankGrowthOpportunities() output.',
  },
  {
    id: 'recommended_actions',
    title: 'Recommended actions',
    type: 'array',
    description: 'Caller-supplied next steps: { domain, action, rationale, evidence, approval_requirement } - a suggestion only; nothing here executes it.',
  },
  {
    id: 'kpis',
    title: 'KPIs',
    type: 'array',
    description: 'Caller-supplied metrics to track: { domain, metric, current_value, target_value, rationale } - never an invented target.',
  },
  {
    id: 'experiment_ideas',
    title: 'Experiment ideas',
    type: 'array',
    description: 'Caller-supplied test hypotheses: { domain, hypothesis, test_description, expected_outcome, evidence } - never invented from nothing.',
  },
  {
    id: 'approval_requirements',
    title: 'Approval requirements',
    type: 'array',
    description: 'Mechanical rollup of every opportunity/recommended_action that requires human approval: { source, reference, classification, title, description, requires_human_approval }.',
  },
  {
    id: 'domain_gaps',
    title: 'Domain gaps',
    type: 'array',
    description: 'One entry per domain not at success status: { domain, reason }.',
  },
  {
    id: 'domain_coverage',
    title: 'Domain coverage',
    type: 'object',
    description: 'Mechanical checklist-coverage across the 7 domains - never a growth-rate prediction.',
  },
  {
    id: 'methodology',
    title: 'Methodology',
    type: 'string',
    description: 'Plain-English explanation of how this plan was composed, for auditability.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Caveats and honesty-guard downgrades applied while composing this plan.',
  },
];

const ARRAY_FIELD_IDS = SALES_GROWTH_PLAN_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = SALES_GROWTH_PLAN_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

function emptyCurrentStateForDomain() {
  return {
    summary: '',
    actual_metrics: [],
    calculated_metrics: [],
    estimated_metrics: [],
    verification_status: 'unverified',
  };
}

function emptyCurrentState() {
  const state = {};
  for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
    state[domain] = emptyCurrentStateForDomain();
  }
  return state;
}

function emptyDomainStatus() {
  const status = {};
  for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
    status[domain] = 'empty';
  }
  return status;
}

function emptyDomainCoverage() {
  return {
    domains_total: SALES_GROWTH_PLAN_DOMAINS.length,
    domains_success: 0,
    domains_partial: 0,
    domains_empty: SALES_GROWTH_PLAN_DOMAINS.length,
    percentage: 0,
    status: 'empty',
  };
}

// Returns a blank Sales Growth Plan conforming to SALES_GROWTH_PLAN_FIELDS. No real
// business data - callers (agent/core/salesGrowthPlanner.js) fill it in from
// caller-supplied evidence.
function createEmptySalesGrowthPlan(subject_reference = '') {
  return {
    subject_reference,
    plan_date: '',
    domain_status: emptyDomainStatus(),
    current_state: emptyCurrentState(),
    bottlenecks: [],
    opportunities: [],
    recommended_actions: [],
    kpis: [],
    experiment_ideas: [],
    approval_requirements: [],
    domain_gaps: [],
    domain_coverage: emptyDomainCoverage(),
    methodology: '',
    limitations: [],
  };
}

function validateSubKeyedEntries(entries, fieldId, expectedSubKeys, errors) {
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${fieldId}[${index}] must be an object`);
      return;
    }
    const subIds = Object.keys(entry);
    for (const key of expectedSubKeys) {
      if (!subIds.includes(key)) errors.push(`${fieldId}[${index}] is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!expectedSubKeys.includes(key)) errors.push(`${fieldId}[${index}] has unexpected sub-field: ${key}`);
    }
  });
}

function validateApprovalRequirementShape(approval, pathLabel, errors) {
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  const subIds = Object.keys(approval);
  for (const key of APPROVAL_REQUIREMENT_SUB_KEYS) {
    if (!subIds.includes(key)) errors.push(`${pathLabel} is missing sub-field: ${key}`);
  }
  for (const key of subIds) {
    if (!APPROVAL_REQUIREMENT_SUB_KEYS.includes(key)) errors.push(`${pathLabel} has unexpected sub-field: ${key}`);
  }
  if ('classification' in approval && approval.classification && !ACTION_CLASSIFICATION_IDS.includes(approval.classification)) {
    errors.push(`${pathLabel}.classification must be one of: ${ACTION_CLASSIFICATION_IDS.join(', ')}`);
  }
  if ('requires_human_approval' in approval && typeof approval.requires_human_approval !== 'boolean') {
    errors.push(`${pathLabel}.requires_human_approval must be a boolean`);
  }
}

// Checks that a Sales Growth Plan has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateSalesGrowthPlanShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SALES_GROWTH_PLAN_FIELDS.map((field) => field.id);
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

  // domain_status
  if (record.domain_status && typeof record.domain_status === 'object' && !Array.isArray(record.domain_status)) {
    const domainIds = Object.keys(record.domain_status);
    for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
      if (!domainIds.includes(domain)) errors.push(`domain_status is missing domain: ${domain}`);
    }
    for (const domain of domainIds) {
      if (!SALES_GROWTH_PLAN_DOMAINS.includes(domain)) errors.push(`domain_status has unexpected domain: ${domain}`);
      else if (!DOMAIN_STATUSES.includes(record.domain_status[domain])) {
        errors.push(`domain_status.${domain} must be one of: ${DOMAIN_STATUSES.join(', ')}`);
      }
    }
  }

  // current_state
  if (record.current_state && typeof record.current_state === 'object' && !Array.isArray(record.current_state)) {
    const domainIds = Object.keys(record.current_state);
    for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
      if (!domainIds.includes(domain)) errors.push(`current_state is missing domain: ${domain}`);
    }
    for (const domain of domainIds) {
      if (!SALES_GROWTH_PLAN_DOMAINS.includes(domain)) {
        errors.push(`current_state has unexpected domain: ${domain}`);
        continue;
      }
      const value = record.current_state[domain];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`current_state.${domain} must be an object`);
        continue;
      }
      const subIds = Object.keys(value);
      for (const key of CATEGORY_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`current_state.${domain} is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!CATEGORY_SUB_KEYS.includes(key)) errors.push(`current_state.${domain} has unexpected sub-field: ${key}`);
      }
      for (const metricsKey of METRICS_SUB_KEYS) {
        if (metricsKey in value && !Array.isArray(value[metricsKey])) {
          errors.push(`current_state.${domain}.${metricsKey} must be an array`);
        }
      }
      if ('verification_status' in value && !RESEARCH_VERIFICATION_STATUSES.includes(value.verification_status)) {
        errors.push(`current_state.${domain}.verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
      }
    }
  }

  // bottlenecks
  if (Array.isArray(record.bottlenecks)) {
    validateSubKeyedEntries(record.bottlenecks, 'bottlenecks', BOTTLENECK_SUB_KEYS, errors);
    record.bottlenecks.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('domain' in entry && entry.domain && !SALES_GROWTH_PLAN_DOMAINS.includes(entry.domain)) {
        errors.push(`bottlenecks[${index}].domain must be one of: ${SALES_GROWTH_PLAN_DOMAINS.join(', ')}`);
      }
      if ('severity' in entry && entry.severity && !SEVERITY_LEVELS.includes(entry.severity)) {
        errors.push(`bottlenecks[${index}].severity must be one of: ${SEVERITY_LEVELS.join(', ')}`);
      }
      if ('evidence' in entry && !Array.isArray(entry.evidence)) {
        errors.push(`bottlenecks[${index}].evidence must be an array`);
      }
    });
  }

  // recommended_actions
  if (Array.isArray(record.recommended_actions)) {
    validateSubKeyedEntries(record.recommended_actions, 'recommended_actions', RECOMMENDED_ACTION_SUB_KEYS, errors);
    record.recommended_actions.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('domain' in entry && entry.domain && !SALES_GROWTH_PLAN_DOMAINS.includes(entry.domain)) {
        errors.push(`recommended_actions[${index}].domain must be one of: ${SALES_GROWTH_PLAN_DOMAINS.join(', ')}`);
      }
      if ('evidence' in entry && !Array.isArray(entry.evidence)) {
        errors.push(`recommended_actions[${index}].evidence must be an array`);
      }
      if ('approval_requirement' in entry) {
        validateApprovalRequirementShape(entry.approval_requirement, `recommended_actions[${index}].approval_requirement`, errors);
      }
    });
  }

  // kpis
  if (Array.isArray(record.kpis)) {
    validateSubKeyedEntries(record.kpis, 'kpis', KPI_SUB_KEYS, errors);
    record.kpis.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('domain' in entry && entry.domain && !SALES_GROWTH_PLAN_DOMAINS.includes(entry.domain)) {
        errors.push(`kpis[${index}].domain must be one of: ${SALES_GROWTH_PLAN_DOMAINS.join(', ')}`);
      }
    });
  }

  // experiment_ideas
  if (Array.isArray(record.experiment_ideas)) {
    validateSubKeyedEntries(record.experiment_ideas, 'experiment_ideas', EXPERIMENT_IDEA_SUB_KEYS, errors);
    record.experiment_ideas.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('domain' in entry && entry.domain && !SALES_GROWTH_PLAN_DOMAINS.includes(entry.domain)) {
        errors.push(`experiment_ideas[${index}].domain must be one of: ${SALES_GROWTH_PLAN_DOMAINS.join(', ')}`);
      }
      if ('evidence' in entry && !Array.isArray(entry.evidence)) {
        errors.push(`experiment_ideas[${index}].evidence must be an array`);
      }
    });
  }

  // approval_requirements (aggregated rollup)
  if (Array.isArray(record.approval_requirements)) {
    validateSubKeyedEntries(record.approval_requirements, 'approval_requirements', APPROVAL_REQUIREMENT_SUMMARY_SUB_KEYS, errors);
    record.approval_requirements.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('source' in entry && entry.source && !APPROVAL_SOURCE_TYPES.includes(entry.source)) {
        errors.push(`approval_requirements[${index}].source must be one of: ${APPROVAL_SOURCE_TYPES.join(', ')}`);
      }
      if ('classification' in entry && entry.classification && !ACTION_CLASSIFICATION_IDS.includes(entry.classification)) {
        errors.push(`approval_requirements[${index}].classification must be one of: ${ACTION_CLASSIFICATION_IDS.join(', ')}`);
      }
      if ('requires_human_approval' in entry && typeof entry.requires_human_approval !== 'boolean') {
        errors.push(`approval_requirements[${index}].requires_human_approval must be a boolean`);
      }
    });
  }

  // domain_gaps
  if (Array.isArray(record.domain_gaps)) {
    validateSubKeyedEntries(record.domain_gaps, 'domain_gaps', DOMAIN_GAP_SUB_KEYS, errors);
    record.domain_gaps.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      if ('domain' in entry && entry.domain && !SALES_GROWTH_PLAN_DOMAINS.includes(entry.domain)) {
        errors.push(`domain_gaps[${index}].domain must be one of: ${SALES_GROWTH_PLAN_DOMAINS.join(', ')}`);
      }
    });
  }

  // domain_coverage
  if (record.domain_coverage && typeof record.domain_coverage === 'object' && !Array.isArray(record.domain_coverage)) {
    const subIds = Object.keys(record.domain_coverage);
    for (const key of DOMAIN_COVERAGE_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`domain_coverage is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!DOMAIN_COVERAGE_SUB_KEYS.includes(key)) errors.push(`domain_coverage has unexpected sub-field: ${key}`);
    }
    if ('status' in record.domain_coverage && !DOMAIN_STATUSES.includes(record.domain_coverage.status)) {
      errors.push(`domain_coverage.status must be one of: ${DOMAIN_STATUSES.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SALES_GROWTH_PLAN_DOMAINS,
  DOMAIN_STATUSES,
  SALES_GROWTH_PLAN_FIELDS,
  createEmptySalesGrowthPlan,
  validateSalesGrowthPlanShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Sales Growth Plan model (schema only):\n');
  SALES_GROWTH_PLAN_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptySalesGrowthPlan('(no subject set)'), null, 2));
}
