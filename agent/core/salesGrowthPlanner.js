'use strict';

// The Sales Growth Planner. Combines caller-supplied structured evidence from 7
// domains - product, customer, analytics, SEO, marketing, social, advertising - into
// one cross-domain report: current state, bottlenecks, opportunities, recommended
// actions, KPIs, experiment ideas, and approval requirements.
//
// Standalone deliverable, not wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/growthOpportunityEngine.js, agent/core/offerRecommendationEngine.js, and
// agent/core/seoQualityChecker.js already made. It does not call into any specialist
// agent, fetch a live page, or make an AI/API call itself - whoever calls this planner
// (a workflow, the orchestrator, or a human) is responsible for gathering each
// domain's evidence from the relevant specialist first.
//
// WHAT THIS MODULE INVENTS VS. RELAYS (the same deterministic, evidence-only
// philosophy as every other engine in this project):
//   - `current_state` per domain is a direct relay of caller-supplied summary/metrics
//     - never computed or guessed.
//   - `opportunities` is composed by calling
//     agent/core/growthOpportunityEngine.js's rankGrowthOpportunities() on a
//     caller-supplied candidate list - the ICE-style rank_score formula is reused,
//     not reimplemented.
//   - `bottlenecks`, `recommended_actions`, `kpis`, and `experiment_ideas` are always
//     caller-supplied hypotheses/facts, structured and validated only - this planner
//     never infers a bottleneck from a metric threshold, invents a next step, or
//     invents a KPI target. The same "never invent an explanation for why a metric
//     changed" rule agent/core/insightModel.js's possible_cause field already
//     establishes.
//   - `approval_requirements` is a mechanical rollup: it scans `opportunities` and
//     `recommended_actions` for anything already tagged with
//     `requires_human_approval: true` and lists it - never an independently-asserted
//     judgment.
//
// HONESTY GUARD (bottleneck severity): a bottleneck asserted with zero evidence is
// forced down from 'critical'/'high' to 'medium' (the same downgrade-and-record
// pattern agent/core/growthOpportunityEngine.js applies to confidence/verification_status,
// and agent/core/analyticsAgent.js's analyzeInsights() applies to possible_cause
// confidence) - a severity claim about what's blocking growth cannot be asserted at
// the top tier with nothing backing it. The downgrade is recorded in `limitations`,
// never applied silently.
//
// `recommended_actions` reuses agent/core/growthOpportunityEngine.js's
// buildApprovalRequirement() (not reimplemented) so every action is tagged with one
// of approvals/approvalArchitecture.js's 4 classifications via a caller-supplied
// `actionClassification`, exactly like every opportunity candidate already is.

const {
  SALES_GROWTH_PLAN_DOMAINS,
  createEmptySalesGrowthPlan,
  validateSalesGrowthPlanShape,
} = require('./salesGrowthPlanModel');
const { SEVERITY_LEVELS } = require('./conversionOptimizationCheckModel');
const { rankGrowthOpportunities, buildApprovalRequirement } = require('./growthOpportunityEngine');
const { getClassificationById } = require('../../approvals/approvalArchitecture');

const METHODOLOGY =
  'current_state is a direct relay of caller-supplied per-domain summary/metrics. opportunities are ranked by ' +
  'agent/core/growthOpportunityEngine.js\'s rankGrowthOpportunities() (ICE-style: expected_impact_magnitude x ' +
  'confidence_multiplier). bottlenecks, recommended_actions, kpis, and experiment_ideas are caller-supplied ' +
  'hypotheses, structured and validated only - never inferred from a threshold or invented. approval_requirements ' +
  'is a mechanical rollup of every opportunity/recommended_action already tagged requires_human_approval: true.';

const DOWNGRADED_SEVERITIES = { critical: 'medium', high: 'medium' };

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

// ---------------------------------------------------------------------------------
// current_state / domain_status / domain_gaps / domain_coverage
// ---------------------------------------------------------------------------------

