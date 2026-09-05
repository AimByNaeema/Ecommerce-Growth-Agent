'use strict';

// The boundary between the two existing systems, and nothing more:
//
//   Content -> Compliance -> Human Approval -> approved / rejected
//
// It STOPS at approval. There is no publishing stage in this project, nothing here
// calls an external system, and an approval produced by this module authorizes a future
// publishing step rather than performing one.
//
// WHAT THIS MODULE IS NOT. It is not a second approval state machine. Every state
// transition still belongs to approvals/approvalWorkflow.js: createApprovalRequest()
// makes the pending record, decideApprovalRequest() is still the only function that can
// move one out of 'pending', and both are called here rather than reimplemented. It is
// not a second compliance checker either - compliance/complianceEngine.js's
// evaluateCompliance() is the only thing that ever produces a verdict. This file adds
// exactly one thing neither system had: the rule for which compliance verdicts may
// ENTER the approval lifecycle, and the re-verification that keeps a verdict honest
// once a record has left this process.
//
// THE VERDICT IS ALWAYS COMPUTED, NEVER ACCEPTED. No function here reads a
// caller-supplied compliance status, and no caller can hand one in: the gate is given
// the compliance INPUT (the content and its context) and runs the real evaluation
// itself. A record that arrives claiming a verdict is re-evaluated from its own content
// and refused when the two disagree. This works precisely because
// compliance/complianceEngine.js is deterministic and offline - re-verification is
// exact, costs nothing, and makes no model call, so it can be done on every decision.
//
// THE THREE VERDICTS AT THIS BOUNDARY:
//   PASS   - eligible for human approval. A pending request is created. The approval
//            is still required; a PASS is not an approval (see below).
//   REVIEW - ALSO eligible, and that is the point of REVIEW: something needs a human.
//            The verdict and every review reason are carried onto the request so the
//            approver sees exactly what was unresolved. A REVIEW never silently becomes
//            a PASS - the recorded status stays REVIEW even after a human approves it.
//   BLOCK  - refused. No approval request is created at all, so a BLOCK cannot enter
//            the normal approval flow and there is nothing for a human to decide. There
//            is no override argument, because approvals/approvalArchitecture.js has no
//            authorized-override mechanism and inventing one is not in scope.
//
// HUMAN APPROVAL IS NOT COMPLIANCE PASS. They answer different questions and are stored
// separately: the compliance verdict lives in the request's execution_request, the human
// decision lives in the record's own status/decided_by/decided_at. Approving something
// does not change its compliance verdict, and a compliance PASS decides nothing.
//
// NO SCHEMA CHANGE WAS NEEDED. approvals/approvalRequestModel.js already relays
// `execution_request` as an opaque object "as-is, never rebuilt from scratch at resume
// time", so the compliance summary and the input it was computed from ride along inside
// it. Nothing in approvals/ or compliance/ is modified by this integration.

const {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
} = require('./approvalWorkflow');
const { evaluateCompliance, summarizeComplianceForApproval } = require('../compliance/complianceEngine');
const { appendAuditEvent } = require('../audit/auditTrail');

// Publishing content is exactly approvals/approvalArchitecture.js's own description of
// 'approval_required': an action that "would change something (e.g. publishing content
// ...) but [is] not yet wired to an external system". Reused, never redefined, and
// deliberately not 'externally_executable' - no external system is connected here.
const COMPLIANCE_GATED_CLASSIFICATION = 'approval_required';

// The single honest statement about what an approval from this gate does and does not
// do. Carried on every outcome so no consumer can read an approval as a publication.
const AUTHORIZATION_LIMITATION =
  'An approval here authorizes a FUTURE publishing step only. This project has no publishing stage, nothing was sent anywhere, and no external system was called.';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Order-insensitive comparison of the reasons a human is meant to weigh. Compared on
