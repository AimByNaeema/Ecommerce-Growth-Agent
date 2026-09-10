'use strict';

// Projects the EXISTING execution record onto the customer-facing workflow map.
//
// READ-ONLY, AND PURE. Every function here takes a run record and/or a Command Center
// session that some other part of the system already produced, and returns display state.
// It runs nothing, saves nothing, and holds no state of its own - there is no second
// execution-state system here, which is exactly why it can never disagree with the real one.
//
// THE DEFAULT IS "NOT RUN". With no record, every stage is "Not run" - never a demo state,
// never a hard-coded "Completed". A stage reads as completed only because a real plan step
// for that specialist reported completion.
//
// COMPLIANCE AND APPROVAL ARE READ SEPARATELY, from two different places, because they are
// two different decisions. A PASS verdict never sets the approval gate.

const {
  STAGE_DEFINITIONS,
  NODE_STATES,
  nodeStateForTaskStatus,
  UNAVAILABLE_FOR_RUN_TEXT,
} = require('./workflowNarrative');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function planStepsOf(record) {
  return record && record.result && record.result.routing && Array.isArray(record.result.routing.plan)
    ? record.result.routing.plan
    : [];
}

// The newest saved record's plan steps for one specialist. A stage with no step simply did
// not run for this goal - which is normal and is shown as such, not as a failure.
function stepsForSpecialist(record, specialistId) {
  return planStepsOf(record).filter(
    (step) => step && step.selected_specialist && step.selected_specialist.id === specialistId
  );
}

// One specialist's display state, from its real steps. When a specialist ran more than once,
// the WORST outcome wins: a customer must not see "Completed" because one of three steps
// happened to finish.
const STATE_SEVERITY = ['completed', 'running', 'waiting', 'needs_information', 'blocked'];

function worstState(states) {
  let worst = null;
  for (const state of states) {
    if (worst === null || STATE_SEVERITY.indexOf(state) > STATE_SEVERITY.indexOf(worst)) worst = state;
  }
  return worst;
}

function deriveAgentStage(record, stage) {
  const steps = stepsForSpecialist(record, stage.specialistId);
  if (steps.length === 0) {
    return { state: 'not_run', detail: 'This agent did not run for this goal.', evidence: [], ranSteps: 0 };
  }

  const states = steps.map((step) => {
    // A tool that answered honestly with "needs_information" is not a failure and not a
    // success - it is a request for something nobody has supplied.
    const output = step.outputs && (step.outputs.result || step.outputs);
    if (output && output.status === 'needs_information') return 'needs_information';
    return nodeStateForTaskStatus(step.completion_state);
  });

  const detailParts = [];
  for (const step of steps) {
    if (asArray(step.errors).length > 0) detailParts.push(String(step.errors[0]));
    else if (nonEmptyString(step.current_task)) detailParts.push(step.current_task);
  }

  // Source URLs this specialist's own steps actually recorded. Never a URL from anywhere else.
  const evidence = [];
  for (const step of steps) {
    const output = step.outputs && (step.outputs.result || step.outputs);
    for (const url of asArray(output && output.sources_used)) {
      if (nonEmptyString(url) && !evidence.includes(url)) evidence.push(url);
    }
    for (const item of asArray(output && output.evidence)) {
      const url = item && (item.source_url || item.url);
      if (nonEmptyString(url) && !evidence.includes(url)) evidence.push(url);
    }
  }

  return {
    state: worstState(states) || 'not_run',
    detail: detailParts.length > 0 ? detailParts[0] : UNAVAILABLE_FOR_RUN_TEXT,
    evidence,
    ranSteps: steps.length,
  };
}

// The Chief ran whenever a plan exists at all - it is what produced the plan.
function deriveChiefStage(record) {
  const steps = planStepsOf(record);
  if (steps.length === 0) return { state: 'not_run', detail: 'No run yet.', evidence: [], ranSteps: 0 };
  const specialists = [...new Set(steps.map((s) => (s.selected_specialist && s.selected_specialist.id) || null).filter(Boolean))];
  return {
    state: 'completed',
    detail: `Planned and coordinated ${steps.length} step(s) across ${specialists.length} specialist(s).`,
    evidence: [],
    ranSteps: steps.length,
  };
}