function buildCurrentStateForDomain(evidence) {
  if (!evidence) {
    return { summary: '', actual_metrics: [], calculated_metrics: [], estimated_metrics: [], verification_status: 'unverified' };
  }
  return {
    summary: evidence.summary || '',
    actual_metrics: normalizeArray(evidence.actualMetrics),
    calculated_metrics: normalizeArray(evidence.calculatedMetrics),
    estimated_metrics: normalizeArray(evidence.estimatedMetrics),
    verification_status: evidence.verificationStatus || 'unverified',
  };
}

function deriveDomainStatus(currentStateForDomain) {
  const hasSummary = Boolean(currentStateForDomain.summary);
  const hasMetrics =
    currentStateForDomain.actual_metrics.length > 0 ||
    currentStateForDomain.calculated_metrics.length > 0 ||
    currentStateForDomain.estimated_metrics.length > 0;

  if (!hasSummary && !hasMetrics) return 'empty';
  if (hasSummary && hasMetrics) return 'success';
  return 'partial';
}

function buildDomainGapReason(status) {
  if (status === 'empty') return 'no current-state evidence supplied for this domain';
  return 'only partial current-state evidence supplied for this domain (summary or metrics, not both)';
}

// ---------------------------------------------------------------------------------
// bottlenecks
// ---------------------------------------------------------------------------------

function normalizeBottleneck(entry, index, limitations) {
  requireEnumMember(entry.domain, SALES_GROWTH_PLAN_DOMAINS, `bottlenecks[${index}].domain`, 'generateSalesGrowthPlan');
  requireNonEmptyString(entry.description, `bottlenecks[${index}].description`, 'generateSalesGrowthPlan');

  const evidence = normalizeArray(entry.evidence);
  const assertedSeverity = entry.severity || 'low';
  requireEnumMember(assertedSeverity, SEVERITY_LEVELS, `bottlenecks[${index}].severity`, 'generateSalesGrowthPlan');

  let severity = assertedSeverity;
  if (evidence.length === 0 && assertedSeverity in DOWNGRADED_SEVERITIES) {
    severity = DOWNGRADED_SEVERITIES[assertedSeverity];
    limitations.push(
      `bottlenecks[${index}] ("${entry.description}") asserted severity '${assertedSeverity}' with no evidence - downgraded to '${severity}'.`
    );
  }

  return { domain: entry.domain, description: entry.description, evidence, severity };
}

// ---------------------------------------------------------------------------------
// recommended_actions
// ---------------------------------------------------------------------------------

function normalizeRecommendedAction(entry, index) {
  requireEnumMember(entry.domain, SALES_GROWTH_PLAN_DOMAINS, `recommendedActions[${index}].domain`, 'generateSalesGrowthPlan');
  requireNonEmptyString(entry.action, `recommendedActions[${index}].action`, 'generateSalesGrowthPlan');
  requireNonEmptyString(entry.rationale, `recommendedActions[${index}].rationale`, 'generateSalesGrowthPlan');

  const classification = getClassificationById(entry.actionClassification);
  if (!classification) {
    throw new Error(
      `generateSalesGrowthPlan requires recommendedActions[${index}].actionClassification to resolve to a real approvals/approvalArchitecture.js classification id.`
    );
  }

  return {
    domain: entry.domain,
    action: entry.action,
    rationale: entry.rationale,
    evidence: normalizeArray(entry.evidence),
    approval_requirement: buildApprovalRequirement(classification),
  };
}

// ---------------------------------------------------------------------------------
// kpis / experiment_ideas
// ---------------------------------------------------------------------------------

function normalizeKpi(entry, index) {
  requireEnumMember(entry.domain, SALES_GROWTH_PLAN_DOMAINS, `kpis[${index}].domain`, 'generateSalesGrowthPlan');
  requireNonEmptyString(entry.metric, `kpis[${index}].metric`, 'generateSalesGrowthPlan');
  return {
    domain: entry.domain,
    metric: entry.metric,
    current_value: entry.currentValue || '',
    target_value: entry.targetValue || '',
    rationale: entry.rationale || '',
  };
}