// their own rather than as part of a whole-result diff, because a result's checked_at
// legitimately differs between the original evaluation and a re-evaluation - diffing
// whole results would report every honest record as tampered with.
function sameReviewReasons(a, b) {
  const left = [...(a || [])].sort();
  const right = [...(b || [])].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

// ---------------------------------------------------------------------------------
// Content -> Compliance -> (pending) Human Approval
// ---------------------------------------------------------------------------------

// Runs the real compliance evaluation and, only when the verdict allows it, creates a
// pending approval request through the existing lifecycle.
//
// `requests` is the caller-held array approvals/approvalWorkflow.js already expects -
// this module holds no state of its own, exactly like every other engine in this
// project. It is never mutated: a new array is returned.
//
// Returns { status, compliance_result, approval_request, requests, reason, limitations }
//   status 'blocked'          - BLOCK: no approval request was created, and none can be
//   status 'pending_approval' - PASS or REVIEW: a pending request now awaits a human
//   status 'failed'           - the input was unusable; nothing was evaluated or created
function requestApprovalForCheckedContent({
  id,
  complianceInput,
  specialistId = null,
  toolId,
  executionRequest = {},
  requests = [],
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error('requestApprovalForCheckedContent requires `requests` to be an array.');
  }
  if (!isPlainObject(executionRequest)) {
    throw new Error('requestApprovalForCheckedContent requires `executionRequest` to be an object.');
  }

  // The verdict is COMPUTED here from the content itself. A caller cannot supply one:
  // there is no parameter for a compliance status anywhere in this signature.
  let complianceResult;
  try {
    complianceResult = evaluateCompliance(complianceInput);
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      toolId: toolId || null,
      specialistId,
      status: 'error',
      summary: `Compliance could not be evaluated, so no approval request was created: ${err.message}`,
    });
    return {
      status: 'failed',
      compliance_result: null,
      approval_request: null,
      requests,
      reason: err.message,
      limitations: [AUTHORIZATION_LIMITATION],
    };
  }

  const summary = summarizeComplianceForApproval(complianceResult);

  if (complianceResult.status === 'BLOCK') {
    // Refused at the boundary: nothing is added to `requests`, so there is no record
    // for a human to approve and no path that could resume from one.
    appendAuditEvent(auditTracker, {
      type: 'approval',
      toolId: toolId || null,
      specialistId,
      classification: COMPLIANCE_GATED_CLASSIFICATION,
      status: 'blocked',
      summary: `Compliance returned BLOCK, so no approval request was created for '${complianceResult.content_reference || '(no content reference)'}'.`,
      detail: { compliance: summary },
    });
    return {
      status: 'blocked',
      compliance_result: complianceResult,
      approval_request: null,
      requests,
      reason: `Compliance returned BLOCK for this content, so it cannot enter the approval flow. Blocking reasons: ${summary.blocking_findings.map((finding) => finding.reason).join(' | ')}`,
      limitations: [AUTHORIZATION_LIMITATION],
    };
  }

  // PASS and REVIEW both reach a human. The verdict and its reasons ride on the request
  // so the approver sees them, and compliance_input rides along so the decision can be
  // re-verified against the content rather than trusted.
  const approvalRequest = createApprovalRequest({
    id,
    classification: COMPLIANCE_GATED_CLASSIFICATION,
    specialistId,
    toolId,
    executionRequest: {
      ...executionRequest,
      compliance: summary,
      compliance_input: complianceInput,
    },
    reason:
      complianceResult.status === 'PASS'
        ? 'Compliance detected no issue under the checks that ran. Explicit human approval is still required before this content may be published by a future publishing step.'
        : `Compliance returned REVIEW and a human must resolve it before this content proceeds. Review reasons: ${complianceResult.review_reasons.join(' | ')}`,
  });

  appendAuditEvent(auditTracker, {
    type: 'approval',
    toolId: toolId || null,
    specialistId,
    classification: COMPLIANCE_GATED_CLASSIFICATION,
    status: 'pending',
    summary: `Approval request '${approvalRequest.id}' created after compliance returned ${complianceResult.status}.`,
    detail: { compliance: summary },
  });

  return {
    status: 'pending_approval',
    compliance_result: complianceResult,
    approval_request: approvalRequest,
    requests: [...requests, approvalRequest],
    reason: null,
    limitations: [AUTHORIZATION_LIMITATION],
  };
}

// ---------------------------------------------------------------------------------
// Re-verification - what makes a claimed verdict worthless on its own.
// ---------------------------------------------------------------------------------

