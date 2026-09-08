'use strict';

// One-off live execution runner for the owner's five confirmed store-growth decisions.
// Drives the REAL chain for every consequential write:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify -> independent re-read
//
// Read-only verification for decisions 1 and 2 (IP-risk drafts, Valentine listing) -
// no mutation is attempted for either. Not part of the permanent project - delete once
// the execution is complete.

const shopifyClient = require('./integrations/adapters/shopifyClient');
const { correctProductVendor } = require('./integrations/shopifyVendorCorrection');
const { planInventoryCorrections, correctInventoryDeficit } = require('./integrations/shopifyInventoryCorrection');
const { addProductToFreeDesignsCollection } = require('./integrations/shopifyCollectionMembership');
const { requestApprovalForCheckedContent, decideComplianceGatedApproval } = require('./approvals/complianceApprovalGate');
const { createAuditTracker, getEventsByType, getErrorEvents } = require('./audit/auditTrail');

// The accountable human decision-maker for every approval below - the store owner, who
// confirmed each category explicitly in chat. Never a placeholder.
const DECIDED_BY = 'aimbynaeema@gmail.com';
const SPECIALIST_ID = 'product';

const OLD_VENDOR = 'CraftPixel Market';
const NEW_VENDOR = 'Digital Studio by Naeema';
const FREE_DESIGNS_COLLECTION_ID = 'gid://shopify/Collection/486769164528';
const FREE_GHOST_TITLE = 'Free Cute Ghost SVG';

const IP_RISK_DRAFT_TITLES = ['Easter Disney Craft Bundle', '4  Bluey Mom SVG', '4 Mickey And Friends Halloween SVG Bundle'];
const VALENTINE_TITLE = '8 Valentine Love SVG Bundle';

// The four inventory items the owner explicitly approved for correction - each one
// fully explained by Shopify's own test:true orders in Phase 0. CPM-005, CPM-009 and
// CPM-010 are deliberately absent: the owner instructed that they stay untouched
// (CPM-010 included, even though one of its two units traces to a test order).
const APPROVED_INVENTORY_ITEM_IDS = [
  'gid://shopify/InventoryItem/52128333594864', // CPM-EX-7  16 Football Quotes SVG Bundle
  'gid://shopify/InventoryItem/52128334774512', // CPM-EX-9  8 Valentine Love SVG Bundle (inventory only)
  'gid://shopify/InventoryItem/52341708914928', // 108 Watercolor Mega Clipart PNG Bundle
  'gid://shopify/InventoryItem/52342235070704', // 14 Bear Doll Halloween Sublimation PNG Bundle
];

// Every digit run in a compliance `content` sentence must also be a supported fact, or
// compliance/complianceEngine.js's unsupported-claims check flags it (correctly) as a
// claim no evidence backs. Product titles and GIDs carry digits, so they are extracted
// verbatim rather than the sentence being reworded to hide them.
function extractDigitTokens(text) {
  return String(text || '').match(/\d[\d,.]*/g) || [];
}

const tracker = createAuditTracker('run-confirmed-store-corrections-2026-09-08');
let requests = [];
let approvalCounter = 0;

// Runs one item through the real Compliance -> Human Approval chain, then hands the
// authorized request to `execute`. The human decision is the owner's own, recorded per
// item from the single batch confirmation they gave for that category.
async function runGatedAction({ label, contentReference, content, provenance, toolId, execute }) {
  approvalCounter += 1;
  const requestId = `apr-${approvalCounter}`;

  const gated = requestApprovalForCheckedContent({
    id: requestId,
    toolId,
    specialistId: SPECIALIST_ID,
    complianceInput: { content, content_reference: contentReference, content_type: 'catalog_correction', provenance },
    requests,
    auditTracker: tracker,
  });
  requests = gated.requests;

  if (gated.status !== 'pending_approval') {
    console.log(`  ${label}: COMPLIANCE ${gated.status.toUpperCase()} - ${gated.reason}`);
    return { label, status: gated.status, reason: gated.reason };
  }

  const decided = decideComplianceGatedApproval(requests, requestId, {
    decision: 'approved',
    decidedBy: DECIDED_BY,
    notes: 'Batch-confirmed by the store owner in chat for this category.',
    auditTracker: tracker,
  });
  requests = decided.requests;

  if (!decided.ok) {
    console.log(`  ${label}: APPROVAL REFUSED - ${decided.reason}`);
    return { label, status: 'approval_refused', reason: decided.reason };
  }

  const outcome = await execute({ requests, requestId, contentReference });
  console.log(
    `  ${label}: ${outcome.status.toUpperCase()}${outcome.reason ? ` - ${outcome.reason}` : ''} (compliance ${decided.compliance_result.status})`
  );
  return { label, status: outcome.status, reason: outcome.reason, compliance: decided.compliance_result.status };
}

