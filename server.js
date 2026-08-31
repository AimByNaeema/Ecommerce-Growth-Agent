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

const BUSINESS_CONFIG_PATH = path.join(__dirname, 'configuration', 'business.yaml');

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
  app.use(express.static(path.join(__dirname, 'public')));

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

  app.post('/ask', async (req, res) => {
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
      res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
    }
  });

  app.post('/run', async (req, res) => {
    const { specialist, objective } = req.body || {};
    const internalSpecialistId = SPECIALIST_ID_MAP[specialist];
    if (!internalSpecialistId || !getSpecialistById(internalSpecialistId)) {
      res.status(400).json({ error: `Unrecognized specialist id: "${specialist}".` });
      return;
    }
    if (typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'A non-empty "objective" string is required.' });
      return;
    }

    try {
      const target = orchestratorExecutionContract.buildSpecialistTarget(internalSpecialistId);
      const trimmedObjective = objective.trim();
      const step = await orchestratorExecutionContract.buildPlanStep(target, trimmedObjective, trimmedObjective);
      // 'complete' -> success, 'failed' -> error (a real failure, not just "not done
      // yet"), everything else ('blocked'/'not_started') -> partial. Previously any
      // non-complete state - including a genuine failure - was reported as "partial",
      // which reads as "still in progress" rather than "this failed".
      const status =
        step.completion_state === 'complete' ? 'success' : step.completion_state === 'failed' ? 'error' : 'partial';
      res.json({ ...step, status, summary: summarizeExecutionState(step) });
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
  app.post('/orchestrate', async (req, res) => {
    const { objective } = req.body || {};
    if (typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'A non-empty "objective" string is required.' });
      return;
    }

    try {
      const result = await orchestratorExecutionContract.runOrchestratorContract(objective.trim());
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
  app.post('/orchestrate/approve', async (req, res) => {
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