// Recomputes the compliance verdict from the request's OWN content and compares it with
// the verdict the request claims. Returns { ok, reason, compliance_result }.
//
// Refuses when: the request carries no compliance input to check against; the recomputed
// verdict disagrees with the recorded one (a forged or stale status); or the recomputed
// verdict is BLOCK. Never mutates anything, and never calls a model - the whole check is
// deterministic and free.
function verifyComplianceForApprovalRequest(request) {
  if (!isPlainObject(request) || !isPlainObject(request.execution_request)) {
    return { ok: false, reason: 'This is not a usable approval request record.', compliance_result: null };
  }

  const { compliance, compliance_input: complianceInput } = request.execution_request;

  if (!isPlainObject(complianceInput)) {
    return {
      ok: false,
      reason:
        'This approval request carries no compliance input, so its compliance verdict cannot be re-verified. A claimed verdict is never accepted on its own.',
      compliance_result: null,
    };
  }
  if (!isPlainObject(compliance) || typeof compliance.compliance_status !== 'string') {
    return {
      ok: false,
      reason: 'This approval request carries no recorded compliance verdict to verify.',
      compliance_result: null,
    };
  }

  let recomputed;
  try {
    recomputed = evaluateCompliance(complianceInput);
  } catch (err) {
    return { ok: false, reason: `Compliance could not be re-evaluated for this request: ${err.message}`, compliance_result: null };
  }

  if (recomputed.status !== compliance.compliance_status) {
    return {
      ok: false,
      reason: `This approval request claims compliance status '${compliance.compliance_status}', but re-evaluating its own content produces '${recomputed.status}'. The claimed verdict is refused.`,
      compliance_result: recomputed,
    };
  }

  // Belt and braces: even a request whose claim matches is refused if what it actually
  // is now is a BLOCK. A BLOCK can never be approved by any route.
  if (recomputed.status === 'BLOCK') {
    return {
      ok: false,
      reason: 'Compliance returns BLOCK for this content, so it cannot be approved by any route.',
      compliance_result: recomputed,
    };
  }

  // The recorded review reasons must still be the real ones - a record cannot quietly
  // drop or edit what a human was supposed to weigh, even while claiming the right
  // overall status.
  if (!sameReviewReasons(compliance.review_reasons, recomputed.review_reasons)) {
    return {
      ok: false,
      reason: 'The review reasons recorded on this approval request do not match the ones its own content produces. The record is refused rather than decided on altered reasons.',
      compliance_result: recomputed,
    };
  }

  return { ok: true, reason: null, compliance_result: recomputed };
}

// ---------------------------------------------------------------------------------
// Human decision - delegated entirely to the existing lifecycle.
// ---------------------------------------------------------------------------------

// Re-verifies compliance, then records the human decision using
// approvals/approvalWorkflow.js's decideApprovalRequest() - which remains the only
// function in this codebase that can move a request out of 'pending', and which already
// requires a real, non-empty `decidedBy` and refuses to re-decide a decided request.
// Nothing about that lifecycle is reimplemented or bypassed here.
//
// Returns { ok, requests, decided_request, compliance_result, reason, limitations }.
function decideComplianceGatedApproval(
  requests,
  requestId,
  { decision, decidedBy, notes = null, expectedBusinessId = null, auditTracker = null } = {}
) {
  if (!Array.isArray(requests)) {
    throw new Error('decideComplianceGatedApproval requires `requests` to be an array.');
  }

  const existing = getApprovalRequestById(requests, requestId);
  if (!existing) {
    return {
      ok: false,
      requests,
      decided_request: null,
      compliance_result: null,
      reason: `No approval request with id '${requestId}'.`,
      limitations: [AUTHORIZATION_LIMITATION],
    };
  }

  // Compliance is checked BEFORE any decision is recorded, so a refused record is left
  // exactly as it was.
  const verification = verifyComplianceForApprovalRequest(existing);
  if (!verification.ok) {
    appendAuditEvent(auditTracker, {
      type: 'approval',
      toolId: existing.tool_id || null,
      specialistId: existing.specialist_id || null,
      classification: existing.classification || null,
      status: 'refused',
      summary: `Approval decision refused for '${requestId}': ${verification.reason}`,
    });
    return {
      ok: false,
      requests,
      decided_request: null,
      compliance_result: verification.compliance_result,
      reason: verification.reason,
      limitations: [AUTHORIZATION_LIMITATION],
    };
  }

  let updated;
  try {
    updated = decideApprovalRequest(requests, requestId, { decision, decidedBy, notes, expectedBusinessId });
  } catch (err) {
    // decideApprovalRequest's own errors are already specific and safe (a missing
    // decidedBy, an already-decided request, a cross-business mismatch) - relayed, never
    // replaced or softened.
    appendAuditEvent(auditTracker, {
      type: 'approval',
      toolId: existing.tool_id || null,
      specialistId: existing.specialist_id || null,
      classification: existing.classification || null,
      status: 'refused',
      summary: `Approval decision refused for '${requestId}': ${err.message}`,
    });
    return {
      ok: false,
      requests,
      decided_request: null,
      compliance_result: verification.compliance_result,
      reason: err.message,
      limitations: [AUTHORIZATION_LIMITATION],
    };
  }

  const decidedRequest = getApprovalRequestById(updated, requestId);
  appendAuditEvent(auditTracker, {
    type: 'approval',
    toolId: decidedRequest.tool_id || null,
    specialistId: decidedRequest.specialist_id || null,
    classification: decidedRequest.classification || null,
    status: decidedRequest.status,
    summary: `Approval request '${requestId}' ${decidedRequest.status} (compliance ${verification.compliance_result.status}). Nothing was published.`,
    detail: { decided_by: decidedRequest.decided_by, compliance_status: verification.compliance_result.status },
  });

  return {
    ok: true,
    requests: updated,
    decided_request: decidedRequest,
    compliance_result: verification.compliance_result,
    reason: null,
    limitations: [AUTHORIZATION_LIMITATION],
  };
}

