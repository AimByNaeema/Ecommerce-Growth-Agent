'use strict';

// The Shopify inventory correction workflow - one of three write orchestration
// wrappers built alongside integrations/shopifyBlogPublishing.js's existing chain, and
// shaped identically to it:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify inventoryAdjustQuantities
//
// TWO RESPONSIBILITIES, DELIBERATELY SEPARATED:
//   planInventoryCorrections() - a PURE function, no I/O - decides, per negative
//     inventory item, exactly how much of its deficit Shopify's own `test: true` order
//     flag can account for. It never guesses: an item whose test-order quantity does not
//     EXACTLY match its deficit is reported unresolved, with the exact discrepancy,
//     rather than partially corrected.
//   correctInventoryDeficit() - the orchestration wrapper - re-checks authorization,
//     calls the one client mutation, and independently re-reads the corrected item.
//
// See integrations/shopifyVendorCorrection.js's header for the shared design rationale
// (re-check immediately before the mutation, fail closed, one call site, independent
// re-read, no client-supplied approval state trusted).

const shopifyClient = require('./adapters/shopifyClient');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const PLATFORM = 'shopify';
const DESTINATION = 'inventory_correction';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Decides, for each negative inventory item, whether Shopify's own test-order signal
// exactly accounts for its deficit. Pure: takes already-fetched data, makes no Shopify
// call itself.
//
//   inventoryItems - array of { id, sku, available, locationId } - one entry per
//     negative (inventoryItem, location) pair to evaluate. `available` is expected to be
//     negative; a non-negative entry is skipped (nothing to correct).
//   testOrderTotals - a Map<inventoryItemId, quantity>, as returned by
//     shopifyClient.sumTestOrderQuantitiesByInventoryItem(orders).
//
// Returns { resolvable, unresolved }:
//   resolvable - items where testOrderQuantitySum === |available| exactly. Each entry
//     carries the exact `delta` to apply (always +|available|, i.e. the full restoration).
//   unresolved - every other negative item, carrying currentAvailable, testOrderQuantitySum,
//     and the exact discrepancy - never a partial or guessed correction.
function planInventoryCorrections({ inventoryItems, testOrderTotals } = {}) {
  const items = Array.isArray(inventoryItems) ? inventoryItems : [];
  const totals = testOrderTotals instanceof Map ? testOrderTotals : new Map();

  const resolvable = [];
  const unresolved = [];

  for (const item of items) {
    if (!item || typeof item.available !== 'number' || item.available >= 0) continue;
    const deficit = Math.abs(item.available);
    const testOrderQuantitySum = totals.get(item.id) || 0;

    if (testOrderQuantitySum === deficit) {
      resolvable.push({
        inventoryItemId: item.id,
        sku: item.sku,
        locationId: item.locationId,
        currentAvailable: item.available,
        testOrderQuantitySum,
        delta: deficit,
      });
    } else {
      unresolved.push({
        inventoryItemId: item.id,
        sku: item.sku,
        locationId: item.locationId,
        currentAvailable: item.available,
        testOrderQuantitySum,
        discrepancy: deficit - testOrderQuantitySum,
      });
    }
  }

  return { resolvable, unresolved };
}

