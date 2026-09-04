'use strict';

const path = require('path');
const express = require('express');
const { loadBusinessConfig } = require('./tools/configValidator');
const { getSpecialistById } = require('./agent/core/specialistRegistry');
// Required as the whole module object (not destructured) so a test can monkey-patch
// orchestratorExecutionContract.buildPlanStep on the shared, cached module instance.
// No model client is required here any more: /ask used to call
// agent/core/aiProviderSelector.js directly, which is exactly the shared-infrastructure
// side channel CLAUDE.md section 2 forbids - it now goes through buildPlanStep like
// every other execution path. The same object also exposes runOrchestratorContract,
// resumeApprovedExecution, reviseStepAfterResume, and aggregatePlanState - reused
// unchanged below for the Chief Orchestrator's own free-text routing + approval flow
// (see /orchestrate and /orchestrate/approve).
const orchestratorExecutionContract = require('./agent/core/orchestratorExecutionContract');
// The two already-built, already-tested orchestrators this file exposes over HTTP (see
// /growth-workflow and /optimization-cycle below). Required as whole module objects for
// the same reason orchestratorExecutionContract is above - a test monkey-patches these
// functions on the shared, cached module instance. NOTHING about either orchestrator's
// logic is reimplemented, copied, or wrapped here: these endpoints only validate input,
// hold a paused run's in-memory state between calls, and hand the real functions their
// own documented arguments. There is no second orchestration layer.
const growthWorkflowOrchestrator = require('./agent/core/growthWorkflowOrchestrator');
const optimizationCycleOrchestrator = require('./agent/core/optimizationCycleOrchestrator');
// The project's existing least-privilege gate (agent/core/toolPermissions.js). Used
// below purely as a deterministic PRE-check at the HTTP boundary, so a caller-supplied
// optimization-cycle target that its specialist does not actually own is refused before
// any tool or model budget is spent. It is the same function buildPlanStep already calls
// internally - never a second, parallel permission system.
const { checkToolAccess } = require('./agent/core/toolPermissions');
// One honest, human-readable sentence per execution state (agent/core/executionState.js
// shape) - so a run's primary, user-facing answer is never just the raw internal JSON
// (see /run, /orchestrate, /orchestrate/approve below and public/index.html's
// renderResult/renderPlanStep, which now show this text instead of only the raw state).
const { summarizeExecutionState } = require('./agent/core/resultSummary');
// approvals/approvalWorkflow.js's real, already-tested pending -> approved/rejected
// lifecycle (see verification/testing/chiefToApprovalIntegration.test.js) - reused
// unchanged, never reimplemented here.
const { decideApprovalRequest, getApprovalRequestById } = require('./approvals/approvalWorkflow');
// The persisted counterpart to orchestratorRuns below - see
// agent/core/runHistoryStore.js's own header for why this exists and its scope. Every
// /run and /orchestrate result is saved here as soon as it's produced, and
// /orchestrate/approve re-saves under the same run_id after a human decision is
// resolved, so a result survives a page refresh or a server restart - unlike
// orchestratorRuns (still in-memory only, since a pending APPROVAL DECISION itself
// requires the live approvals/approvalWorkflow.js request object, not just its saved
// JSON shape - see that Map's own comment above for why that part stays unpersisted).
const runHistoryStore = require('./agent/core/runHistoryStore');
// The HTTP boundary's authentication + rate limiting (CLAUDE.md section 3's
// "Security"). Every endpoint below that can reach real store data, call an external
// service, or spend model/API budget goes through both - see security/
// serverAccessControl.js's own header for why a shared secret was chosen and why it
// fails closed when AGENT_API_KEY is unset.
const { requireApiKey, createRateLimiter } = require('./security/serverAccessControl');
// The per-run tracker factories /ask threads into buildPlanStep, so a conversational
// question is audited, metered, and budget-limited exactly like every other execution
// path (see /ask below). Reused unchanged from the shared infrastructure - never
// reimplemented here.
const { createAuditTracker } = require('./audit/auditTrail');
const { createUsageLedger } = require('./usage/usageTracker');
const { createToolResultCache } = require('./agent/core/toolResultCache');
const { createUsageTracker } = require('./agent/core/usageLimits');

const BUSINESS_CONFIG_PATH = path.join(__dirname, 'configuration', 'business.yaml');

// Real specialist display name for a dashboard specialist id (SPECIALIST_ID_MAP's
// keys) - used only for a saved run-history record's human-readable label, never for
// routing/permissions (that's SPECIALIST_ID_MAP + agent/core/specialistRegistry.js).
const SPECIALIST_DISPLAY_NAMES = {
  research: 'Research',
  product: 'Product',
  seo: 'SEO',
  listing: 'Listing',
  marketing: 'Marketing',
  social_advertising: 'Social & Advertising',
  analytics: 'Analytics & Optimization',
};

// Derives one honest overall status for a Chief Orchestrator run's saved record, from
// the same fields the response itself already carries - never a new judgment call.
// Mirrors /run's own success/error/partial vocabulary (see its status computation
// below) so a saved run-history row can use one shared set of dashboard status colors
// regardless of which endpoint produced it.
function deriveOrchestrateHistoryStatus(result) {
  if (result && result.routing && result.routing.status === 'clarification_required') {
    return 'needs_clarification';
  }
  if (result && result.verification_status === 'passed') return 'success';
  if (result && result.verification_status === 'failed') return 'error';
  return 'partial';
}

