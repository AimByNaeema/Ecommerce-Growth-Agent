'use strict';

// Tests for the Shopify collection membership workflow:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify collectionAddProducts
//
// Same CALL-COUNT security property and no-real-network convention as
// verification/testing/shopifyVendorCorrection.test.js / shopifyBlogPublishing.test.js.
// Every id and reference below is an invented placeholder.

const assert = require('node:assert');
// Real Ed25519 approval signatures - see approvalSigningTestKey.js. Verification itself is
// never mocked: every decision below is signed for real and checked by the real gate.
const { signedDecision } = require('./approvalSigningTestKey');

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { addProductToFreeDesignsCollection } = require('../../integrations/shopifyCollectionMembership');
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

const CONTENT_REFERENCE = 'collection-add-(placeholder-product)-(placeholder-collection)';
const OTHER_CONTENT_REFERENCE = 'collection-add-(a-completely-different-pair)';
const COLLECTION_ID = 'gid://shopify/Collection/000000001 (placeholder)';
const PRODUCT_ID = 'gid://shopify/Product/000000002 (placeholder)';

const PASSING_CONTENT = `Add product '(placeholder free product)' (${PRODUCT_ID}) to the existing 'Free Designs (placeholder)' collection (${COLLECTION_ID}). No new collection is created and no other field is changed.`;

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return {
    content,
    content_reference: contentReference,
    content_type: 'collection_membership_update',
    provenance: {
      source: 'shopify_collection_membership_update',
      generator: 'integrations/shopifyCollectionMembership.js',
      evidence: [{ signal_kind: 'collection_data_retrieval', reference: COLLECTION_ID }],
      supported_facts: [PRODUCT_ID, COLLECTION_ID],
    },
  };
}

function pipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-collection-1',
    toolId: 'shopify_collection_membership_update',
    specialistId: 'product',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  if (decision === 'pending') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-collection-1', signedDecision(gated.requests, 'apr-collection-1', {
    decision,
    decidedBy: 'store-owner@example.com (placeholder)',
  })).requests;
}

// member: whether getProducts() should report the product as already a member (used to
// simulate the re-read succeeding immediately vs. never, without a real setTimeout delay
// mattering to the test - the wrapper's own bounded retry still runs, just against fake
// timers-free real delays capped at 3 attempts of 500ms, acceptable for a test).
async function withMockedShopify({ throws = null, member = true }, fn) {
  const savedAdd = shopifyClient.addProductsToCollection;
  const savedGetProducts = shopifyClient.getProducts;
  const savedFetch = global.fetch;
  const calls = [];
  shopifyClient.addProductsToCollection = async (request) => {
    calls.push(request);
    if (throws) throw new Error(throws);
    return { id: request.collectionId, title: 'Free Designs (placeholder)' };
  };
  shopifyClient.getProducts = async () => [
    { id: PRODUCT_ID, collections: member ? [{ id: COLLECTION_ID, title: 'Free Designs (placeholder)' }] : [] },
  ];
  try {
    return await fn(calls, () => assert.strictEqual(global.fetch, savedFetch, 'global.fetch must never be touched'));
  } finally {
    shopifyClient.addProductsToCollection = savedAdd;
    shopifyClient.getProducts = savedGetProducts;
    global.fetch = savedFetch;
  }
}

function add(requests, overrides = {}) {
  return addProductToFreeDesignsCollection({
    requests,
    requestId: 'apr-collection-1',
    contentReference: CONTENT_REFERENCE,
    collectionId: COLLECTION_ID,
    productId: PRODUCT_ID,
    ...overrides,
  });
}

(async () => {
  // --- ZERO MUTATION: every unauthorized path ---------------------------------------

  await testAsync('UNAUTHORIZED (no such approval) -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls, assertFetchUntouched) => {
      const outcome = await add([]);
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
      assertFetchUntouched();
    });
  });

  await testAsync('PENDING approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await add(pipeline(PASSING_CONTENT, { decision: 'pending' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REJECTED approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await add(pipeline(PASSING_CONTENT, { decision: 'rejected' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('WRONG CONTENT REFERENCE -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await add(pipeline(), { contentReference: OTHER_CONTENT_REFERENCE });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'approval_matches_content_reference');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REVOKED PERMISSION (unowned specialist) -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await add(pipeline(), { specialistId: 'seo' });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'tool_permission_still_granted');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED compliance PASS -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline('An outstanding [VERIFY: which collection] must be resolved.');
      requests[0].execution_request.compliance.compliance_status = 'PASS';
      requests[0].execution_request.compliance.review_reasons = [];
      const outcome = await add(requests);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'compliance_attached_and_unchanged');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('authorized but missing collectionId/productId -> zero mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline();
      const outcome1 = await add(requests, { collectionId: '' });
      assert.strictEqual(outcome1.status, 'refused');
      const outcome2 = await add(requests, { productId: '' });
      assert.strictEqual(outcome2.status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  // --- The one authorized path ---------------------------------------------------------

  await testAsync('VALID AUTHORIZATION -> EXACTLY ONE mutation, independently re-read, reported as added', async () => {
    await withMockedShopify({ member: true }, async (calls, assertFetchUntouched) => {
      const outcome = await add(pipeline());
      assert.strictEqual(outcome.succeeded, true);
      assert.strictEqual(outcome.status, 'added');
      assert.strictEqual(calls.length, 1, 'exactly one Shopify mutation');
      assert.deepStrictEqual(calls[0].productIds, [PRODUCT_ID]);
      assertFetchUntouched();
    });
  });

  // --- Failure and unconfirmed handling -------------------------------------------------

  await testAsync('a Shopify failure is handled safely - reported, never a fabricated success', async () => {
    await withMockedShopify({ throws: 'Shopify returned a placeholder error' }, async (calls) => {
      const outcome = await add(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(calls.length, 1);
    });
  });

  await testAsync('a mutation that succeeds but never re-reads as a member is reported unconfirmed', async () => {
    await withMockedShopify({ member: false }, async (calls) => {
      const outcome = await add(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'unconfirmed');
      assert.strictEqual(calls.length, 1, 'the mutation itself still only happens once');
    });
  });

  // --- Audit ----------------------------------------------------------------------------

  await testAsync('AUDIT records the attempt AND the result', async () => {
    const tracker = createAuditTracker('run-shopify-collection-membership-1');
    await withMockedShopify({ member: true }, async () => {
      await add(pipeline(), { auditTracker: tracker });
    });
    const attempts = getEventsByType(tracker, 'execution').filter((event) => event.status === 'attempted');
    const results = getEventsByType(tracker, 'result');
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].summary.includes('SUCCEEDED'));
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('shopifyCollectionMembership.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
