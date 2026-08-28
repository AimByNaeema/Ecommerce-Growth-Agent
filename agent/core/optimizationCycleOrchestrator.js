'use strict';

// The controlled optimization cycle:
//
//   Research -> Recommendation -> Approval -> Action -> Measurement -> Analysis
//   -> Learning -> New Recommendation
//
// Unlike agent/core/growthWorkflowOrchestrator.js (one fixed 8-specialist pipeline run
// once), this is a GENERIC, REUSABLE cycle: Research/Action are caller-specified
// targets, and the cycle may repeat for multiple iterations - each iteration testing
// one real hypothesis (agent/core/experimentModel.js) and, if the evidence says
// 'iterate', producing a validated lesson that becomes evidence for the next
// iteration's recommendation.
//
// ZERO new engine logic. Every stage reuses an already-existing, already-tested module:
//   Research / Action  -> orchestratorExecutionContract.js's buildPlanStep()/
//                          resumeApprovedExecution() - the SAME dispatch/audit/usage/
//                          approval-gate machinery growthWorkflowOrchestrator.js uses.
//                          Approval is enforced by exactly this mechanism
//                          (agent/core/toolPermissions.js's checkToolAccess) - CLAUDE.md
//                          section 2 forbids a side channel around it, so this module
//                          never invents a second approval check.
//   Recommendation      -> experimentEngine.js's createExperiment()
//   Measurement         -> experimentEngine.js's recordExperimentResult()
//   Analysis            -> experimentEngine.js's decideExperiment()
//   Learning            -> experimentLearningStore.js's recordExperimentLesson()
//                          (only for a decided ship_variant/keep_control - 'iterate'/
//                          'inconclusive' are not learnable yet, and this module never
//                          forces one)
//   New Recommendation  -> experimentLearningStore.js's lessonsAsRecommendationEvidence()
//
// NOT AN UNCONTROLLED AUTONOMOUS LOOP: this cycle is exposed as 4 checkpointed entry
// points, never one self-driving function, and there is no setTimeout/interval/retry
// anywhere in this file:
//   - startOptimizationCycle()      Research -> Recommendation -> attempt Action
//   - resumeAfterApproval()         consumes a REAL, accountable decideApprovalRequest()
//                                   result (approvals/approvalWorkflow.js requires a
//                                   non-empty decidedBy) before Action ever executes
//   - recordMeasurementAndAnalyze() consumes REAL, caller-supplied measurement/analysis
//                                   facts; only a decided outcome of 'iterate' can even
//                                   make another iteration possible
//   - startNextIteration()          a SEPARATE, deliberate external call required to
//                                   actually start iteration N+1 - nothing in this file
//                                   ever calls it automatically
//
// EXPLICIT STOPPING CONDITIONS, ITERATION LIMITS, TOKEN LIMITS, TOOL LIMITS (see
// STOP_REASONS below):
//   - iteration_limit_reached    getMaxOptimizationCycleIterations() (default 5, env
//                                MAX_OPTIMIZATION_CYCLE_ITERATIONS) - captured once per
//                                cycle, checked before every iteration attempt.
//   - token_budget_exhausted     agent/core/tokenControls.js's existing
//                                getMaxTokensPerRun(), checked proactively before each
//                                iteration's Research dispatch (buildPlanStep's own
//                                per-call enforcement still applies underneath).
//   - tool_call_budget_exhausted agent/core/usageLimits.js's existing
//                                getMaxToolCallsPerRun(), same proactive-check pattern.
//   - research_stage_failed / action_stage_failed   a stage's real outcome did not
//                                complete - never guessed forward.
//   - approval_rejected          the Action approval request was decided 'rejected'.
//   - decision_keep_control / decision_inconclusive a real, human-made Analysis call
//                                that this module never overrides.
// Only a decided outcome of 'iterate' can continue the cycle at all, and only up to the
// ceilings above. A decided 'ship_variant' ends the cycle successfully - a human starts
// a NEW cycle for the next opportunity rather than this one continuing indefinitely.
//
// NO NEW PERSISTENCE LAYER (matches growthWorkflowOrchestrator.js's own documented
// stance - agent/core/memory/ has no persistence engine implemented yet, and adding one
// is an unscoped technical decision per CLAUDE.md rule 15): `_resumeState` carries the
// live, in-memory tracker objects directly - in-process resume only.

