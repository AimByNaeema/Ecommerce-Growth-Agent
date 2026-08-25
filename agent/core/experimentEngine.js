'use strict';

// The Experiment Framework's lifecycle engine. Three pure functions carry one
// Experiment record (agent/core/experimentModel.js) through its full lifecycle -
// design, run, decide - reused identically across all 8 growth surfaces named in the
// prompt this answers: products, pricing, listing, SEO, offers, marketing, social,
// advertising.
//
// Standalone deliverable, not wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/growthOpportunityEngine.js, agent/core/offerRecommendationEngine.js,
// agent/core/seoQualityChecker.js, agent/core/conversionOptimizationChecker.js, and
// agent/core/salesGrowthPlanner.js already made. This engine does not call into any
// specialist agent, fetch a live page, or make an AI/API call itself - whoever calls it
// (a workflow, the orchestrator, or a human) is responsible for supplying real
// hypothesis/control/variant/result/decision facts.
//
// WHAT THIS MODULE INVENTS VS. RELAYS (the same deterministic, evidence-only
// philosophy as every other engine in this project):
//   - hypothesis, variable, control, variant, target_metric, duration,
//     success_criteria, result, and decision.rationale are always caller-supplied -
//     this engine never infers a hypothesis, invents a result, or predicts an outcome.
//   - `status` is the one thing this engine computes itself, and only mechanically:
//     derived from whether duration.start_date and result have actually been supplied
//     - never asserted by the caller directly (matching
//     agent/core/salesGrowthPlanner.js's deriveDomainStatus()).
//   - `decision.approval_requirement` reuses
//     agent/core/growthOpportunityEngine.js's buildApprovalRequirement() (not
//     reimplemented) so every decision is tagged with one of
//     approvals/approvalArchitecture.js's 4 classifications via a caller-supplied
//     actionClassification, exactly like every recommended_action in
//     agent/core/salesGrowthPlanner.js already is.
//
// HONESTY GUARD (decision outcome): `ship_variant` and `keep_control` are conclusive,
// production-affecting outcomes. Asserting either one before the experiment's `status`
// is 'completed' (i.e. before a real result has been recorded) is downgraded to
// 'inconclusive' - the same downgrade-and-record pattern
// agent/core/salesGrowthPlanner.js's DOWNGRADED_SEVERITIES applies to bottleneck
// severity. The downgrade is recorded in `limitations`, never applied silently.
// `iterate` and `inconclusive` never require completion - both are honest calls a
// human can make at any stage.

const {
  EXPERIMENT_DOMAINS,
  DECISION_OUTCOMES,
  createEmptyExperiment,
  validateExperimentShape,
} = require('./experimentModel');
const { buildApprovalRequirement } = require('./growthOpportunityEngine');
const { getClassificationById } = require('../../approvals/approvalArchitecture');

const CONCLUSIVE_OUTCOMES_REQUIRING_COMPLETION = ['ship_variant', 'keep_control'];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireEnumMember(value, allowed, fieldName, fnName) {
  if (!allowed.includes(value)) {
    throw new Error(`${fnName} requires \`${fieldName}\` to be one of: ${allowed.join(', ')}`);
  }
}

function normalizeControlVariant(entry, fieldName, fnName) {
  const value = entry || {};
  requireNonEmptyString(value.description, `${fieldName}.description`, fnName);
  return { description: value.description, evidence: normalizeArray(value.evidence) };
}

function normalizeDuration(entry) {
  const value = entry || {};
  return {
    start_date: value.startDate || '',
    end_date: value.endDate || '',
    planned_duration_days: value.plannedDurationDays || 0,
  };
}

function deriveStatus(duration, result) {
  const hasStarted = Boolean(duration.start_date);
  const hasResult = Boolean(result.control_value || result.variant_value || result.observed_effect);
  if (hasResult) return 'completed';
  if (hasStarted) return 'running';
  return 'draft';
}

// ---------------------------------------------------------------------------------
// createExperiment
// ---------------------------------------------------------------------------------

function createExperiment({
  experimentId,
  domain,
  subjectReference = '',
  hypothesis,
  variable,
  control,
  variant,
  targetMetric,
  duration,
  successCriteria,
} = {}) {
  requireNonEmptyString(experimentId, 'experimentId', 'createExperiment');
  requireEnumMember(domain, EXPERIMENT_DOMAINS, 'domain', 'createExperiment');
  requireNonEmptyString(hypothesis, 'hypothesis', 'createExperiment');
  requireNonEmptyString(variable, 'variable', 'createExperiment');
  requireNonEmptyString(targetMetric, 'targetMetric', 'createExperiment');
  requireNonEmptyString(successCriteria, 'successCriteria', 'createExperiment');

  const experiment = createEmptyExperiment(subjectReference, domain);
  experiment.experiment_id = experimentId;
  experiment.hypothesis = hypothesis;
  experiment.variable = variable;
  experiment.control = normalizeControlVariant(control, 'control', 'createExperiment');
  experiment.variant = normalizeControlVariant(variant, 'variant', 'createExperiment');
  experiment.target_metric = targetMetric;
  experiment.duration = normalizeDuration(duration);
  experiment.success_criteria = successCriteria;
  experiment.status = deriveStatus(experiment.duration, experiment.result);
  experiment.created_date = todayIsoDate();

  const validation = validateExperimentShape(experiment);
  if (!validation.valid) {
    throw new Error(`Composed Experiment failed validation: ${validation.errors.join('; ')}`);
  }
  return experiment;
}

