'use strict';

// The final authorization boundary, and the last thing before a publishing stage that
// does not exist:
//
//   Content -> Compliance -> Human Approval -> Publish Authorization -> (nothing yet)
//
// It answers exactly one question: "is this content authorized for a FUTURE publishing
// action?" It never publishes, never calls a platform, and imports no adapter - the
// answer is a boolean and a reason, nothing more.
//
// WHY THIS EXISTS SEPARATELY FROM approvals/complianceApprovalGate.js. That module owns
// getting content INTO the approval lifecycle and re-verifying its compliance verdict.
// This one owns the opposite end: deciding whether an already-decided record actually
// confers authority, for THIS content, right now. Its own record-level predicate
// (isAuthorizedForPublishing) is reused here rather than reimplemented - this module
// adds the four things a record cannot establish about itself.
//
// THE STRUCTURAL POINT: THE RECORD IS LOOKED UP, NEVER ACCEPTED. authorizePublishing()
// takes the SERVER-HELD requests array plus an id and a content reference. There is no
// parameter anywhere in it for an approval record, an approval status, a compliance
// status, or an approver identity - so a client has nothing to forge with. The worst a
// caller can do is name an id that does not exist, or name content that the approval was
// not for; both are refused. A hand-built { status: 'approved', decided_by: 'me' }
// object cannot be passed in at all, because nothing here would take it.
//
// FAIL CLOSED, AND SAY WHY. Every condition is checked in order and the first failure
// refuses with a specific reason. There is no default-allow branch: authorized stays
// false unless every single check passes.
//
// COMPLIANCE PASS ALONE IS NOT AUTHORIZATION, AND HUMAN APPROVAL ALONE IS NOT EITHER.
// Both are required, and they are checked independently: a PASS with no approved record
// is refused for want of a decision; an approved record whose compliance cannot be
// re-verified is refused for want of a verdict. A BLOCK is refused whatever else is
// true. A REVIEW is authorized only by the ordinary approval architecture - a human
// approving it - and is never rewritten to PASS by doing so; the recorded verdict stays
// REVIEW and is reported as REVIEW.
//
// NOTHING NEW WAS BUILT. No state machine (approvals/approvalWorkflow.js still owns
// every transition), no storage (the caller holds the array, as everywhere else in this
// project), no schema change, no adapter, no model call, no configuration.

const { getApprovalRequestById } = require('./approvalWorkflow');
const { validateApprovalRequestShape } = require('./approvalRequestModel');
const { requiresApproval } = require('./approvalArchitecture');
const { verifyComplianceForApprovalRequest, isAuthorizedForPublishing, AUTHORIZATION_LIMITATION } = require('./complianceApprovalGate');
const { checkToolAccess } = require('../agent/core/toolPermissions');
const { appendAuditEvent } = require('../audit/auditTrail');

