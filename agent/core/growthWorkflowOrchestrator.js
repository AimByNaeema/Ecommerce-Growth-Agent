'use strict';

// The complete controlled ecommerce growth workflow (CLAUDE.md section 2's 7
// specialists, run as one deliberate, Chief-controlled, 8-stage pipeline):
//
//   Research -> Product -> Listing -> SEO -> Marketing -> Social & Advertising
//   -> Analytics -> Optimization
//
// This is a SECOND, separate entry point alongside runOrchestratorContract's
// free-text/clause-routed pipeline in agent/core/orchestratorExecutionContract.js -
// that file's ad hoc routing (planRouting/routeClause/ROUTING_TARGETS) is completely
// unchanged. This file exists because the growth workflow needs a specific,
// always-complete, specifically-ordered sequence (Listing before SEO; Optimization as
// its own final stage) that free-text clause matching cannot reliably guarantee.
//
// ZERO new dispatch/approval/audit/usage logic. Every stage is executed via
// buildPlanStep() - the exact same function runOrchestratorContract calls per routed
// target - using its additive `forcedSelection` parameter to pin exactly which
// tool/capability each stage runs (see orchestratorExecutionContract.js's own header
// comment on forcedSelection). Approval gating, audit events, usage events, the
// tool-result cache, and the run-usage budget are therefore identical to the rest of
// this codebase - nothing here bypasses agent/core/toolPermissions.js's
// checkToolAccess() or approvals/approvalWorkflow.js.
//
// STRUCTURED DATA FLOWS STAGE-TO-STAGE via agent/core/crossAgentContext.js's already
// -built pair-flows (Research -> Product's evidence dimensions, Product -> Listing,
// Listing -> SEO, Product -> Marketing's retention branch, "All -> Analytics"), plus
// one workflow-specific piece crossAgentContext.js's own scope doesn't cover: passing
// one real market-comparison row (a whole structured object, not a declared scalar
// field) from the Research stage into the Product stage's `marketRow` parameter (see
// selectMarketRow below), and threading the Product stage's own real product_identity
// forward as later stages' productReference default (see withSharedProductReference)
// - both purely additive over the caller's own explicit input, never inventing a
// value the caller already supplied.
//
// APPROVAL PAUSE/RESUME: if any stage's tool is classified approval_required/
// externally_executable (agent/core/toolPermissions.js's TOOL_CLASSIFICATIONS - none
// is today; see that file's header), the stage loop stops immediately - no later
// stage ever runs against data a gated, not-yet-approved action hasn't produced yet -
// and runGrowthWorkflow returns status 'workflow_paused' with the one pending
// approval. resumeGrowthWorkflow(decidedApprovalRequest, pausedWorkflowState) resumes
// exactly that stage via the existing resumeApprovedExecution(), then continues the
// remaining stages. Per this project's established no-new-persistence stance (see
// usage/usageTracker.js's own header), _resumeState carries the live, in-memory
// tracker objects directly - in-process resume only, no new persistence layer.

const {
  buildPlanStep,
  resumeApprovedExecution,
  aggregatePlanState,
  buildSpecialistTarget,
  isGatedForApproval,
  reviseStepAfterResume,
} = require('./orchestratorExecutionContract');
const { gatherGrowthOpportunityDrafts } = require('./crossAgentContext');
const { createAuditTracker } = require('../../audit/auditTrail');
const { createUsageLedger, summarizeUsage } = require('../../usage/usageTracker');
const { createToolResultCache } = require('./toolResultCache');
const { createUsageTracker } = require('./usageLimits');

