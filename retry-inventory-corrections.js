'use strict';

// One-off INVENTORY-ONLY retry runner. Deliberately separate from
// execute-confirmed-corrections.js so that re-running this can never re-touch the vendor
// or collection corrections, which are already applied and independently verified.
//
// Drives the same real chain for every write:
//   Compliance -> Human Approval -> Publish Authorization -> Shopify -> independent re-read
//
// Touches ONLY the four owner-approved inventory items. The three unresolved items
// (CPM-005 -7, CPM-009 -1, CPM-010 -2) are never referenced here at all. Not part of the
// permanent project - delete once the correction is complete.

const crypto = require('node:crypto');
const shopifyClient = require('./integrations/adapters/shopifyClient');
const { planInventoryCorrections, correctInventoryDeficit } = require('./integrations/shopifyInventoryCorrection');
const { requestApprovalForCheckedContent, decideComplianceGatedApproval } = require('./approvals/complianceApprovalGate');
const { createAuditTracker, getEventsByType, getErrorEvents } = require('./audit/auditTrail');

const DECIDED_BY = 'aimbynaeema@gmail.com';
const SPECIALIST_ID = 'product';

// The four items the owner approved, each fully explained by Shopify's own test:true
// orders. Nothing else is in scope.
const APPROVED_INVENTORY_ITEMS = {
  'gid://shopify/InventoryItem/52128333594864': '16 Football Quotes SVG Bundle',
  'gid://shopify/InventoryItem/52128334774512': '8 Valentine Love SVG Bundle (inventory only)',
  'gid://shopify/InventoryItem/52341708914928': '108 Watercolor Mega Clipart PNG Bundle',
  'gid://shopify/InventoryItem/52342235070704': '14 Bear Doll Halloween Sublimation PNG Bundle',
};

function extractDigitTokens(text) {
  return String(text || '').match(/\d[\d,.]*/g) || [];
}