function normalizeExperimentIdea(entry, index) {
  requireEnumMember(entry.domain, SALES_GROWTH_PLAN_DOMAINS, `experimentIdeas[${index}].domain`, 'generateSalesGrowthPlan');
  requireNonEmptyString(entry.hypothesis, `experimentIdeas[${index}].hypothesis`, 'generateSalesGrowthPlan');
  return {
    domain: entry.domain,
    hypothesis: entry.hypothesis,
    test_description: entry.testDescription || '',
    expected_outcome: entry.expectedOutcome || '',
    evidence: normalizeArray(entry.evidence),
  };
}

// ---------------------------------------------------------------------------------
// approval_requirements rollup
// ---------------------------------------------------------------------------------

function collectApprovalRequirements(opportunities, recommendedActions) {
  const rollup = [];
  for (const opportunity of opportunities) {
    if (opportunity.approval_requirement.requires_human_approval) {
      rollup.push({
        source: 'opportunity',
        reference: opportunity.opportunity,
        classification: opportunity.approval_requirement.classification,
        title: opportunity.approval_requirement.title,
        description: opportunity.approval_requirement.description,
        requires_human_approval: true,
      });
    }
  }
  for (const action of recommendedActions) {
    if (action.approval_requirement.requires_human_approval) {
      rollup.push({
        source: 'recommended_action',
        reference: action.action,
        classification: action.approval_requirement.classification,
        title: action.approval_requirement.title,
        description: action.approval_requirement.description,
        requires_human_approval: true,
      });
    }
  }
  return rollup;
}

// ---------------------------------------------------------------------------------
// Combined entry point.
// ---------------------------------------------------------------------------------

function generateSalesGrowthPlan({
  subjectReference = '',
  product,
  customer,
  analytics,
  seo,
  marketing,
  social,
  advertising,
  opportunityCandidates = [],
  bottlenecks = [],
  recommendedActions = [],
  kpis = [],
  experimentIdeas = [],
} = {}) {
  const domainEvidence = { product, customer, analytics, seo, marketing, social, advertising };
  const limitations = [];

  const plan = createEmptySalesGrowthPlan(subjectReference);
  plan.plan_date = todayIsoDate();
  plan.methodology = METHODOLOGY;

  for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
    const currentState = buildCurrentStateForDomain(domainEvidence[domain]);
    plan.current_state[domain] = currentState;
    plan.domain_status[domain] = deriveDomainStatus(currentState);
  }

  plan.domain_gaps = SALES_GROWTH_PLAN_DOMAINS.filter((domain) => plan.domain_status[domain] !== 'success').map(
    (domain) => ({ domain, reason: buildDomainGapReason(plan.domain_status[domain]) })
  );

  const domainsSuccess = SALES_GROWTH_PLAN_DOMAINS.filter((domain) => plan.domain_status[domain] === 'success').length;
  const domainsPartial = SALES_GROWTH_PLAN_DOMAINS.filter((domain) => plan.domain_status[domain] === 'partial').length;
  const domainsEmpty = SALES_GROWTH_PLAN_DOMAINS.length - domainsSuccess - domainsPartial;
  plan.domain_coverage = {
    domains_total: SALES_GROWTH_PLAN_DOMAINS.length,
    domains_success: domainsSuccess,
    domains_partial: domainsPartial,
    domains_empty: domainsEmpty,
    percentage: Math.round((domainsSuccess / SALES_GROWTH_PLAN_DOMAINS.length) * 100),
    status:
      domainsSuccess === SALES_GROWTH_PLAN_DOMAINS.length
        ? 'success'
        : domainsSuccess === 0 && domainsPartial === 0
        ? 'empty'
        : 'partial',
  };

  plan.bottlenecks = bottlenecks.map((entry, index) => normalizeBottleneck(entry, index, limitations));

  plan.opportunities = rankGrowthOpportunities(opportunityCandidates).opportunities;

  plan.recommended_actions = recommendedActions.map((entry, index) => normalizeRecommendedAction(entry, index));

  plan.kpis = kpis.map((entry, index) => normalizeKpi(entry, index));

  plan.experiment_ideas = experimentIdeas.map((entry, index) => normalizeExperimentIdea(entry, index));

  plan.approval_requirements = collectApprovalRequirements(plan.opportunities, plan.recommended_actions);

  plan.limitations = limitations;

  const validation = validateSalesGrowthPlanShape(plan);
  if (!validation.valid) {
    throw new Error(`Composed Sales Growth Plan failed validation: ${validation.errors.join('; ')}`);
  }
  return plan;
}

