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
// Read by GET /overview only, to REPORT which provider is selected and whether its key is
// set. A status-only module: it cannot send a model call, so server.js still never reaches a
// model itself - every model call goes through the shared tool stack.
const aiProviderStatus = require('./agent/core/aiProviderStatus');
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
// decideAndPersistApprovalRequest is decideApprovalRequest plus the durable write - the
// SAME verification, then approvals/approvalStore.js. Used by /orchestrate/approve below
// so an approved correction is recoverable from durable state, which is the only thing
// integrations/approvedCorrectionDispatch.js will accept as authorization.
const {
  decideApprovalRequest,
  decideAndPersistApprovalRequest,
  getApprovalRequestById,
} = require('./approvals/approvalWorkflow');
// The durable approval store itself, for persisting a pending approval at creation time
// (see /orchestrate below). Same module the dispatcher reads from - never a second store.
const approvalStore = require('./approvals/approvalStore');
// Controlled autonomy: the kill switch and business policy are READ for the read-only state
// endpoint; the owner's durable-approval resolution, the one-cycle trigger and explicit
// schedule management each live in their own module (see the /autonomy endpoints below).
const { readKillSwitch, resolveBusinessPolicy } = require('./agent/core/autonomyPolicy');
const autonomyApprovals = require('./autonomy/approvalResolution');
const { triggerAutonomousCycle, checkDurableStorage } = require('./autonomy/cycleTrigger');
const { createBusinessSchedule, setBusinessScheduleEnabled, listBusinessSchedules } = require('./scheduler/scheduleManagement');
// The human-provenance surface. issueApprovalChallenge produces the exact string a person
// signs offline; decideApprovalRequest verifies the returned signature itself.
const { issueApprovalChallenge } = require('./approvals/approvalArchitecture');
// The persisted counterpart to orchestratorRuns below - see
// agent/core/runHistoryStore.js's own header for why this exists and its scope. Every
// /run, /orchestrate, /growth-workflow and /optimization-cycle result is saved here as
// soon as it's produced, and every continuation endpoint (/orchestrate/approve,
// /growth-workflow/approve, /optimization-cycle/approve|measure|next) re-saves under the
// same run_id once a human decision or measurement is resolved, so a run's RECORD - its
// audit trail, usage ledger and approval outcomes - survives a page refresh or a server
// restart. What is deliberately NOT saved is the ability to CONTINUE a paused run: both
// orchestratorRuns and the two workflow Maps stay in-memory only, because resuming needs
// the live approvals/approvalWorkflow.js request object and the live, non-serializable
// trackers, not their saved JSON shape - see those Maps' and saveWorkflowRunRecord's own
// comments below.
const runHistoryStore = require('./agent/core/runHistoryStore');
// The Command Center session layer and its store. The session layer contains no routing or
// dispatch of its own - every turn ends in one call to the SAME runOrchestratorContract
// this file's /orchestrate route already uses.
const commandCenterSession = require('./agent/core/commandCenterSession');
const workflowStateProjection = require('./agent/core/workflowStateProjection');
const workflowNarrative = require('./agent/core/workflowNarrative');
const workflowDocument = require('./documents/workflowDocument');
const commandCenterSessionStore = require('./agent/core/commandCenterSessionStore');
// The HTTP boundary's authentication + rate limiting (CLAUDE.md section 3's
// "Security"). Every endpoint below that can reach real store data, call an external
// service, or spend model/API budget goes through both - see security/
// serverAccessControl.js's own header for why a shared secret was chosen and why it
// fails closed when AGENT_API_KEY is unset.
const {
  requireApiKey,
  createRateLimiter,
  requireAuthorizedBusiness,
  isBusinessAuthorized,
} = require('./security/serverAccessControl');
// The per-run tracker factories /ask threads into buildPlanStep, so a conversational
// question is audited, metered, and budget-limited exactly like every other execution
// path (see /ask below). Reused unchanged from the shared infrastructure - never
// reimplemented here.
const { createAuditTracker } = require('./audit/auditTrail');
const { createUsageLedger } = require('./usage/usageTracker');
const { createToolResultCache } = require('./agent/core/toolResultCache');
const { createUsageTracker } = require('./agent/core/usageLimits');
// The existing platform adapters, required ONLY for their credential-presence checks,
// which the dashboard's Connected Channels section reports. All are deliberately
// zero-network: shopifyClient.isConfigured() reads resolved credentials, and
// etsyReadClient.canRead() calls its own missingReadCredentials() - neither opens a
// socket, so GET /overview below stays safe to call on every page load. Required as whole
// module objects so a test can monkey-patch the check on the shared, cached instance, the
// same convention orchestratorExecutionContract above already uses.
//
// ETSY IS THE READ CLIENT, NOT THE PUBLISHING CLIENT. integrations/adapters/etsyClient.js
// answers "are publishing credentials present" - a question whose answer is deliberately
// no, because Etsy publishing is intentionally closed in this project. What the dashboard
// actually reports is whether this shop's data can be READ, which is
// integrations/adapters/etsyReadClient.js's canRead(). Reporting the publish client here
// would show "Not connected" for a channel whose reads work perfectly.
const shopifyClient = require('./integrations/adapters/shopifyClient');
const etsyReadClient = require('./integrations/adapters/etsyReadClient');
// The two existing read-only Etsy tools (tools/toolRegistry.js's
// etsy_shop_data_retrieval / etsy_listing_data_retrieval), both classified analysis_only.
// GET /store/metrics relays their {status, result, error} envelopes the same way it
// relays analyticsDataTool's. No Etsy write tool exists to require.
const etsyShopDataTool = require('./tools/etsyShopDataTool');
const etsyListingDataTool = require('./tools/etsyListingDataTool');
// The existing read-only live-data tool (tools/toolRegistry.js's
// analytics_data_retrieval). GET /store/metrics below is the dashboard's window onto it -
// it calls this function and relays its result verbatim, never recomputing a metric or
// filling in a missing one. Whole module object, same monkey-patch reason as above.
const analyticsDataTool = require('./tools/analyticsDataTool');
// The EXISTING analytics engine's own pure trend arithmetic
// (agent/core/analyticsMetricsCalculator.js's calculateSalesTrend). Used below to turn
// the orders tools/analyticsDataTool.js ALREADY pulled into a revenue/orders trend -
// no second analytics engine, no extra Shopify call, and no number this server invents.
const { calculateSalesTrend, calculateTopProductsBySales } = require('./agent/core/analyticsMetricsCalculator');

const BUSINESS_CONFIG_PATH = path.join(__dirname, 'configuration', 'business.yaml');

// How many saved runs GET /history reads before authorization filtering, so that removing
// other businesses' records does not silently shorten the page the caller actually gets.
// Larger than the 50 returned, bounded so a large store cannot be walked in one request.
const HISTORY_SCAN_LIMIT = 500;

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

// Maps a growth-workflow / optimization-cycle status onto the same three-way run-history
// vocabulary /run and /orchestrate already use ('success' | 'error' | 'partial'), by the
// identical rule: finished -> success, a real halt -> error, still-in-progress -> partial.
// 'stopped' is a genuine halt (a budget, tool-call or iteration ceiling was hit - the
// orchestrator's own stop_reason says which), not "not done yet", so it maps to 'error'
// exactly the way /run maps completion_state 'failed'.
function deriveWorkflowHistoryStatus(result) {
  if (!isPlainObject(result)) return 'partial';
  if (result.status === 'completed') return 'success';
  if (result.status === 'stopped') return 'error';
  return 'partial';
}

// One short, honest sentence for a saved run-history list row, composed only from what
// the orchestrator itself reported - never a fabricated narrative. Mirrors
// buildOrchestrateHistorySummary's discipline above.
function buildWorkflowHistorySummary(result) {
  if (!isPlainObject(result)) return 'This run produced no result.';
  const parts = [`Status: ${result.status || 'unknown'}.`];
  if (result.stop_reason) parts.push(`Stop reason: ${result.stop_reason}.`);
  if (Array.isArray(result.stages)) parts.push(`${result.stages.length} stage(s) recorded.`);
  if (Array.isArray(result.iterations)) parts.push(`${result.iterations.length} iteration(s) recorded.`);
  if (Array.isArray(result.audit_trail)) parts.push(`${result.audit_trail.length} audit event(s).`);
  return parts.join(' ');
}