// The fixed, named pipeline. Order matches the requested workflow exactly - never
// derived from clause matching or specialist-registry declaration order.
const STAGE_DEFINITIONS = [
  {
    key: 'research',
    specialistId: 'research',
    objective: 'Analyze global ecommerce market opportunity across the supplied markets.',
    forcedSelection: { toolId: 'global_market_opportunity_analysis', capabilityId: 'global_market_opportunity_analysis' },
  },
  {
    key: 'product',
    specialistId: 'product',
    objective: "Assess the caller-supplied product's opportunity within the researched market.",
    forcedSelection: { toolId: 'market_product_opportunity_analysis', capabilityId: 'market_product_opportunity_analysis' },
  },
  {
    key: 'listing',
    specialistId: 'listing',
    objective: 'Compose listing content for the assessed product.',
    forcedSelection: { toolId: 'listing_content_generation', capabilityId: 'listing_content' },
  },
  {
    key: 'seo',
    specialistId: 'seo',
    objective: 'Run on-page SEO analysis for the generated listing content.',
    forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' },
  },
  {
    key: 'marketing',
    specialistId: 'marketing',
    objective: 'Identify a retention growth opportunity for the product.',
    forcedSelection: { toolId: 'marketing_analysis', capabilityId: 'retention' },
  },
  {
    key: 'social_advertising',
    specialistId: 'social_advertising',
    objective: 'Plan one social content calendar entry for the product.',
    forcedSelection: { toolId: 'content_calendar_generation', capabilityId: 'content_calendar' },
  },
  {
    key: 'analytics',
    specialistId: 'analytics_optimization',
    objective: 'Retrieve real store sales analytics.',
    forcedSelection: { toolId: 'analytics_data_retrieval', capabilityId: 'sales' },
  },
  {
    key: 'optimization',
    specialistId: 'analytics_optimization',
    objective: 'Identify growth optimization opportunities from this run.',
    forcedSelection: { toolId: 'analytics', capabilityId: 'growth_opportunities' },
  },
];

const STAGE_KEYS = STAGE_DEFINITIONS.map((stage) => stage.key);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// A step's real tool/specialist output, unwrapped from the tools/*.js
// { status, result, error } convention - null when the step never produced a real
// result (matches agent/core/crossAgentContext.js's own realOutput helper).
function realOutput(step) {
  const wrapper = step && step.outputs;
  return wrapper && wrapper.result ? wrapper.result : null;
}

// marketRow is a whole structural row (not a declared scalar field), so it is built
// here rather than as an agent/core/crossAgentContext.js pair-flow - see that file's
// own header on why it only relays declared fields. Picks the real comparison row
// (from the Research stage's own result.comparison array) whose real
// specialized_records.products list already contains the caller-supplied
// productIdentity - the exact field workflows/productOpportunityAnalysisWorkflow.js's
// findProductInMarketRow() itself searches, verified directly against that source.
// Falls back to the first row when no row's product list matches yet (a genuinely new
// product may not appear in any market row) so the real tool can still run and report
// its own honest outcome, rather than this file guessing or inventing a row.
function selectMarketRow(researchStep, productIdentity) {
  const output = realOutput(researchStep);
  const rows = output && Array.isArray(output.comparison) ? output.comparison : [];
  if (rows.length === 0) return null;

  const matched = rows.find(
    (row) =>
      row.specialized_records &&
      Array.isArray(row.specialized_records.products) &&
      row.specialized_records.products.some((record) => record.product_identity === productIdentity)
  );
  return matched || rows[0];
}

// Fills `productReference` from the Product stage's own real product_identity output
// only when the caller's own per-stage input doesn't already supply it - the same
// "caller-supplied always wins" rule agent/core/crossAgentContext.js's mergeContext
// already enforces, applied one level up (workflow orchestration, not cross-agent
// context derivation) since productReference is a required field on 3 stages
// (listing, seo, marketing) that no crossAgentContext.js flow populates for at least
// 2 of them (listing, seo).
function withSharedProductReference(researchParams, sharedProductIdentity) {
  if (!sharedProductIdentity || (researchParams && 'productReference' in researchParams)) {
    return researchParams || {};
  }
  return { ...(researchParams || {}), productReference: sharedProductIdentity };
}

function buildPausedResponse(ctx, pendingApproval, nextStageIndex) {
  return {
    status: 'workflow_paused',
    run_id: ctx.runId,
    business_id: ctx.businessId,
    plan: ctx.plan,
    pending_approval: pendingApproval,
    growth_opportunity_drafts: gatherGrowthOpportunityDrafts(ctx.plan),
    audit_trail: ctx.runAuditTracker.events,
    usage_ledger: ctx.runUsageLedger.events,
    usage_summary: summarizeUsage(ctx.runUsageLedger),
    _resumeState: {
      nextStageIndex,
      stageInputs: ctx.stageInputs,
      sharedProductIdentity: ctx.sharedProductIdentity,
      runId: ctx.runId,
      businessId: ctx.businessId,
      plan: ctx.plan,
      runTokenTracker: ctx.runTokenTracker,
      runApprovalTracker: ctx.runApprovalTracker,
      runAuditTracker: ctx.runAuditTracker,
      runToolResultCache: ctx.runToolResultCache,
      runUsageTracker: ctx.runUsageTracker,
      runUsageLedger: ctx.runUsageLedger,
    },
  };
}

