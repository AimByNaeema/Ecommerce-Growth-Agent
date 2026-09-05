'use strict';

// The Etsy publishing workflow - the last link in the chain, and the only thing in this
// project that would ever mutate an external marketplace:
//
//   Content -> Compliance -> Human Approval -> Publish Authorization -> Etsy Publish
//
// ONE JOB: re-check server-side authorization IMMEDIATELY before the mutation, then call
// the adapter exactly once, then record what happened. It composes existing pieces and
// adds no second gate of its own: approvals/publishAuthorization.js decides authority,
// integrations/adapters/etsyClient.js owns the transport, audit/auditTrail.js records it.
//
// NOTHING CLIENT-SUPPLIED IS TRUSTED. There is no parameter here for an approval record,
// an approval status, a compliance verdict, or an authorization result - the same
// property approvals/publishAuthorization.js establishes, preserved by not re-opening it.
// A caller passes the SERVER-HELD requests array plus a lookup id and a content
// reference; authority is recomputed here, at the moment of publishing, not inherited
// from anything a caller asserts.
//
// WHY RE-CHECK WHEN THE CALLER MAY HAVE CHECKED ALREADY. Authorization is a statement
// about a moment: an approval can be rejected, content can be edited into a BLOCK, and a
// permission can be revoked between an earlier check and this call. Re-running it here
// is cheap (compliance is deterministic and offline, and no model is involved) and it is
// the only check whose result is still true when the mutation happens.
//
// FAIL CLOSED. The adapter is unreachable except through a passing authorization: there
// is exactly one call site for etsyClient.publishListing() in this file, and it sits
// after the authorization branch has already returned on every failure path. An
// unauthorized publish makes ZERO adapter calls - not a call that is later discarded.
//
// NO AI CALL. Publishing needs no model, so none is made and no token budget is touched.
//
// etsyClient is required as a module object and called via property access so a test can
// substitute it without a mocking framework - this project's existing convention (see
// tools/aiReasoningCompletion.js's own header). That is also what lets the test suite
// assert an exact adapter call COUNT, which is the real security property.