// One short, honest sentence for a saved run-history list row - reuses each plan
// step's own real summarizeExecutionState() text rather than inventing a new one;
// never fabricates a summary for a clarification stop, which has no steps at all.
function buildOrchestrateHistorySummary(result) {
  if (result && result.routing && result.routing.status === 'clarification_required') {
    return result.routing.reason || 'The Chief needs clarification before it can proceed.';
  }
  const plan = result && result.routing && Array.isArray(result.routing.plan) ? result.routing.plan : [];
  if (plan.length === 0) return 'The Chief did not produce a plan for this goal.';
  return plan.map((step) => summarizeExecutionState(step)).join(' ');
}

// Maps the dashboard's specialist ids (public/index.html's SPECIALISTS list) to the
// real specialist ids agent/core/specialistRegistry.js uses. Identical for every id
// except "analytics" - the dashboard's short label - vs. the registry's
// "analytics_optimization".
const SPECIALIST_ID_MAP = {
  research: 'research',
  product: 'product',
  seo: 'seo',
  listing: 'listing',
  marketing: 'marketing',
  social_advertising: 'social_advertising',
  analytics: 'analytics_optimization',
};

// Validates an optional `research_params` request-body field shared by /run and
// /orchestrate below. This is purely a wiring fix: orchestratorExecutionContract.js's
// buildPlanStep/runOrchestratorContract already accept a real `researchParams` object
// (see crossAgentContext.js's merge into effectiveResearchParams) - neither endpoint
// ever threaded a caller-supplied one through. Absent/null is today's exact existing
// behavior (both functions already default researchParams to null); anything else
// that isn't a plain object (a string, an array, a number, etc.) is rejected outright
// rather than silently coerced, so a caller's mistake surfaces as a clear 400 instead
// of an obscure failure deeper in the pipeline.
function validateResearchParams(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, value: null };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Shared helpers for the two orchestrator surfaces below (/growth-workflow and
// /optimization-cycle). Input validation and response shaping only - no workflow,
// stage, iteration, or approval logic lives here; all of that stays in
// agent/core/growthWorkflowOrchestrator.js and agent/core/optimizationCycleOrchestrator.js.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Both orchestrators hand back a `_resumeState` carrying their LIVE, in-memory run
// trackers. It must never reach an HTTP client, for two independent reasons:
//
//  1. It is not serializable. agent/core/toolResultCache.js's createToolResultCache()
//     returns `{ entries: new Map() }`, and JSON.stringify turns a Map into `{}` - so a
//     client would receive a `_resumeState` that LOOKS resumable but has a silently
//     gutted cache.
//  2. Accepting one back would destroy this endpoint's cost controls. It carries
//     runTokenTracker/runUsageTracker/runApprovalTracker, so a caller who could post
//     their own could reset `tokensUsedThisRun` to 0 on every resume and run an
//     unbounded cycle, or hand in a forged already-approved approval request.
//
// So the resume state is kept SERVER-side (see the two Maps in createApp) and the
// client only ever sends back a run id - exactly the discipline orchestratorRuns
// already uses for /orchestrate -> /orchestrate/approve. Everything else the
// orchestrator returned (status, stop_reason, plan/iterations, audit_trail,
// usage_ledger, usage_summary, growth_opportunity_drafts, ...) is passed through
// unchanged, so each orchestrator's own result semantics are preserved.
function withoutResumeState(result) {
  if (!isPlainObject(result)) return result;
  const { _resumeState, ...publicResult } = result;
  return publicResult;
}

// Stores a paused run's resume state under its own run id, or forgets the run entirely
// once it reaches a terminal status (no `_resumeState` means 'completed'/'stopped' -
// there is nothing left to resume, so holding its trackers would only leak memory).
function retainRunState(store, runId, result) {
  if (!runId) return;
  if (isPlainObject(result) && isPlainObject(result._resumeState)) {
    store.set(runId, result._resumeState);
  } else {
    store.delete(runId);
  }
}

// The deterministic least-privilege pre-check for a caller-supplied optimization-cycle
// target. No LLM is involved: agent/core/toolPermissions.js's checkToolAccess() decides
// this from the tool registry and the specialist's own declared categories/operations.
//
// This matters concretely rather than defensively. buildPlanStep only honors a
// forcedSelection.toolId when that tool is ALREADY a candidate for the target specialist
// (see its `candidateToolIds.includes(...)` guard); otherwise it silently falls through
// to word-overlap scoring and runs a DIFFERENT tool. Over HTTP that would mean a caller
// asking for a tool their specialist does not own gets some other tool's result back
// with no error at all. Checking here turns that into an honest 403 - and does so before
// any tool call or model token is spent. buildPlanStep itself is unchanged and still
// performs its own identical check internally; this never replaces it.
function validateCycleTarget(target, fieldName) {
  if (!isPlainObject(target) || typeof target.specialistId !== 'string' || !target.specialistId.trim()) {
    return { ok: false, status: 400, error: `"${fieldName}" must be an object with a non-empty "specialistId" string.` };
  }
  const forced = target.forcedSelection;
  if (!isPlainObject(forced) || typeof forced.toolId !== 'string' || !forced.toolId.trim()) {
    return {
      ok: false,
      status: 400,
      error: `"${fieldName}.forcedSelection.toolId" is required - this cycle never guesses which tool a stage should run.`,
    };
  }

  const access = checkToolAccess({ specialistId: target.specialistId, toolId: forced.toolId });
  if (access.decision === 'denied' || access.decision === 'unavailable') {
    // checkToolAccess's own `reason` is a static, already-safe sentence about tool
    // ownership/roles - it names no secret, credential, path, or store data.
    return { ok: false, status: 403, error: access.reason };
  }
  return { ok: true };
}

// Looks up a paused run the caller is trying to continue. An unknown id is an honest
// 400 (the run never existed, already finished, or the server restarted) - never a
// fabricated or silently-restarted run.
function requireRunState(store, runId) {
  if (typeof runId !== 'string' || !runId.trim() || !store.has(runId)) {
    return { ok: false, error: 'Unrecognized or expired run id.' };
  }
  return { ok: true, state: store.get(runId) };
}

// Records a human decision against a paused run's OWN approval tracker - the array the
// orchestrator itself will read when it resumes - using approvals/approvalWorkflow.js's
// real decideApprovalRequest(). Identical in kind to what /orchestrate/approve already
// does; reused, never reimplemented. decideApprovalRequest returns a new array, so it is
// assigned back onto the tracker the resume path will actually consult.
function decideRunApproval(state, { approvalId, decision, decidedBy, notes }) {
  const tracker = state.runApprovalTracker;
  if (!tracker || !Array.isArray(tracker.requests)) {
    return { ok: false, error: 'This run has no approval request to decide.' };
  }
  try {
    tracker.requests = decideApprovalRequest(tracker.requests, approvalId, {
      decision,
      decidedBy: decidedBy.trim(),
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
    });
    return { ok: true, decidedRequest: getApprovalRequestById(tracker.requests, approvalId) };
  } catch (err) {
    // Already specific and safe (e.g. "already 'approved', not 'pending'") - surfaced
    // directly, exactly as /orchestrate/approve already surfaces them.
    return { ok: false, error: err.message };
  }
}

// The four fields every approve endpoint below requires, validated identically so a
// caller gets the same errors from both orchestrators.
function validateApprovalDecisionBody({ approvalId, decision, decidedBy }) {
  if (typeof approvalId !== 'string' || !approvalId.trim()) {
    return { ok: false, error: 'A non-empty "approvalId" string is required.' };
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: 'A "decision" of "approved" or "rejected" is required.' };
  }
  if (typeof decidedBy !== 'string' || !decidedBy.trim()) {
    return { ok: false, error: 'A non-empty "decidedBy" string is required so every decision is accountable.' };
  }
  return { ok: true };
}

