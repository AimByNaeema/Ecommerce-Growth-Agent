'use strict';

// The Shopify vendor correction workflow - one of three write orchestration wrappers
// built alongside integrations/shopifyBlogPublishing.js's existing chain, and shaped
// identically to it:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify productUpdate
//
// ONE JOB: re-check server-side authorization IMMEDIATELY before the mutation, then call
// the client exactly once, then record what happened, then independently re-read the
// live product to confirm the vendor actually changed. It composes existing pieces and
// adds no second gate of its own: approvals/publishAuthorization.js decides authority,
// integrations/adapters/shopifyClient.js owns the transport and the one real mutation,
// audit/auditTrail.js records it. This is deliberately the same shape as
// integrations/shopifyBlogPublishing.js - reused rather than reinvented.
//
// NOTHING CLIENT-SUPPLIED IS TRUSTED. There is no parameter here for an approval record,
// an approval status, a compliance verdict, or an authorization result. A caller passes
// the SERVER-HELD requests array plus a lookup id and a content reference; authority is
// recomputed here, at the moment of correcting, not inherited from anything a caller
// asserts.
//
// FAIL CLOSED. The client's mutation is unreachable except through a passing
// authorization: there is exactly one call site for shopifyClient.updateProductVendor()
// in this file, and it sits after the authorization branch has already returned on every
// failure path. The client then applies its OWN fail-closed 'write_products' scope
// preflight before any mutation leaves the process.
//
// ONLY THE VENDOR FIELD IS EVER TOUCHED. No other product field (title, description,
// price, images, status, collections) is read, sent, or requested back anywhere in this
// file or in shopifyClient.updateProductVendor().
//
// RETURNED SHAPE DELIBERATELY DIFFERENT FROM shopifyBlogPublishing.js's `published`
// field: this is a correction, not a publish, so the outcome field is named `succeeded`
// and `status` uses this workflow's own vocabulary ('corrected'/'unconfirmed'), never
// borrowing publishing's vocabulary for something that isn't one.

const shopifyClient = require('./adapters/shopifyClient');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const PLATFORM = 'shopify';
const DESTINATION = 'product_vendor';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Corrects one already-authorized product's vendor field on the live store, then
// independently re-reads it to confirm the change actually took.
//
//   requests         - the SERVER-HELD approval requests array. Required.
//   requestId        - which approval to consult. A lookup key only.
//   contentReference - the change being authorized. Matched against the approval.
//   productId        - the product's gid://shopify/Product/... id. Required.
//   newVendor        - the vendor value to set. Required, non-empty.
//   specialistId     - optional, forwarded to the permission re-check.
//   businessId       - optional, selects that business's own Shopify credentials.
//   auditTracker     - optional; the attempt, result, and re-read are all recorded.
//
// Returns { succeeded, status, reason, authorization, result }.
//   status 'refused'     - not authorized, or nothing valid to correct. NO mutation made.
//   status 'failed'      - authorized, the client was called, and Shopify (or its own
//                          scope preflight) reported a failure.
//   status 'unconfirmed' - the mutation reported success, but an independent re-read did
//                          not show the expected vendor. Never reported as a success.
//   status 'corrected'   - authorized, mutated, and independently re-read as correct.
async function correctProductVendor({
  requests,
  requestId,
  contentReference,
  productId,
  newVendor,
  specialistId = 'product',
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'correctProductVendor requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }

  const authorization = authorizePublishing({ requests, requestId, contentReference, specialistId, auditTracker });

  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      toolId: null,
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'refused',
      summary: `Shopify vendor correction REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Shopify call was made.`,
      detail: { failed_check: authorization.failed_check, platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason: authorization.reason, authorization, result: null };
  }

  const missing = [];
  if (!isNonEmptyString(productId)) missing.push('a productId');
  if (!isNonEmptyString(newVendor)) missing.push('a newVendor');
  if (missing.length > 0) {
    const reason = `Nothing was corrected: ${missing.join('; ')}. Nothing here is substituted or invented.`;
    appendAuditEvent(auditTracker, {
      type: 'error',
      status: 'error',
      summary: `Shopify vendor correction REFUSED for '${contentReference}' - ${reason} No Shopify call was made.`,
      detail: { platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason, authorization, result: null };
  }

  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'attempted',
    summary: `Shopify vendor correction ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}): product '${productId}' -> vendor '${newVendor}'.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, decided_by: authorization.approval.decided_by, product_id: productId, new_vendor: newVendor },
  });

  let result;
  try {
    result = await shopifyClient.updateProductVendor({ productId, vendor: newVendor, businessId });
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'failed',
      summary: `Shopify vendor correction FAILED for '${contentReference}': ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return { succeeded: false, status: 'failed', reason: err.message, authorization, result: null };
  }

  // Independent re-read: a fresh, separate query, never the mutation's own echoed
  // response alone. getProducts() is the existing read function; filtered locally to
  // the one product this correction targeted.
  let reread;
  try {
    const products = await shopifyClient.getProducts({ limit: 250, businessId });
    reread = products.find((product) => product.id === productId) || null;
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'error',
      summary: `Shopify vendor correction for '${contentReference}' mutated successfully, but the independent re-read failed: ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return { succeeded: false, status: 'unconfirmed', reason: `Mutated, but could not independently re-read: ${err.message}`, authorization, result };
  }

  if (!reread || reread.vendor !== newVendor) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'error',
      summary: `Shopify vendor correction for '${contentReference}' mutated, but the independent re-read shows vendor='${reread ? reread.vendor : '(product not found)'}', not '${newVendor}'.`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return {
      succeeded: false,
      status: 'unconfirmed',
      reason: `Shopify accepted the mutation, but an independent re-read shows vendor='${reread ? reread.vendor : '(product not found)'}', not the expected '${newVendor}'.`,
      authorization,
      result,
    };
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'success',
    summary: `Shopify vendor correction SUCCEEDED and was independently re-read for '${contentReference}' under approval '${requestId}': product '${productId}' now shows vendor '${newVendor}'.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, result, reread_vendor: reread.vendor },
  });

  return { succeeded: true, status: 'corrected', reason: null, authorization, result };
}

module.exports = {
  PLATFORM,
  DESTINATION,
  correctProductVendor,
};