// ---------------------------------------------------------------------------------
// recordExperimentResult
// ---------------------------------------------------------------------------------

function recordExperimentResult(experiment, { controlValue, variantValue, observedEffect, statisticalSignificance, evidence } = {}) {
  if (!experiment || !experiment.duration || !experiment.duration.start_date) {
    throw new Error('recordExperimentResult requires an experiment whose duration.start_date is already set (it must have started).');
  }
  requireNonEmptyString(controlValue, 'controlValue', 'recordExperimentResult');
  requireNonEmptyString(variantValue, 'variantValue', 'recordExperimentResult');
  requireNonEmptyString(observedEffect, 'observedEffect', 'recordExperimentResult');

  const updated = {
    ...experiment,
    result: {
      control_value: controlValue,
      variant_value: variantValue,
      observed_effect: observedEffect,
      statistical_significance: statisticalSignificance || '',
      evidence: normalizeArray(evidence),
    },
  };
  updated.status = deriveStatus(updated.duration, updated.result);
  updated.created_date = todayIsoDate();

  const validation = validateExperimentShape(updated);
  if (!validation.valid) {
    throw new Error(`Composed Experiment failed validation: ${validation.errors.join('; ')}`);
  }
  return updated;
}

// ---------------------------------------------------------------------------------
// decideExperiment
// ---------------------------------------------------------------------------------

function decideExperiment(experiment, { outcome, rationale, evidence, actionClassification } = {}) {
  if (!experiment) {
    throw new Error('decideExperiment requires an experiment record.');
  }
  requireEnumMember(outcome, DECISION_OUTCOMES, 'outcome', 'decideExperiment');
  requireNonEmptyString(rationale, 'rationale', 'decideExperiment');

  const classification = getClassificationById(actionClassification);
  if (!classification) {
    throw new Error(
      'decideExperiment requires `actionClassification` to resolve to a real approvals/approvalArchitecture.js classification id.'
    );
  }

  const limitations = [...experiment.limitations];
  let finalOutcome = outcome;

  if (CONCLUSIVE_OUTCOMES_REQUIRING_COMPLETION.includes(outcome) && experiment.status !== 'completed') {
    finalOutcome = 'inconclusive';
    limitations.push(
      `decision outcome '${outcome}' was asserted while status was '${experiment.status}' (not 'completed') - downgraded to 'inconclusive'.`
    );
  }

  const updated = {
    ...experiment,
    decision: {
      outcome: finalOutcome,
      rationale,
      evidence: normalizeArray(evidence),
      approval_requirement: buildApprovalRequirement(classification),
    },
    limitations,
    created_date: todayIsoDate(),
  };

  const validation = validateExperimentShape(updated);
  if (!validation.valid) {
    throw new Error(`Composed Experiment failed validation: ${validation.errors.join('; ')}`);
  }
  return updated;
}

module.exports = {
  createExperiment,
  recordExperimentResult,
  decideExperiment,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Experiment Engine (deterministic lifecycle only):\n');

  let experiment = createExperiment({
    experimentId: 'exp-pricing-001',
    domain: 'pricing',
    subjectReference: '(Example store) - Product X',
    hypothesis: 'Lowering the price by 10% increases conversion rate enough to grow net revenue (caller-supplied placeholder).',
    variable: 'list_price',
    control: { description: 'Current price: $49.99 (caller-supplied placeholder).', evidence: ['(placeholder pricing report)'] },
    variant: { description: 'Test price: $44.99 (caller-supplied placeholder).', evidence: ['(placeholder pricing report)'] },
    targetMetric: 'conversion_rate',
    duration: { plannedDurationDays: 14 },
    successCriteria: 'Net revenue (price x conversion rate) improves by at least 5% at 95% confidence (caller-supplied placeholder).',
  });
  console.log('After createExperiment() (draft, not yet started):');
  console.log(JSON.stringify(experiment, null, 2));

  experiment = {
    ...experiment,
    duration: { ...experiment.duration, start_date: '2026-01-01' },
  };
  console.log('\nManually starting the experiment (duration.start_date set) moves it to running on the next call.');

  experiment = recordExperimentResult(experiment, {
    controlValue: '1.9% conversion rate (caller-supplied placeholder).',
    variantValue: '2.3% conversion rate (caller-supplied placeholder).',
    observedEffect: 'Conversion rate improved by 0.4 percentage points; net revenue improved by 6% (caller-supplied placeholder).',
    statisticalSignificance: '95% confidence, two-sample z-test (caller-supplied placeholder).',
    evidence: ['(placeholder experiment results report)'],
  });
  console.log('\nAfter recordExperimentResult() (status now completed):');
  console.log(JSON.stringify(experiment.status, null, 2));

  experiment = decideExperiment(experiment, {
    outcome: 'ship_variant',
    rationale: 'Result clears the success criteria at 95% confidence (caller-supplied placeholder).',
    evidence: ['(placeholder experiment results report)'],
    actionClassification: 'approval_required',
  });
  console.log('\nAfter decideExperiment() (final record):');
  console.log(JSON.stringify(experiment, null, 2));

  console.log('\nNo hypothesis, control, variant, result, or decision above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This engine never executes a decision automatically - acting on ship_variant/keep_control is a separate, human-approved action via approvals/.');
}
