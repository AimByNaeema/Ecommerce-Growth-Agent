'use strict';

// THE OWNER'S SIDE OF AN AUTONOMOUS APPROVAL: decide a durable approval the autonomous cycle
// queued, and - if approved - execute it once, record its independent verification, and
// feed the verified outcome forward.
//
//   durable pending approval -> owner's Ed25519 signature -> decide (persisted)
//   -> circuit breaker -> execute once -> independent verification -> verification record
//   -> audit + run record (with usage) -> verified memory -> next cycle
//
// WHY THIS EXISTS. autonomy/autonomousCycle.js queues consequential actions as durable
// approvals, but every existing approve endpoint looks approvals up in the server's
// in-memory run maps, so a queued autonomous approval could never be decided. This module
// is the smallest connection that fixes that.
//
// IT IS NOT A SECOND APPROVAL SYSTEM. It adds no verification, no signature handling and no
// execution logic of its own. Every step CALLS the existing one:
//   deciding (Ed25519, single-use nonce, fingerprint) -> approvals/approvalWorkflow.js
//   durable state                                     -> approvals/approvalStore.js
//   executing an approved action, execute-once        -> resumeApprovedExecution ->
//                                                        integrations/approvedCorrectionDispatch.js
//   verification record / idempotency                 -> reliability/executionVerification.js
//   integration health                                -> reliability/circuitBreaker.js
//   what happened                                     -> audit/auditTrail.js, agent/core/runHistoryStore.js
//   what the next cycle may reuse                     -> agent/core/memoryContextRetrieval.js
//
// FAILS CLOSED. Only a record that is in durable storage, belongs to exactly the requesting
// business (the default business can never reach a named business's record), carries the
// autonomous-cycle origin, and is still pending can be decided. A forged, replayed or stale
// signature, or a request changed after the challenge was issued, is refused by the existing
// verification before anything is written. A platform disabled since the request was queued
// is refused again at execution time by the Chief contract.
//
// VERIFICATION IS NEVER ASSUMED. The correction integrations independently re-read the
// platform after writing and report 'corrected' only when the re-read matches. Only that is
// recorded as 'verified'; anything else is recorded honestly as unverifiable or failed, and
// only a verified outcome is written to memory.

const approvalStore = require('../approvals/approvalStore');
const { decideAndPersistApprovalRequest, loadPendingApprovalRequests } = require('../approvals/approvalWorkflow');
const { resumeApprovedExecution } = require('../agent/core/orchestratorExecutionContract');
const executionVerification = require('../reliability/executionVerification');
const circuitBreaker = require('../reliability/circuitBreaker');
const { persistVerifiedFinding } = require('../agent/core/memoryContextRetrieval');
const runHistoryStore = require('../agent/core/runHistoryStore');
const { createAuditTracker, appendAuditEvent } = require('../audit/auditTrail');
const { createUsageLedger, summarizeUsage } = require('../usage/usageTracker');
const { createUsageTracker } = require('../agent/core/usageLimits');

const AUTONOMOUS_ORIGIN = 'autonomous_cycle';

// The entity kind a verification record for an approved action is stored under. The
// idempotency key is derived from the approval id, which is itself derived from the job
// occurrence - so one approved autonomous action has exactly one completion record.
const APPROVED_ACTION_ENTITY_KIND = 'approved_action';

const RESOLUTION_REFUSALS = {
  invalid_request: 'The decision request is incomplete.',
  approval_not_found: 'No autonomous approval with that id is held for this business.',
  approval_not_pending: 'That approval is no longer pending, so it cannot be decided again.',
  already_completed: 'That approved action has already been executed and verified. It is never applied twice.',
  circuit_open: 'This integration is currently failing, so the approved action was not attempted. The approval is still pending and can be decided once the circuit recovers.',
  approval_verification_failed: 'The signed decision could not be verified, so nothing was recorded or executed.',
};