function deriveGoalStage(record) {
  if (!record || !nonEmptyString(record.objective)) {
    return { state: 'not_run', detail: 'No goal has been given yet.', evidence: [], ranSteps: 0 };
  }
  return { state: 'completed', detail: record.objective, evidence: [], ranSteps: 1 };
}

// COMPLIANCE, read from what compliance itself recorded - never inferred from a step
// finishing. `session` is optional; an opportunity workflow carries the clearest verdict.
function deriveComplianceStage(record, session) {
  const workflows = asArray(session && session.opportunity_workflows);
  const verdicts = workflows.map((w) => w && w.compliance_status).filter(nonEmptyString);
  if (verdicts.length > 0) {
    // BLOCK dominates, then REVIEW - the safest reading, never the most flattering.
    const verdict = verdicts.includes('BLOCK') ? 'BLOCK' : verdicts.includes('REVIEW') ? 'REVIEW' : 'PASS';
    return {
      state: verdict === 'BLOCK' ? 'blocked' : verdict === 'REVIEW' ? 'needs_information' : 'completed',
      verdict,
      detail: `Compliance returned ${verdict}.`,
      evidence: [],
      ranSteps: verdicts.length,
    };
  }
  // A research run records its own per-candidate compliance counts.
  for (const step of planStepsOf(record)) {
    const output = step.outputs && (step.outputs.result || step.outputs);
    const counts = output && output.candidate_count;
    if (counts && typeof counts.compliance_eligible === 'number') {
      return {
        state: 'completed',
        verdict: 'PASS',
        detail: `${counts.compliance_eligible} candidate(s) cleared compliance; ${asArray(output.excluded_opportunities).length} excluded.`,
        evidence: [],
        ranSteps: 1,
      };
    }
  }
  return { state: 'not_run', verdict: null, detail: 'Compliance has not run for this goal.', evidence: [], ranSteps: 0 };
}

// HUMAN APPROVAL, read from approval records only. Deliberately independent of the function
// above: a compliance PASS can never set this to approved.
function deriveApprovalStage(record, session) {
  const statuses = [];
  for (const workflow of asArray(session && session.opportunity_workflows)) {
    if (workflow && nonEmptyString(workflow.approval_status)) statuses.push(workflow.approval_status);
  }
  for (const step of planStepsOf(record)) {
    for (const approval of asArray(step.approvals)) {
      // Auto-approved analysis steps are not a human decision and must not read as one.
      if (approval && nonEmptyString(approval.status) && approval.status !== 'auto_approved') statuses.push(approval.status);
    }
  }
  if (statuses.length === 0) {
    return { state: 'not_run', verdict: null, detail: 'No approval has been requested for this goal.', evidence: [], ranSteps: 0 };
  }
  const verdict = statuses.includes('rejected') ? 'rejected' : statuses.includes('pending') ? 'pending' : 'approved';
  return {
    state: verdict === 'pending' ? 'waiting' : verdict === 'rejected' ? 'blocked' : 'completed',
    verdict,
    detail:
      verdict === 'pending'
        ? 'Waiting for your decision. Nothing has been sent anywhere.'
        : verdict === 'rejected'
          ? 'You declined this action.'
          : 'You approved this action.',
    evidence: [],
    ranSteps: statuses.length,
  };
}

// THE PLATFORM BOUNDARY. This project registers no publishing tool, so this stage cannot
// report anything but "Not run" - and says why, rather than looking merely idle.
function derivePlatformActionStage() {
  return {
    state: 'not_run',
    detail: 'No action has crossed into a connected store. Etsy is connected for reading only, and no publishing capability exists in this system.',
    evidence: [],
    ranSteps: 0,
  };
}

