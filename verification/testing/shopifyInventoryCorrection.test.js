'use strict';

// Tests for the Shopify inventory correction workflow:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify inventoryAdjustQuantities
//
// Two things are tested: planInventoryCorrections() (pure reconciliation logic, no I/O)
// and correctInventoryDeficit() (the orchestration wrapper, same CALL-COUNT security
// property and no-real-network convention as the other two Shopify write workflow
// tests). Every id and reference below is an invented placeholder.

const assert = require('node:assert');

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { planInventoryCorrections, correctInventoryDeficit } = require('../../integrations/shopifyInventoryCorrection');
const { requestApprovalForCheckedContent, decideComplianceGatedApproval } = require('../../approvals/complianceApprovalGate');
const { createAuditTracker, getEventsByType } = require('../../audit/auditTrail');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

// --- planInventoryCorrections(): pure, no I/O -----------------------------------------

test('planInventoryCorrections: an item fully explained by test orders is resolvable, with the exact delta', () => {
  const { resolvable, unresolved } = planInventoryCorrections({
    inventoryItems: [{ id: 'item-A', sku: 'SKU-A', available: -1, locationId: 'loc-1' }],
    testOrderTotals: new Map([['item-A', 1]]),
  });
  assert.strictEqual(unresolved.length, 0);
  assert.strictEqual(resolvable.length, 1);
  assert.deepStrictEqual(resolvable[0], {
    inventoryItemId: 'item-A',
    sku: 'SKU-A',
    locationId: 'loc-1',
    currentAvailable: -1,
    testOrderQuantitySum: 1,
    delta: 1,
  });
});

test('planInventoryCorrections: an item with ZERO test-order contribution is unresolved, never corrected', () => {
  const { resolvable, unresolved } = planInventoryCorrections({
    inventoryItems: [{ id: 'item-B', sku: 'SKU-B', available: -7, locationId: 'loc-1' }],
    testOrderTotals: new Map(),
  });
  assert.strictEqual(resolvable.length, 0);
  assert.strictEqual(unresolved.length, 1);
  assert.deepStrictEqual(unresolved[0], {
    inventoryItemId: 'item-B',
    sku: 'SKU-B',
    locationId: 'loc-1',
    currentAvailable: -7,
    testOrderQuantitySum: 0,
    discrepancy: 7,
  });
});

test('planInventoryCorrections: a PARTIALLY explained item is unresolved with the exact discrepancy, never a partial correction', () => {
  const { resolvable, unresolved } = planInventoryCorrections({
    inventoryItems: [{ id: 'item-C', sku: 'SKU-C', available: -2, locationId: 'loc-1' }],
    testOrderTotals: new Map([['item-C', 1]]),
  });
  assert.strictEqual(resolvable.length, 0, 'a partial match must never appear in resolvable');
  assert.strictEqual(unresolved.length, 1);
  assert.deepStrictEqual(unresolved[0], {
    inventoryItemId: 'item-C',
    sku: 'SKU-C',
    locationId: 'loc-1',
    currentAvailable: -2,
    testOrderQuantitySum: 1,
    discrepancy: 1,
  });
});

test('planInventoryCorrections: a non-negative item is skipped entirely', () => {
  const { resolvable, unresolved } = planInventoryCorrections({
    inventoryItems: [{ id: 'item-D', sku: 'SKU-D', available: 0, locationId: 'loc-1' }],
    testOrderTotals: new Map([['item-D', 5]]),
  });
  assert.strictEqual(resolvable.length, 0);
  assert.strictEqual(unresolved.length, 0);
});

test('planInventoryCorrections: empty/malformed input never throws', () => {
  assert.deepStrictEqual(planInventoryCorrections({}), { resolvable: [], unresolved: [] });
  assert.deepStrictEqual(planInventoryCorrections({ inventoryItems: undefined, testOrderTotals: undefined }), { resolvable: [], unresolved: [] });
});

// --- correctInventoryDeficit(): the orchestration wrapper ------------------------------

const CONTENT_REFERENCE = 'inventory-correction-(placeholder-item)';
const OTHER_CONTENT_REFERENCE = 'inventory-correction-(a-completely-different-item)';
const INVENTORY_ITEM_ID = 'gid://shopify/InventoryItem/000000001 (placeholder)';
const LOCATION_ID = 'gid://shopify/Location/000000001 (placeholder)';
const DELTA = 1;

const PASSING_CONTENT = `Restore ${DELTA} unit(s) to inventory item ${INVENTORY_ITEM_ID} (SKU PLACEHOLDER-1, product '(placeholder)'), matching the exact quantity decremented by Shopify's own test orders flagged test:true for this item.`;

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return {
    content,
    content_reference: contentReference,
    content_type: 'inventory_correction',
    provenance: {
      source: 'shopify_inventory_correction',
      generator: 'integrations/shopifyInventoryCorrection.js',
      evidence: [{ signal_kind: 'shopify_test_order', reference: 'gid://shopify/Order/000000001 (placeholder)' }],
      supported_facts: [String(DELTA), INVENTORY_ITEM_ID, 'PLACEHOLDER-1'],
    },
  };
}

function pipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-inventory-1',
    toolId: 'shopify_inventory_correction',
    specialistId: 'product',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  if (decision === 'pending') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-inventory-1', {
    decision,
    decidedBy: 'store-owner@example.com (placeholder)',
  }).requests;
}