const {
  buildPlanStep,
  resumeApprovedExecution,
  buildSpecialistTarget,
  isGatedForApproval,
  reviseStepAfterResume,
} = require('./orchestratorExecutionContract');
const { createAuditTracker } = require('../../audit/auditTrail');
const { createUsageLedger, summarizeUsage } = require('../../usage/usageTracker');
const { createToolResultCache } = require('./toolResultCache');
const { createUsageTracker, getMaxToolCallsPerRun } = require('./usageLimits');
const { getMaxTokensPerRun } = require('./tokenControls');
const { createExperiment, recordExperimentResult, decideExperiment } = require('./experimentEngine');
const { recordExperimentLesson, lessonsAsRecommendationEvidence } = require('./experimentLearningStore');

// The 8 requested stage names, in order - documentation/assertion constant only (this
// file's real control flow is the 4 checkpointed functions below, not a stage list to
// iterate over).
const OPTIMIZATION_CYCLE_STAGE_KEYS = [
  'research',
  'recommendation',
  'approval',
  'action',
  'measurement',
  'analysis',
  'learning',
  'new_recommendation',
];

// Every way this cycle can stop, named explicitly - never a silent/implicit halt.
// 'ship_variant' is not listed here: that path ends the cycle successfully
// (status: 'completed'), not as a stop_reason.
const STOP_REASONS = Object.freeze({
  ITERATION_LIMIT_REACHED: 'iteration_limit_reached',
  TOKEN_BUDGET_EXHAUSTED: 'token_budget_exhausted',
  TOOL_CALL_BUDGET_EXHAUSTED: 'tool_call_budget_exhausted',
  RESEARCH_STAGE_FAILED: 'research_stage_failed',
  ACTION_STAGE_FAILED: 'action_stage_failed',
  APPROVAL_REJECTED: 'approval_rejected',
  DECISION_KEEP_CONTROL: 'decision_keep_control',
  DECISION_INCONCLUSIVE: 'decision_inconclusive',
});