(async () => {
  const results = { vendor: [], inventory: [], collection: [], unresolvedInventory: [] };

  console.log('=== Live state re-read ===');
  const shop = await shopifyClient.getShopInfo();
  console.log(`Store: ${shop.name} (${shop.domain}), API ${shop.apiVersion}`);
  const scopes = await shopifyClient.getGrantedAccessScopes({ refresh: true });
  console.log(`Granted scopes: ${scopes.join(', ')}`);

  const products = await shopifyClient.getProducts({ limit: 250 });

  // --- A. IP-risk drafts: READ-ONLY verification, no mutation -------------------------
  console.log('\n=== A. IP-risk drafts (read-only verification, zero mutations) ===');
  const ipRiskStatuses = IP_RISK_DRAFT_TITLES.map((title) => {
    const product = products.find((p) => p.title === title);
    console.log(`  "${title}": ${product ? product.status : 'NOT FOUND'}`);
    return { title, status: product ? product.status : 'NOT FOUND', id: product ? product.id : null };
  });

  // --- B. Valentine listing: READ-ONLY verification, no mutation ----------------------
  console.log('\n=== B. Valentine listing (read-only verification, zero mutations) ===');
  const valentine = products.find((p) => p.title === VALENTINE_TITLE);
  console.log(`  "${VALENTINE_TITLE}": status=${valentine.status}, vendor=${valentine.vendor}`);

  // --- C. Vendor correction -----------------------------------------------------------
  console.log(`\n=== C. Vendor correction: "${OLD_VENDOR}" -> "${NEW_VENDOR}" ===`);
  const vendorProducts = products.filter((p) => p.vendor === OLD_VENDOR);
  console.log(`  ${vendorProducts.length} product(s) currently show vendor "${OLD_VENDOR}"`);
  for (const product of vendorProducts) {
    const contentReference = `vendor-correction-${product.id}`;
    const content = `Change vendor from '${OLD_VENDOR}' to '${NEW_VENDOR}' on product '${product.title}' (${product.id}).`;
    const result = await runGatedAction({
      label: `"${product.title}"`,
      contentReference,
      content,
      provenance: {
        source: 'shopify_vendor_correction',
        generator: 'integrations/shopifyVendorCorrection.js',
        evidence: [{ signal_kind: 'product_data_retrieval', reference: product.id }],
        supported_facts: [product.id, ...extractDigitTokens(product.title), ...extractDigitTokens(product.id)],
      },
      toolId: 'shopify_vendor_correction',
      execute: ({ requests: serverRequests, requestId, contentReference: ref }) =>
        correctProductVendor({
          requests: serverRequests,
          requestId,
          contentReference: ref,
          productId: product.id,
          newVendor: NEW_VENDOR,
          specialistId: SPECIALIST_ID,
          auditTracker: tracker,
        }),
    });
    results.vendor.push({ ...result, productId: product.id, oldVendor: OLD_VENDOR, newVendor: NEW_VENDOR });
  }

  // --- D. Inventory correction ---------------------------------------------------------
  console.log('\n=== D. Inventory correction (test-order-caused deficits only) ===');
  const orders = await shopifyClient.getOrders({ limit: 250 });
  const testOrderTotals = shopifyClient.sumTestOrderQuantitiesByInventoryItem(orders);
  const allInventoryItems = await shopifyClient.getInventoryItemsByIds({
    inventoryItemIds: APPROVED_INVENTORY_ITEM_IDS,
  });

  const negativeItems = [];
  for (const item of allInventoryItems) {
    for (const level of item.levels) {
      if (typeof level.available === 'number' && level.available < 0) {
        negativeItems.push({ id: item.id, sku: item.sku, available: level.available, locationId: level.locationId });
      }
    }
  }

  const { resolvable, unresolved } = planInventoryCorrections({ inventoryItems: negativeItems, testOrderTotals });
  results.unresolvedInventory = unresolved;
  console.log(`  ${resolvable.length} resolvable, ${unresolved.length} unresolved (of the ${APPROVED_INVENTORY_ITEM_IDS.length} owner-approved items)`);
  for (const entry of unresolved) {
    console.log(`  UNRESOLVED (not touched): ${entry.inventoryItemId} sku=${entry.sku} available=${entry.currentAvailable} testOrderQty=${entry.testOrderQuantitySum} discrepancy=${entry.discrepancy}`);
  }

  for (const item of resolvable) {
    const productForItem = products.find((p) => p.variants.some((v) => v.sku && v.sku === item.sku));
    const productTitle = productForItem ? productForItem.title : '(product title not resolved by sku)';
    const contentReference = `inventory-correction-${item.inventoryItemId}`;
    const content = `Restore ${item.delta} unit(s) to inventory item ${item.inventoryItemId} at location ${item.locationId}, matching the exact quantity decremented by Shopify's own orders flagged test:true for this item.`;
    const result = await runGatedAction({
      label: `${item.sku || '(no sku)'} ${productTitle}`,
      contentReference,
      content,
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
          ...extractDigitTokens(item.sku || ''),
        ],
      },
      toolId: 'shopify_inventory_correction',
      execute: ({ requests: serverRequests, requestId, contentReference: ref }) =>
        correctInventoryDeficit({
          requests: serverRequests,
          requestId,
          contentReference: ref,
          inventoryItemId: item.inventoryItemId,
          locationId: item.locationId,
          delta: item.delta,
          specialistId: SPECIALIST_ID,
          auditTracker: tracker,
        }),
    });
    results.inventory.push({ ...result, inventoryItemId: item.inventoryItemId, sku: item.sku, before: item.currentAvailable, delta: item.delta });
  }

  // --- E. Free Designs collection -------------------------------------------------------
  console.log('\n=== E. Free Designs collection ===');
  const freeGhost = products.find((p) => p.title === FREE_GHOST_TITLE);
  const contentReference = `collection-add-${freeGhost.id}-${FREE_DESIGNS_COLLECTION_ID}`;
  const content = `Add product '${FREE_GHOST_TITLE}' (${freeGhost.id}) to the existing 'Free Designs' collection (${FREE_DESIGNS_COLLECTION_ID}). No new collection is created and no other field is changed.`;
  const collectionResult = await runGatedAction({
    label: `"${FREE_GHOST_TITLE}" -> Free Designs`,
    contentReference,
    content,
    provenance: {
      source: 'shopify_collection_membership_update',
      generator: 'integrations/shopifyCollectionMembership.js',
      evidence: [{ signal_kind: 'collection_data_retrieval', reference: FREE_DESIGNS_COLLECTION_ID }],
      supported_facts: [
        freeGhost.id,
        FREE_DESIGNS_COLLECTION_ID,
        ...extractDigitTokens(freeGhost.id),
        ...extractDigitTokens(FREE_DESIGNS_COLLECTION_ID),
      ],
    },
    toolId: 'shopify_collection_membership_update',
    execute: ({ requests: serverRequests, requestId, contentReference: ref }) =>
      addProductToFreeDesignsCollection({
        requests: serverRequests,
        requestId,
        contentReference: ref,
        collectionId: FREE_DESIGNS_COLLECTION_ID,
        productId: freeGhost.id,
        specialistId: SPECIALIST_ID,
        auditTracker: tracker,
      }),
  });
  results.collection.push({ ...collectionResult, productId: freeGhost.id, collectionId: FREE_DESIGNS_COLLECTION_ID });

  // --- Audit summary ---------------------------------------------------------------------
  console.log('\n=== Audit summary (from the run tracker, not reconstructed) ===');
  console.log(`  approval events: ${getEventsByType(tracker, 'approval').length}`);
  console.log(`  execution events: ${getEventsByType(tracker, 'execution').length}`);
  console.log(`  result events (successful writes): ${getEventsByType(tracker, 'result').length}`);
  console.log(`  error events: ${getErrorEvents(tracker).length}`);

  console.log('\n=== MACHINE-READABLE RESULT ===');
  console.log(JSON.stringify({ ipRiskStatuses, valentine: { status: valentine.status, vendor: valentine.vendor }, ...results }, null, 2));
})().catch((err) => {
  console.error('Execution runner FAILED:', err.message);
  process.exit(1);
});