function normalizeBusinessId(businessId) {
  return typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isAutonomousApprovalRecord(record) {
  const origin = record && record.execution_request && record.execution_request.autonomy;
  return Boolean(origin) && origin.origin === AUTONOMOUS_ORIGIN;
}

function recordBusinessId(record) {
  return normalizeBusinessId(record && record.execution_request ? record.execution_request.business_id : null);
}

// The durable envelope for one autonomous approval, scoped to EXACTLY this business.
// approvalStore's own business filter treats a null expectation as "any business", so the
// exact match is enforced here: the default business never reaches a named one's record.
function loadAutonomousApproval(approvalId, { businessId = null, storeDir = undefined } = {}) {
  if (!isNonEmptyString(approvalId)) return null;
  const expected = normalizeBusinessId(businessId);
  const envelope = approvalStore.loadApprovalRecord(approvalId, { expectedBusinessId: expected, storeDir });
  if (!envelope || !envelope.approval_request) return null;
  if (normalizeBusinessId(envelope.business_id) !== expected) return null;
  if (recordBusinessId(envelope.approval_request) !== expected) return null;
  if (!isAutonomousApprovalRecord(envelope.approval_request)) return null;
  return envelope;
}

// The pending record a challenge may be issued for, or null.
function findPendingAutonomousApproval(approvalId, { businessId = null, storeDir = undefined } = {}) {
  const envelope = loadAutonomousApproval(approvalId, { businessId, storeDir });
  if (!envelope) return null;
  if (envelope.execution_state !== 'awaiting_decision' || envelope.approval_request.status !== 'pending') return null;
  return envelope.approval_request;
}

// A read-only view of this business's pending autonomous approvals: what the owner is being
// asked to sign. research_params is included because it is part of the signed request.
function listPendingAutonomousApprovals({ businessId = null, storeDir = undefined } = {}) {
  const expected = normalizeBusinessId(businessId);
  return loadPendingApprovalRequests({ storeDir })
    .filter((record) => isAutonomousApprovalRecord(record) && recordBusinessId(record) === expected)
    .map((record) => ({
      approval_id: record.id,
      tool_id: record.tool_id,
      specialist_id: record.specialist_id,
      classification: record.classification,
      reason: record.reason,
      requested_at: record.requested_at,
      objective: record.execution_request.objective || null,
      research_params: record.execution_request.research_params || null,
      compliance_status: record.execution_request.compliance ? record.execution_request.compliance.compliance_status || null : null,
      platform: record.execution_request.autonomy.platform || null,
      job_id: record.execution_request.autonomy.job_id || null,
      occurrence_key: record.execution_request.autonomy.occurrence_key || null,
    }));
}

function refuse(reasonCode, detail = null) {
  return {
    ok: false,
    reason_code: reasonCode,
    reason: detail || RESOLUTION_REFUSALS[reasonCode] || 'The approval could not be resolved.',
  };
}

// Which verification verdict an approved execution earned. Only an integration-reported,
// independently re-read 'corrected' is verified.
function verificationVerdict(outcome) {
  if (outcome && outcome.status === 'success') {
    if (outcome.data && outcome.data.status === 'corrected') {
      return { status: 'verified', reason_code: null, reason: null };
    }
    return {
      status: 'unverifiable',
      reason_code: 'no_independent_confirmation',
      reason: 'The action reported success, but no independent re-read confirmed it, so it is not treated as verified.',
    };
  }
  return {
    status: 'failed',
    reason_code: 'execution_unsuccessful',
    reason: 'The approved action did not complete, so nothing was confirmed.',
  };
}

async function resolveAutonomousApproval({
  approvalId,
  businessId = null,
  decision,
  decidedBy,
  notes = null,
  authorization = null,
  now = new Date(),
  approvalStoreDir = undefined,
  verificationRootDir = undefined,
  circuitRootDir = undefined,
  runHistoryStoreDir = undefined,
} = {}) {
  if (
    !isNonEmptyString(approvalId) ||
    (decision !== 'approved' && decision !== 'rejected') ||
    !isNonEmptyString(decidedBy) ||
    !authorization ||
    !isNonEmptyString(authorization.nonce) ||
    !isNonEmptyString(authorization.signature)
  ) {
    return refuse(
      'invalid_request',
      'An approvalId, a decision of "approved" or "rejected", a decidedBy, and a signed nonce and signature are all required. A name alone is never authorization.'
    );
  }

  const expected = normalizeBusinessId(businessId);
  const envelope = loadAutonomousApproval(approvalId, { businessId: expected, storeDir: approvalStoreDir });
  if (!envelope) return refuse('approval_not_found');

  const record = envelope.approval_request;
  if (envelope.execution_state !== 'awaiting_decision' || record.status !== 'pending') {
    return refuse('approval_not_pending');
  }

  // The platform the cycle recorded inside the signed request, never guessed from a registry.
  const platform = record.execution_request.autonomy.platform || envelope.platform || null;
  const toolId = record.tool_id;
  const idempotencyKey = executionVerification.computeIdempotencyKey({
    businessId: expected,
    platform,
    action: toolId,
    entityKind: APPROVED_ACTION_ENTITY_KIND,
    entityId: record.id,
    expected: null,
  });
  const idempotency = executionVerification.checkIdempotency(idempotencyKey, { businessId: expected, rootDir: verificationRootDir });
  if (!idempotency.allowed) return refuse('already_completed');

  // Checked BEFORE deciding, so an open circuit leaves the approval pending rather than
  // approved-but-unexecuted.
  if (decision === 'approved') {
    const breaker = circuitBreaker.checkCircuit({ businessId: expected, platform, action: toolId, now, rootDir: circuitRootDir });
    if (!breaker.allowed) return refuse('circuit_open');
  }

  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const runId = `approval-${record.id}-${nowIso.replace(/[-:.]/g, '')}`;
  const audit = createAuditTracker(runId, expected);
  const usageLedger = createUsageLedger(runId, expected);

  let decided;
  try {
    const updated = decideAndPersistApprovalRequest(
      [record],
      record.id,
      {
        decision,
        decidedBy: decidedBy.trim(),
        notes: isNonEmptyString(notes) ? notes.trim() : null,
        expectedBusinessId: expected,
        authorization: { nonce: authorization.nonce, signature: authorization.signature },
      },
      { storeDir: approvalStoreDir }
    );
    decided = updated.find((entry) => entry.id === record.id);
  } catch (err) {
    // The workflow's own messages are specific and carry no secret (the same messages the
    // existing approve endpoints relay).
    return refuse('approval_verification_failed', err.message);
  }

  appendAuditEvent(audit, {
    type: 'approval',
    toolId,
    specialistId: record.specialist_id || null,
    classification: record.classification || null,
    status: decided.status,
    summary: `Autonomous approval '${record.id}' was ${decided.status} by a verified signature.`,
  });

  let execution = null;
  let verification = null;

  if (decided.status === 'approved') {
    let outcome;
    try {
      outcome = await resumeApprovedExecution(
        decided,
        { tokensUsedThisRun: 0 },
        audit,
        null,
        createUsageTracker(),
        usageLedger,
        { storeDir: approvalStoreDir }
      );
    } catch (err) {
      outcome = { status: 'error', data: null, error: 'The approved action could not be executed.' };
    }
    execution = { status: outcome.status, error: outcome.status === 'success' ? null : outcome.error || null };

    const verdict = verificationVerdict(outcome);
    verification = {
      verification_version: executionVerification.VERIFICATION_VERSION,
      idempotency_key: idempotencyKey,
      business_id: expected,
      platform,
      action: toolId,
      entity_kind: APPROVED_ACTION_ENTITY_KIND,
      entity_id: record.id,
      status: verdict.status,
      verified: verdict.status === 'verified',
      reason_code: verdict.reason_code,
      reason: verdict.reason,
      findings: [],
      unintended_mutations: [],
      verified_at: nowIso,
    };
    try {
      executionVerification.saveVerificationRecord(verification, { rootDir: verificationRootDir });
    } catch (err) {
      // The verdict is still returned and audited; a store failure never invents success.
    }

    if (verdict.status === 'verified') {
      circuitBreaker.recordSuccess({ businessId: expected, platform, action: toolId, now, rootDir: circuitRootDir });
    } else if (outcome.status === 'error') {
      circuitBreaker.recordFailure({ businessId: expected, platform, action: toolId, now, rootDir: circuitRootDir });
    }

    appendAuditEvent(audit, {
      type: verdict.status === 'verified' ? 'execution' : 'error',
      toolId,
      status: verdict.status,
      summary: `Approved action '${toolId}' verification: ${verdict.status}.`,
    });

    // LEARNING: only a verified outcome becomes memory the next cycle can read.
    if (verdict.status === 'verified' && expected !== null) {
      persistVerifiedFinding({
        businessId: expected,
        id: `autonomy-${record.id}`,
        priorityId: 'completed_tasks',
        summary: `Approved action '${toolId}' (approval ${record.id}) was executed and independently verified on ${platform || 'the platform'}.`,
        source: { run_id: runId, approval_id: record.id, tool_id: toolId, capability_id: null, job_id: record.execution_request.autonomy.job_id || null },
        verificationStatus: 'passed',
        approval: { status: 'approved', approval_id: record.id, decided_by: decided.decided_by || null },
      });
    }
  }

  const runStatus = decided.status === 'rejected' || (verification && verification.verified)
    ? 'success'
    : verification && verification.status === 'unverifiable'
      ? 'partial'
      : 'error';

  try {
    runHistoryStore.saveRunRecord(
      {
        run_id: runId,
        kind: 'autonomous_approval_resolution',
        business_id: expected,
        status: runStatus,
        created_at: nowIso,
        summary: decided.status === 'rejected'
          ? `Autonomous approval '${record.id}' was rejected. Nothing was executed.`
          : `Autonomous approval '${record.id}' was approved; execution ${execution.status}, verification ${verification.status}.`,
        result: {
          approval_id: record.id,
          tool_id: toolId,
          decision: decided.status,
          autonomy: record.execution_request.autonomy,
          execution,
          verification: verification ? { status: verification.status, reason_code: verification.reason_code } : null,
          usage_summary: summarizeUsage(usageLedger),
          audit_trail: audit.events,
        },
      },
      runHistoryStoreDir ? { storeDir: runHistoryStoreDir } : undefined
    );
  } catch (err) {
    // A record that cannot be stored never changes the decision the owner already made.
  }

  return {
    ok: true,
    reason_code: null,
    reason: null,
    run_id: runId,
    approval_request: decided,
    execution,
    verification,
  };
}

module.exports = {
  AUTONOMOUS_ORIGIN,
  APPROVED_ACTION_ENTITY_KIND,
  RESOLUTION_REFUSALS,
  isAutonomousApprovalRecord,
  loadAutonomousApproval,
  findPendingAutonomousApproval,
  listPendingAutonomousApprovals,
  verificationVerdict,
  resolveAutonomousApproval,
};