// A DETERMINISTIC idempotency key for one logical correction. This API version mandates
// @idempotent(key:) on inventoryAdjustQuantities, and the point of that directive is
// defeated by a random key: deriving it from the item, location and delta means running
// this script twice sends the SAME key, so Shopify absorbs the repeat instead of applying
// a second +1. Formatted as a UUID because that is the shape Shopify's own directive
// documentation shows.
function deterministicIdempotencyKey(inventoryItemId, locationId, delta) {
  const digest = crypto
    .createHash('sha256')
    .update(`inventory-correction|${inventoryItemId}|${locationId}|${delta}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

const tracker = createAuditTracker('run-inventory-correction-retry-2026-09-08');
let requests = [];
let approvalCounter = 0;

(async () => {
  const scopes = await shopifyClient.getGrantedAccessScopes({ refresh: true });
  console.log(`Scopes: write_inventory=${scopes.includes('write_inventory')}`);

  // --- 1. Fresh live re-read of the four approved items -------------------------------
  console.log('\n=== BEFORE (live re-read of the 4 approved items) ===');
  const itemsBefore = await shopifyClient.getInventoryItemsByIds({
    inventoryItemIds: Object.keys(APPROVED_INVENTORY_ITEMS),
  });
  const negativeItems = [];
  for (const item of itemsBefore) {
    for (const level of item.levels) {
      console.log(`  ${APPROVED_INVENTORY_ITEMS[item.id]} | available=${level.available} | loc=${level.locationId}`);
      if (typeof level.available === 'number' && level.available < 0) {
        negativeItems.push({ id: item.id, sku: item.sku, available: level.available, locationId: level.locationId });
      }
    }
  }

  // --- 2. Rebuild the test-order reconciliation from fresh order data -------------------
  const orders = await shopifyClient.getOrders({ limit: 250 });
  const testOrderTotals = shopifyClient.sumTestOrderQuantitiesByInventoryItem(orders);
  const { resolvable, unresolved } = planInventoryCorrections({ inventoryItems: negativeItems, testOrderTotals });

  const alreadyApplied = Object.keys(APPROVED_INVENTORY_ITEMS).filter(
    (id) => !negativeItems.some((item) => item.id === id)
  );
  console.log(`\n  already applied (no longer negative, skipped): ${alreadyApplied.length}`);
  for (const id of alreadyApplied) console.log(`    SKIP: ${APPROVED_INVENTORY_ITEMS[id]}`);
  console.log(`  resolvable now: ${resolvable.length}, unresolved: ${unresolved.length}`);
  for (const entry of unresolved) {
    console.log(`    UNRESOLVED (untouched): ${APPROVED_INVENTORY_ITEMS[entry.inventoryItemId]} available=${entry.currentAvailable} testOrderQty=${entry.testOrderQuantitySum} discrepancy=${entry.discrepancy}`);
  }

  // --- 3. The real chain, per resolvable item -------------------------------------------
  console.log('\n=== APPLYING ===');
  const applied = [];
  for (const item of resolvable) {
    approvalCounter += 1;
    const requestId = `apr-inv-${approvalCounter}`;
    const label = APPROVED_INVENTORY_ITEMS[item.inventoryItemId];
    const contentReference = `inventory-correction-${item.inventoryItemId}`;
    const content = `Restore ${item.delta} unit(s) to inventory item ${item.inventoryItemId} at location ${item.locationId}, matching the exact quantity decremented by Shopify's own orders flagged test:true for this item.`;

    const gated = requestApprovalForCheckedContent({
      id: requestId,
      toolId: 'shopify_inventory_correction',
      specialistId: SPECIALIST_ID,
      complianceInput: {
        content,
        content_reference: contentReference,
        content_type: 'inventory_correction',
        provenance: {
          source: 'shopify_inventory_correction',
          generator: 'integrations/shopifyInventoryCorrection.js',
          evidence: orders
            .filter((order) => order.test && order.lineItems.some((li) => li.inventoryItemId === item.inventoryItemId))
            .map((order) => ({ signal_kind: 'shopify_test_order', reference: order.id })),
          supported_facts: [
            String(item.delta),
            item.inventoryItemId,
            item.locationId,
            ...extractDigitTokens(item.inventoryItemId),
            ...extractDigitTokens(item.locationId),
          ],
        },
      },
      requests,
      auditTracker: tracker,
    });
    requests = gated.requests;
    if (gated.status !== 'pending_approval') {
      console.log(`  ${label}: COMPLIANCE ${gated.status.toUpperCase()} - ${gated.reason}`);
      continue;
    }

    const decided = decideComplianceGatedApproval(requests, requestId, {
      decision: 'approved',
      decidedBy: DECIDED_BY,
      notes: 'Batch-confirmed by the store owner for the four test-order-caused inventory deficits.',
      auditTracker: tracker,
    });
    requests = decided.requests;
    if (!decided.ok) {
      console.log(`  ${label}: APPROVAL REFUSED - ${decided.reason}`);
      continue;
    }

    const outcome = await correctInventoryDeficit({
      requests,
      requestId,
      contentReference,
      inventoryItemId: item.inventoryItemId,
      locationId: item.locationId,
      delta: item.delta,
      // The live quantity this plan was computed from - Shopify refuses the adjustment
      // if it is no longer that, so an already-applied correction cannot double-apply.
      changeFromQuantity: item.currentAvailable,
      idempotencyKey: deterministicIdempotencyKey(item.inventoryItemId, item.locationId, item.delta),
      specialistId: SPECIALIST_ID,
      auditTracker: tracker,
    });

    console.log(`  ${label}: ${outcome.status.toUpperCase()}${outcome.reason ? ` - ${outcome.reason}` : ''}`);
    applied.push({ label, inventoryItemId: item.inventoryItemId, before: item.currentAvailable, delta: item.delta, status: outcome.status, reason: outcome.reason });
  }

  // --- 4. Independent AFTER re-read ------------------------------------------------------
  console.log('\n=== AFTER (independent live re-read of the 4 approved items) ===');
  const itemsAfter = await shopifyClient.getInventoryItemsByIds({
    inventoryItemIds: Object.keys(APPROVED_INVENTORY_ITEMS),
  });
  for (const item of itemsAfter) {
    for (const level of item.levels) {
      console.log(`  ${APPROVED_INVENTORY_ITEMS[item.id]} | available=${level.available} | loc=${level.locationId}`);
    }
  }

  console.log('\n=== Audit ===');
  console.log(`  approval: ${getEventsByType(tracker, 'approval').length}, execution: ${getEventsByType(tracker, 'execution').length}, result: ${getEventsByType(tracker, 'result').length}, error: ${getErrorEvents(tracker).length}`);
  console.log('\n=== RESULT JSON ===');
  console.log(JSON.stringify({ alreadyApplied, applied, unresolved }, null, 2));
})().catch((err) => {
  console.error('Retry runner FAILED:', err.message);
  process.exit(1);
});