// The ordered checks. Reported on every outcome so a refusal names the exact condition
// that failed, and an authorization names everything that had to hold.
const AUTHORIZATION_CHECKS = [
  'request_found_in_server_state',
  'record_from_approval_workflow',
  'classification_actually_required_approval',
  'human_decision_is_approved',
  'decision_is_accountable',
  // Compliance is verified BEFORE the content-reference match, because the reference is
  // read out of the compliance input: with compliance missing, a reference mismatch
  // would be a symptom, and reporting it as the cause would send a reader after the
  // wrong problem.
  'compliance_attached_and_unchanged',
  'compliance_not_block',
  'approval_matches_content_reference',
  'tool_permission_still_granted',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The content this approval is actually for. Read from the compliance input the gate
// attached, which is the same object compliance was evaluated from - so the reference
// cannot drift from the content it describes.
function approvedContentReference(request) {
  const input = request.execution_request && request.execution_request.compliance_input;
  return isPlainObject(input) && isNonEmptyString(input.content_reference) ? input.content_reference.trim() : null;
}

function refuse(checks, failedCheck, reason, extra = {}) {
  return {
    authorized: false,
    reason,
    failed_check: failedCheck,
    checks,
    compliance_status: null,
    approval: null,
    limitations: [AUTHORIZATION_LIMITATION],
    ...extra,
  };
}

// Answers "is this content authorized for a future publishing action?".
//
//   requests         - the SERVER-HELD array of approval requests. Required. This is the
//                      array approvals/approvalWorkflow.js already operates on (on the
//                      server: a run's own approval tracker). Never client-supplied.
//   requestId        - which approval to consult. A lookup key only; naming one confers
//                      nothing.
//   contentReference - the content the caller wants authorization FOR. Compared against
//                      what the approval was actually granted for.
//   specialistId     - optional, for the permission re-check; defaults to the record's.
//   auditTracker     - optional; every decision is recorded when supplied.
//
// Returns { authorized, reason, failed_check, checks, compliance_status, approval,
// limitations }. Never throws for a merely unauthorized request - refusal is a normal,
// reportable outcome. Throws only when `requests` is not a server-held array, because
// that is a programming error at the call site, not an authorization outcome.
function authorizePublishing({ requests, requestId, contentReference, specialistId, auditTracker = null } = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'authorizePublishing requires the server-held `requests` array. It never accepts an approval record from a caller - that is what makes a forged record impossible.'
    );
  }

  const checks = {};
  for (const check of AUTHORIZATION_CHECKS) checks[check] = false;

  const record = isNonEmptyString(requestId) ? getApprovalRequestById(requests, requestId) : undefined;

  const recordAudit = (outcome) => {
    appendAuditEvent(auditTracker, {
      type: 'approval',
      toolId: (record && record.tool_id) || null,
      specialistId: (record && record.specialist_id) || null,
      classification: (record && record.classification) || null,
      status: outcome.authorized ? 'authorized' : 'refused',
      summary: outcome.authorized
        ? `Publish authorization GRANTED for '${contentReference}' (approval '${requestId}', compliance ${outcome.compliance_status}). Nothing was published.`
        : `Publish authorization REFUSED for '${contentReference || '(no content reference)'}': ${outcome.reason}`,
      detail: { failed_check: outcome.failed_check || null, checks: outcome.checks },
    });
    return outcome;
  };

  // 1. The record must exist in state the server holds. A caller naming an unknown id
  //    gets nothing, and a caller cannot supply a record at all.
  if (!record) {
    return recordAudit(
      refuse(
        checks,
        'request_found_in_server_state',
        isNonEmptyString(requestId)
          ? `No approval request '${requestId}' exists in server-held state.`
          : 'A non-empty approval request id is required.'
      )
    );
  }
  checks.request_found_in_server_state = true;

  // 2. It must be a real approvals/approvalRequestModel.js record - not something
  //    shaped to look like one.
  const shape = validateApprovalRequestShape(record);
  if (!shape.valid) {
    return recordAudit(
      refuse(checks, 'record_from_approval_workflow', `Approval request '${requestId}' is not a valid approval record: ${shape.errors.join('; ')}`)
    );
  }
  checks.record_from_approval_workflow = true;

  // 3. Its classification must be one that genuinely required approval. An
  //    analysis_only/recommendation record never needed a human at all, so a decision
  //    on one confers no authority over a consequential action.
  if (!requiresApproval(record.classification)) {
    return recordAudit(
      refuse(
        checks,
        'classification_actually_required_approval',
        `Approval request '${requestId}' is classified '${record.classification}', which never required approval - it cannot authorize a consequential action.`
      )
    );
  }
  checks.classification_actually_required_approval = true;

  // 4. A human must actually have approved it. Pending and rejected both stop here.
  if (record.status !== 'approved') {
    return recordAudit(
      refuse(checks, 'human_decision_is_approved', `Approval request '${requestId}' is '${record.status}', not 'approved'.`)
    );
  }
  checks.human_decision_is_approved = true;

  // 5. That decision must be accountable. approvals/approvalWorkflow.js already refuses
  //    to record one without a decided_by; this refuses to ACT on one lacking it.
  if (!isNonEmptyString(record.decided_by) || !isNonEmptyString(record.decided_at)) {
    return recordAudit(
      refuse(checks, 'decision_is_accountable', `Approval request '${requestId}' carries no accountable decision (decided_by/decided_at).`)
    );
  }
  checks.decision_is_accountable = true;

  // 6 & 7. Compliance must still be attached, unchanged, and not BLOCK - recomputed from
  //    the record's own content by the gate, never read off a claimed field.
  const verification = verifyComplianceForApprovalRequest(record);
  if (!verification.ok) {
    const failedCheck =
      verification.compliance_result && verification.compliance_result.status === 'BLOCK'
        ? 'compliance_not_block'
        : 'compliance_attached_and_unchanged';
    if (failedCheck === 'compliance_not_block') checks.compliance_attached_and_unchanged = true;
    return recordAudit(refuse(checks, failedCheck, verification.reason));
  }
  checks.compliance_attached_and_unchanged = true;
  checks.compliance_not_block = true;

  // 8. The approval must be FOR this content. An approval of something else authorizes
  //    nothing here, however genuine it is.
  const approvedFor = approvedContentReference(record);
  if (!isNonEmptyString(contentReference)) {
    return recordAudit(refuse(checks, 'approval_matches_content_reference', 'A non-empty content reference is required to authorize anything.'));
  }
  if (approvedFor === null) {
    return recordAudit(
      refuse(
        checks,
        'approval_matches_content_reference',
        `Approval request '${requestId}' names no content reference, so it cannot be matched to the content being authorized.`
      )
    );
  }
  if (approvedFor !== contentReference.trim()) {
    return recordAudit(
      refuse(
        checks,
        'approval_matches_content_reference',
        `Approval request '${requestId}' was granted for a different content reference, so it does not authorize '${contentReference.trim()}'.`
      )
    );
  }
  checks.approval_matches_content_reference = true;

  // 9. Permission is re-checked at the moment of asking, exactly as
  //    agent/core/orchestratorExecutionContract.js's resumeApprovedExecution() does:
  //    an approval only ever satisfied the approval gate, never the permission one, and
  //    ownership could have changed since the request was created.
  if (isNonEmptyString(record.tool_id)) {
    const access = checkToolAccess({
      specialistId: specialistId === undefined ? record.specialist_id : specialistId,
      toolId: record.tool_id,
    });
    if (access.decision === 'unavailable' || access.decision === 'denied') {
      return recordAudit(
        refuse(checks, 'tool_permission_still_granted', `Permission is no longer granted for this action: ${access.reason}`)
      );
    }
  }
  checks.tool_permission_still_granted = true;

  // Belt and braces: the gate's own record-level predicate must agree. Reused rather
  // than restated, so the two can never drift apart.
  if (!isAuthorizedForPublishing(record)) {
    return recordAudit(
      refuse(checks, 'compliance_attached_and_unchanged', `Approval request '${requestId}' does not authorize publishing.`)
    );
  }

  return recordAudit({
    authorized: true,
    reason: null,
    failed_check: null,
    checks,
    compliance_status: verification.compliance_result.status,
    approval: {
      id: record.id,
      status: record.status,
      classification: record.classification,
      decided_by: record.decided_by,
      decided_at: record.decided_at,
      content_reference: approvedFor,
    },
    limitations: [AUTHORIZATION_LIMITATION],
  });
}