// The whole map. `record` and `session` are both optional - with neither, every stage is
// "Not run", which is the honest state of a system that has not been asked to do anything.
function deriveWorkflowState({ record = null, session = null } = {}) {
  const stages = {};
  for (const stage of STAGE_DEFINITIONS) {
    let derived;
    if (stage.key === 'goal') derived = deriveGoalStage(record);
    else if (stage.key === 'chief') derived = deriveChiefStage(record);
    else if (stage.key === 'compliance') derived = deriveComplianceStage(record, session);
    else if (stage.key === 'approval') derived = deriveApprovalStage(record, session);
    else if (stage.key === 'platform_action') derived = derivePlatformActionStage();
    else derived = deriveAgentStage(record, stage);

    stages[stage.key] = {
      key: stage.key,
      title: stage.title,
      kind: stage.kind,
      state: derived.state,
      state_label: NODE_STATES[derived.state].label,
      state_tone: NODE_STATES[derived.state].tone,
      detail: derived.detail,
      evidence: derived.evidence || [],
      ran_steps: derived.ranSteps || 0,
      verdict: derived.verdict !== undefined ? derived.verdict : null,
    };
  }

  return {
    has_run: Boolean(record),
    run_id: record ? record.run_id || null : null,
    objective: record && nonEmptyString(record.objective) ? record.objective : null,
    created_at: record ? record.created_at || null : null,
    session_id: session ? session.session_id || null : null,
    stages,
  };
}

// The evidence chain behind ONE opportunity, straight out of the persisted record. Every
// figure is relayed exactly as the research stored it: a null stays null, and the caller
// renders the shared "not available" sentence rather than a zero.
function buildEvidenceChain(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return null;

  const signal = (key) => {
    const value = opportunity[key];
    if (!value || typeof value !== 'object') return { available: false, value: null, unit: null, grade: null, assessment: null, sources: [] };
    const hasAssessment = nonEmptyString(value.assessment) && !/^not available/i.test(value.assessment);
    return {
      available: value.value !== null && value.value !== undefined ? true : hasAssessment,
      // Relayed verbatim - never coerced, never defaulted to 0.
      value: value.value === undefined ? null : value.value,
      unit: value.unit === undefined ? null : value.unit,
      grade: value.grade || null,
      classification: value.classification || null,
      assessment: hasAssessment ? value.assessment : null,
      sources: asArray(value.source).filter(nonEmptyString),
    };
  };

  const evidenceUrls = asArray(opportunity.evidence)
    .map((item) => item && item.source_url)
    .filter(nonEmptyString);

  return {
    product: opportunity.product || null,
    rank: opportunity.rank !== undefined ? opportunity.rank : null,
    market: opportunity.market || null,
    research_evidence: { sources: [...new Set(evidenceUrls)], count: new Set(evidenceUrls).size },
    customer_fit: {
      reason: nonEmptyString(opportunity.customer_fit_reason) ? opportunity.customer_fit_reason : null,
      score: opportunity.scores && typeof opportunity.scores.customer_fit === 'number' ? opportunity.scores.customer_fit : null,
    },
    opportunity_evaluation: {
      demand: signal('demand'),
      competition: signal('competition'),
      trend: signal('trend'),
      commercial: signal('commercial'),
      evidence_coverage:
        opportunity.scores && typeof opportunity.scores.evidence_coverage === 'number' ? opportunity.scores.evidence_coverage : null,
      confidence: opportunity.confidence || null,
      rank_basis: opportunity.scores && nonEmptyString(opportunity.scores.rank_basis) ? opportunity.scores.rank_basis : null,
    },
    compliance: {
      status: opportunity.compliance && nonEmptyString(opportunity.compliance.status) ? opportunity.compliance.status : null,
      reasons: asArray(opportunity.compliance && opportunity.compliance.review_reasons).filter(nonEmptyString),
    },
    preparation: { state: null, missing_information: [] },
  };
}

// Adds what the preparation workflow recorded for this opportunity, when it has run. Kept
// separate so an opportunity that was never prepared simply reports nothing prepared.
function attachPreparation(chain, session) {
  if (!chain) return chain;
  const workflow = asArray(session && session.opportunity_workflows).find((w) => w && w.ref === chain.rank);
  if (!workflow) return chain;
  return {
    ...chain,
    preparation: {
      state: workflow.state || null,
      missing_information: asArray(workflow.missing_information),
      stages: workflow.stages || null,
      approval_status: workflow.approval_status || null,
    },
  };
}

module.exports = {
  deriveWorkflowState,
  deriveAgentStage,
  deriveChiefStage,
  deriveComplianceStage,
  deriveApprovalStage,
  derivePlatformActionStage,
  buildEvidenceChain,
  attachPreparation,
  worstState,
};