// Restores one already-authorized inventory item's deficit, then independently re-reads
// it to confirm the correction actually took.
//
//   requests, requestId, contentReference, specialistId, businessId, auditTracker - as
//     in correctProductVendor().
//   inventoryItemId - the gid://shopify/InventoryItem/... id being corrected. Required.
//   locationId      - the gid://shopify/Location/... id the deficit is at. Required.
//   delta           - the exact positive integer quantity to restore. Required. This
//     function never computes or guesses a delta itself - planInventoryCorrections()
//     already decided it from Shopify's own test-order data.
//   changeFromQuantity - optional; the quantity the caller's plan was computed from
//     (planInventoryCorrections()'s currentAvailable). Passed straight through to the
//     client as InventoryChangeInput's own optimistic-concurrency guard: Shopify refuses
//     the adjustment if the live quantity is no longer that value, so a correction that
//     has already been applied cannot be applied a second time. Like delta, it is never
//     computed here - this wrapper performs no read of its own before the mutation.
//   idempotencyKey  - required, non-empty. This API version mandates the @idempotent
//     directive on inventoryAdjustQuantities. The caller supplies a key that is STABLE
//     for one logical correction, so re-running a correction that already succeeded is
//     absorbed by Shopify instead of applying a second time.
//   reason          - a non-empty Shopify inventoryAdjustQuantities reason string.
//     Defaults to 'correction'.
//
// Returns { succeeded, status, reason, authorization, result }.
async function correctInventoryDeficit({
  requests,
  requestId,
  contentReference,
  inventoryItemId,
  locationId,
  delta,
  changeFromQuantity = null,
  idempotencyKey,
  reason = 'correction',
  specialistId = 'product',
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'correctInventoryDeficit requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }

  const authorization = authorizePublishing({ requests, requestId, contentReference, specialistId, auditTracker });

  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      toolId: null,
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'refused',
      summary: `Shopify inventory correction REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Shopify call was made.`,
      detail: { failed_check: authorization.failed_check, platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason: authorization.reason, authorization, result: null };
  }

  const missing = [];
  if (!isNonEmptyString(inventoryItemId)) missing.push('an inventoryItemId');
  if (!isNonEmptyString(locationId)) missing.push('a locationId');
  if (!Number.isInteger(delta) || delta <= 0) missing.push('a positive integer delta');
  if (!isNonEmptyString(idempotencyKey)) missing.push('a non-empty idempotencyKey (this mutation mandates the @idempotent directive)');
  if (missing.length > 0) {
    const refuseReason = `Nothing was corrected: ${missing.join('; ')}. Nothing here is substituted or invented.`;
    appendAuditEvent(auditTracker, {
      type: 'error',
      status: 'error',
      summary: `Shopify inventory correction REFUSED for '${contentReference}' - ${refuseReason} No Shopify call was made.`,
      detail: { platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason: refuseReason, authorization, result: null };
  }

  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'attempted',
    summary: `Shopify inventory correction ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}): inventory item '${inventoryItemId}' +${delta}.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, decided_by: authorization.approval.decided_by, inventory_item_id: inventoryItemId, delta },
  });

  let result;
  try {
    result = await shopifyClient.adjustInventoryQuantities({
      changes: [
        Number.isInteger(changeFromQuantity)
          ? { inventoryItemId, locationId, delta, changeFromQuantity }
          : { inventoryItemId, locationId, delta },
      ],
      reason,
      idempotencyKey,
      businessId,
    });
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'failed',
      summary: `Shopify inventory correction FAILED for '${contentReference}': ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return { succeeded: false, status: 'failed', reason: err.message, authorization, result: null };
  }

  // Independent re-read via a fresh, separate query - cross-checked against Shopify's
  // own quantityAfterChange from the mutation itself, never trusted from either alone.
  let reread;
  try {
    const items = await shopifyClient.getInventoryItemsByIds({ inventoryItemIds: [inventoryItemId], businessId });
    reread = items[0] || null;
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'error',
      summary: `Shopify inventory correction for '${contentReference}' mutated successfully, but the independent re-read failed: ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return { succeeded: false, status: 'unconfirmed', reason: `Mutated, but could not independently re-read: ${err.message}`, authorization, result };
  }

  const rereadLevel = reread ? reread.levels.find((level) => level.locationId === locationId) : null;
  const mutationChange = Array.isArray(result.changes) ? result.changes.find((c) => c.item && c.item.id === inventoryItemId) : null;
  const expectedAfter = mutationChange ? mutationChange.quantityAfterChange : null;

  if (!rereadLevel || (expectedAfter !== null && rereadLevel.available !== expectedAfter)) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'error',
      summary: `Shopify inventory correction for '${contentReference}' mutated, but the independent re-read (${rereadLevel ? rereadLevel.available : '(not found)'}) does not match the mutation's own reported result (${expectedAfter}).`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return {
      succeeded: false,
      status: 'unconfirmed',
      reason: `Shopify accepted the mutation, but an independent re-read does not agree with its own reported result.`,
      authorization,
      result,
    };
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'success',
    summary: `Shopify inventory correction SUCCEEDED and was independently re-read for '${contentReference}' under approval '${requestId}': inventory item '${inventoryItemId}' now available=${rereadLevel.available}.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, result, reread_available: rereadLevel.available },
  });

  return { succeeded: true, status: 'corrected', reason: null, authorization, result };
}

module.exports = {
  PLATFORM,
  DESTINATION,
  planInventoryCorrections,
  correctInventoryDeficit,
};