module.exports = {
  AUTHORIZATION_CHECKS,
  AUTHORIZATION_LIMITATION,
  authorizePublishing,
};

if (require.main === module) {
  const {
    requestApprovalForCheckedContent,
    decideComplianceGatedApproval,
  } = require('./complianceApprovalGate');

  console.log('Smart E-Commerce Growth AI Agent - publish authorization boundary:\n');

  const provenance = {
    source: 'seo_content_generation',
    evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
  };
  const contentReference = '(placeholder) jacket-lifespan';

  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: {
      content: 'How long an insulated jacket lasts depends on how often you wear it and how you store it.',
      content_reference: contentReference,
      provenance,
    },
  });

  const pending = authorizePublishing({ requests: gated.requests, requestId: 'apr-1', contentReference });
  console.log(`--- pending approval        -> authorized: ${pending.authorized} (${pending.failed_check})`);

  const decided = decideComplianceGatedApproval(gated.requests, 'apr-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (caller-supplied placeholder)',
  });

  const granted = authorizePublishing({ requests: decided.requests, requestId: 'apr-1', contentReference });
  console.log(`--- approved, same content  -> authorized: ${granted.authorized} (compliance ${granted.compliance_status})`);

  const wrongContent = authorizePublishing({
    requests: decided.requests,
    requestId: 'apr-1',
    contentReference: '(placeholder) a-completely-different-page',
  });
  console.log(`--- approved, other content -> authorized: ${wrongContent.authorized} (${wrongContent.failed_check})`);

  console.log(`\n${AUTHORIZATION_LIMITATION}`);
  console.log('Every value above is an invented placeholder.');
}