// Persists one growth-workflow / optimization-cycle run so its audit trail, usage ledger
// and approval outcomes survive a server restart - the durability CLAUDE.md section 3's
// Audit requirement ("traceable after the fact") already assumes, and which /run and
// /orchestrate have had since agent/core/runHistoryStore.js was built. These two surfaces
// were simply never connected to it, so their trail lived only in this process.
//
// WHAT IS DELIBERATELY NOT PERSISTED: withoutResumeState() is applied first, so
// `_resumeState` never reaches disk. That is not an oversight - it is the same rule that
// keeps it out of an HTTP response (see withoutResumeState's own comment): it carries a
// non-serializable tool-result cache (a Map, which JSON.stringify silently guts) and the
// live token/usage/approval trackers that make this run's cost controls real. A saved
// copy would be a resumable-LOOKING record that is neither resumable nor safe to trust,
// so the in-memory Maps below remain the only place a run is resumed from, and an
// expired/restarted run still gets requireRunState's honest "Unrecognized or expired run
// id" rather than a silently degraded resume. What is saved is the RECORD of what
// happened, not the ability to continue it.
//
// A save failure is logged and swallowed, never allowed to fail the real response the
// user is waiting on - identical to /run and /orchestrate's own save call sites.
function saveWorkflowRunRecord({ runId, kind, businessId, result }) {
  if (typeof runId !== 'string' || !runId.trim()) return;
  try {
    // A continuation (approve/measure/next) re-saves under the SAME run_id, so the record
    // always reflects the run's latest known state rather than a stale first snapshot -
    // the overwrite-by-run_id behavior /orchestrate/approve already relies on. The
    // original business_id and created_at are read back from that first record, because
    // the continuation request bodies carry only a run id.
    const existing = runHistoryStore.getRunRecordById(runId);
    const now = new Date().toISOString();
    runHistoryStore.saveRunRecord({
      run_id: runId,
      kind,
      business_id: businessId || (existing && existing.business_id) || null,
      status: deriveWorkflowHistoryStatus(result),
      summary: buildWorkflowHistorySummary(result),
      created_at: (existing && existing.created_at) || now,
      updated_at: now,
      result: withoutResumeState(result),
    });
  } catch (saveErr) {
    console.error(`Could not save run history for ${kind}:`, saveErr.message);
  }
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
function decideRunApproval(state, { approvalId, decision, decidedBy, notes, authorization }) {
  const tracker = state.runApprovalTracker;
  if (!tracker || !Array.isArray(tracker.requests)) {
    return { ok: false, error: 'This run has no approval request to decide.' };
  }
  try {
    tracker.requests = decideApprovalRequest(tracker.requests, approvalId, {
      decision,
      decidedBy: decidedBy.trim(),
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      authorization,
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
function validateApprovalDecisionBody({ approvalId, decision, decidedBy, nonce, signature }) {
  if (typeof approvalId !== 'string' || !approvalId.trim()) {
    return { ok: false, error: 'A non-empty "approvalId" string is required.' };
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: 'A "decision" of "approved" or "rejected" is required.' };
  }
  if (typeof decidedBy !== 'string' || !decidedBy.trim()) {
    return { ok: false, error: 'A non-empty "decidedBy" string is required so every decision is accountable.' };
  }
  // A decision is only real once it carries a signature produced with a key this server
  // does not hold. Checked here so every approve endpoint refuses an unsigned decision the
  // same way, and refuses it before touching any run state.
  if (typeof nonce !== 'string' || !nonce.trim() || typeof signature !== 'string' || !signature.trim()) {
    return {
      ok: false,
      error:
        'A signed human approval is required: request a challenge from GET /approval-challenge, sign its payload, ' +
        'and submit the "nonce" and base64 "signature". A decidedBy name alone is not authorization.',
    };
  }
  return { ok: true };
}

// Finds one pending approval across every run store, so the challenge endpoint below works
// for all three orchestrators without each needing its own route. Returns the record only -
// naming a request id confers nothing by itself.
function findPendingApprovalRecord(runStores, approvalId) {
  for (const store of runStores) {
    for (const state of store.values()) {
      const tracker = state && (state.runApprovalTracker || null);
      const fromTracker = tracker && Array.isArray(tracker.requests) ? tracker.requests : null;
      const fromRun = state && Array.isArray(state.pendingApprovals) ? state.pendingApprovals : null;
      for (const list of [fromTracker, fromRun]) {
        if (!list) continue;
        const found = list.find((request) => request && request.id === approvalId);
        if (found) return found;
      }
    }
  }
  return null;
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

// ---------------------------------------------------------------------------
// The dashboard Overview's read-only composition (GET /overview below).
//
// EVERY value these helpers produce is either read straight from an already-loaded
// business config, from a credential-presence check, or COUNTED/RELAYED from a run
// record agent/core/runHistoryStore.js already saved. Nothing here estimates,
// extrapolates, scores, ranks or synthesizes - a fact this project does not already
// hold is simply absent from the payload, and the dashboard renders "No data" for it
// rather than a number. That discipline is the whole point of this surface: it exists
// to make already-real work VISIBLE, never to make an empty system look populated.
//
// There is deliberately no new engine, store, or analytics layer here - see CLAUDE.md
// rules 3-4. The opportunity relay below reads what
// agent/core/crossAgentContext.js's gatherGrowthOpportunityDrafts and each specialist's
// own result already produced; it never re-derives an opportunity of its own.
// ---------------------------------------------------------------------------

// How far back the Overview looks. Capped so a store with thousands of saved runs still
// renders one bounded, fast response - a listing, never a full history export (that is
// GET /history's job).
const OVERVIEW_HISTORY_SCAN_LIMIT = 50;
const OVERVIEW_ACTIVITY_LIMIT = 10;
const OVERVIEW_OPPORTUNITY_LIMIT = 8;
// How many Etsy listings GET /store/metrics reads per cache window. Bounded on purpose:
// this is a dashboard summary, not a catalogue export, and Etsy's shop-listings endpoint
// is paged - so one page is read and the response says so via `catalog.pagination`. The
// SHOP-WIDE totals shown as metrics come from the shop record itself, never from counting
// this page, so a bounded read can never understate the catalogue.
const ETSY_DASHBOARD_LISTING_LIMIT = 25;

// The sales channels the dashboard reports on. A channel is "connectable" only when a
// real adapter for it exists under integrations/adapters/ - today that is Shopify and
// Etsy. The remaining three are listed with a null adapter purely so the owner can see
// what this system does NOT integrate with yet; they render as unavailable, never with a
// connect control, because no code behind them exists. NO integration is added here (the
// dashboard is a presentation layer) - a platform moves off the null list the day a real
// adapter lands.
//
// `check` names the adapter method that answers "are this channel's credentials present",
// because the two adapters answer different questions: Shopify's isConfigured() covers the
// one credential set it has, while Etsy's read path and publish path are separate and only
// the read path is open. `access` records WHICH capability that check proved - 'read_only'
// for Etsy, so the dashboard can never label a read-only connection as though it could
// publish. null means "the adapter's full capability", the pre-existing behavior.
const DASHBOARD_CHANNELS = [
  { id: 'shopify', name: 'Shopify', adapter: shopifyClient, check: 'isConfigured', access: null },
  { id: 'etsy', name: 'Etsy', adapter: etsyReadClient, check: 'canRead', access: 'read_only' },
  { id: 'ebay', name: 'eBay', adapter: null, check: null, access: null },
  { id: 'amazon', name: 'Amazon', adapter: null, check: null, access: null },
  { id: 'woocommerce', name: 'WooCommerce', adapter: null, check: null, access: null },
];

// Real connection state per channel, from each adapter's OWN credential-presence check.
// That check means "credentials are present", never "the integration works" - the exact
// distinction integrations/adapters/etsyClient.js's own canPublish() documents - so the
// field is named `configured` and the dashboard labels it "Connected" only for a channel
// whose adapter is genuinely wired to a live API today. An adapter that throws is reported
// as not configured with its own message, never as connected.
//
// Every check here is zero-network by construction (shopifyClient.isConfigured() reads
// resolved credentials; etsyReadClient.canRead() counts missing env keys), which is what
// keeps GET /overview safe to call on every page load.
function buildChannelStates() {
  return DASHBOARD_CHANNELS.map((channel) => {
    const checkName = channel.check || 'isConfigured';
    if (!channel.adapter || typeof channel.adapter[checkName] !== 'function') {
      return {
        id: channel.id,
        name: channel.name,
        adapter_exists: false,
        configured: false,
        access: null,
        detail: null,
      };
    }
    try {
      return {
        id: channel.id,
        name: channel.name,
        adapter_exists: true,
        configured: Boolean(channel.adapter[checkName]()),
        access: channel.access,
        detail: null,
      };
    } catch (err) {
      return {
        id: channel.id,
        name: channel.name,
        adapter_exists: true,
        configured: false,
        access: channel.access,
        detail: err.message,
      };
    }
  });
}

// The dashboard's specialist id for a saved record's internal specialist id - the exact
// inverse of SPECIALIST_ID_MAP above, derived from it rather than maintained as a second
// list that could drift.
const INTERNAL_TO_DASHBOARD_SPECIALIST_ID = Object.fromEntries(
  Object.entries(SPECIALIST_ID_MAP).map(([dashboardId, internalId]) => [internalId, dashboardId])
);

// One honest per-specialist rollup, keyed by the dashboard's own specialist ids. A
// specialist with no saved run maps to null - which is what makes the card's "Not run
// yet" truthful instead of a default that hides real history. Summaries arrive newest
// first (listRunRecordSummaries sorts by created_at), so the first match per specialist
// is its latest run.
function buildSpecialistRollup(summaries) {
  const rollup = {};
  for (const dashboardId of Object.keys(SPECIALIST_ID_MAP)) rollup[dashboardId] = null;

  for (const summary of summaries) {
    const dashboardId = INTERNAL_TO_DASHBOARD_SPECIALIST_ID[summary.specialist_id];
    if (!dashboardId) continue;
    if (!rollup[dashboardId]) {
      rollup[dashboardId] = {
        last_run_at: summary.created_at || null,
        last_status: summary.status || null,
        last_summary: summary.summary || null,
        last_run_id: summary.run_id || null,
        last_result_count: null,
        run_count: 0,
      };
    }
    rollup[dashboardId].run_count += 1;
  }
  return rollup;
}

// The number of records a run actually returned, when - and only when - its own result
// is a list. agent/core/orchestratorExecutionContract.js puts a tool's return value at
// outputs.result, so a catalog pull lands here as a real array whose length is a fact,
// not an estimate. Anything else yields null and the dashboard shows nothing rather
// than a fabricated count.
function resultRecordCount(record) {
  const outputs = record && record.result && record.result.outputs;
  if (!outputs || !Array.isArray(outputs.result)) return null;
  return outputs.result.length;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// RELAY ONLY. Pulls the opportunity-shaped content a saved record ALREADY contains -
// agent/core/crossAgentContext.js's growth_opportunity_drafts, and the `recommendations`
// array a specialist result carries in its own right - and tags each with where it came
// from. It computes no priority, applies no ranking, and invents no field: an item's
// verification status is shown only when its source record already carries one. This is
// emphatically not a second opportunity engine (CLAUDE.md rule 4).
function extractOpportunities(record, summary) {
  if (!record || !record.result) return [];
  const specialistId = summary.specialist_id ? INTERNAL_TO_DASHBOARD_SPECIALIST_ID[summary.specialist_id] || null : null;
  const base = {
    run_id: summary.run_id || null,
    run_kind: summary.kind || null,
    specialist_id: specialistId,
    specialist_name: summary.specialist_name || (specialistId ? SPECIALIST_DISPLAY_NAMES[specialistId] : null) || null,
    created_at: summary.created_at || null,
  };
  const found = [];

  for (const draft of asArray(record.result.growth_opportunity_drafts)) {
    if (!draft || typeof draft.opportunity !== 'string' || !draft.opportunity.trim()) continue;
    found.push({
      ...base,
      source_kind: 'growth_opportunity_draft',
      title: draft.opportunity,
      reason: (typeof draft.reason === 'string' && draft.reason) || draft.requiredAction || null,
      category: draft.category || null,
      verification_status: draft.verificationStatus || null,
    });
  }

  // A specialist run's own result, and every step of a Chief Orchestrator plan, can each
  // carry a `recommendations` array produced by that capability itself. A plan step is
  // attributed to the specialist the step itself names (executionState's
  // selected_specialist) - an orchestrate record has no top-level specialist_id, so
  // without this its opportunities would be shown unattributed even though the record
  // plainly says which specialist produced them.
  const resultsCarryingRecommendations = [
    { result: record.result.outputs && record.result.outputs.result, step: null },
    ...asArray(record.result.routing && record.result.routing.plan).map((step) => ({
      result: step && step.outputs && step.outputs.result,
      step,
    })),
  ];
  for (const { result: candidate, step } of resultsCarryingRecommendations) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const stepSpecialist = step && step.selected_specialist ? step.selected_specialist : null;
    const attribution =
      stepSpecialist && stepSpecialist.id
        ? {
            specialist_id: INTERNAL_TO_DASHBOARD_SPECIALIST_ID[stepSpecialist.id] || stepSpecialist.id,
            specialist_name: stepSpecialist.title || base.specialist_name,
          }
        : {};
    for (const recommendation of asArray(candidate.recommendations)) {
      if (typeof recommendation !== 'string' || !recommendation.trim()) continue;
      found.push({
        ...base,
        ...attribution,
        source_kind: 'recommendation',
        title: recommendation,
        reason: (typeof candidate.topic === 'string' && candidate.topic) || null,
        category: candidate.capability || null,
        verification_status: candidate.verification_status || null,
      });
    }
  }

  return found;
}

// The catalogue-expansion research result carried inside one saved run record, if it has
// one. RELAY ONLY: every value below is read straight out of what
// workflows/customerMarketOpportunityWorkflow.js already produced and
// agent/core/runHistoryStore.js already saved. Nothing is recomputed, re-ranked,
// re-scored or filled in here, and no research is re-run - this reads a file on disk.
//
// WHY IT LIVES ON GET /overview. That route already loads every saved record locally to
// build its specialist rollup and opportunity list, and it is contractually zero-network.
// Surfacing the newest research result from the SAME pass costs one extra property read
// per record. The alternative - having the browser fetch /history and then GET each
// record until it finds one with opportunities - would be N round trips for data this
// loop already holds.
//
// Returns null when the record carries no such result, which is the normal case for every
// other kind of run.
function extractMarketResearchResult(record, summary) {
  const plan = record && record.result && record.result.routing && Array.isArray(record.result.routing.plan)
    ? record.result.routing.plan
    : [];
  for (const step of plan) {
    const outputs = step && step.outputs ? step.outputs : {};
    const result = outputs.result || outputs;
    if (!result || !Array.isArray(result.top_opportunities)) continue;
    return {
      available: true,
      run_id: summary.run_id || null,
      session_id: record.session_id || null,
      objective: record.objective || null,
      // The run's own saved status and the research result's own status are different
      // facts (a run can succeed while the research reports 'partial'), so both are kept.
      run_status: record.status || null,
      research_status: result.status || null,
      created_at: record.created_at || null,
      // Verbatim. `candidate_count` is the real funnel; a missing key stays missing rather
      // than becoming 0, so the dashboard can tell "measured zero" from "not reported".
      candidate_count: result.candidate_count || null,
      market_scope: result.market_scope || null,
      research_summary: result.research_summary
        ? {
            verified_source_count: result.research_summary.verified_source_count,
            sources_used: Array.isArray(result.research_summary.sources_used) ? result.research_summary.sources_used.length : null,
            model_calls: result.research_summary.model_calls,
            generated_at: result.research_summary.generated_at || null,
          }
        : null,
      opportunities: result.top_opportunities,
      excluded_count: Array.isArray(result.excluded_opportunities) ? result.excluded_opportunities.length : null,
      limitations: Array.isArray(result.limitations) ? result.limitations : [],
    };
  }
  return null;
}

// Counts the approvals a saved record genuinely recorded, split by whether a human
// decision is still outstanding. Reads only the approval objects
// agent/core/executionState.js already stores on each step - never a second approval
// system (CLAUDE.md rule 4), and never a judgment about whether one SHOULD exist.
function countRecordApprovals(record) {
  const steps = [
    record && record.result,
    ...asArray(record && record.result && record.result.routing && record.result.routing.plan),
  ];
  let pending = 0;
  let recorded = 0;
  for (const step of steps) {
    for (const approval of asArray(step && step.approvals)) {
      if (!approval || typeof approval !== 'object') continue;
      recorded += 1;
      if (approval.status === 'required') pending += 1;
    }
  }
  return { pending, recorded };
}

// The Sales Funnel's data layer.
//
// THIS FUNNEL IS MOSTLY EMPTY ON PURPOSE, AND THAT IS THE HONEST RESULT. Shopify's
// read-only Admin API exposes ORDERS. It does not expose sessions, product views, or
// add-to-cart events - that is storefront analytics, a different product surface - and
// this system has no analytics adapter that reports them (tools/analyticsDataTool.js
// offers no 'traffic' or 'conversion' capability for exactly this reason).
//
// So four of the five stages carry no number and say why. The alternative - deriving
// "views" from orders, or showing a plausible-looking cart figure - would be fabricating
// the precise numbers a funnel exists to be trusted on. An owner reading this section
// learns something real and actionable: which tracking they do not yet have.
//
// Because the upper stages are unknown, DROP-OFF BETWEEN STAGES IS NOT COMPUTED. A
// conversion percentage needs a denominator this system does not have, and inventing one
// would be the single most misleading number this dashboard could show.
const FUNNEL_UNAVAILABLE_REASON =
  "Shopify's read-only Admin API does not expose this, and no connected analytics source in this system reports it.";

function buildFunnel(salesOutcome) {
  const salesDomain =
    salesOutcome && salesOutcome.result && Array.isArray(salesOutcome.result.specialized_records)
      ? salesOutcome.result.specialized_records[0] && salesOutcome.result.specialized_records[0].sales
      : null;
  const orderMetrics =
    salesDomain && Array.isArray(salesDomain.actual_metrics)
      ? salesDomain.actual_metrics.filter((metric) => metric && metric.label === 'order')
      : [];
  const ordersKnown = Boolean(salesOutcome && salesOutcome.status !== 'failed' && salesDomain);

  return {
    // Stated up front so the section can never be read as "your funnel is broken".
    drop_off_available: false,
    drop_off_reason:
      'Stage-to-stage drop-off needs the upper-funnel counts above, which no connected source reports. It is left uncalculated rather than estimated.',
    stages: [
      { id: 'sessions', label: 'Visitors / sessions', value: null, available: false, reason: FUNNEL_UNAVAILABLE_REASON },
      { id: 'product_views', label: 'Product views', value: null, available: false, reason: FUNNEL_UNAVAILABLE_REASON },
      { id: 'add_to_cart', label: 'Add to cart', value: null, available: false, reason: FUNNEL_UNAVAILABLE_REASON },
      { id: 'checkout', label: 'Checkout started', value: null, available: false, reason: FUNNEL_UNAVAILABLE_REASON },
      {
        id: 'orders',
        label: 'Orders',
        value: ordersKnown ? orderMetrics.length : null,
        available: ordersKnown,
        reason: ordersKnown ? null : 'The live order pull did not succeed for this request.',
      },
    ],
  };
}

// Top Products, from the SAME read-only adapter the rest of this endpoint uses.
// agent/core/analyticsMetricsCalculator.js's calculateTopProductsBySales() does the
// counting - no product-ranking engine is introduced here, and no score is computed.
//
// Per-product REVENUE is absent by design: getOrders()' line items carry no per-line
// price (see calculateTopProductsBySales' own header), so it is reported as unavailable
// rather than apportioned out of each order's total.
function buildTopProducts(orders) {
  const products = calculateTopProductsBySales(Array.isArray(orders) ? orders : [], { limit: 5 });
  return {
    available: products.length > 0,
    products,
    revenue_available: false,
    revenue_reason:
      'Shopify order line items carry no per-line price in this read, so per-product revenue would have to be apportioned from the order total - it is left out rather than estimated.',
    views_available: false,
    views_reason: "Per-product views and conversion need storefront analytics, which Shopify's read-only Admin API does not expose.",
  };
}

/* ---------- Etsy: a SEPARATE channel, never merged with the Shopify data above ----------
   Everything below describes the Etsy shop alone. No figure here is combined with, derived
   from, or compared against a Shopify figure, and no record is matched across the two
   channels - agent/core/channelModel.js deliberately exports no merge or id-equivalence
   function, and this block adds none.

   READ-ONLY, AND VISIBLY SO. The two tools relayed here are classified analysis_only and
   sit on integrations/adapters/etsyReadClient.js, which issues GET requests only and
   refuses any other method before a socket is opened. No Etsy write tool is required by
   this file, so no route can reach one.

   WHY SO MANY METRICS ARE UNAVAILABLE. This integration holds exactly two Etsy scopes -
   shops_r and listings_r. Orders, revenue, buyers and shop traffic live behind scopes it
   deliberately does not request, so each is reported unavailable WITH THE REASON rather
   than shown as 0. A zero here would read as "your Etsy shop sold nothing", which is a
   fabricated claim about a real business. */
const ETSY_SCOPE_UNAVAILABLE_REASON =
  'Etsy grants this integration only the shops_r and listings_r read scopes. Order, revenue and buyer data ' +
  'live behind transactions_r/receipts_r, which are deliberately not requested.';

const ETSY_TRAFFIC_UNAVAILABLE_REASON =
  'Etsy\'s API does not report shop-level traffic or conversion to this integration, and no connected analytics ' +
  'source in this system reports it for Etsy.';

// One Etsy listing, projected to what a dashboard row actually shows.
//
// `description` is dropped on purpose: it is long raw seller copy with no row to fill, and
// carrying it would bloat every /store/metrics response. Nothing else is reshaped - each
// field is exactly what Etsy returned, and the record keeps its channel stamp so it can
// never be mistaken downstream for a Shopify product.
function projectEtsyListing(entry) {
  const listing = (entry && entry.listing) || {};
  const compliance = (entry && entry.compliance) || {};
  return {
    listing_id: listing.listing_id ?? null,
    title: listing.title ?? null,
    state: listing.state ?? null,
    url: listing.url ?? null,
    listing_type: listing.listing_type ?? null,
    is_digital_product: listing.is_digital_product ?? null,
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    taxonomy_id: listing.taxonomy_id ?? null,
    price: listing.price ?? null,
    quantity: listing.quantity ?? null,
    // Etsy DOES return these per listing, so they are shown per listing. They are never
    // summed into a shop-wide total: a sum over the page read would misdescribe a
    // catalogue larger than that page.
    num_favorers: listing.num_favorers ?? null,
    views: listing.views ?? null,
    // The channel stamp travels with the record, exactly as etsyReadClient applied it.
    channel: listing.channel ?? null,
    // The compliance verdict the retrieval tool already attached - relayed, not recomputed.
    compliance_status: compliance.status ?? null,
    missing_fact_count: Array.isArray(entry && entry.missing_facts) ? entry.missing_facts.length : null,
  };
}

// Builds the response's `etsy` key from the two tools' own {status, result, error}
// envelopes. Recomputes nothing: every available number below is a field Etsy returned.
function buildEtsyBlock({ connected, shopOutcome, listingOutcome }) {
  const shop = shopOutcome && shopOutcome.status === 'success' ? shopOutcome.result : null;

  // The reason a value is missing, in order of specificity: not connected at all, then the
  // tool's own error, then the honest fallback. Never a guess about which it was.
  const shopReason = !connected
    ? 'Etsy is not connected for reading.'
    : (shopOutcome && shopOutcome.error) || 'The Etsy shop read did not return a shop record for this request.';

  const value = (key) => (shop && shop[key] !== null && shop[key] !== undefined ? shop[key] : null);
  const known = (key) => value(key) !== null;

  const metrics = [
    {
      id: 'active_listings',
      label: 'Active listings',
      value: value('listing_active_count'),
      available: known('listing_active_count'),
      reason: known('listing_active_count') ? null : shopReason,
    },
    {
      id: 'digital_listings',
      label: 'Digital listings',
      value: value('digital_listing_count'),
      available: known('digital_listing_count'),
      reason: known('digital_listing_count') ? null : shopReason,
    },
    {
      id: 'shop_status',
      // is_vacation is a real boolean Etsy reports; null stays unavailable rather than
      // defaulting to "Open", which would claim a shop is trading when we do not know.
      label: 'Shop status',
      value: known('is_vacation') ? (value('is_vacation') ? 'On vacation' : 'Open') : null,
      available: known('is_vacation'),
      reason: known('is_vacation') ? null : shopReason,
    },
    {
      id: 'currency',
      label: 'Shop currency',
      value: value('currency_code'),
      available: known('currency_code'),
      reason: known('currency_code') ? null : shopReason,
    },
    { id: 'orders', label: 'Orders', value: null, available: false, reason: ETSY_SCOPE_UNAVAILABLE_REASON },
    { id: 'revenue', label: 'Revenue', value: null, available: false, reason: ETSY_SCOPE_UNAVAILABLE_REASON },
    { id: 'customers', label: 'Customers', value: null, available: false, reason: ETSY_SCOPE_UNAVAILABLE_REASON },
    { id: 'sessions', label: 'Visits / traffic', value: null, available: false, reason: ETSY_TRAFFIC_UNAVAILABLE_REASON },
    {
      id: 'conversion_rate',
      label: 'Conversion rate',
      value: null,
      available: false,
      reason: ETSY_TRAFFIC_UNAVAILABLE_REASON,
    },
  ];

  const listingResult = listingOutcome && listingOutcome.result ? listingOutcome.result : null;
  const listings = listingResult && Array.isArray(listingResult.listings) ? listingResult.listings : [];

  return {
    connected: Boolean(connected),
    // Stated as data, not only as UI copy, so no consumer of this payload can conclude
    // publishing is available.
    access: 'read_only',
    publishing_enabled: false,
    publishing_note:
      'Etsy publishing is intentionally disabled in this project. No Etsy write tool is registered, and the read ' +
      'client issues GET requests only.',
    shop: shop
      ? {
          shop_id: shop.shop_id ?? null,
          shop_name: shop.shop_name ?? null,
          title: shop.title ?? null,
          url: shop.url ?? null,
          currency_code: shop.currency_code ?? null,
          is_vacation: shop.is_vacation ?? null,
          channel: shop.channel ?? null,
        }
      : null,
    shop_status: shopOutcome ? shopOutcome.status : null,
    shop_error: (shopOutcome && shopOutcome.error) || null,
    metrics,
    catalog: {
      status: listingOutcome ? listingOutcome.status : null,
      error: (listingOutcome && listingOutcome.error) || null,
      // How many listings were READ this request - explicitly not the catalogue size,
      // which is the `active_listings` metric above.
      listing_count: listingResult ? listingResult.listing_count : null,
      aggregate_compliance_status: listingResult ? listingResult.aggregate_compliance_status : null,
      pagination: listingResult ? listingResult.pagination : null,
      listings: listings.map(projectEtsyListing),
      // Both need one Etsy request PER LISTING. Fetching them for a page of listings would
      // multiply this endpoint's Etsy usage by ~50 for two columns, so they are reported
      // unavailable with that reason rather than quietly fetched.
      inventory_available: false,
      inventory_reason:
        "Etsy returns inventory only from its per-listing inventory endpoint, one request per listing. It is not " +
        'fetched here to keep this dashboard within a small, predictable Etsy request budget.',
      images_available: false,
      images_reason:
        'Etsy returns images only from its per-listing images endpoint, one request per listing. It is not fetched ' +
        'here for the same reason.',
    },
  };
}

// The Performance charts' data layer.
//
// SOURCE: the `sales` capability's OWN actual_metrics - the per-order records
// tools/analyticsDataTool.js already returned from the pull this same response relays.
// So a trend costs ZERO extra Shopify calls and cannot disagree with the metric tiles
// beside it: both read the identical pulled orders. The bucketing itself is
// agent/core/analyticsMetricsCalculator.js's calculateSalesTrend() - the existing
// engine's own pure arithmetic, not a reimplementation here.
//
// WHAT IS DELIBERATELY UNAVAILABLE: sessions/traffic and conversion rate. Shopify's
// read-only Admin API exposes neither (tools/analyticsDataTool.js's header states this,
// and it is why it offers no 'traffic'/'conversion' capability at all). They are
// therefore returned as available:false carrying the real reason - never as an empty
// series, a zero line, or an estimate derived from orders.
//
// CHANNEL-READY BY CONSTRUCTION: every metric carries a `channels` ARRAY, and each
// series names the channel it came from. Today exactly one channel can populate it -
// Shopify, the only connected adapter. When a real Etsy/eBay/Amazon adapter lands, it
// appends another entry here and the chart layer renders it with no restructuring: the
// UI already loops over channels rather than assuming a single series.
const TREND_UNAVAILABLE_REASON =
  "Shopify's read-only Admin API does not expose this. No connected data source in this system reports it yet, so no trend can be shown without inventing one.";

function buildTrends(salesOutcome) {
  const salesDomain =
    salesOutcome && salesOutcome.result && Array.isArray(salesOutcome.result.specialized_records)
      ? salesOutcome.result.specialized_records[0] && salesOutcome.result.specialized_records[0].sales
      : null;
  const actualMetrics = salesDomain && Array.isArray(salesDomain.actual_metrics) ? salesDomain.actual_metrics : [];

  // actual_metrics entries are orderToActualMetric()'s shape ({ value, unit, createdAt })
  // - mapped back onto the canonical order field names calculateSalesTrend() shares with
  // its sibling calculators. A pure rename, never a recomputation.
  const orders = actualMetrics
    .filter((metric) => metric && metric.label === 'order')
    .map((metric) => ({ totalPrice: metric.value, currency: metric.unit, createdAt: metric.createdAt }));

  const trend = calculateSalesTrend(orders);
  const limitations =
    salesOutcome && salesOutcome.result && Array.isArray(salesOutcome.result.limitations)
      ? salesOutcome.result.limitations
      : [];

  const available = Boolean(trend);
  const channelsFor = (valueKey) =>
    available
      ? [
          {
            id: 'shopify',
            name: 'Shopify',
            points: trend.points.map((point) => ({ t: point.bucket_start, value: point[valueKey] })),
          },
        ]
      : [];

  return {
    available,
    // Null when nothing usable was pulled - the dashboard then says "No data available"
    // rather than drawing an axis around an empty range.
    granularity: available ? trend.granularity : null,
    range: available ? trend.range : null,
    currency: available ? trend.currency : null,
    order_count: available ? trend.order_count : 0,
    ignored_currencies: available ? trend.ignored_currencies : [],
    // Passed straight through so the chart can state the same capped-read caveat the
    // metric tiles do - a trend over a capped pull is never presented as the full history.
    limitations,
    metrics: [
      {
        id: 'revenue',
        label: 'Revenue',
        unit: available ? trend.currency : null,
        available,
        reason: available ? null : 'No usable orders were returned by the connected store.',
        channels: channelsFor('revenue'),
      },
      {
        id: 'orders',
        label: 'Orders',
        unit: null,
        available,
        reason: available ? null : 'No usable orders were returned by the connected store.',
        channels: channelsFor('orders'),
      },
      { id: 'sessions', label: 'Sessions / traffic', unit: null, available: false, reason: TREND_UNAVAILABLE_REASON, channels: [] },
      { id: 'conversion_rate', label: 'Conversion rate', unit: '%', available: false, reason: TREND_UNAVAILABLE_REASON, channels: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// The Overview's business + AI visibility sections. Every one of these is composed
// from state this process ALREADY holds - saved run records, the audit/approval data
// those records carry, and each adapter's own connection check. None of them fetches
// anything, runs a specialist, or spends a model token, so they stay safe on every
// page load.
//
// The standing rule from the sections above applies unchanged here: a figure this
// project cannot support is ABSENT (null), and the dashboard renders "No data" for it.
// Nothing below estimates, apportions, or scores.
// ---------------------------------------------------------------------------

// Which saved-record kinds represent the Chief/orchestration layer rather than a single
// specialist run. Used by both the orchestrator status panel and the AI-impact counts.
const ORCHESTRATION_KINDS = ['orchestrate', 'growth_workflow', 'optimization_cycle'];

// "What has the AI actually contributed?" - every entry is a COUNT of real saved records
// or of the approval/opportunity objects those records already carry. A metric whose
// basis does not exist yet is emitted with value null rather than 0, because "we have
// never done this" and "we did this zero times" read identically as a bare 0 and only
// one of them is true here.
function buildAiImpact({ summaries, specialists, opportunities, approvals, usage }) {
  const successful = summaries.filter((summary) => summary.status === 'success');
  const orchestrationRuns = summaries.filter((summary) => ORCHESTRATION_KINDS.includes(summary.kind));
  const seoOpportunities = opportunities.filter((opportunity) => opportunity.specialist_id === 'seo');

  // The catalog size the most recent Product run actually retrieved. Deliberately NOT
  // summed across runs: re-running Product re-reads the same catalog, so a sum would
  // report 150 "products analyzed" for one 50-product store.
  const productEntry = specialists.product;
  const productsAnalyzed = productEntry && typeof productEntry.last_result_count === 'number'
    ? productEntry.last_result_count
    : null;

  return [
    {
      id: 'products_analyzed',
      label: 'Products analyzed',
      value: productsAnalyzed,
      detail: productsAnalyzed === null ? null : 'in the most recent Product run',
    },
    {
      id: 'opportunities_identified',
      label: 'Opportunities identified',
      value: opportunities.length,
      detail: 'relayed from saved results',
    },
    {
      id: 'seo_opportunities',
      label: 'SEO opportunities',
      value: seoOpportunities.length,
      detail: null,
    },
    {
      id: 'tasks_completed',
      label: 'Tasks completed',
      value: successful.length,
      detail: `of ${summaries.length} saved run(s)`,
    },
    {
      id: 'workflows_run',
      label: 'Orchestrated runs',
      value: orchestrationRuns.length,
      detail: 'Chief / workflow / cycle',
    },
    {
      id: 'actions_gated',
      label: 'Actions gated for approval',
      value: approvals.recorded,
      detail: approvals.pending > 0 ? `${approvals.pending} still pending` : 'none outstanding',
    },
    {
      id: 'model_tokens',
      label: 'Model tokens used',
      value: usage.tokens_total,
      detail: usage.tokens_total === null ? null : `across ${usage.runs_with_usage} run(s) that recorded usage`,
    },
  ];
}

// "What should the owner do next?" - a ROUTER over work this project has already
// produced, never a second recommendation engine. Each card is triggered by one concrete,
// checkable fact, and `basis` names that fact so the ordering is never an opaque score
// the owner has to trust. `page` is an existing dashboard page id, so every button lands
// on real functionality - there are no decorative buttons here.
function buildNextActions({ opportunities, specialists, approvals, summaries, channels }) {
  const actions = [];

  // 1. A human decision that is actually blocking a gated action outranks everything
  // else: nothing else the owner does will unblock it.
  if (approvals.pending > 0) {
    actions.push({
      id: 'review_approvals',
      title: `Review ${approvals.pending} action(s) waiting for your approval`,
      basis: 'These are gated in saved runs and cannot proceed without a human decision.',
      emphasis: 'high',
      cta: 'Review',
      page: 'approvals',
    });
  }

  // 2. A store that is not connected makes every other recommendation moot.
  const shopify = channels.find((channel) => channel.id === 'shopify');
  if (!shopify || !shopify.configured) {
    actions.push({
      id: 'connect_store',
      title: 'Connect your Shopify store',
      basis: 'No Shopify credentials are configured, so no specialist can read real store data.',
      emphasis: 'high',
      cta: 'View channels',
      page: 'overview',
    });
  }

  // 3. Opportunities the specialists already produced, strongest evidence first. A
  // 'verified' verification_status is the source record's OWN judgment - relayed, not
  // assigned here.
  const rankedOpportunities = [...opportunities].sort((a, b) => {
    const score = (o) => (o.verification_status === 'verified' ? 1 : 0);
    return score(b) - score(a);
  });
  for (const opportunity of rankedOpportunities.slice(0, 2)) {
    actions.push({
      id: `opportunity_${opportunity.run_id}_${actions.length}`,
      title: opportunity.title,
      basis:
        (opportunity.specialist_name ? `${opportunity.specialist_name} produced this` : 'Produced by a saved run') +
        (opportunity.verification_status === 'verified' ? ', from verified evidence.' : '.'),
      emphasis: opportunity.verification_status === 'verified' ? 'high' : 'normal',
      cta: 'View result',
      page: 'history',
      run_id: opportunity.run_id,
    });
  }

  // 4. A specialist that stopped because the request lacked structured input is a
  // concrete, fixable gap - the run's own summary already says exactly what was missing.
  const blocked = summaries.find((summary) => summary.status === 'partial' && summary.specialist_id);
  if (blocked) {
    const dashboardId = INTERNAL_TO_DASHBOARD_SPECIALIST_ID[blocked.specialist_id];
    actions.push({
      id: 'unblock_specialist',
      title: `Give ${blocked.specialist_name || dashboardId || 'a specialist'} the input it asked for`,
      basis: blocked.summary || 'This run stopped because a required input was missing.',
      emphasis: 'normal',
      cta: 'Open',
      page: 'specialists',
      specialist_id: dashboardId || null,
    });
  }

  // 5. A specialist that has genuinely never run is real unused capability.
  const neverRun = Object.keys(specialists).filter((id) => !specialists[id]);
  if (neverRun.length > 0) {
    actions.push({
      id: 'run_unused_specialist',
      title: `Run ${SPECIALIST_DISPLAY_NAMES[neverRun[0]] || neverRun[0]} for the first time`,
      basis: `${neverRun.length} of ${Object.keys(specialists).length} specialists have never been run.`,
      emphasis: 'normal',
      cta: 'Run',
      page: 'specialists',
      specialist_id: neverRun[0],
    });
  }

  return actions.slice(0, 5);
}

// The Chief/orchestration layer's real state, read from what it already saved. This adds
// no status system of its own: `last_*` comes from the newest orchestration record, and
// `paused_awaiting_approval` is the live count of runs THIS server process is holding
// mid-flight for a human decision (server.js's orchestratorRuns and the two workflow
// Maps - see their own comments on why that state is deliberately per-process).
//
// 'ready' means idle, not "healthy": with no orchestration record saved yet there is
// simply nothing to report, and that is said plainly rather than dressed up as a status.
function buildOrchestratorStatus({ summaries, pausedCount }) {
  const latest = summaries.find((summary) => ORCHESTRATION_KINDS.includes(summary.kind)) || null;

  let state;
  if (pausedCount > 0) state = 'waiting_for_approval';
  else if (!latest) state = 'ready';
  else if (latest.status === 'success') state = 'completed';
  else if (latest.status === 'error') state = 'error';
  else state = 'incomplete';

  return {
    state,
    paused_awaiting_approval: pausedCount,
    last_run: latest
      ? {
          run_id: latest.run_id,
          kind: latest.kind,
          objective: latest.objective || null,
          status: latest.status || null,
          summary: latest.summary || null,
          created_at: latest.created_at || null,
        }
      : null,
    // Said explicitly so an empty panel is never mistaken for a broken orchestrator.
    detail: latest ? null : 'The Chief Orchestrator has no saved run yet.',
  };
}

// Real model/tool usage, summed from the usage ledgers usage/usageTracker.js already
// wrote into saved run records. Nothing is estimated.
//
// COST IS DELIBERATELY ABSENT. This project has no price table anywhere - usage/
// usageRecordModel.js's own comment calls a pricing engine a FUTURE addition - so any
// currency figure here would be invented. Tokens are reported; cost is not, and the
// dashboard says why rather than showing a plausible-looking number.
//
// Coverage is reported honestly too: today only the orchestration endpoints thread a
// usage ledger into what they save, so `runs_with_usage` is usually smaller than the
// total run count. Presenting the token sum without that denominator would imply the
// figure covers every run, which it does not.
function buildAiUsage(records) {
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensTotal = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let runsWithUsage = 0;
  let sawAnyTokens = false;

  for (const record of records) {
    const summary = record && record.result && record.result.usage_summary;
    if (!summary || typeof summary !== 'object' || !summary.by_category) continue;
    runsWithUsage += 1;

    const model = summary.by_category.model_call;
    if (model && typeof model === 'object') {
      if (Number.isFinite(model.tokens_input)) { tokensInput += model.tokens_input; sawAnyTokens = true; }
      if (Number.isFinite(model.tokens_output)) { tokensOutput += model.tokens_output; sawAnyTokens = true; }
      if (Number.isFinite(model.tokens_total)) { tokensTotal += model.tokens_total; sawAnyTokens = true; }
      if (Number.isFinite(model.count)) modelCalls += model.count;
    }
    const tool = summary.by_category.tool_call;
    if (tool && Number.isFinite(tool.count)) toolCalls += tool.count;
  }

  return {
    available: runsWithUsage > 0,
    runs_with_usage: runsWithUsage,
    // null rather than 0 when no run recorded a token count - see this file's standing rule.
    tokens_input: sawAnyTokens ? tokensInput : null,
    tokens_output: sawAnyTokens ? tokensOutput : null,
    tokens_total: sawAnyTokens ? tokensTotal : null,
    model_calls: runsWithUsage > 0 ? modelCalls : null,
    tool_calls: runsWithUsage > 0 ? toolCalls : null,
    cost: null,
    cost_reason:
      'This project has no model price table, so an AI cost figure would have to be invented. Tokens are reported; cost is not.',
  };
}

// Store-health lines, each stating a fact this server can already verify. No line is
// emitted on a hunch, and a healthy system honestly reports "ok" rather than inventing a
// warning to look vigilant.
// Which AI provider AI_PROVIDER selects, and whether THAT provider's key is present. Zero
// network, like every other check GET /overview makes - see agent/core/aiProviderStatus.js.
// "configured" means a key is set, not that a model call has succeeded, so the dashboard says
// "configured", never "connected". No key, and no raw AI_PROVIDER value, is ever returned.
function buildAiProviderStatus() {
  return aiProviderStatus.getAiProviderStatus();
}

function buildHealthChecks({ channels, summaries, historyReadable, approvals }) {
  const checks = [];

  const shopify = channels.find((channel) => channel.id === 'shopify');
  checks.push({
    id: 'shopify_connection',
    status: shopify && shopify.configured ? 'ok' : 'warn',
    label: shopify && shopify.configured ? 'Shopify credentials configured' : 'Shopify not connected',
    detail: shopify && shopify.configured ? null : 'Set the Shopify credentials in .env - see .env.example.',
  });

  // Etsy is reported only as a READ connection, because that is the only Etsy capability
  // this project has. It is never described as "connected" in a way that could be read as
  // "can publish" - publishing stays closed by design, not by a missing credential.
  const etsy = channels.find((channel) => channel.id === 'etsy');
  checks.push({
    id: 'etsy_read_connection',
    status: etsy && etsy.configured ? 'ok' : 'warn',
    label: etsy && etsy.configured ? 'Etsy connected for reading' : 'Etsy not connected for reading',
    detail:
      etsy && etsy.configured
        ? 'Read-only: listings are read under shops_r and listings_r. Publishing to Etsy is intentionally disabled.'
        : 'Run `npm run integrations:etsy-authorize` and set the Etsy values in .env - see .env.example.',
  });

  checks.push({
    id: 'run_history',
    status: historyReadable ? 'ok' : 'warn',
    label: historyReadable ? 'Run history readable' : 'Run history could not be read',
    detail: historyReadable ? `${summaries.length} saved run(s) available.` : null,
  });

  const failed = summaries.filter((summary) => summary.status === 'error');
  if (failed.length > 0) {
    checks.push({
      id: 'failed_runs',
      status: 'error',
      label: `${failed.length} saved run(s) failed`,
      detail: failed[0].summary || null,
    });
  }

  const partial = summaries.filter((summary) => summary.status === 'partial');
  if (partial.length > 0) {
    checks.push({
      id: 'partial_runs',
      status: 'warn',
      label: `${partial.length} run(s) stopped for missing input`,
      detail: partial[0].summary || null,
    });
  }

  checks.push({
    id: 'pending_approvals',
    status: approvals.pending > 0 ? 'warn' : 'ok',
    label: approvals.pending > 0 ? `${approvals.pending} approval(s) recorded as still required` : 'No approvals outstanding in saved runs',
    detail: null,
  });

  return checks;
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
  // Rate limit -> authenticate -> authorize the requested business, in that order, on EVERY
  // protected endpoint. requireAuthorizedBusiness is in the shared chain rather than on the
  // three routes that happen to read a business_id today, so a future business-scoped
  // endpoint is covered the day it is added instead of the day someone remembers to guard
  // it. A request naming no business_id passes straight through - that is the server's own
  // root-.env business, and the single-business deployment is unchanged.
  const protect = [createRateLimiter(), requireApiKey, requireAuthorizedBusiness];

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
  // identical, deliberate stance orchestratorRuns documents above, and NOT for want of a
  // persistence engine: agent/core/runHistoryStore.js exists and every one of these runs
  // is now saved to it (see saveWorkflowRunRecord). What is not persisted is precisely
  // this resume state, because a JSON copy of it would be neither resumable (its
  // tool-result cache is a Map that JSON.stringify guts) nor safe to trust (its trackers
  // ARE this run's cost controls). The record of what happened is durable; the ability to
  // continue it stays bound to this process, and an expired run gets requireRunState's
  // honest error rather than a silently degraded resume.
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

  /* ---------- Etsy read-only analysis, through the EXISTING specialist path ----------
     Runs the existing SEO or Listing specialist against one real Etsy listing. This is a
     thin, channel-aware ENTRY POINT, not a second execution path: it assembles evidence
     from data Etsy actually returned and then calls the very same
     orchestratorExecutionContract.buildPlanStep() that POST /run above uses, with the
     same permission, budget, approval and audit machinery. No new agent, no second SEO or
     Listing implementation, no workflow engine.

     WHY IT IS A SERVER ROUTE AND NOT A BROWSER-BUILT /run CALL. Provenance has to be
     trustworthy. If the dashboard assembled the evidence and posted it to /run, every
     "source" in the resulting analysis would be a client-supplied string this server had
     no way to verify - a forged provenance chain by construction. Here the evidence is
     read from Etsy on this side of the boundary, so each source names the real endpoint
     and the real listing id.

     READ-ONLY, STRUCTURALLY. The only Etsy call it can make is the same GET-only listings
     read the dashboard already performs, and both specialists it can reach
     (seo_analysis, listing_content_generation) are classified analysis_only and produce
     text. There is no Etsy write tool in the registry for this route to select even if it
     tried, and it pins the tool explicitly rather than routing by free text.

     THE EVIDENCE RULE, which is the whole point. Evidence is built ONLY from structural
     fields Etsy returned - listing_type, state, tags, taxonomy_id, quantity, title length,
     favourites, views. The listing DESCRIPTION is deliberately NOT mined for facts: it is
     seller-written marketing copy, so its claims (file formats, "editable in Canva",
     licensing) are content to be SCRUTINISED by compliance, never evidence that those
     things are true. Anything Etsy did not state structurally is reported as
     NEEDS_INFORMATION, never filled in. */
  const ETSY_ANALYSES = {
    seo: {
      specialistId: 'seo',
      toolId: 'seo_analysis',
      capabilityId: 'product_seo',
      label: 'SEO analysis',
    },
    listing: {
      specialistId: 'listing',
      toolId: 'listing_content_generation',
      capabilityId: 'marketplace_format',
      label: 'Listing analysis',
    },
  };

  // Facts Etsy itself stated about this listing, each carrying the real endpoint and
  // listing id it came from. Nothing here is derived from the description.
  function buildEtsyEvidence(listing, source) {
    const evidence = [
      { topic: 'Listing type', finding: `Etsy reports listing_type='${listing.listing_type}'.`, source },
      { topic: 'Listing state', finding: `Etsy reports state='${listing.state}'.`, source },
      {
        // Reported as a COUNT of what Etsy returned, deliberately not as "N of 13". Etsy's
        // own OpenAPI spec declares no maxItems for tags and no maxLength for title, so a
        // ceiling stated here would be an unsourced number - precisely the kind of
        // invented fact this integration refuses to produce.
        topic: 'Tag coverage',
        finding: `Etsy returned ${listing.tags.length} tag(s) on this listing: ${listing.tags.join(', ') || 'none'}.`,
        source,
      },
      { topic: 'Taxonomy', finding: `Etsy reports taxonomy_id=${listing.taxonomy_id}.`, source },
      { topic: 'Title', finding: `The title Etsy returned is ${String(listing.title || '').length} characters long.`, source },
    ];
    // Only reported when Etsy actually returned a number - an absent count is left out
    // entirely rather than asserted as zero.
    if (typeof listing.num_favorers === 'number') {
      evidence.push({ topic: 'Favourites', finding: `Etsy reports num_favorers=${listing.num_favorers}.`, source });
    }
    if (typeof listing.views === 'number') {
      evidence.push({ topic: 'Views', finding: `Etsy reports views=${listing.views}.`, source });
    }
    if (typeof listing.quantity === 'number') {
      evidence.push({ topic: 'Quantity', finding: `Etsy reports quantity=${listing.quantity}.`, source });
    }
    return evidence;
  }

  // Real, checkable observations about THIS listing's own data - each one a count or a
  // presence/absence fact that can be re-derived from the same Etsy response.
  //
  // WHAT IS NOT HERE, ON PURPOSE: search volume, ranking, competitor content, or a
  // "recommended" title length. This system has no keyword-volume source, no rank
  // tracker, and no licence to copy another seller's listing - so a claim that a term is
  // "high volume", or that a title should be some particular length, would be fabricated.
  // Etsy's own OpenAPI spec declares no maxLength for title and no maxItems for tags, so
  // even the platform ceiling is not a number this code may assert.
  function buildEtsySeoObservations(listing) {
    const observations = [
      `The title Etsy returned is ${String(listing.title || '').length} characters long.`,
      `Etsy returned ${listing.tags.length} tag(s) on this listing.`,
    ];
    if (listing.tags.length === 0) {
      observations.push('Etsy returned no tags at all for this listing.');
    }
    if (listing.taxonomy_id === null || listing.taxonomy_id === undefined) {
      observations.push('Etsy returned no taxonomy_id for this listing.');
    }
    return observations;
  }

  app.post('/etsy/analyze', protect, async (req, res) => {
    const { listing_id: listingIdInput, analysis: analysisInput } = req.body || {};
    const analysis = ETSY_ANALYSES[String(analysisInput || '').trim()];
    if (!analysis) {
      res.status(400).json({ error: `"analysis" must be one of: ${Object.keys(ETSY_ANALYSES).join(', ')}.` });
      return;
    }
    // Etsy listing ids are positive integers. Validated before it can be compared against
    // anything, and never substituted into a URL by this route at all.
    const listingId = String(listingIdInput === undefined || listingIdInput === null ? '' : listingIdInput).trim();
    if (!/^[0-9]+$/.test(listingId)) {
      res.status(400).json({ error: 'A numeric "listing_id" is required.' });
      return;
    }

    // FAIL CLOSED. No Etsy request is attempted when reading is not configured.
    if (!etsyReadClient.canRead()) {
      res.status(409).json({
        error: 'Etsy is not connected for reading, so no Etsy listing can be analysed. No Etsy request was attempted.',
      });
      return;
    }

    try {
      // The SAME bounded, read-only listings pull the dashboard already performs. Within
      // etsyReadClient's own response-cache TTL this costs NO new Etsy request, and its
      // in-flight de-duplication means two people triggering an analysis at once still
      // produce one read. No per-listing GET, no inventory read, no images read - the
      // shop-listings response already carries every field the evidence below uses.
      const listingOutcome = await etsyListingDataTool.runEtsyListingDataTool({ limit: ETSY_DASHBOARD_LISTING_LIMIT });
      if (!listingOutcome.result || !Array.isArray(listingOutcome.result.listings)) {
        res.status(502).json({ error: listingOutcome.error || 'Etsy listings could not be read for this request.' });
        return;
      }

      const entry = listingOutcome.result.listings.find((item) => String(item.listing.listing_id) === listingId);
      if (!entry) {
        res.status(404).json({
          error: `Listing ${listingId} was not in the page of listings read from this shop. No analysis was run.`,
        });
        return;
      }

      const listing = entry.listing;
      // Provenance names the real endpoint and the real listing - never a placeholder.
      const source = [`Etsy Open API v3 getListingsByShop - listing ${listing.listing_id}, shop ${listing.shop_id}`];
      const evidence = buildEtsyEvidence(listing, source);
      const productReference = `Etsy listing ${listing.listing_id}`;
      const objective = `${analysis.label} for Etsy listing ${listing.listing_id} ("${listing.title}") in shop ${listing.shop_id}.`;

      const researchParams =
        analysis.specialistId === 'seo'
          ? {
              seoCapability: 'product_seo',
              productReference,
              internalOptimizationOpportunities: buildEtsySeoObservations(listing),
              evidence,
            }
          : {
              listingCapability: 'marketplace_format',
              // The channel travels INTO the agent, so the draft is produced for Etsy
              // rather than for a generic or Shopify-shaped listing.
              marketplace: 'etsy',
              productReference,
              sourceListing: { productTitle: listing.title },
              evidence,
            };

      // Per-run trackers, exactly as POST /ask builds them - caller-held, never
      // module-level, so two concurrent analyses can never share a budget or a trail.
      const runId = `etsy-${analysis.specialistId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const runAuditTracker = createAuditTracker(runId, null);
      const runUsageLedger = createUsageLedger(runId, null);

      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget(analysis.specialistId),
        objective,
        objective,
        { tokensUsedThisRun: 0 },
        researchParams,
        [],
        { requests: [] },
        runAuditTracker,
        createToolResultCache(),
        createUsageTracker(),
        null,
        runUsageLedger,
        // Pinned rather than free-text routed, the same mechanism /ask uses. buildPlanStep
        // still refuses a tool outside this specialist's own real ownership, so pinning
        // can never reach a tool the specialist does not own - and no Etsy write tool
        // exists for it to reach in any case.
        { toolId: analysis.toolId, capabilityId: analysis.capabilityId }
      );

      const status =
        step.completion_state === 'complete' ? 'success' : step.completion_state === 'failed' ? 'error' : 'partial';
      const summary = summarizeExecutionState(step);

      // COMPLIANCE TRAVELS WITH THE RESULT. The verdict on the listing's EXISTING content
      // was already computed by the retrieval tool through the shared engine
      // (compliance/etsyComplianceInput.js) - it is relayed here, never recomputed and
      // never softened, so no Etsy content circulates without it. `missing_facts` is the
      // machine-readable NEEDS_INFORMATION list: the product facts this listing's own data
      // does not establish, which is why no draft may assert them.
      const compliance = {
        status: entry.compliance.status,
        review_reasons: entry.compliance.review_reasons,
        limitations: entry.compliance.limitations,
        checked_at: entry.compliance.checked_at,
        checker_version: entry.compliance.checker_version,
        needs_information: entry.missing_facts,
      };

      const responseBody = {
        ...step,
        status,
        summary,
        channel: etsyReadClient.ETSY_CHANNEL,
        analysis: analysis.specialistId,
        // Draft/analysis only, stated in the payload itself so no consumer can read this
        // as an applied change. Acting on it would be a separate, human-approved action
        // that this project has no Etsy path for.
        applied_to_etsy: false,
        etsy_write_attempted: false,
        listing: {
          listing_id: listing.listing_id,
          shop_id: listing.shop_id,
          title: listing.title,
          url: listing.url,
          channel: listing.channel,
        },
        provenance: { source, endpoint: 'getListingsByShop', listing_id: listing.listing_id },
        compliance,
        // Why the Listing draft reports "partial" rather than reformatting anything. The
        // marketplace-format capability truncates/maps against caller-supplied constraints,
        // and Etsy's own OpenAPI spec declares no maxLength for title and no maxItems for
        // tags - so there is no sourced ceiling to supply. Passing a plausible-looking
        // number (a "140-character title limit") would make every future draft silently
        // truncate real copy against a figure nothing backs. Reporting the gap is the
        // correct outcome, not a failure.
        format_constraints:
          analysis.specialistId === 'listing'
            ? {
                supplied: false,
                reason:
                  "Etsy's own OpenAPI spec declares no maximum title length and no maximum tag count, so no format " +
                  'constraint could be sourced. None was invented, and the listing content was carried through unchanged.',
              }
            : null,
      };

      try {
        runHistoryStore.saveRunRecord({
          run_id: runId,
          kind: 'run',
          objective,
          specialist_id: analysis.specialistId,
          specialist_name: SPECIALIST_DISPLAY_NAMES[analysis.specialistId] || analysis.specialistId,
          // The explicit channel metadata Activity/History renders. Set because THIS
          // endpoint knows the channel for certain, never inferred downstream.
          channel: etsyReadClient.ETSY_CHANNEL,
          channel_reference: String(listing.listing_id),
          status,
          summary,
          created_at: new Date().toISOString(),
          result: responseBody,
        });
      } catch (saveErr) {
        console.error('Could not save run history for /etsy/analyze:', saveErr.message);
      }

      res.json({ ...responseBody, run_id: runId });
    } catch (err) {
      console.error('POST /etsy/analyze failed:', err.message);
      res.status(502).json({ error: 'The Etsy analysis could not complete right now. Please try again shortly.' });
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

      // DURABLE PENDING STATE, WRITTEN AT CREATION TIME.
      //
      // THE DEFECT THIS CLOSES. orchestratorRuns above is an in-memory Map, and it was the
      // ONLY record of a pending approval this endpoint produced. A correction approved
      // through /orchestrate/approve therefore verified correctly and then refused to
      // execute, because integrations/approvedCorrectionDispatch.js deliberately accepts
      // authorization ONLY from stored, server-written state - and nothing had ever been
      // stored. Observed end to end: apr-1 passed all 8 Ed25519 checks, reached status
      // 'approved', and still could not execute ("not in durable approval state").
      //
      // Written HERE, before a challenge can be issued for this approval, so the durable
      // record always exists first and the store is never the thing lagging behind.
      // approvals/approvalStore.js is the existing store and the same one the dispatcher
      // reads - no second persistence mechanism, and the record itself is unchanged.
      //
      // GRANTS NOTHING. The stored record is 'awaiting_decision': persisting a PENDING
      // approval is not approving it. Only a verified Ed25519 decision moves it on, and
      // every existing check still applies. A write failure is logged and never allowed to
      // fail the run - but it does leave that approval unexecutable, which is the correct
      // fail-closed direction and is exactly what the old behaviour did for every approval.
      for (const pendingApproval of result.pending_approvals || []) {
        try {
          approvalStore.saveApprovalRecord(pendingApproval, { executionState: 'awaiting_decision' });
        } catch (storeErr) {
          console.error(
            `Could not persist pending approval '${pendingApproval && pendingApproval.id}':`,
            storeErr.message
          );
        }
      }
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
    const { runId, approvalId, decision, decidedBy, notes, nonce, signature } = req.body || {};

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
    // Same signed-approval requirement as the other two approve endpoints.
    if (typeof nonce !== 'string' || !nonce.trim() || typeof signature !== 'string' || !signature.trim()) {
      res.status(400).json({
        error:
          'A signed human approval is required: request a challenge from GET /approval-challenge, sign its payload, ' +
          'and submit the "nonce" and base64 "signature". A decidedBy name alone is not authorization.',
      });
      return;
    }

    const run = orchestratorRuns.get(runId);
    let decidedRequest;
    try {
      // THE SAME RECORD, MOVED TO ITS DECIDED STATE IN DURABLE STORAGE.
      //
      // decideAndPersistApprovalRequest is decideApprovalRequest plus the store write, in
      // that order: the Ed25519 verification runs FIRST and throws before anything is
      // written, so a forged, replayed or expired signature never reaches the store and
      // can never leave an 'approved' record behind. The persisted record carries the
      // verified approval_provenance the decision produced, which is what
      // integrations/approvedCorrectionDispatch.js re-reads and re-checks (status
      // 'approved' AND provenance.method === 'ed25519_signature') before it will dispatch.
      //
      // Nothing here weakens a check: same function, same verification, same single-use
      // nonce, same fingerprint binding, same execute-once claim downstream. decidedBy
      // remains a label, never authorization.
      const updatedRequests = decideAndPersistApprovalRequest(run.pendingApprovals, approvalId, {
        decision,
        decidedBy: decidedBy.trim(),
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
        authorization: { nonce, signature },
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
      saveWorkflowRunRecord({
        runId: result && result.run_id,
        kind: 'growth_workflow',
        businessId: businessId || null,
        result,
      });
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
    const { run_id: runId, approvalId, decision, decidedBy, notes, nonce, signature } = req.body || {};

    const bodyCheck = validateApprovalDecisionBody({ approvalId, decision, decidedBy, nonce, signature });
    if (!bodyCheck.ok) {
      res.status(400).json({ error: bodyCheck.error });
      return;
    }
    const runLookup = requireRunState(growthWorkflowRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }

    const decisionResult = decideRunApproval(runLookup.state, {
      approvalId,
      decision,
      decidedBy,
      notes,
      authorization: { nonce, signature },
    });
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
      saveWorkflowRunRecord({ runId, kind: 'growth_workflow', businessId: null, result });
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
      saveWorkflowRunRecord({
        runId: result && result.run_id,
        kind: 'optimization_cycle',
        businessId: businessId || null,
        result,
      });
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
    const { run_id: runId, approvalId, decision, decidedBy, notes, nonce, signature } = req.body || {};

    const bodyCheck = validateApprovalDecisionBody({ approvalId, decision, decidedBy, nonce, signature });
    if (!bodyCheck.ok) {
      res.status(400).json({ error: bodyCheck.error });
      return;
    }
    const runLookup = requireRunState(optimizationCycleRuns, runId);
    if (!runLookup.ok) {
      res.status(400).json({ error: runLookup.error });
      return;
    }

    const decisionResult = decideRunApproval(runLookup.state, {
      approvalId,
      decision,
      decidedBy,
      notes,
      authorization: { nonce, signature },
    });
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
      saveWorkflowRunRecord({ runId, kind: 'optimization_cycle', businessId: null, result });
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
      saveWorkflowRunRecord({ runId, kind: 'optimization_cycle', businessId: null, result });
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
      saveWorkflowRunRecord({ runId, kind: 'optimization_cycle', businessId: null, result });
      res.json(withoutResumeState(result));
    } catch (err) {
      console.error('POST /optimization-cycle/next failed:', err.message);
      res.status(502).json({ error: 'The next iteration could not be started right now. Please try again shortly.' });
    }
  });

  // -------------------------------------------------------------------------
  // The dashboard Overview's two read-only surfaces. Both are GET, both go through the
  // same `protect` boundary as every other endpoint, and NEITHER runs a specialist,
  // spends a model token, or writes anything anywhere.
  // -------------------------------------------------------------------------

  // Everything the Overview can show WITHOUT touching an external service: the business
  // identity this process already loaded, each adapter's own credential-presence check,
  // and a rollup/relay over the runs agent/core/runHistoryStore.js already saved. Zero
  // network calls, so the dashboard can call it on every page load without cost - which
  // is exactly why store metrics live in a separate endpoint below rather than here.
  app.get('/overview', protect, (req, res) => {
    const channels = buildChannelStates();

    let summaries;
    let historyReadable = true;
    try {
      summaries = runHistoryStore.listRunRecordSummaries({ limit: OVERVIEW_HISTORY_SCAN_LIMIT });
    } catch (err) {
      // An unreadable history is reported as a health fact, never as zero runs - "we
      // could not read this" and "there is nothing here" are different truths.
      console.error('GET /overview could not read run history:', err.message);
      summaries = [];
      historyReadable = false;
    }

    const specialists = buildSpecialistRollup(summaries);
    // summaries are newest-first (listRunRecordSummaries sorts by created_at), so the
    // FIRST record carrying a research result is the latest one. Nothing re-runs.
    let marketResearch = null;
    const opportunities = [];
    const approvals = { pending: 0, recorded: 0 };

    // One pass over the same bounded listing, reading each record once for the details a
    // summary does not carry (opportunities, approvals, result size). A record that has
    // gone missing or unreadable is skipped rather than faked.
    const loadedRecords = [];
    for (const summary of summaries) {
      if (!summary.run_id) continue;
      let record;
      try {
        record = runHistoryStore.getRunRecordById(summary.run_id);
      } catch (err) {
        continue;
      }
      if (!record) continue;
      loadedRecords.push(record);

      opportunities.push(...extractOpportunities(record, summary));
      if (!marketResearch) marketResearch = extractMarketResearchResult(record, summary);

      const recordApprovals = countRecordApprovals(record);
      approvals.pending += recordApprovals.pending;
      approvals.recorded += recordApprovals.recorded;

      const dashboardId = INTERNAL_TO_DASHBOARD_SPECIALIST_ID[summary.specialist_id];
      const entry = dashboardId ? specialists[dashboardId] : null;
      if (entry && entry.last_run_id === summary.run_id) {
        entry.last_result_count = resultRecordCount(record);
      }
    }

    const specialistsRun = Object.values(specialists).filter(Boolean).length;

    // Real, live count of runs THIS process is holding mid-flight for a human decision.
    // Per-process by the same deliberate design documented on these Maps above - it is
    // not a scheduler and is never presented as one.
    const pausedCount = orchestratorRuns.size + growthWorkflowRuns.size + optimizationCycleRuns.size;
    const aiUsage = buildAiUsage(loadedRecords);
    const aiImpact = buildAiImpact({ summaries, specialists, opportunities, approvals, usage: aiUsage });
    const nextActions = buildNextActions({ opportunities, specialists, approvals, summaries, channels });
    const orchestrator = buildOrchestratorStatus({ summaries, pausedCount });

    res.json({
      business: {
        // Business facts only. No credential, no env var, no resolved token ever appears
        // in this payload - see verification/testing/secretExposureAudit.js's standing rule.
        name: businessConfig.business_name || null,
        platform: businessConfig.platform || null,
        store_url: businessConfig.store_url || null,
        primary_language: businessConfig.primary_language || null,
        tagline: (businessConfig.brand && businessConfig.brand.tagline) || null,
      },
      channels,
      specialists,
      specialist_names: SPECIALIST_DISPLAY_NAMES,
      activity: summaries.slice(0, OVERVIEW_ACTIVITY_LIMIT),
      // Counts of real saved records and relayed items - never a projection. A figure the
      // saved records cannot support is absent here entirely, and the dashboard says
      // "No data" instead of showing a number nothing backs.
      growth: {
        runs_total: summaries.length,
        runs_completed: summaries.filter((summary) => summary.status === 'success').length,
        runs_partial: summaries.filter((summary) => summary.status === 'partial').length,
        runs_failed: summaries.filter((summary) => summary.status === 'error').length,
        specialists_run: specialistsRun,
        specialists_total: Object.keys(SPECIALIST_ID_MAP).length,
        opportunities_found: opportunities.length,
        approvals_recorded: approvals.recorded,
        approvals_pending: approvals.pending,
        last_run_at: summaries.length > 0 ? summaries[0].created_at || null : null,
      },
      opportunities: opportunities.slice(0, OVERVIEW_OPPORTUNITY_LIMIT),
      // The latest saved catalogue-expansion research, relayed verbatim, or an honest
      // unavailable with the reason. Never triggers research - see
      // extractMarketResearchResult's own header.
      market_research:
        marketResearch || {
          available: false,
          reason: historyReadable
            ? 'No market research run yet.'
            : 'Saved run history could not be read, so it is unknown whether market research has been run.',
        },
      ai_impact: aiImpact,
      next_actions: nextActions,
      orchestrator,
      ai_usage: aiUsage,
      health: buildHealthChecks({ channels, summaries, historyReadable, approvals }),
      history_readable: historyReadable,
      ai_provider: buildAiProviderStatus(),
    });
  });

  // Real, live store metrics - the ONE place the Overview reaches Shopify. It calls the
  // existing read-only tools/analyticsDataTool.js (tool id analytics_data_retrieval) and
  // relays each capability's own { status, result, error } VERBATIM. No metric is
  // recomputed, reshaped, defaulted or filled in here; when that tool reports a source as
  // failed/degraded, the dashboard shows exactly that reason instead of a number.
  //
  // WHAT IS DELIBERATELY ABSENT: sessions, traffic and conversion rate. Shopify's
  // read-only Admin API does not expose them (see analyticsDataTool.js's own header), so
  // they are not in this payload at all and the dashboard renders them "Not available"
  // rather than inventing a figure.
  //
  // The cache below is in-memory, per-process, and lost on restart - the same deliberate
  // stance as orchestratorRuns and the two workflow Maps above. Its purpose is cost, not
  // durability: a page refresh, a second browser tab, and a returning owner all reuse one
  // live pull instead of issuing four fresh Shopify reads each time.
  const METRICS_TTL_MS = Number(process.env.OVERVIEW_METRICS_TTL_MS) > 0
    ? Number(process.env.OVERVIEW_METRICS_TTL_MS)
    : 5 * 60 * 1000;
  let metricsCache = null;

  app.get('/store/metrics', protect, async (req, res) => {
    if (metricsCache && Date.now() - metricsCache.cachedAtMs < METRICS_TTL_MS) {
      res.json({ ...metricsCache.payload, cached: true });
      return;
    }

    try {
      // Each capability is requested independently and reported independently, so one
      // missing Shopify scope (e.g. read_customers) never blanks out the others - the
      // graceful degradation analyticsDataTool.js already implements per source.
      const capabilities = ['sales', 'products', 'inventory', 'customers'];
      // Top Products needs per-order LINE ITEMS, which the analytics tool's own return
      // shape does not carry (it reports order totals). So one read-only getOrders() runs
      // alongside the capabilities - the same adapter, the same read, resolved in the same
      // round of requests and covered by the same cache below, so it costs one extra
      // Shopify read per TTL window rather than one per page load. A failure here degrades
      // Top Products alone and never blanks out the rest of the response.
      // Etsy rides this same request and this same cache, which is what keeps it to TWO
      // Etsy GETs per TTL window no matter how often the dashboard is opened or how many
      // tabs are watching. Both tools are read-only and never throw (they return a failed
      // envelope instead), and the read client below them adds its own response cache and
      // in-flight de-duplication - no second caching layer is introduced here.
      //
      // When Etsy is not connected, NO Etsy request is attempted at all: canRead() is a
      // local env check, and skipping the calls entirely is cheaper and more honest than
      // firing them to collect a predictable failure.
      const etsyConnected = etsyReadClient.canRead();
      // SEQUENTIAL ON PURPOSE, and only these two. Each Etsy read resolves an OAuth access
      // token first; running them concurrently makes both miss the token cache and perform
      // their own refresh, so one dashboard build costs two token exchanges instead of
      // one. Awaiting them in order lets the second reuse the first's cached token. The
      // pair still runs CONCURRENTLY with the Shopify reads below, so this costs no wall
      // time the Shopify pull was not already spending.
      const etsyReads = etsyConnected
        ? (async () => {
            const shopOutcome = await etsyShopDataTool.runEtsyShopDataTool({}).catch((err) => {
              console.error('GET /store/metrics could not read the Etsy shop:', err.message);
              return { status: 'failed', result: null, error: err.message };
            });
            const listingOutcome = await etsyListingDataTool
              .runEtsyListingDataTool({ limit: ETSY_DASHBOARD_LISTING_LIMIT })
              .catch((err) => {
                console.error('GET /store/metrics could not read Etsy listings:', err.message);
                return { status: 'failed', result: null, error: err.message };
              });
            return [shopOutcome, listingOutcome];
          })()
        : Promise.resolve([null, null]);

      const [outcomes, ordersForProducts, [etsyShopOutcome, etsyListingOutcome]] = await Promise.all([
        Promise.all(
          capabilities.map((analyticsCapability) =>
            analyticsDataTool.runAnalyticsDataTool({ analyticsCapability, limit: 50 })
          )
        ),
        shopifyClient.getOrders({ limit: 50 }).catch((err) => {
          console.error('GET /store/metrics could not read orders for Top Products:', err.message);
          return null;
        }),
        etsyReads,
      ]);

      const salesOutcome = outcomes[capabilities.indexOf('sales')];
      const payload = {
        fetched_at: new Date().toISOString(),
        capabilities: Object.fromEntries(capabilities.map((name, index) => [name, outcomes[index]])),
        // Built from the sales pull above - no additional Shopify request (see buildTrends).
        trends: buildTrends(salesOutcome),
        funnel: buildFunnel(salesOutcome),
        top_products: ordersForProducts
          ? buildTopProducts(ordersForProducts)
          : { available: false, products: [], revenue_available: false, revenue_reason: null, views_available: false, views_reason: null },
        // A SEPARATE key, deliberately. Etsy data never joins the Shopify keys above -
        // not in `capabilities`, not in `trends.channels`, not in `top_products`.
        etsy: buildEtsyBlock({
          connected: etsyConnected,
          shopOutcome: etsyShopOutcome,
          listingOutcome: etsyListingOutcome,
        }),
      };
      metricsCache = { payload, cachedAtMs: Date.now() };
      res.json({ ...payload, cached: false });
    } catch (err) {
      // runAnalyticsDataTool documents that it never throws, so reaching here means
      // something outside it broke. Logged rather than swallowed (CLAUDE.md rule 13), and
      // reported as an honest failure - never as an empty or zeroed metric set.
      console.error('GET /store/metrics failed:', err.message);
      res.status(502).json({ error: 'Could not read live store metrics right now. Please try again shortly.' });
    }
  });

  /* ---------- Command Center sessions ----------
     The multi-turn surface over the SAME Chief these endpoints already expose. A session
     adds memory of what was asked and produced so a later turn can say "deep research #3";
     it adds no routing, no dispatch and no second orchestrator - every turn ends in one
     call to runOrchestratorContract, via agent/core/commandCenterSession.js.

     Each turn saves a normal run record through agent/core/runHistoryStore.js under its own
     run id, so a session's work appears on the History page exactly like any other run and
     the two can never drift apart. The session file references those run ids and never
     copies a run into itself.

     NO SECRET REACHES A SESSION: the store refuses to persist any credential-shaped key
     (agent/core/commandCenterSessionModel.js's SESSION_FORBIDDEN_KEY_PATTERN), so this is
     enforced at the boundary rather than trusted to callers. */
  app.post('/session', protect, (req, res) => {
    const { goal, channel } = req.body || {};
    if (typeof goal !== 'string' || !goal.trim()) {
      res.status(400).json({ error: 'A non-empty "goal" string is required.' });
      return;
    }
    // Channel is STATED or absent - never derived from the goal's wording. A wrong channel
    // label would attribute one store's work to another.
    if (channel !== undefined && channel !== null && !['shopify', 'etsy', 'multi_channel'].includes(channel)) {
      res.status(400).json({ error: 'If provided, "channel" must be one of: shopify, etsy, multi_channel.' });
      return;
    }
    try {
      const session = commandCenterSessionStore.createSession({ goal: goal.trim(), channel: channel || null });
      res.json(session);
    } catch (err) {
      console.error('POST /session failed:', err.message);
      res.status(500).json({ error: 'Could not start a session right now. Please try again shortly.' });
    }
  });

  app.post('/session/:sessionId/message', protect, async (req, res) => {
    const { message, research_params: researchParamsInput } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'A non-empty "message" string is required.' });
      return;
    }
    const researchParamsCheck = validateResearchParams(researchParamsInput);
    if (!researchParamsCheck.ok) {
      res.status(400).json({ error: 'If provided, "research_params" must be a plain object.' });
      return;
    }
    const session = commandCenterSessionStore.getSessionById(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'No session found for this id.' });
      return;
    }

    try {
      const outcome = await commandCenterSession.runSessionTurn(session, message.trim(), {
        researchParams: researchParamsCheck.value,
        // Reuses this file's own step summariser rather than the session module growing a
        // second one.
        summarizeStep: summarizeExecutionState,
        // Each turn's run is persisted through the EXISTING run store, under its own id.
        saveRun: (runResult, objective) => {
          const runId = `cc-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          try {
            runHistoryStore.saveRunRecord({
              run_id: runId,
              kind: 'orchestrate',
              objective,
              status: deriveOrchestrateHistoryStatus(runResult),
              summary: buildOrchestrateHistorySummary(runResult),
              // The session this run belongs to - additive, so a run record without one
              // behaves exactly as before.
              session_id: session.session_id,
              channel: session.channel || null,
              created_at: new Date().toISOString(),
              result: runResult,
            });
          } catch (saveErr) {
            console.error('Could not save run history for a Command Center turn:', saveErr.message);
          }
          return runId;
        },
      });
      res.json({
        session: outcome.session,
        run_id: outcome.run_id || null,
        clarification: outcome.clarification || null,
        error: outcome.error || null,
      });
    } catch (err) {
      console.error('POST /session/:sessionId/message failed:', err.message);
      res.status(502).json({ error: 'The Chief could not complete this turn right now. Please try again shortly.' });
    }
  });

  app.get('/sessions', protect, (req, res) => {
    res.json({ sessions: commandCenterSessionStore.listSessions({ limit: 25 }) });
  });

  app.get('/session/:sessionId', protect, (req, res) => {
    const session = commandCenterSessionStore.getSessionById(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'No session found for this id.' });
      return;
    }
    res.json(session);
  });

  // The customer-facing workflow map. A PRESENTATION SURFACE ONLY: it runs nothing and
  // stores nothing - agent/core/workflowStateProjection.js reads the newest saved run (and
  // a session, when one is named) and projects it onto the stages a customer sees. With no
  // saved run it honestly reports every stage as 'not run' rather than inventing a demo.
  // Zero network calls, exactly like GET /overview.
  app.get('/workflow/state', protect, (req, res) => {
    try {
      const summaries = runHistoryStore.listRunRecordSummaries({ limit: 25 });
      // Newest-first, so the first record carrying a real plan is the current one.
      let record = null;
      for (const summary of summaries) {
        const candidate = runHistoryStore.getRunRecordById(summary.run_id);
        if (candidate && candidate.result && candidate.result.routing) { record = candidate; break; }
      }
      const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
      const session = sessionId ? commandCenterSessionStore.getSessionById(sessionId) : null;
      res.json({
        ...workflowStateProjection.deriveWorkflowState({ record, session }),
        ...workflowNarrative.getCustomerWorkflowDefinition(),
      });
    } catch (err) {
      console.error('GET /workflow/state failed:', err.message);
      res.status(500).json({ error: 'Could not build the workflow view right now.' });
    }
  });

  // The evidence chain behind ONE persisted opportunity - relayed from the saved research
  // run, never recomputed. A rank with no saved opportunity is an honest 404.
  app.get('/workflow/evidence/:rank', protect, (req, res) => {
    const rank = Number(req.params.rank);
    if (!Number.isInteger(rank) || rank < 1) {
      res.status(400).json({ error: 'rank must be a positive integer.' });
      return;
    }
    try {
      for (const summary of runHistoryStore.listRunRecordSummaries({ limit: 25 })) {
        const record = runHistoryStore.getRunRecordById(summary.run_id);
        const research = extractMarketResearchResult(record, summary);
        if (!research) continue;
        const opportunity = (research.opportunities || []).find((item) => item && item.rank === rank);
        if (!opportunity) continue;
        const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
        const session = sessionId ? commandCenterSessionStore.getSessionById(sessionId) : null;
        const chain = workflowStateProjection.attachPreparation(
          workflowStateProjection.buildEvidenceChain(opportunity),
          session
        );
        res.json({ available: true, run_id: research.run_id, chain, unavailable_text: workflowNarrative.getCustomerWorkflowDefinition().unavailable_text });
        return;
      }
      res.status(404).json({ available: false, error: 'No saved research opportunity with that rank.' });
    } catch (err) {
      console.error('GET /workflow/evidence failed:', err.message);
      res.status(500).json({ error: 'Could not read the evidence chain right now.' });
    }
  });

  // The customer-facing PDF, generated from the SAME definitions the dashboard renders
  // (agent/core/workflowNarrative.js), so the document and the product cannot drift.
  // It documents how the system works and carries no run data, no credentials and no
  // customer records.
  app.get('/workflow/document.pdf', protect, (req, res) => {
    try {
      const pdf = workflowDocument.buildWorkflowDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${workflowDocument.DOCUMENT_FILENAME}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (err) {
      console.error('GET /workflow/document.pdf failed:', err.message);
      res.status(500).json({ error: 'Could not generate the document right now.' });
    }
  });

  // Read-only views onto agent/core/runHistoryStore.js's saved runs - what makes
  // "Run a Specialist"/"Chief Orchestrator" results survive a page refresh or server
  // restart (public/index.html's History page). Never executes anything; a bad/unknown
  // id is an honest 404, never a fabricated result.
  // The human's half of the approval handshake: hands back the EXACT string to sign for one
  // specific pending decision. Nothing secret is returned - the payload is a public
  // description of the action, and holding it confers nothing without the private key.
  //
  // The nonce is generated server-side (never accepted from the caller) and is single-use,
  // so a signature obtained here authorizes exactly one decision and cannot be replayed.
  app.get('/approval-challenge', protect, (req, res) => {
    const approvalId = req.query && typeof req.query.approvalId === 'string' ? req.query.approvalId.trim() : '';
    const decision = req.query && typeof req.query.decision === 'string' ? req.query.decision.trim() : '';
    const decidedBy = req.query && typeof req.query.decidedBy === 'string' ? req.query.decidedBy.trim() : '';

    if (!approvalId) {
      res.status(400).json({ error: 'A non-empty "approvalId" is required.' });
      return;
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({ error: 'A "decision" of "approved" or "rejected" is required.' });
      return;
    }
    if (!decidedBy) {
      res.status(400).json({ error: 'A non-empty "decidedBy" is required so the challenge is bound to one approver.' });
      return;
    }

    // A durable approval queued by the autonomous cycle is held in no in-memory run map. It is
    // found in durable storage instead - scoped to exactly the requested business, and only
    // while still pending - and receives the SAME challenge from the same function.
    const record =
      findPendingApprovalRecord([orchestratorRuns, growthWorkflowRuns, optimizationCycleRuns], approvalId) ||
      autonomyApprovals.findPendingAutonomousApproval(approvalId, { businessId: autonomyBusinessId(req.query && req.query.business_id) });
    if (!record) {
      res.status(404).json({ error: 'No pending approval with that id is held by this server.' });
      return;
    }

    try {
      res.json(issueApprovalChallenge({ request: record, decision, decidedBy }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // CONTROLLED AUTONOMY (autonomy/, scheduler/). Every endpoint below sits behind `protect`
  // (API key, rate limit, business authorization). None of them enables autonomy: the
  // AGENT_AUTONOMY_ENABLED kill switch and each business's own `autonomy` block remain the
  // only switches, and every job still passes agent/core/autonomyPolicy.js. They add no
  // decision logic - each calls the module that owns the concern.
  // -------------------------------------------------------------------------
  function autonomyBusinessId(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  const AUTONOMY_RUN_KINDS = ['autonomous_cycle', 'autonomous_approval_resolution'];

  // Read-only: what the owner needs to see about autonomy for one business.
  app.get('/autonomy/state', protect, (req, res) => {
    const businessId = autonomyBusinessId(req.query && req.query.business_id);
    try {
      const policy = resolveBusinessPolicy(businessId);
      const recentRuns = runHistoryStore
        .listRunRecordSummaries({ limit: HISTORY_SCAN_LIMIT, businessId })
        .filter((run) => run && AUTONOMY_RUN_KINDS.includes(run.kind) && (run.business_id || null) === businessId)
        .slice(0, 20);
      res.json({
        business_id: businessId,
        kill_switch: readKillSwitch().state,
        storage: checkDurableStorage(),
        business_autonomy: policy.ok
          ? {
              readable: true,
              enabled: policy.autonomy.enabled === true,
              daily_token_budget: policy.autonomy.daily_token_budget,
              daily_run_budget: policy.autonomy.daily_run_budget,
            }
          : { readable: false, enabled: false, reason_code: policy.reason_code },
        enabled_platforms: policy.ok ? policy.enabled_platforms : [],
        schedules: listBusinessSchedules({ businessId }),
        recent_runs: recentRuns,
        pending_approvals: autonomyApprovals.listPendingAutonomousApprovals({ businessId }),
      });
    } catch (err) {
      res.status(502).json({ error: 'Could not read the autonomy state right now. Please try again shortly.' });
    }
  });

  app.get('/autonomy/schedules', protect, (req, res) => {
    const businessId = autonomyBusinessId(req.query && req.query.business_id);
    try {
      res.json({ business_id: businessId, schedules: listBusinessSchedules({ businessId }) });
    } catch (err) {
      res.status(502).json({ error: 'Could not read schedules right now. Please try again shortly.' });
    }
  });

  function scheduleRefusalStatus(reasonCode) {
    if (reasonCode === 'schedule_exists') return 409;
    if (reasonCode === 'schedule_not_found') return 404;
    return 400;
  }

  // The owner creates a schedule explicitly. It is always saved DISABLED.
  app.post('/autonomy/schedules', protect, (req, res) => {
    const body = req.body || {};
    try {
      const result = createBusinessSchedule({
        businessId: autonomyBusinessId(body.business_id),
        jobId: body.job_id,
        schedule: body.schedule,
        task: body.task,
      });
      if (!result.ok) {
        res.status(scheduleRefusalStatus(result.reason_code)).json({ error: result.reason, reason_code: result.reason_code, errors: result.errors });
        return;
      }
      res.status(201).json({ job: result.job });
    } catch (err) {
      res.status(502).json({ error: 'Could not save the schedule right now. Please try again shortly.' });
    }
  });

  app.post('/autonomy/schedules/:jobId/enabled', protect, (req, res) => {
    const body = req.body || {};
    try {
      const result = setBusinessScheduleEnabled({
        businessId: autonomyBusinessId(body.business_id),
        jobId: req.params.jobId,
        enabled: body.enabled,
      });
      if (!result.ok) {
        res.status(scheduleRefusalStatus(result.reason_code)).json({ error: result.reason, reason_code: result.reason_code });
        return;
      }
      res.json({ job: result.job });
    } catch (err) {
      res.status(502).json({ error: 'Could not update the schedule right now. Please try again shortly.' });
    }
  });

  const RESOLUTION_HTTP_STATUS = {
    invalid_request: 400,
    approval_not_found: 404,
    approval_not_pending: 409,
    already_completed: 409,
    circuit_open: 503,
    approval_verification_failed: 400,
  };

  // The owner decides an approval the autonomous cycle queued: GET /approval-challenge with
  // its approvalId (and business_id), sign the payload, then submit nonce + signature here.
  app.post('/autonomy/approvals/decide', protect, async (req, res) => {
    const body = req.body || {};
    try {
      const result = await autonomyApprovals.resolveAutonomousApproval({
        approvalId: body.approvalId,
        businessId: autonomyBusinessId(body.business_id),
        decision: body.decision,
        decidedBy: body.decidedBy,
        notes: body.notes,
        authorization: { nonce: body.nonce, signature: body.signature },
      });
      if (!result.ok) {
        res.status(RESOLUTION_HTTP_STATUS[result.reason_code] || 400).json({ error: result.reason, reason_code: result.reason_code });
        return;
      }
      res.json({
        run_id: result.run_id,
        approval_request: result.approval_request,
        execution: result.execution,
        verification: result.verification ? { status: result.verification.status, reason_code: result.verification.reason_code } : null,
      });
    } catch (err) {
      res.status(502).json({ error: 'The approval could not be resolved right now. Please try again shortly.' });
    }
  });

  // Runs ONE cycle for one business - for an owner-chosen external scheduler to call. Refuses
  // unless storage is durable, the kill switch is on and the business has enabled autonomy.
  app.post('/autonomy/cycle', protect, async (req, res) => {
    const body = req.body || {};
    try {
      const result = await triggerAutonomousCycle({ businessId: autonomyBusinessId(body.business_id) });
      const status = result.triggered ? 200 : result.reason_code === 'storage_not_durable' ? 503 : 409;
      res.status(status).json(result);
    } catch (err) {
      res.status(502).json({ error: 'The autonomous cycle could not run right now. Please try again shortly.' });
    }
  });

  app.get('/history', protect, (req, res) => {
    // Optional business scoping: /growth-workflow and /optimization-cycle both accept a
    // business_id, so their saved records carry one, and a caller working on one business
    // must be able to list only that business's runs rather than every business's. Omitted
    // -> the full listing, exactly as before. Unattributed /run and /orchestrate records
    // are never returned for a business-scoped request (see listRunRecordSummaries).
    // A business_id here is already authorized by `protect`'s requireAuthorizedBusiness -
    // an unauthorized one never reaches this handler. Type validation stays because a
    // non-string is a malformed request (400), not an authorization failure (403).
    const businessId = req.query && typeof req.query.business_id === 'string' ? req.query.business_id : null;
    if (req.query && req.query.business_id !== undefined && typeof req.query.business_id !== 'string') {
      res.status(400).json({ error: 'If provided, "business_id" must be a string.' });
      return;
    }
    try {
      // THE UNSCOPED LISTING IS THE ENUMERATION RISK, AND IT IS CLOSED HERE. Asking for a
      // business you may not have is refused by the middleware - but asking for NO business
      // used to return every business's runs in one page, which reaches the same data
      // without ever naming it. So the result is filtered to what this credential may see:
      // its own default-business records, plus any business it is explicitly authorized for.
      //
      // Filtered AFTER the read because runHistoryStore's own filter takes a single id and
      // treats null as "no filter" - it cannot express "records with no business_id", and
      // teaching it to is a change to a module outside this boundary's scope. A wider scan
      // window than the returned page keeps the filtering from silently shortening results.
      const scanned = runHistoryStore.listRunRecordSummaries({ limit: HISTORY_SCAN_LIMIT, businessId });
      const visible = scanned.filter((run) => isBusinessAuthorized(run && run.business_id)).slice(0, 50);
      res.json({ runs: visible });
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
    // A run id is guessable and is not a capability. A record belonging to a business this
    // credential may not reach is reported as NOT FOUND rather than forbidden: a 403 here
    // would confirm the run exists, which is exactly the enumeration this check exists to
    // prevent. The response is byte-identical to a genuinely unknown id.
    if (!isBusinessAuthorized(record.business_id)) {
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
