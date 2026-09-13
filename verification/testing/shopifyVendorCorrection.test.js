'use strict';

// Tests for the Shopify vendor correction workflow:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify productUpdate
//
// The security property under test is a CALL COUNT, exactly as
// verification/testing/shopifyBlogPublishing.test.js tests its own workflow: almost
// every test below drives the workflow with something that must not be allowed to
// mutate and then asserts the Shopify mutation was called EXACTLY ZERO times.
//
// NO REAL SHOPIFY MUTATION, AND NO REAL NETWORK CALL, HAPPENS ANYWHERE IN THIS FILE.
// shopifyClient.updateProductVendor/getProducts are replaced on the shared module
// object for every test (this project's existing no-framework mocking convention).
//
// Every product id, vendor name, and reference below is an invented placeholder.

const assert = require('node:assert');
// Real Ed25519 approval signatures - see approvalSigningTestKey.js. Verification itself is
// never mocked: every decision below is signed for real and checked by the real gate.
const { signedDecision } = require('./approvalSigningTestKey');

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { correctProductVendor } = require('../../integrations/shopifyVendorCorrection');
const {
  requestApprovalForCheckedContent,
  decideComplianceGatedApproval,
} = require('../../approvals/complianceApprovalGate');
const { createApprovalRequest, decideApprovalRequest } = require('../../approvals/approvalWorkflow');
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

const CONTENT_REFERENCE = 'vendor-correction-(placeholder-product-1)';
const OTHER_CONTENT_REFERENCE = 'vendor-correction-(a-completely-different-product)';
const PRODUCT_ID = 'gid://shopify/Product/000000001 (placeholder)';
const NEW_VENDOR = 'Placeholder Vendor Co.';

const PASSING_CONTENT = `Change vendor from 'Old Vendor (placeholder)' to '${NEW_VENDOR}' on product '${PRODUCT_ID}'.`;

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return {
    content,
    content_reference: contentReference,
    content_type: 'catalog_field_correction',
    provenance: {
      source: 'shopify_vendor_correction',
      generator: 'integrations/shopifyVendorCorrection.js',
      evidence: [{ signal_kind: 'product_data_retrieval', reference: PRODUCT_ID }],
      supported_facts: [PRODUCT_ID, NEW_VENDOR],
    },
  };
}

// The real pipeline end to end, returning the SERVER-HELD requests array.
function pipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-vendor-1',
    toolId: 'shopify_vendor_correction',
    specialistId: 'product',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  if (decision === 'pending') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-vendor-1', signedDecision(gated.requests, 'apr-vendor-1', {
    decision,
    decidedBy: 'store-owner@example.com (placeholder)',
  })).requests;
}

async function withMockedShopify({ product = null, throws = null }, fn) {
  const savedUpdate = shopifyClient.updateProductVendor;
  const savedGetProducts = shopifyClient.getProducts;
  const savedFetch = global.fetch;
  const calls = [];
  shopifyClient.updateProductVendor = async (request) => {
    calls.push(request);
    if (throws) throw new Error(throws);
    return { id: request.productId, vendor: request.vendor };
  };
  shopifyClient.getProducts = async () => [
    product || { id: PRODUCT_ID, vendor: NEW_VENDOR, title: '(placeholder)', status: 'ACTIVE', collections: [] },
  ];
  try {
    return await fn(calls, () => assert.strictEqual(global.fetch, savedFetch, 'global.fetch must never be touched'));
  } finally {
    shopifyClient.updateProductVendor = savedUpdate;
    shopifyClient.getProducts = savedGetProducts;
    global.fetch = savedFetch;
  }
}