// Same getter-with-env-override convention as agent/core/usageLimits.js/
// agent/core/tokenControls.js/agent/core/executionBounds.js - a safety ceiling, not an
// asserted business policy. Captured once per cycle (see startOptimizationCycle) so a
// run's own budget cannot change mid-run.
function getMaxOptimizationCycleIterations() {
  const envOverride = Number(process.env.MAX_OPTIMIZATION_CYCLE_ITERATIONS);
  return envOverride > 0 ? envOverride : 5;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Research/Action targets are caller-specified (unlike growthWorkflowOrchestrator.js's
// hardcoded stages) - this cycle is generic, not tied to one business scenario. Never
// guessed: a missing/malformed target throws rather than letting buildPlanStep's own
// word-overlap scoring silently pick something.
function requireTarget(target, fieldName) {
  if (
    !target ||
    typeof target.specialistId !== 'string' ||
    typeof target.objective !== 'string' ||
    !target.forcedSelection ||
    typeof target.forcedSelection.toolId !== 'string' ||
    typeof target.forcedSelection.capabilityId !== 'string'
  ) {
    throw new Error(
      `${fieldName} must be { specialistId, objective, forcedSelection: { toolId, capabilityId } } - this cycle never guesses which tool/capability a stage should run.`
    );
  }
}

async function dispatchStage(ctx, target, params) {
  return buildPlanStep(
    buildSpecialistTarget(target.specialistId),
    target.objective,
    target.objective,
    ctx.runTokenTracker,
    params || {},
    [],
    ctx.runApprovalTracker,
    ctx.runAuditTracker,
    ctx.runToolResultCache,
    ctx.runUsageTracker,
    ctx.businessId,
    ctx.runUsageLedger,
    target.forcedSelection
  );
}

function markExperimentStarted(experiment) {
  if (experiment.duration.start_date) return experiment;
  return { ...experiment, duration: { ...experiment.duration, start_date: todayIsoDate() } };
}

// Proactive stopping-condition checks, run before an iteration is allowed to start its
// Research dispatch - a clean, explicit stop_reason instead of relying on a generic
// per-call failure buried inside buildPlanStep's own dispatch path.
function checkIterationLimit(ctx) {
  if (ctx.iteration > ctx.maxIterations) {
    return {
      allowed: false,
      stopReason: STOP_REASONS.ITERATION_LIMIT_REACHED,
      reason: `This cycle has reached its maximum of ${ctx.maxIterations} iterations - it will not start another one automatically. A human must explicitly start a new optimization cycle if more iterations are needed.`,
    };
  }
  return { allowed: true, stopReason: null, reason: null };
}

function checkResourceBudgets(ctx) {
  const maxTokens = getMaxTokensPerRun();
  if (ctx.runTokenTracker.tokensUsedThisRun >= maxTokens) {
    return {
      allowed: false,
      stopReason: STOP_REASONS.TOKEN_BUDGET_EXHAUSTED,
      reason: `This cycle has already used ${ctx.runTokenTracker.tokensUsedThisRun} tokens, at or beyond its run budget of ${maxTokens} - no further stages may run.`,
    };
  }
  const maxToolCalls = getMaxToolCallsPerRun();
  if (ctx.runUsageTracker.toolCalls >= maxToolCalls) {
    return {
      allowed: false,
      stopReason: STOP_REASONS.TOOL_CALL_BUDGET_EXHAUSTED,
      reason: `This cycle has already made ${ctx.runUsageTracker.toolCalls} tool calls, at or beyond its run budget of ${maxToolCalls} - no further stages may run.`,
    };
  }
  return { allowed: true, stopReason: null, reason: null };
}

function baseResponse(ctx) {
  return {
    run_id: ctx.runId,
    business_id: ctx.businessId,
    iteration: ctx.iteration,
    max_iterations: ctx.maxIterations,
    iterations: ctx.iterations,
    lessons: ctx.lessons,
    audit_trail: ctx.runAuditTracker.events,
    usage_ledger: ctx.runUsageLedger.events,
    usage_summary: summarizeUsage(ctx.runUsageLedger),
  };
}

function serializeResumeState(ctx) {
  return {
    runId: ctx.runId,
    businessId: ctx.businessId,
    iteration: ctx.iteration,
    maxIterations: ctx.maxIterations,
    iterations: ctx.iterations,
    lessons: ctx.lessons,
    currentIterationRecord: ctx.currentIterationRecord,
    runTokenTracker: ctx.runTokenTracker,
    runApprovalTracker: ctx.runApprovalTracker,
    runAuditTracker: ctx.runAuditTracker,
    runToolResultCache: ctx.runToolResultCache,
    runUsageTracker: ctx.runUsageTracker,
    runUsageLedger: ctx.runUsageLedger,
  };
}

function ctxFromResumeState(resumeState) {
  if (!resumeState || typeof resumeState !== 'object') {
    throw new Error('resumeState must be the _resumeState field from a prior response of this module.');
  }
  return {
    runId: resumeState.runId,
    businessId: resumeState.businessId,
    iteration: resumeState.iteration,
    maxIterations: resumeState.maxIterations,
    iterations: resumeState.iterations,
    lessons: resumeState.lessons,
    currentIterationRecord: resumeState.currentIterationRecord,
    runTokenTracker: resumeState.runTokenTracker,
    runApprovalTracker: resumeState.runApprovalTracker,
    runAuditTracker: resumeState.runAuditTracker,
    runToolResultCache: resumeState.runToolResultCache,
    runUsageTracker: resumeState.runUsageTracker,
    runUsageLedger: resumeState.runUsageLedger,
  };
}

function buildAwaitingApprovalResponse(ctx, pendingApproval) {
  return {
    ...baseResponse(ctx),
    status: 'awaiting_approval',
    stop_reason: null,
    pending_approval: pendingApproval,
    _resumeState: serializeResumeState(ctx),
  };
}

function buildAwaitingMeasurementResponse(ctx) {
  return {
    ...baseResponse(ctx),
    status: 'awaiting_measurement',
    stop_reason: null,
    _resumeState: serializeResumeState(ctx),
  };
}

function buildIterationReadyResponse(ctx, availableEvidence) {
  return {
    ...baseResponse(ctx),
    status: 'iteration_ready',
    stop_reason: null,
    available_evidence: availableEvidence,
    _resumeState: serializeResumeState(ctx),
  };
}

function buildCompletedResponse(ctx) {
  return { ...baseResponse(ctx), status: 'completed', stop_reason: null };
}

function buildStoppedResponse(ctx, stopReason, reason) {
  return { ...baseResponse(ctx), status: 'stopped', stop_reason: stopReason, reason };
}

// Research -> Recommendation -> attempt Action. Shared by startOptimizationCycle
// (iteration 1) and startNextIteration (iteration N+1) - the stage-running logic exists
// in exactly one place.
async function runIterationUpToAction(ctx, { researchTarget, researchParams, experimentInput, actionTarget, actionParams }) {
  const iterationLimitCheck = checkIterationLimit(ctx);
  if (!iterationLimitCheck.allowed) {
    return buildStoppedResponse(ctx, iterationLimitCheck.stopReason, iterationLimitCheck.reason);
  }
  const budgetCheck = checkResourceBudgets(ctx);
  if (!budgetCheck.allowed) {
    return buildStoppedResponse(ctx, budgetCheck.stopReason, budgetCheck.reason);
  }

  requireTarget(researchTarget, 'researchTarget');
  requireTarget(actionTarget, 'actionTarget');

  const record = { iteration: ctx.iteration, research_step: null, experiment: null, action_step: null, lesson: null, stop_reason: null };

  // --- Research ---
  const researchStep = await dispatchStage(ctx, researchTarget, researchParams);
  record.research_step = researchStep;

  if (researchStep.completion_state !== 'complete') {
    record.stop_reason = STOP_REASONS.RESEARCH_STAGE_FAILED;
    ctx.iterations.push(record);
    return buildStoppedResponse(
      ctx,
      STOP_REASONS.RESEARCH_STAGE_FAILED,
      `Research stage did not complete (completion_state: '${researchStep.completion_state}') - no recommendation, approval, or action was attempted this iteration.`
    );
  }

  // --- Recommendation --- (hypothesis/control/variant are always caller-supplied -
  // never inferred from the Research step's own output, matching
  // agent/core/experimentModel.js's own "always caller-supplied" discipline)
  const experiment = createExperiment(experimentInput);
  record.experiment = experiment;

  // --- Approval + Action --- (the Approval gate is buildPlanStep's own existing
  // checkToolAccess mechanism - no second, invented approval check)
  const actionStep = await dispatchStage(ctx, actionTarget, actionParams);
  record.action_step = actionStep;

  if (isGatedForApproval(actionStep)) {
    ctx.currentIterationRecord = record;
    const pendingApproval = ctx.runApprovalTracker.requests[ctx.runApprovalTracker.requests.length - 1] || null;
    return buildAwaitingApprovalResponse(ctx, pendingApproval);
  }

  if (actionStep.completion_state !== 'complete') {
    record.stop_reason = STOP_REASONS.ACTION_STAGE_FAILED;
    ctx.iterations.push(record);
    return buildStoppedResponse(
      ctx,
      STOP_REASONS.ACTION_STAGE_FAILED,
      `Action stage did not complete (completion_state: '${actionStep.completion_state}') - measurement cannot proceed this iteration.`
    );
  }

  record.experiment = markExperimentStarted(record.experiment);
  ctx.currentIterationRecord = record;
  return buildAwaitingMeasurementResponse(ctx);
}

// The main entry point: starts a new optimization cycle at iteration 1.
async function startOptimizationCycle({
  businessId = null,
  researchTarget,
  researchParams,
  experiment,
  actionTarget,
  actionParams,
} = {}) {
  const runId = `optimization-cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    runId,
    businessId,
    iteration: 1,
    maxIterations: getMaxOptimizationCycleIterations(),
    iterations: [],
    lessons: [],
    currentIterationRecord: null,
    runAuditTracker: createAuditTracker(runId, businessId),
    runUsageLedger: createUsageLedger(runId, businessId),
    runTokenTracker: { tokensUsedThisRun: 0 },
    runApprovalTracker: { requests: [] },
    runToolResultCache: createToolResultCache(),
    runUsageTracker: createUsageTracker(),
  };

  return runIterationUpToAction(ctx, { researchTarget, researchParams, experimentInput: experiment, actionTarget, actionParams });
}

// Resumes a cycle paused awaiting a real Action approval decision. `decidedApprovalRequest`
// must be the already-decided record from approvals/approvalWorkflow.js's
// decideApprovalRequest() (status 'approved' or 'rejected') - this is the only path that
// can execute a once-gated Action, and only when that decision is 'approved'.
async function resumeAfterApproval(decidedApprovalRequest, resumeState) {
  const ctx = ctxFromResumeState(resumeState);
  const record = ctx.currentIterationRecord;
  if (!record) {
    throw new Error('resumeAfterApproval requires resumeState from a response with status "awaiting_approval".');
  }

  const resumedOutcome = await resumeApprovedExecution(
    decidedApprovalRequest,
    ctx.runTokenTracker,
    ctx.runAuditTracker,
    ctx.runToolResultCache,
    ctx.runUsageTracker,
    ctx.runUsageLedger
  );

  record.action_step = reviseStepAfterResume(record.action_step, resumedOutcome);

  if (resumedOutcome.status !== 'success') {
    record.stop_reason = STOP_REASONS.APPROVAL_REJECTED;
    ctx.iterations.push(record);
    ctx.currentIterationRecord = null;
    return buildStoppedResponse(
      ctx,
      STOP_REASONS.APPROVAL_REJECTED,
      `Action was not approved and executed (${resumedOutcome.status}) - this iteration stops here.`
    );
  }

  record.experiment = markExperimentStarted(record.experiment);
  ctx.currentIterationRecord = record;
  return buildAwaitingMeasurementResponse(ctx);
}

// Measurement -> Analysis -> Learning (only if decided). `measurement` is passed
// straight to experimentEngine.js's recordExperimentResult() (real, caller-supplied
// fact only - this module never predicts or computes an effect). `analysis` is passed
// straight to decideExperiment() (a real, accountable decision - outcome/rationale/
// actionClassification are always caller-supplied, honesty-guarded by that function
// itself). `lesson` (optional { lesson, confidence }) is passed to
// recordExperimentLesson() only when the decided outcome is learnable.
async function recordMeasurementAndAnalyze(resumeState, { measurement, analysis, lesson } = {}) {
  const ctx = ctxFromResumeState(resumeState);
  const record = ctx.currentIterationRecord;
  if (!record || !record.experiment) {
    throw new Error('recordMeasurementAndAnalyze requires resumeState from a response with status "awaiting_measurement".');
  }

  let experiment = recordExperimentResult(record.experiment, measurement);
  experiment = decideExperiment(experiment, analysis);
  record.experiment = experiment;

  const outcome = experiment.decision.outcome;
  if (outcome === 'ship_variant' || outcome === 'keep_control') {
    const lessonRecord = recordExperimentLesson(experiment, lesson || {});
    record.lesson = lessonRecord;
    ctx.lessons = [...ctx.lessons, lessonRecord];
  }

  if (outcome === 'ship_variant') {
    ctx.iterations.push(record);
    ctx.currentIterationRecord = null;
    return buildCompletedResponse(ctx);
  }

  if (outcome === 'keep_control') {
    record.stop_reason = STOP_REASONS.DECISION_KEEP_CONTROL;
    ctx.iterations.push(record);
    ctx.currentIterationRecord = null;
    return buildStoppedResponse(
      ctx,
      STOP_REASONS.DECISION_KEEP_CONTROL,
      "The decided outcome was 'keep_control' - the tested variant is not worth pursuing further on this hypothesis. A human may start a new optimization cycle for a different hypothesis."
    );
  }

  if (outcome === 'inconclusive') {
    record.stop_reason = STOP_REASONS.DECISION_INCONCLUSIVE;
    ctx.iterations.push(record);
    ctx.currentIterationRecord = null;
    return buildStoppedResponse(
      ctx,
      STOP_REASONS.DECISION_INCONCLUSIVE,
      "The decided outcome was 'inconclusive' - this cycle never continues automatically on ambiguous evidence. A human must review and explicitly start a new iteration or a new cycle."
    );
  }

  // outcome === 'iterate': the only outcome capable of continuing this cycle at all,
  // and only up to the ceilings below. Finalize this iteration's record now; the next
  // iteration (if any) gets its own fresh record via startNextIteration.
  ctx.iterations.push(record);
  ctx.currentIterationRecord = null;
  ctx.iteration += 1;

  const iterationLimitCheck = checkIterationLimit(ctx);
  if (!iterationLimitCheck.allowed) {
    return buildStoppedResponse(ctx, iterationLimitCheck.stopReason, iterationLimitCheck.reason);
  }
  const budgetCheck = checkResourceBudgets(ctx);
  if (!budgetCheck.allowed) {
    return buildStoppedResponse(ctx, budgetCheck.stopReason, budgetCheck.reason);
  }

  return buildIterationReadyResponse(ctx, lessonsAsRecommendationEvidence(ctx.lessons));
}

// Only valid after a response with status 'iteration_ready'. A deliberate, separate
// external call, carrying the next iteration's real hypothesis/control/variant - this
// cycle never starts an iteration on its own.
async function startNextIteration(resumeState, { researchTarget, researchParams, experiment, actionTarget, actionParams } = {}) {
  const ctx = ctxFromResumeState(resumeState);
  if (ctx.currentIterationRecord) {
    throw new Error(
      'startNextIteration requires resumeState from a response with status "iteration_ready" (no iteration may already be in progress).'
    );
  }
  return runIterationUpToAction(ctx, { researchTarget, researchParams, experimentInput: experiment, actionTarget, actionParams });
}

module.exports = {
  OPTIMIZATION_CYCLE_STAGE_KEYS,
  STOP_REASONS,
  getMaxOptimizationCycleIterations,
  startOptimizationCycle,
  resumeAfterApproval,
  recordMeasurementAndAnalyze,
  startNextIteration,
};

if (require.main === module) {
  (async () => {
    console.log('Smart E-Commerce Growth AI Agent - controlled optimization cycle (demo, no approval gate triggered):\n');

    const researchTarget = {
      specialistId: 'research',
      objective: 'Research the target market before recommending a pricing change.',
      forcedSelection: { toolId: 'market_research', capabilityId: 'market_research' },
    };
    const actionTarget = {
      specialistId: 'seo',
      objective: 'Take the recommended on-page SEO action for this product.',
      forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' },
    };

    let result = await startOptimizationCycle({
      researchTarget,
      researchParams: { market: 'European Union outdoor apparel market (placeholder)' },
      experiment: {
        experimentId: 'demo-exp-iter-1',
        domain: 'pricing',
        subjectReference: '(Example store) - Insulated Jacket X (placeholder)',
        hypothesis: 'Lowering the price by 10% increases conversion enough to grow net revenue (placeholder).',
        variable: 'list_price',
        control: { description: 'Current price: $89.99 (placeholder).', evidence: [] },
        variant: { description: 'Test price: $80.99 (placeholder).', evidence: [] },
        targetMetric: 'conversion_rate',
        duration: { plannedDurationDays: 14 },
        successCriteria: 'Net revenue improves by at least 5% (placeholder).',
      },
      actionTarget,
      actionParams: { productReference: 'Insulated Jacket X (placeholder)' },
    });
    console.log(`Iteration 1 - after startOptimizationCycle: ${result.status}`);

    result = await recordMeasurementAndAnalyze(result._resumeState, {
      measurement: {
        controlValue: '1.9% conversion rate (placeholder)',
        variantValue: '2.1% conversion rate (placeholder)',
        observedEffect: 'Modest improvement, inside the noise band for this sample size (placeholder).',
        evidence: ['(placeholder experiment results report)'],
      },
      analysis: {
        outcome: 'iterate',
        rationale: 'Directionally promising but not yet conclusive - worth one more iteration at a larger discount (placeholder).',
        evidence: ['(placeholder experiment results report)'],
        actionClassification: 'recommendation',
      },
    });
    console.log(`Iteration 1 - after recordMeasurementAndAnalyze: ${result.status}`);

    if (result.status === 'iteration_ready') {
      result = await startNextIteration(result._resumeState, {
        researchTarget,
        researchParams: { market: 'European Union outdoor apparel market (placeholder)' },
        experiment: {
          experimentId: 'demo-exp-iter-2',
          domain: 'pricing',
          subjectReference: '(Example store) - Insulated Jacket X (placeholder)',
          hypothesis: 'A larger, 15% price reduction clears the success bar this time (placeholder).',
          variable: 'list_price',
          control: { description: 'Current price: $89.99 (placeholder).', evidence: [] },
          variant: { description: 'Test price: $76.49 (placeholder).', evidence: [] },
          targetMetric: 'conversion_rate',
          duration: { plannedDurationDays: 14 },
          successCriteria: 'Net revenue improves by at least 5% (placeholder).',
        },
        actionTarget,
        actionParams: { productReference: 'Insulated Jacket X (placeholder)' },
      });
      console.log(`Iteration 2 - after startNextIteration: ${result.status}`);

      result = await recordMeasurementAndAnalyze(result._resumeState, {
        measurement: {
          controlValue: '1.9% conversion rate (placeholder)',
          variantValue: '2.4% conversion rate (placeholder)',
          observedEffect: 'Net revenue improved by 6% (placeholder).',
          statisticalSignificance: '95% confidence (placeholder).',
          evidence: ['(placeholder experiment results report)'],
        },
        analysis: {
          outcome: 'ship_variant',
          rationale: 'Clears the success criteria at 95% confidence (placeholder).',
          evidence: ['(placeholder experiment results report)'],
          actionClassification: 'recommendation',
        },
        lesson: {
          lesson: 'A 15% price reduction on this product increases net revenue enough to ship (placeholder).',
          confidence: 'medium',
        },
      });
      console.log(`Iteration 2 - after recordMeasurementAndAnalyze: ${result.status}`);
    }

    console.log(`\nFinal status: ${result.status}${result.stop_reason ? ` (${result.stop_reason})` : ''}`);
    console.log(`Iterations run: ${result.iterations.length}`);
    console.log(`Validated lessons recorded: ${result.lessons.length}`);
    console.log('\nNo hypothesis, measurement, or decision above is real - every value is a caller-supplied placeholder for demonstration.');
  })();
}
