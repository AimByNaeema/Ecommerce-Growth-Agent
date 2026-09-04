'use strict';

const path = require('path');
const express = require('express');
const { loadBusinessConfig } = require('./tools/configValidator');
const aiProviderSelector = require('./agent/core/aiProviderSelector');
const { getSpecialistById } = require('./agent/core/specialistRegistry');
// Required as the whole module object (not destructured) so a test can monkey-patch
// orchestratorExecutionContract.buildPlanStep on the shared, cached module instance -
// the same convention verification/testing/server.test.js already uses for
// aiProviderSelector.sendMessage. The same object also exposes runOrchestratorContract,
// resumeApprovedExecution, reviseStepAfterResume, and aggregatePlanState - reused
// unchanged below for the Chief Orchestrator's own free-text routing + approval flow
// (see /orchestrate and /orchestrate/approve).
const orchestratorExecutionContract = require('./agent/core/orchestratorExecutionContract');
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

  app.post('/ask', protect, async (req, res) => {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'A non-empty "message" string is required.' });
      return;
    }

    try {
      const result = await aiProviderSelector.sendMessage({
        messages: [{ role: 'user', content: `${context}\n\n${message}` }],
      });
      res.json({ reply: result.text });
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