function buildBusinessContext(config) {
  const lines = [
    `Business: ${config.business_name || 'unknown'}`,
    `Platform: ${config.platform || 'unknown'}`,
    `Product categories: ${(config.product_categories || []).join(', ')}`,
    `Target markets: ${(config.target_markets || []).join(', ')}`,
    `Customer segments: ${(config.customer_segments || []).join(', ')}`,
  ];
  return `You are the assistant for the following business:\n${lines.join('\n')}`;
}

function createApp() {
  const businessConfig = loadBusinessConfig(BUSINESS_CONFIG_PATH);
  const context = buildBusinessContext(businessConfig);

  const app = express();
  app.use(express.json());
  // The dashboard itself stays publicly servable - it is static markup and carries no
  // business data or credential of its own. It obtains the API key from whoever opens
  // it and sends it as an Authorization header on every call below (see
  // public/index.html), so the real boundary is on the endpoints, never on the page.
  app.use(express.static(path.join(__dirname, 'public')));

  // Applied to every endpoint that can reach real store data, call an external
  // service, or spend model/API budget. Rate limiting runs BEFORE authentication on
  // purpose: an unauthenticated caller trying to guess AGENT_API_KEY is throttled by
  // the same counter, so the key cannot be brute-forced at full speed.
  const protect = [createRateLimiter(), requireApiKey];

  // Per-app-instance store for Chief Orchestrator runs that produced at least one
  // pending approval (see /orchestrate below) - keyed by a server-generated run id,
  // never the objective/business data itself. This is the same "caller holds the
  // array across calls" discipline approvals/approvalWorkflow.js's own header
  // documents (there is no persistence engine yet - see agent/core/memory/'s own
  // scope note) - the Chief's real routing/approval engine already has no hidden
  // state of its own; this Map is just where THIS process temporarily keeps a run's
  // pending_approvals + plan between the initial /orchestrate call and a later
  // /orchestrate/approve decision, so the run is lost on server restart, never
  // silently reused across different objectives.
  const orchestratorRuns = new Map();

  // The same "caller holds the run's state across calls" discipline as orchestratorRuns
  // above, applied to the two orchestrators exposed below - each keeps ONE paused run's
  // `_resumeState` (its live plan/iterations plus its token, usage, approval, audit and
  // cache trackers) between the call that paused it and the call that continues it.
  //
  // Keeping this server-side is what makes the cost controls real across a multi-step
  // run: a resumed stage keeps accumulating into the SAME runTokenTracker/runUsageTracker
  // the earlier stages already spent from, and a caller cannot reset either by editing a
  // request body (see withoutResumeState's own comment). Entries are deleted as soon as a
  // run reaches a terminal status. In memory only, per process, lost on restart - the
  // identical, deliberate stance orchestratorRuns documents above; choosing a persistence
  // engine remains an unscoped decision (CLAUDE.md rule 15).
  const growthWorkflowRuns = new Map();
  const optimizationCycleRuns = new Map();

  // A plain conversational question, executed through the SAME shared stack as every
  // other tool call in this project. This endpoint used to call a model client
  // directly, which meant it was the one path that bypassed permissions, token/usage
  // budgets, and the audit trail (CLAUDE.md section 2 forbids exactly that side
  // channel). It now goes through orchestratorExecutionContract.buildPlanStep - the
  // same function /run already uses - so checkToolAccess(), TOOL_EXECUTORS,
  // tokenControls, usageLimits, approvals/approvalArchitecture.js's classification
  // gate, and audit/auditTrail.js all apply here exactly as they do everywhere else.
  //
  // The 'ai_reasoning' shared-infrastructure category is pinned deliberately rather
  // than clause-routed: /orchestrate already owns free-text routing to specialists,
  // and this endpoint's contract is a direct conversational reply, not a plan. Pinning
  // via forcedSelection is the same mechanism agent/core/growthWorkflowOrchestrator.js
  // uses, and it cannot reach a tool outside the target's own real ownership (see
  // buildPlanStep's own forcedSelection check).
  app.post('/ask', protect, async (req, res) => {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'A non-empty "message" string is required.' });
      return;
    }

    const trimmedMessage = message.trim();
    // One tracker set per request, exactly like every other entry point in this
    // project (see agent/core/growthWorkflowOrchestrator.js) - caller-held, never
    // module-level, so two concurrent questions can never share a budget or a trail.
    const runId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runAuditTracker = createAuditTracker(runId, null);
    const runUsageLedger = createUsageLedger(runId, null);

    try {
      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSharedInfrastructureTarget('ai_reasoning'),
        // `objective` is what the tool sends the model verbatim, so the business
        // context stays attached to it exactly as before this endpoint was rerouted -
        // the reply is unchanged in kind. `currentTask` is the clean question, which
        // is what the audit trail and usage ledger record, so neither is polluted with
        // the whole context blob on every turn.
        `${context}\n\n${trimmedMessage}`,
        trimmedMessage,
        { tokensUsedThisRun: 0 },
        null,
        [],
        { requests: [] },
        runAuditTracker,
        createToolResultCache(),
        createUsageTracker(),
        null,
        runUsageLedger,
        { toolId: 'ai_reasoning_completion', capabilityId: null }
      );

      // Only a genuinely completed step yields a reply. Anything else - a denied
      // permission, an exhausted token/usage budget, a gated classification awaiting
      // approval, a model failure - falls through to the honest error below rather
      // than fabricating an answer or reporting a non-answer as success.
      const reply = step.completion_state === 'complete' && step.outputs ? step.outputs.text : null;
      if (typeof reply !== 'string' || reply.trim() === '') {
        const reason = orchestratorExecutionContract.isGatedForApproval(step)
          ? 'the step is gated awaiting human approval'
          : summarizeExecutionState(step);
        console.error(`POST /ask did not complete (${runId}): ${reason}`);
        res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
        return;
      }

      res.json({ reply });
    } catch (err) {
      // Logged (not just swallowed) so the real cause - a bad AI_PROVIDER value, a
      // missing/invalid API key, a network/API failure - is visible in the deployment's
      // logs instead of only the deliberately generic message the client receives below
      // (CLAUDE.md rule 13: no silent failure at a system boundary).
      console.error('POST /ask failed:', err.message);
      res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
    }
  });

  app.post('/run', protect, async (req, res) => {
    const { specialist, objective, research_params: researchParamsInput } = req.body || {};
    const internalSpecialistId = SPECIALIST_ID_MAP[specialist];
    if (!internalSpecialistId || !getSpecialistById(internalSpecialistId)) {
      res.status(400).json({ error: `Unrecognized specialist id: "${specialist}".` });
      return;
    }
    if (typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'A non-empty "objective" string is required.' });
      return;
    }
    const researchParamsCheck = validateResearchParams(researchParamsInput);
    if (!researchParamsCheck.ok) {
      res.status(400).json({ error: 'If provided, "research_params" must be a plain object.' });
      return;
    }

    try {
      const target = orchestratorExecutionContract.buildSpecialistTarget(internalSpecialistId);
      const trimmedObjective = objective.trim();
      // 4th positional argument (runTokenTracker) is deliberately left `undefined` so
      // buildPlanStep's own default (`{ tokensUsedThisRun: 0 }`) still applies exactly
      // as it did before this endpoint knew about research_params - only the 5th
      // (researchParams) argument is new here.
      const step = await orchestratorExecutionContract.buildPlanStep(
        target,
        trimmedObjective,
        trimmedObjective,
        undefined,
        researchParamsCheck.value
      );
      // 'complete' -> success, 'failed' -> error (a real failure, not just "not done
      // yet"), everything else ('blocked'/'not_started') -> partial. Previously any
      // non-complete state - including a genuine failure - was reported as "partial",
      // which reads as "still in progress" rather than "this failed".
      const status =
        step.completion_state === 'complete' ? 'success' : step.completion_state === 'failed' ? 'error' : 'partial';
      const summary = summarizeExecutionState(step);
      const responseBody = { ...step, status, summary };

      // Persist this result so it survives a page refresh/server restart (see
      // agent/core/runHistoryStore.js) - a save failure is logged, never allowed to
      // fail the actual response the user is waiting on; the real result already
      // succeeded or failed on its own merits before this line ever runs.
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        runHistoryStore.saveRunRecord({
          run_id: runId,
          kind: 'run',
          objective: trimmedObjective,
          specialist_id: internalSpecialistId,
          specialist_name: SPECIALIST_DISPLAY_NAMES[specialist] || internalSpecialistId,
          status,
          summary,
          created_at: new Date().toISOString(),
          result: responseBody,
        });
      } catch (saveErr) {
        console.error('Could not save run history for /run:', saveErr.message);
      }

      res.json({ ...responseBody, run_id: runId });
    } catch (err) {
      res.status(502).json({ error: 'The specialist could not complete this run right now. Please try again shortly.' });
    }
  });

  // The Chief Orchestrator's own free-text entry point (CLAUDE.md section 2: the
  // Chief "receives objectives, decides which specialist(s) are relevant"). Unlike
  // /run above - where the dashboard's "Run a Specialist" tab already picked the
  // specialist for agent/core/orchestratorExecutionContract.js's buildPlanStep to
  // execute - this endpoint hands the Chief a raw objective and lets its own
  // planRouting()/runOrchestratorContract() decide routing, exactly as CLAUDE.md
  // describes, never pre-selected by the caller.
  app.post('/orchestrate', protect, async (req, res) => {
    const { objective, research_params: researchParamsInput } = req.body || {};
    if (typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'A non-empty "objective" string is required.' });
      return;
    }
    const researchParamsCheck = validateResearchParams(researchParamsInput);
    if (!researchParamsCheck.ok) {
      res.status(400).json({ error: 'If provided, "research_params" must be a plain object.' });
      return;
    }

    try {
      // businessId is intentionally omitted here, same as before this change - this
      // endpoint has never accepted/passed one, and runOrchestratorContract's own
      // default (null) reproduces its exact existing behavior.
      const result = await orchestratorExecutionContract.runOrchestratorContract(objective.trim(), {
        researchParams: researchParamsCheck.value,
      });
      const runId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      orchestratorRuns.set(runId, {
        pendingApprovals: result.pending_approvals || [],
        plan: result.routing && Array.isArray(result.routing.plan) ? result.routing.plan : [],
      });
      // Attaches a `summary` to a shallow copy of each plan step for this HTTP
      // response only - the internal execution-state objects held in
      // orchestratorRuns/result.routing.plan (and agent/core/executionState.js's own
      // fixed 12-field schema) are never mutated.
      const responseResult =
        result.routing && Array.isArray(result.routing.plan)
          ? {
              ...result,
              routing: {
                ...result.routing,
                plan: result.routing.plan.map((step) => ({ ...step, summary: summarizeExecutionState(step) })),
              },
            }
          : result;

      // Persist this run so it survives a page refresh/server restart (see
      // agent/core/runHistoryStore.js). Uses the SAME runId as orchestratorRuns above,
      // so /orchestrate/approve below can re-save under this exact id once a pending
      // approval is resolved - one saved record per run, always reflecting its latest
      // known state (see runHistoryStore.saveRunRecord's own overwrite-by-run_id
      // behavior). A save failure is logged, never allowed to fail the response.
      try {
        runHistoryStore.saveRunRecord({
          run_id: runId,
          kind: 'orchestrate',
          objective: objective.trim(),
          status: deriveOrchestrateHistoryStatus(result),
          summary: buildOrchestrateHistorySummary(result),
          created_at: new Date().toISOString(),
          result: responseResult,
        });
      } catch (saveErr) {
        console.error('Could not save run history for /orchestrate:', saveErr.message);
      }

      res.json({ ...responseResult, run_id: runId });
    } catch (err) {
      res.status(502).json({ error: 'The Chief Orchestrator could not complete this run right now. Please try again shortly.' });
    }
  });

  // The human-in-the-loop decision point CLAUDE.md rule 7 requires for any
  // approval_required/externally_executable step /orchestrate's plan produced
  // (agent/core/orchestratorExecutionContract.js never executes those on its own -
  // see executeSelectedCapability's 'approval_required' path). decideApprovalRequest
  // is the only function anywhere that can move a request out of 'pending' (see
  // approvals/approvalWorkflow.js), and resumeApprovedExecution is the only path that
  // can then actually run the gated tool call - both reused here unchanged, never
  // reimplemented. A rejected decision is recorded exactly the same way; it simply
  // never reaches the tool executor (resumeApprovedExecution refuses on its own).
  app.post('/orchestrate/approve', protect, async (req, res) => {
    const { runId, approvalId, decision, decidedBy, notes } = req.body || {};

    if (typeof runId !== 'string' || !runId.trim() || !orchestratorRuns.has(runId)) {
      res.status(400).json({ error: 'Unrecognized or expired orchestrator run id.' });
      return;
    }
    if (typeof approvalId !== 'string' || !approvalId.trim()) {
      res.status(400).json({ error: 'A non-empty "approvalId" string is required.' });
      return;
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({ error: 'A "decision" of "approved" or "rejected" is required.' });
      return;
    }
    if (typeof decidedBy !== 'string' || !decidedBy.trim()) {
      res.status(400).json({ error: 'A non-empty "decidedBy" string is required so every decision is accountable.' });
      return;
    }

    const run = orchestratorRuns.get(runId);
    let decidedRequest;
    try {
      const updatedRequests = decideApprovalRequest(run.pendingApprovals, approvalId, {
        decision,
        decidedBy: decidedBy.trim(),
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      });
      run.pendingApprovals = updatedRequests;
      decidedRequest = getApprovalRequestById(updatedRequests, approvalId);
    } catch (err) {
      // decideApprovalRequest's own errors are already safe, specific, and useful
      // (e.g. "already 'approved', not 'pending'", "found no request with id ...") -
      // surfaced directly, the same way /run already surfaces its own validation
      // errors, rather than replaced with a generic message.
      res.status(400).json({ error: err.message });
      return;
    }

    try {
      const resumedOutcome = await orchestratorExecutionContract.resumeApprovedExecution(decidedRequest);

      const stepIndex = run.plan.findIndex(
        (step) =>
          Array.isArray(step.approvals) &&
          step.approvals.some((approval) => approval.approval_request_id === approvalId)
      );
      const revisedStep =
        stepIndex !== -1
          ? orchestratorExecutionContract.reviseStepAfterResume(run.plan[stepIndex], resumedOutcome)
          : null;
      if (stepIndex !== -1) {
        run.plan[stepIndex] = revisedStep;
      }
      const planState = orchestratorExecutionContract.aggregatePlanState(run.plan);

      // Re-save this run's history record (see agent/core/runHistoryStore.js) now that
      // a pending approval has been resolved, so a later /history/:runId view reflects
      // the real outcome (e.g. a tool that actually ran after approval) instead of the
      // "approval_required" snapshot /orchestrate originally saved. Same run_id as
      // /orchestrate used, so this overwrites that same record rather than creating a
      // second one (see saveRunRecord's own overwrite-by-run_id behavior). Reads the
      // prior record back only to preserve its objective/created_at/full routing
      // shape - never invents anything not already known. A missing prior record (the
      // server restarted between /orchestrate and this call) or a save failure is
      // logged, never allowed to fail the real approval decision the user is waiting on.
      try {
        const existingRecord = runHistoryStore.getRunRecordById(runId);
        const planWithSummaries = run.plan.map((step) => ({ ...step, summary: summarizeExecutionState(step) }));
        const updatedStatus =
          planState.verification_status === 'passed' ? 'success' : planState.verification_status === 'failed' ? 'error' : 'partial';
        runHistoryStore.saveRunRecord({
          ...(existingRecord || {}),
          run_id: runId,
          kind: 'orchestrate',
          status: updatedStatus,
          summary: planWithSummaries.map((step) => step.summary).join(' '),
          created_at: (existingRecord && existingRecord.created_at) || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          result: {
            ...(existingRecord && existingRecord.result),
            routing: { ...((existingRecord && existingRecord.result && existingRecord.result.routing) || {}), plan: planWithSummaries },
            verification_status: planState.verification_status,
            task_status: planState.task_status,
          },
        });
      } catch (saveErr) {
        console.error('Could not update run history after approval decision:', saveErr.message);
      }

      res.json({
        run_id: runId,
        approval_request: decidedRequest,
        step: revisedStep ? { ...revisedStep, summary: summarizeExecutionState(revisedStep) } : null,
        task_status: planState.task_status,
        verification_status: planState.verification_status,
      });
    } catch (err) {
      res.status(502).json({ error: 'The approved action could not be executed right now. Please try again shortly.' });
    }
  });

  // -------------------------------------------------------------------------
  // The complete controlled growth workflow (agent/core/growthWorkflowOrchestrator.js's
  // fixed 8-stage Research -> Product -> Listing -> SEO -> Marketing -> Social &
  // Advertising -> Analytics -> Optimization pipeline), reachable over HTTP for the
  // first time. It was already complete and tested
  // (verification/testing/growthWorkflowOrchestrator.test.js) but had no product
  // surface - only a require() or its own demo block could reach it.
  //
  // This endpoint adds NO orchestration of its own. The stage list, their order, the
  // stage-to-stage data flow, and the approval pause all remain entirely inside that
  // module, which runs every stage through the same buildPlanStep() the rest of this
  // file uses - so checkToolAccess(), TOOL_EXECUTORS, tokenControls, usageLimits, the
  // tool-result cache, approvals/approvalArchitecture.js's gate, and audit/auditTrail.js
  // all apply here exactly as they do to /run and /orchestrate. `protect` gives it the
  // same authentication + rate limiting as every other budget-spending endpoint.
  //
  // The caller supplies only genuine business decisions (which markets, which product,
  // which calendar date) as per-stage `stage_inputs` - never which tool runs.
  app.post('/growth-workflow', protect, async (req, res) => {
    const { business_id: businessId, stage_inputs: stageInputsInput } = req.body || {};

    if (businessId !== undefined && businessId !== null && typeof businessId !== 'string') {
      res.status(400).json({ error: 'If provided, "business_id" must be a string.' });
      return;
    }
    if (stageInputsInput !== undefined && stageInputsInput !== null && !isPlainObject(stageInputsInput)) {
      res.status(400).json({ error: 'If provided, "stage_inputs" must be a plain object.' });
      return;
    }
    // Rejected up front rather than silently ignored: a typo'd stage key would otherwise
    // drop that stage's real caller-supplied input and let the workflow run on defaults,
    // producing a confident result built from input the caller never actually gave.
    // STAGE_KEYS is the orchestrator's own exported list, never a copy maintained here.
    const stageInputs = stageInputsInput || {};
    const unknownStageKeys = Object.keys(stageInputs).filter(
      (key) => !growthWorkflowOrchestrator.STAGE_KEYS.includes(key)
    );
    if (unknownStageKeys.length > 0) {
      res.status(400).json({
        error: `Unrecognized "stage_inputs" key(s): ${unknownStageKeys.join(', ')}. Accepted stages: ${growthWorkflowOrchestrator.STAGE_KEYS.join(', ')}.`,
      });
      return;
    }

    try {
      const result = await growthWorkflowOrchestrator.runGrowthWorkflow(businessId || null, stageInputs);
      retainRunState(growthWorkflowRuns, result && result.run_id, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /growth-workflow failed:', err.message);
      res.status(502).json({ error: 'The growth workflow could not complete right now. Please try again shortly.' });
    }
  });

  // The human-in-the-loop decision point for a growth workflow paused at a gated stage
  // (status 'workflow_paused'). CLAUDE.md rule 7 requires this: an approval_required/
  // externally_executable stage never executes on its own.
  //
  // This deliberately does NOT reuse /orchestrate/approve above. That endpoint calls
  // resumeApprovedExecution + reviseStepAfterResume directly, which would execute the
  // one gated stage and stop - the workflow's remaining stages would never run. Only
  // resumeGrowthWorkflow() continues the pipeline, so it is what this calls.
  app.post('/growth-workflow/approve', protect, async (req, res) => {
    const { run_id: runId, approvalId, decision, decidedBy, notes } = req.body || {};

    const bodyCheck = validateApprovalDecisionBody({ approvalId, decision, decidedBy });
    if (!bodyCheck.ok) {
      res.status(400).json({ error: bodyCheck.error });
      return;
    }
    const runLookup = requireRunState(growthWorkflowRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }

    const decisionResult = decideRunApproval(runLookup.state, { approvalId, decision, decidedBy, notes });
    if (!decisionResult.ok) {
      res.status(400).json({ error: decisionResult.error });
      return;
    }

    try {
      // The server-held state is passed through unchanged - never a client-supplied one -
      // so this run's accumulated token/usage budget and audit trail carry forward.
      const result = await growthWorkflowOrchestrator.resumeGrowthWorkflow(
        decisionResult.decidedRequest,
        runLookup.state
      );
      retainRunState(growthWorkflowRuns, runId, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /growth-workflow/approve failed:', err.message);
      res.status(502).json({ error: 'The approved stage could not be executed right now. Please try again shortly.' });
    }
  });

  // -------------------------------------------------------------------------
  // The controlled optimization cycle (agent/core/optimizationCycleOrchestrator.js:
  // Research -> Recommendation -> Approval -> Action -> Measurement -> Analysis ->
  // Learning -> New Recommendation), likewise already complete and tested
  // (verification/testing/optimizationCycleOrchestrator.test.js) but previously
  // unreachable from the product surface.
  //
  // That module deliberately exposes FOUR checkpointed entry points rather than one
  // self-driving loop - a human decision is required between each - so this surface
  // mirrors them one-for-one below. Collapsing them into a single endpoint would change
  // the cycle's contract and remove exactly the checkpoints that keep it non-autonomous.
  // Its iteration ceiling, token budget and tool-call budget (its own STOP_REASONS)
  // stay entirely inside that module; nothing here re-decides them.
  app.post('/optimization-cycle', protect, async (req, res) => {
    const { business_id: businessId, researchTarget, researchParams, experiment, actionTarget, actionParams } = req.body || {};

    if (businessId !== undefined && businessId !== null && typeof businessId !== 'string') {
      res.status(400).json({ error: 'If provided, "business_id" must be a string.' });
      return;
    }
    const researchCheck = validateCycleTarget(researchTarget, 'researchTarget');
    if (!researchCheck.ok) {
      res.status(researchCheck.status).json({ error: researchCheck.error });
      return;
    }
    const actionCheck = validateCycleTarget(actionTarget, 'actionTarget');
    if (!actionCheck.ok) {
      res.status(actionCheck.status).json({ error: actionCheck.error });
      return;
    }

    try {
      // `experiment` is passed through untouched: agent/core/experimentModel.js's
      // createExperiment() already validates it thoroughly (hypothesis, control,
      // variant, success criteria and their evidence), and duplicating that validation
      // here would be a second, drifting copy of the same rules.
      const result = await optimizationCycleOrchestrator.startOptimizationCycle({
        businessId: businessId || null,
        researchTarget,
        researchParams,
        experiment,
        actionTarget,
        actionParams,
      });
      retainRunState(optimizationCycleRuns, result && result.run_id, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /optimization-cycle failed:', err.message);
      res.status(502).json({ error: 'The optimization cycle could not start right now. Please try again shortly.' });
    }
  });

  // Checkpoint 2 of 4: the real, accountable Action approval decision. Only an
  // 'approved' decision can execute a once-gated Action, and only through the
  // orchestrator's own resumeAfterApproval().
  app.post('/optimization-cycle/approve', protect, async (req, res) => {
    const { run_id: runId, approvalId, decision, decidedBy, notes } = req.body || {};

    const bodyCheck = validateApprovalDecisionBody({ approvalId, decision, decidedBy });
    if (!bodyCheck.ok) {
      res.status(400).json({ error: bodyCheck.error });
      return;
    }
    const runLookup = requireRunState(optimizationCycleRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }

    const decisionResult = decideRunApproval(runLookup.state, { approvalId, decision, decidedBy, notes });
    if (!decisionResult.ok) {
      res.status(400).json({ error: decisionResult.error });
      return;
    }

    try {
      const result = await optimizationCycleOrchestrator.resumeAfterApproval(
        decisionResult.decidedRequest,
        runLookup.state
      );
      retainRunState(optimizationCycleRuns, runId, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /optimization-cycle/approve failed:', err.message);
      res.status(502).json({ error: 'The approved action could not be executed right now. Please try again shortly.' });
    }
  });

  // Checkpoint 3 of 4: Measurement -> Analysis -> Learning. `measurement`, `analysis`
  // and `lesson` are real, caller-supplied facts and a real, accountable human decision -
  // agent/core/experimentEngine.js validates and honesty-guards all three, so they are
  // passed straight through rather than re-validated (or worse, inferred) here.
  app.post('/optimization-cycle/measure', protect, async (req, res) => {
    const { run_id: runId, measurement, analysis, lesson } = req.body || {};

    const runLookup = requireRunState(optimizationCycleRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }

    try {
      const result = await optimizationCycleOrchestrator.recordMeasurementAndAnalyze(runLookup.state, {
        measurement,
        analysis,
        lesson,
      });
      retainRunState(optimizationCycleRuns, runId, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /optimization-cycle/measure failed:', err.message);
      res.status(502).json({ error: 'This measurement could not be recorded right now. Please try again shortly.' });
    }
  });

  // Checkpoint 4 of 4: the separate, deliberate call required to actually begin
  // iteration N+1. Nothing in this codebase ever calls it automatically - a cycle only
  // continues because a human asked it to, and only after a decided outcome of
  // 'iterate' left the run in status 'iteration_ready'.
  app.post('/optimization-cycle/next', protect, async (req, res) => {
    const { run_id: runId, researchTarget, researchParams, experiment, actionTarget, actionParams } = req.body || {};

    const runLookup = requireRunState(optimizationCycleRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }
    const researchCheck = validateCycleTarget(researchTarget, 'researchTarget');
    if (!researchCheck.ok) {
      res.status(researchCheck.status).json({ error: researchCheck.error });
      return;
    }
    const actionCheck = validateCycleTarget(actionTarget, 'actionTarget');
    if (!actionCheck.ok) {
      res.status(actionCheck.status).json({ error: actionCheck.error });
      return;
    }

    try {
      const result = await optimizationCycleOrchestrator.startNextIteration(runLookup.state, {
        researchTarget,
        researchParams,
        experiment,
        actionTarget,
        actionParams,
      });
      retainRunState(optimizationCycleRuns, runId, result);
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /optimization-cycle/next failed:', err.message);
      res.status(502).json({ error: 'The next iteration could not be started right now. Please try again shortly.' });
    }
  });

  // Read-only views onto agent/core/runHistoryStore.js's saved runs - what makes
  // "Run a Specialist"/"Chief Orchestrator" results survive a page refresh or server
  // restart (public/index.html's History page). Never executes anything; a bad/unknown
  // id is an honest 404, never a fabricated result.
  app.get('/history', protect, (req, res) => {
    try {
      res.json({ runs: runHistoryStore.listRunRecordSummaries({ limit: 50 }) });
    } catch (err) {
      res.status(502).json({ error: 'Could not read saved run history right now. Please try again shortly.' });
    }
  });

  app.get('/history/:runId', protect, (req, res) => {
    let record;
    try {
      record = runHistoryStore.getRunRecordById(req.params.runId);
    } catch (err) {
      res.status(502).json({ error: 'Could not read this saved run right now. Please try again shortly.' });
      return;
    }
    if (!record) {
      res.status(404).json({ error: 'No saved run found for this id.' });
      return;
    }
    res.json(record);
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}