module.exports = {
  generateSalesGrowthPlan,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Sales Growth Planner (deterministic, cross-domain synthesis only):\n');

  const result = generateSalesGrowthPlan({
    subjectReference: '(Example store)',
    product: {
      summary: 'Caller-supplied placeholder: 120 active SKUs, 8 out of stock.',
      actualMetrics: [{ metric: 'active_skus', value: 120 }],
    },
    analytics: {
      summary: 'Caller-supplied placeholder: conversion rate flat at 1.9% over 90 days.',
      actualMetrics: [{ metric: 'conversion_rate', value: '1.9%' }],
      calculatedMetrics: [{ metric: 'conversion_rate_90d_trend', value: 'flat' }],
    },
    seo: {
      summary: 'Caller-supplied placeholder: organic traffic down 12% month over month.',
      actualMetrics: [{ metric: 'organic_sessions_mom_change', value: '-12%' }],
    },
    // customer, marketing, social, advertising deliberately left unsupplied to
    // demonstrate the honest domain_gaps path.
    bottlenecks: [
      {
        domain: 'analytics',
        description: 'Checkout abandonment is high on mobile (caller-supplied placeholder).',
        evidence: ['(placeholder funnel report)'],
        severity: 'high',
      },
      {
        domain: 'seo',
        description: 'Declining organic traffic with no known cause yet (caller-supplied placeholder).',
        evidence: [],
        severity: 'critical',
      },
    ],
    opportunityCandidates: [
      {
        category: 'seo',
        opportunity: '(Example: recover lost organic rankings on top category pages)',
        reason: 'Caller-supplied placeholder: organic traffic decline coincides with a ranking drop.',
        evidence: ['(placeholder rank-tracking report)'],
        expectedImpactCategory: 'traffic_visibility',
        expectedImpactMagnitude: 4,
        confidence: 'medium',
        requiredAction: 'Audit and refresh on-page SEO for the affected category pages (caller-supplied placeholder).',
        actionClassification: 'recommendation',
      },
    ],
    recommendedActions: [
      {
        domain: 'analytics',
        action: 'Simplify the mobile checkout flow to reduce steps (caller-supplied placeholder).',
        rationale: 'Directly addresses the mobile checkout abandonment bottleneck above.',
        evidence: ['(placeholder funnel report)'],
        actionClassification: 'approval_required',
      },
    ],
    kpis: [
      { domain: 'analytics', metric: 'mobile_checkout_completion_rate', currentValue: '61%', targetValue: '75%', rationale: 'Directly tracks the checkout-flow fix.' },
    ],
    experimentIdeas: [
      {
        domain: 'analytics',
        hypothesis: 'Reducing checkout steps from 4 to 2 increases mobile completion rate (caller-supplied placeholder).',
        testDescription: 'A/B test the simplified checkout flow against the current flow on mobile traffic.',
        expectedOutcome: 'Completion rate improves by at least 5 percentage points.',
        evidence: ['(placeholder funnel report)'],
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo current-state, bottleneck, opportunity, action, KPI, or experiment idea above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This planner never executes a recommended action automatically - acting on one is a separate, human-approved action via approvals/.');
}