function buildCompletedResponse(ctx) {
  return {
    status: 'completed',
    run_id: ctx.runId,
    business_id: ctx.businessId,
    plan: ctx.plan,
    ...aggregatePlanState(ctx.plan),
    growth_opportunity_drafts: gatherGrowthOpportunityDrafts(ctx.plan),
    audit_trail: ctx.runAuditTracker.events,
    usage_ledger: ctx.runUsageLedger.events,
    usage_summary: summarizeUsage(ctx.runUsageLedger),
  };
}

function buildStoppedResponse(ctx) {
  return {
    status: 'stopped',
    run_id: ctx.runId,
    business_id: ctx.businessId,
    plan: ctx.plan,
    ...aggregatePlanState(ctx.plan),
    growth_opportunity_drafts: gatherGrowthOpportunityDrafts(ctx.plan),
    audit_trail: ctx.runAuditTracker.events,
    usage_ledger: ctx.runUsageLedger.events,
    usage_summary: summarizeUsage(ctx.runUsageLedger),
  };
}

// Runs stages [startIndex, STAGE_DEFINITIONS.length) in order, pushing each real
// execution state onto ctx.plan and stopping immediately (returning 'workflow_paused')
// the moment any stage is gated for approval - shared by both runGrowthWorkflow (from
// stage 0) and resumeGrowthWorkflow (from wherever it left off), so the stage-running
// logic exists in exactly one place.
async function executeStagesFrom(startIndex, ctx) {
  for (let i = startIndex; i < STAGE_DEFINITIONS.length; i += 1) {
    const stageDef = STAGE_DEFINITIONS[i];
    const target = buildSpecialistTarget(stageDef.specialistId);
    const explicitParams = ctx.stageInputs[stageDef.key] || null;

    let researchParams = explicitParams ? { ...explicitParams } : {};

    if (stageDef.key === 'product' && !('marketRow' in researchParams)) {
      const researchStep = ctx.plan[0] || null;
      const productIdentity = isNonEmptyString(researchParams.productIdentity) ? researchParams.productIdentity : null;
      const marketRow = researchStep && productIdentity ? selectMarketRow(researchStep, productIdentity) : null;
      if (marketRow) researchParams.marketRow = marketRow;
    }

    if (['listing', 'seo', 'marketing'].includes(stageDef.key)) {
      researchParams = withSharedProductReference(researchParams, ctx.sharedProductIdentity);
    }

    const step = await buildPlanStep(
      target,
      stageDef.objective,
      stageDef.objective,
      ctx.runTokenTracker,
      researchParams,
      ctx.plan,
      ctx.runApprovalTracker,
      ctx.runAuditTracker,
      ctx.runToolResultCache,
      ctx.runUsageTracker,
      ctx.businessId,
      ctx.runUsageLedger,
      stageDef.forcedSelection
    );

    ctx.plan.push(step);

    if (stageDef.key === 'product') {
      const output = realOutput(step);
      if (output && isNonEmptyString(output.product_identity)) {
        ctx.sharedProductIdentity = output.product_identity;
      }
    }

    if (isGatedForApproval(step)) {
      const pendingApproval = ctx.runApprovalTracker.requests[ctx.runApprovalTracker.requests.length - 1] || null;
      return buildPausedResponse(ctx, pendingApproval, i + 1);
    }
  }

  return buildCompletedResponse(ctx);
}