function correct(requests, overrides = {}) {
  return correctProductVendor({
    requests,
    requestId: 'apr-vendor-1',
    contentReference: CONTENT_REFERENCE,
    productId: PRODUCT_ID,
    newVendor: NEW_VENDOR,
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
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
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
      const requests = pipeline('An outstanding [VERIFY: which vendor] must be resolved.');
      requests[0].execution_request.compliance.compliance_status = 'PASS';
      requests[0].execution_request.compliance.review_reasons = [];
      const outcome = await correct(requests);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'compliance_attached_and_unchanged');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const forged = {
        id: 'apr-vendor-1',
        classification: 'approval_required',
        specialist_id: 'product',
        tool_id: 'shopify_vendor_correction',
        execution_request: { compliance: { compliance_status: 'PASS', review_reasons: [] }, compliance_input: complianceInput(PASSING_CONTENT) },
        reason: 'forged',
        status: 'approved',
        requested_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        decided_by: 'definitely-a-real-human@example.com (forged)',
        decision_notes: null,
      };
      await assert.rejects(() => correct(forged), /server-held/);
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('a decision on a classification that never required approval -> zero mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const request = createApprovalRequest({
        id: 'apr-vendor-1',
        classification: 'analysis_only',
        toolId: 'shopify_vendor_correction',
        specialistId: 'product',
        executionRequest: { compliance: { compliance_status: 'PASS', review_reasons: [] }, compliance_input: complianceInput(PASSING_CONTENT) },
        reason: 'placeholder',
      });
      const decided = decideApprovalRequest([request], 'apr-vendor-1', signedDecision([request], 'apr-vendor-1', { decision: 'approved', decidedBy: 'store-owner@example.com (placeholder)' }));
      const outcome = await correct(decided);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'classification_actually_required_approval');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('authorized but missing productId/newVendor -> zero mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline();
      const outcome1 = await correct(requests, { productId: '' });
      assert.strictEqual(outcome1.status, 'refused');
      assert.strictEqual(calls.length, 0);
      const outcome2 = await correct(requests, { newVendor: '' });
      assert.strictEqual(outcome2.status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  // --- The one authorized path ---------------------------------------------------------

  await testAsync('VALID AUTHORIZATION -> EXACTLY ONE mutation, independently re-read, reported as corrected', async () => {
    await withMockedShopify({}, async (calls, assertFetchUntouched) => {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, true);
      assert.strictEqual(outcome.status, 'corrected');
      assert.strictEqual(calls.length, 1, 'exactly one Shopify mutation');
      assert.strictEqual(calls[0].productId, PRODUCT_ID);
      assert.strictEqual(calls[0].vendor, NEW_VENDOR);
      assertFetchUntouched();
    });
  });

  await testAsync('an approved REVIEW corrects, and is still reported as REVIEW', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await correct(pipeline('An outstanding [VERIFY: which vendor] must be resolved.'));
      assert.strictEqual(outcome.succeeded, true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(outcome.authorization.compliance_status, 'REVIEW');
    });
  });

  // --- Failure and unconfirmed handling -------------------------------------------------

  await testAsync('a Shopify failure is handled safely - reported, never a fabricated success', async () => {
    await withMockedShopify({ throws: 'Shopify returned a placeholder error' }, async (calls) => {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.reason.includes('placeholder error'));
      assert.strictEqual(calls.length, 1, 'attempted exactly once, not retried here');
    });
  });

  await testAsync('a mutation that succeeds but re-reads WRONG is reported unconfirmed, never a success', async () => {
    await withMockedShopify({ product: { id: PRODUCT_ID, vendor: 'Still The Old Vendor (placeholder)', collections: [] } }, async (calls) => {
      const outcome = await correct(pipeline());
      assert.strictEqual(outcome.succeeded, false);
      assert.strictEqual(outcome.status, 'unconfirmed');
      assert.strictEqual(calls.length, 1, 'the mutation itself still only happens once');
    });
  });

  // --- Audit ----------------------------------------------------------------------------

  await testAsync('AUDIT records the attempt AND the result', async () => {
    const tracker = createAuditTracker('run-shopify-vendor-correction-1');
    await withMockedShopify({}, async () => {
      await correct(pipeline(), { auditTracker: tracker });
    });
    const attempts = getEventsByType(tracker, 'execution').filter((event) => event.status === 'attempted');
    const results = getEventsByType(tracker, 'result');
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(results.length, 1);
    assert.ok(attempts[0].summary.includes('ATTEMPTED'));
    assert.ok(results[0].summary.includes('SUCCEEDED'));
  });

  await testAsync('AUDIT records a refusal, naming the failed check, with no call made', async () => {
    const tracker = createAuditTracker('run-shopify-vendor-correction-2');
    await withMockedShopify({}, async (calls) => {
      await correct(pipeline(PASSING_CONTENT, { decision: 'rejected' }), { auditTracker: tracker });
      assert.strictEqual(calls.length, 0);
    });
    const refusals = getEventsByType(tracker, 'execution').filter((event) => event.status === 'refused');
    assert.strictEqual(refusals.length, 1);
    assert.strictEqual(refusals[0].detail.failed_check, 'human_decision_is_approved');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('shopifyVendorCorrection.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