async function withMockedShopify({ throws = null, rereadAvailable = 0 }, fn) {
  const savedAdjust = shopifyClient.adjustInventoryQuantities;
  const savedGetItems = shopifyClient.getInventoryItemsByIds;
  const savedFetch = global.fetch;
  const calls = [];
  shopifyClient.adjustInventoryQuantities = async (request) => {
    calls.push(request);
    if (throws) throw new Error(throws);
    const change = request.changes[0];
    return { changes: [{ name: 'available', delta: change.delta, quantityAfterChange: rereadAvailable, item: { id: change.inventoryItemId }, location: { id: change.locationId } }] };
  };
  shopifyClient.getInventoryItemsByIds = async () => [
    { id: INVENTORY_ITEM_ID, sku: 'PLACEHOLDER-1', tracked: false, levels: [{ locationId: LOCATION_ID, available: rereadAvailable }] },
  ];
  try {
    return await fn(calls, () => assert.strictEqual(global.fetch, savedFetch, 'global.fetch must never be touched'));
  } finally {
    shopifyClient.adjustInventoryQuantities = savedAdjust;
    shopifyClient.getInventoryItemsByIds = savedGetItems;
    global.fetch = savedFetch;
  }
}

function correct(requests, overrides = {}) {
  return correctInventoryDeficit({
    requests,
    requestId: 'apr-inventory-1',
    contentReference: CONTENT_REFERENCE,
    inventoryItemId: INVENTORY_ITEM_ID,
    locationId: LOCATION_ID,
    delta: DELTA,
    ...overrides,
  });
}

(async () => {
  // --- ZERO MUTATION: every unauthorized path ---------------------------------------

  await testAsync('UNAUTHORIZED (no such approval) -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls, assertFetchUntouched) => {
      const outcome = await correct([]);
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
      assertFetchUntouched();
    });
  });

  await testAsync('PENDING approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await correct(pipeline(PASSING_CONTENT, { decision: 'pending' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REJECTED approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await correct(pipeline(PASSING_CONTENT, { decision: 'rejected' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('WRONG CONTENT REFERENCE -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await correct(pipeline(), { contentReference: OTHER_CONTENT_REFERENCE });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'approval_matches_content_reference');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REVOKED PERMISSION (unowned specialist) -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await correct(pipeline(), { specialistId: 'seo' });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'tool_permission_still_granted');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED compliance PASS -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline('An outstanding [VERIFY: exact quantity] must be resolved.');
      requests[0].execution_request.compliance.compliance_status = 'PASS';
      requests[0].execution_request.compliance.review_reasons = [];
      const outcome = await correct(requests);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'compliance_attached_and_unchanged');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('authorized but missing inventoryItemId/locationId/delta -> zero mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline();
      assert.strictEqual((await correct(requests, { inventoryItemId: '' })).status, 'refused');
      assert.strictEqual((await correct(requests, { locationId: '' })).status, 'refused');
      assert.strictEqual((await correct(requests, { delta: 0 })).status, 'refused');
      assert.strictEqual((await correct(requests, { delta: -1 })).status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  // --- The one authorized path ---------------------------------------------------------

  await testAsync('VALID AUTHORIZATION -> EXACTLY ONE mutation, independently re-read, reported as corrected', async () => {
    await withMockedShopify({ rereadAvailable: 0 }, async (calls, assertFetchUntouched) => {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, true);
      assert.strictEqual(outcome.status, 'corrected');
      assert.strictEqual(calls.length, 1, 'exactly one Shopify mutation');
      assert.deepStrictEqual(calls[0].changes, [{ inventoryItemId: INVENTORY_ITEM_ID, locationId: LOCATION_ID, delta: DELTA }]);
      assert.strictEqual(calls[0].reason, 'correction');
      assertFetchUntouched();
    });
  });

  // --- Failure and unconfirmed handling -------------------------------------------------

  await testAsync('a Shopify failure is handled safely - reported, never a fabricated success', async () => {
    await withMockedShopify({ throws: 'Shopify returned a placeholder error' }, async (calls) => {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(calls.length, 1);
    });
  });

  await testAsync('a mutation that succeeds but re-reads DISAGREEING with its own result is unconfirmed', async () => {
    // The mutation reports quantityAfterChange=0, but the independent re-read is
    // stubbed to disagree - simulated here by mismatching the mock's own two return
    // values directly rather than via withMockedShopify's single rereadAvailable knob.
    const savedAdjust = shopifyClient.adjustInventoryQuantities;
    const savedGetItems = shopifyClient.getInventoryItemsByIds;
    const calls = [];
    shopifyClient.adjustInventoryQuantities = async (request) => {
      calls.push(request);
      const change = request.changes[0];
      return { changes: [{ name: 'available', delta: change.delta, quantityAfterChange: 0, item: { id: change.inventoryItemId }, location: { id: change.locationId } }] };
    };
    shopifyClient.getInventoryItemsByIds = async () => [
      { id: INVENTORY_ITEM_ID, sku: 'PLACEHOLDER-1', tracked: false, levels: [{ locationId: LOCATION_ID, available: -5 }] },
    ];
    try {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'unconfirmed');
      assert.strictEqual(calls.length, 1);
    } finally {
      shopifyClient.adjustInventoryQuantities = savedAdjust;
      shopifyClient.getInventoryItemsByIds = savedGetItems;
    }
  });

  // --- Audit ----------------------------------------------------------------------------

  await testAsync('AUDIT records the attempt AND the result', async () => {
    const tracker = createAuditTracker('run-shopify-inventory-correction-1');
    await withMockedShopify({ rereadAvailable: 0 }, async () => {
      await correct(pipeline(), { auditTracker: tracker });
    });
    const attempts = getEventsByType(tracker, 'execution').filter((event) => event.status === 'attempted');
    const results = getEventsByType(tracker, 'result');
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].summary.includes('SUCCEEDED'));
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('shopifyInventoryCorrection.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