// The main entry point: runs all 8 stages in order for one business. `stageInputs` is
// an optional { research, product, listing, seo, marketing, social_advertising,
// analytics, optimization } map of caller-supplied researchParams per stage - genuine
// business decisions (which markets, which product, which calendar date/platform)
// this file never invents. See STAGE_KEYS for the exact accepted keys.
async function runGrowthWorkflow(businessId = null, stageInputs = {}) {
  const runId = `growth-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    runId,
    businessId,
    stageInputs: stageInputs || {},
    sharedProductIdentity: null,
    plan: [],
    runAuditTracker: createAuditTracker(runId, businessId),
    runUsageLedger: createUsageLedger(runId, businessId),
    runTokenTracker: { tokensUsedThisRun: 0 },
    runApprovalTracker: { requests: [] },
    runToolResultCache: createToolResultCache(),
    runUsageTracker: createUsageTracker(),
  };

  return executeStagesFrom(0, ctx);
}

// Resumes a workflow paused by runGrowthWorkflow (or a prior resumeGrowthWorkflow
// call) at the stage that required approval. `decidedApprovalRequest` must be the
// already-decided record from approvals/approvalWorkflow.js's decideApprovalRequest()
// (status 'approved' or 'rejected'); `pausedWorkflowState` is the `_resumeState` field
// from that paused response, unchanged. If the resumed stage's real outcome isn't
// 'success' (rejected, or the tool became unavailable/denied since the request was
// created), the workflow stops - it never guesses forward past a gate that was not
// actually cleared.
async function resumeGrowthWorkflow(decidedApprovalRequest, pausedWorkflowState) {
  const ctx = {
    runId: pausedWorkflowState.runId,
    businessId: pausedWorkflowState.businessId,
    stageInputs: pausedWorkflowState.stageInputs || {},
    sharedProductIdentity: pausedWorkflowState.sharedProductIdentity || null,
    plan: pausedWorkflowState.plan,
    runAuditTracker: pausedWorkflowState.runAuditTracker,
    runUsageLedger: pausedWorkflowState.runUsageLedger,
    runTokenTracker: pausedWorkflowState.runTokenTracker,
    runApprovalTracker: pausedWorkflowState.runApprovalTracker,
    runToolResultCache: pausedWorkflowState.runToolResultCache,
    runUsageTracker: pausedWorkflowState.runUsageTracker,
  };

  const resumedOutcome = await resumeApprovedExecution(
    decidedApprovalRequest,
    ctx.runTokenTracker,
    ctx.runAuditTracker,
    ctx.runToolResultCache,
    ctx.runUsageTracker,
    ctx.runUsageLedger
  );

  const pausedStageIndex = pausedWorkflowState.nextStageIndex - 1;
  const pausedStep = ctx.plan[pausedStageIndex];
  ctx.plan[pausedStageIndex] = reviseStepAfterResume(pausedStep, resumedOutcome);

  const resumedStageDef = STAGE_DEFINITIONS[pausedStageIndex];
  if (resumedStageDef && resumedStageDef.key === 'product' && resumedOutcome.status === 'success' && resumedOutcome.data) {
    const output = resumedOutcome.data.result || null;
    if (output && isNonEmptyString(output.product_identity)) {
      ctx.sharedProductIdentity = output.product_identity;
    }
  }

  if (resumedOutcome.status !== 'success') {
    return buildStoppedResponse(ctx);
  }

  return executeStagesFrom(pausedWorkflowState.nextStageIndex, ctx);
}

module.exports = {
  STAGE_DEFINITIONS,
  STAGE_KEYS,
  runGrowthWorkflow,
  resumeGrowthWorkflow,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - complete controlled growth workflow (demo, no approval gate triggered):\n');

  const stageInputs = {
    research: {
      markets: [
        {
          country: 'DE',
          market: 'European Union',
          category: 'outdoor apparel',
          demandSignals: ['(placeholder demand signal)'],
          trends: ['(placeholder trend)'],
          evidence: ['(placeholder market evidence reference)'],
          competitors: [
            {
              competitor: '(Example Co.)',
              positioning: '(placeholder positioning)',
              pricingEvidence: ['(placeholder pricing evidence reference)'],
              source: ['(placeholder competitor source reference)'],
            },
          ],
          products: [
            {
              productIdentity: '(Example insulated jacket)',
              pricing: { currency: 'EUR', cost: '40', price: '90' },
              source: ['(placeholder product source reference)'],
            },
          ],
        },
      ],
    },
    product: {
      productIdentity: '(Example insulated jacket)',
      demandAssessment: '(placeholder assessment)',
      demandConfidence: 'medium',
      competitionAssessment: '(placeholder assessment)',
      competitionConfidence: 'low',
      marketFitAssessment: '(placeholder assessment)',
      marketFitConfidence: 'medium',
      commercialPotentialAssessment: '(placeholder assessment)',
      commercialPotentialConfidence: 'low',
    },
    social_advertising: {
      entryReference: '(Example calendar entry, 2026-09-01, Instagram)',
      date: '2026-09-01',
      platform: 'instagram',
    },
  };

  runGrowthWorkflow(null, stageInputs).then((result) => {
    console.log(`Overall status: ${result.status}\n`);
    for (const step of result.plan) {
      console.log(
        `- ${step.selected_specialist ? step.selected_specialist.id : '(none)'} / ${
          step.inputs ? step.inputs.tool_id : '(no tool)'
        } / ${step.inputs ? step.inputs.capability_id : '(no capability)'} -> ${step.completion_state}`
      );
    }
    console.log(`\nGrowth opportunity drafts: ${result.growth_opportunity_drafts.length}`);
    console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  });
}