const etsyClient = require('./adapters/etsyClient');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const MARKETPLACE = 'etsy';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Publishes one already-authorized formatted listing to Etsy.
//
//   requests         - the SERVER-HELD approval requests array. Required.
//   requestId        - which approval to consult. A lookup key only.
//   contentReference - the content being published. Matched against the approval.
//   listing          - an agent/core/marketplaceListingFormatModel.js record.
//   specialistId     - optional, forwarded to the permission re-check.
//   businessId       - optional, selects that business's own Etsy credentials.
//   auditTracker     - optional; the attempt and its result are both recorded.
//
// Returns { published, status, reason, authorization, result, marketplace }.
//   status 'refused'   - not authorized. NO adapter call was made.
//   status 'failed'    - authorized, the adapter was called, and Etsy (or the adapter)
//                        reported a failure. Reported honestly, never as a success.
//   status 'published' - authorized and the adapter returned a real result.
//
// Never throws for an unauthorized or failed publish - both are real, reportable
// outcomes. Throws only when `requests` is not a server-held array, which is a
// programming error at the call site rather than an outcome.
async function publishAuthorizedListingToEtsy({
  requests,
  requestId,
  contentReference,
  listing,
  specialistId,
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'publishAuthorizedListingToEtsy requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }

  // THE RE-CHECK, immediately before the mutation and after nothing else. Recomputed
  // from server-held state: the approval must exist, be genuinely approved by an
  // accountable human, be for THIS content, still carry an unchanged non-BLOCK
  // compliance verdict, and still hold its permission.
  const authorization = authorizePublishing({
    requests,
    requestId,
    contentReference,
    specialistId,
    auditTracker,
  });

  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      toolId: null,
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'refused',
      summary: `Etsy publish REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Etsy call was made.`,
      detail: { failed_check: authorization.failed_check, marketplace: MARKETPLACE },
    });
    return {
      published: false,
      status: 'refused',
      reason: authorization.reason,
      authorization,
      result: null,
      marketplace: MARKETPLACE,
    };
  }

  if (!isPlainObject(listing)) {
    // Authorized, but there is nothing to publish. Refused before the adapter rather
    // than sending a malformed mutation.
    appendAuditEvent(auditTracker, {
      type: 'error',
      status: 'error',
      summary: `Etsy publish REFUSED for '${contentReference}' - no formatted listing was supplied. No Etsy call was made.`,
      detail: { marketplace: MARKETPLACE },
    });
    return {
      published: false,
      status: 'refused',
      reason: 'A formatted marketplace listing record is required to publish.',
      authorization,
      result: null,
      marketplace: MARKETPLACE,
    };
  }

  // The attempt is recorded BEFORE the call, so a crash mid-flight still leaves evidence
  // that a mutation was attempted - an attempt that vanishes is worse than a failed one.
  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'attempted',
    summary: `Etsy publish ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}).`,
    detail: {
      marketplace: MARKETPLACE,
      approval_id: requestId,
      decided_by: authorization.approval.decided_by,
      compliance_status: authorization.compliance_status,
    },
  });

  let result;
  try {
    // The single adapter call site in this file, reached only past every check above.
    result = await etsyClient.publishListing({ listing, businessId });
  } catch (err) {
    // A missing credential, an unavailable transport, a network failure, or an Etsy
    // error - all surfaced as they are, never converted into a success and never
    // retried here (agent/core/networkRetry.js already owns bounded retries inside the
    // adapter). The error message is the adapter's own, which is written to name what is
    // missing without ever including a credential value.
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'failed',
      summary: `Etsy publish FAILED for '${contentReference}': ${err.message}`,
      detail: { marketplace: MARKETPLACE, approval_id: requestId },
    });
    return {
      published: false,
      status: 'failed',
      reason: err.message,
      authorization,
      result: null,
      marketplace: MARKETPLACE,
    };
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'success',
    summary: `Etsy publish SUCCEEDED for '${contentReference}' under approval '${requestId}'.`,
    detail: { marketplace: MARKETPLACE, approval_id: requestId, result },
  });

  return {
    published: true,
    status: 'published',
    reason: null,
    authorization,
    // Etsy's actual result/reference, relayed exactly as the adapter returned it - never
    // reshaped into something this project invented.
    result,
    marketplace: MARKETPLACE,
  };
}

module.exports = { MARKETPLACE, publishAuthorizedListingToEtsy };

if (require.main === module) {
  const {
    requestApprovalForCheckedContent,
    decideComplianceGatedApproval,
  } = require('../approvals/complianceApprovalGate');

  console.log('Smart E-Commerce Growth AI Agent - Etsy publishing workflow:\n');

  const contentReference = '(placeholder) handmade-jacket-listing';
  const listing = {
    marketplace: 'etsy',
    product_reference: '(placeholder product)',
    formatted_title: '(placeholder title)',
    formatted_description: '(placeholder description)',
    formatted_attributes: [],
    format_constraints_applied: [],
  };

  (async () => {
    const gated = requestApprovalForCheckedContent({
      id: 'apr-1',
      toolId: 'compliance_check',
      complianceInput: {
        content: 'A warm, water-resistant jacket made for cold, wet commutes.',
        content_reference: contentReference,
        provenance: {
          source: 'listing_content_generation',
          evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder)' }],
        },
      },
    });

    const beforeApproval = await publishAuthorizedListingToEtsy({
      requests: gated.requests,
      requestId: 'apr-1',
      contentReference,
      listing,
    });
    console.log(`--- pending approval  -> ${beforeApproval.status} (${beforeApproval.authorization.failed_check}) - zero Etsy calls`);

    const decided = decideComplianceGatedApproval(gated.requests, 'apr-1', {
      decision: 'approved',
      decidedBy: 'store-owner@example.com (caller-supplied placeholder)',
    });

    const afterApproval = await publishAuthorizedListingToEtsy({
      requests: decided.requests,
      requestId: 'apr-1',
      contentReference,
      listing,
    });
    console.log(`--- approved          -> ${afterApproval.status}`);
    console.log(`    reason: ${afterApproval.reason}`);

    console.log('\nAuthorized publishing reaches the adapter, which refuses honestly rather than');
    console.log('fabricating a listing - see integrations/adapters/etsyClient.js.');
    console.log('Every value above is an invented placeholder.');
  })();
}