// ---------------------------------------------------------------------------------
// The one gate a future publishing stage must call.
// ---------------------------------------------------------------------------------

// Whether this record authorizes a future publishing step. Every condition must hold at
// the moment of asking, so a record that once looked approvable cannot be replayed:
//   - a real human decision is recorded ('approved', with a non-empty decided_by)
//   - compliance re-verifies from the record's own content
//   - the re-verified verdict is not BLOCK
//
// It authorizes; it does not publish. There is no publishing stage in this project and
// this module calls nothing.
function isAuthorizedForPublishing(request) {
  if (!isPlainObject(request)) return false;
  if (request.status !== 'approved') return false;
  if (typeof request.decided_by !== 'string' || request.decided_by.trim() === '') return false;
  return verifyComplianceForApprovalRequest(request).ok;
}

module.exports = {
  COMPLIANCE_GATED_CLASSIFICATION,
  AUTHORIZATION_LIMITATION,
  requestApprovalForCheckedContent,
  verifyComplianceForApprovalRequest,
  decideComplianceGatedApproval,
  isAuthorizedForPublishing,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compliance -> human approval gate:\n');

  const provenance = {
    source: 'seo_content_generation',
    evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
  };

  const examples = [
    {
      label: 'PASS - reaches a human approver',
      content:
        'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it.',
    },
    {
      label: 'REVIEW - reaches a human approver, carrying its reasons',
      content: 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use.',
    },
    {
      label: 'BLOCK - never enters the approval flow at all',
      content: 'Every design in our store is guaranteed copyright-free.',
    },
  ];

  let requests = [];
  examples.forEach((example, index) => {
    const outcome = requestApprovalForCheckedContent({
      id: `apr-compliance-${index + 1}`,
      toolId: 'compliance_check',
      complianceInput: { content: example.content, content_reference: `(placeholder) content-${index + 1}`, provenance },
      // The caller holds the array across calls - the same discipline
      // approvals/approvalWorkflow.js's own header establishes. This module keeps none.
      requests,
    });
    requests = outcome.requests;
    console.log(`--- ${example.label}`);
    console.log(`    compliance verdict: ${outcome.compliance_result.status}`);
    console.log(`    gate status:        ${outcome.status}`);
    if (outcome.reason) console.log(`    reason: ${outcome.reason}`);
  });

  const decided = decideComplianceGatedApproval(requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (caller-supplied placeholder)',
    notes: 'Read the draft before approving.',
  });
  console.log('\nAfter a real, accountable human decision on the PASS request:');
  console.log(`    approval status:    ${decided.decided_request.status} by ${decided.decided_request.decided_by}`);
  console.log(`    compliance verdict: ${decided.compliance_result.status} (unchanged by the approval)`);
  console.log(`    authorized for a future publishing step: ${isAuthorizedForPublishing(decided.decided_request)}`);

  console.log(`\n${AUTHORIZATION_LIMITATION}`);
  console.log('Every value above is an invented placeholder.');
}
