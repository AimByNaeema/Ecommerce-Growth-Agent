'use strict';

// COMPLIANCE INPUT INTEGRATION - what makes an approved correction actually executable.
//
// THE DEFECT THIS PINS. With approval persistence fixed, a cryptographically approved
// correction loaded from durable state and then still refused:
//
//   "This approval request carries no compliance input, so its compliance verdict cannot
//    be re-verified. A claimed verdict is never accepted on its own."
//
// approvals/publishAuthorization.js re-runs the compliance engine over the request's OWN
// content before authorizing any mutation. Approvals created on the /orchestrate path
// carried no compliance input at all, so re-verification was impossible and every
// correction failed closed.
//
// WHAT THESE TESTS ASSERT. That the input is genuinely stored, survives reload, is
// genuinely RE-RUN (not trusted), and that every verdict still means what it meant:
// BLOCK stops absolutely, REVIEW still needs the human approval path, and a tampered
// verdict is refused. A test that only checked "execution succeeded" would not have
// distinguished a real re-verification from a stored PASS being believed.
//
// NO REAL SHOPIFY CALL ANYWHERE. global.fetch throws for the whole file, and the two
// Shopify functions the correction path touches are in-memory stubs.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { signPayloadString } = require('./approvalSigningTestKey');

process.env.APPROVAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-input-store-'));
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-input-runs-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const originalFetch = global.fetch;
global.fetch = async (url) => { throw new Error('NETWORK CALL ATTEMPTED in a compliance-input test: ' + url); };

const approvalStore = require('../../approvals/approvalStore');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { verifyComplianceForApprovalRequest } = require('../../approvals/complianceApprovalGate');
const { computeExecutionFingerprint } = require('../../approvals/approvalArchitecture');
const {
  buildCorrectionComplianceInput,
  executeApprovedCorrection,
  CORRECTION_TOOL_IDS,
} = require('../../integrations/approvedCorrectionDispatch');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { createApp } = require('../../server');

const PRODUCT_ID = 'gid://fixture/Product/1';
const CANONICAL = 'Fixture Studio Canonical';
const STARTING_VENDOR = 'fixture studio canonical';

let passed = 0;
let failed = 0;
let mutationCalls = 0;
let vendorNow = STARTING_VENDOR;

// Shopify stubs for the whole file - the real functions are never installed.
shopifyClient.isConfigured = () => true;
shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
  mutationCalls += 1;
  vendorNow = vendor;
  return { id: productId, vendor };
};
shopifyClient.getProducts = async () => [
  { id: PRODUCT_ID, title: 'Fixture', status: 'ACTIVE', vendor: vendorNow, tags: [], variants: [], collections: [], metafields: [] },
];

async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; }
  catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: reqPath, method,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          { Authorization: 'Bearer ' + TEST_API_KEY }
        ),
      },
      (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, raw })); }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try { return await fn(port); } finally { await new Promise((r) => server.close(r)); }
}

// Drives the REAL path: /orchestrate -> pending approval -> challenge -> signature ->
// /orchestrate/approve. Returns the run body, the approval, and the approve response.
async function runRealFlow(port, { newVendor, objective }) {
  const run = JSON.parse((await request(port, {
    method: 'POST', path: '/orchestrate',
    body: { objective, research_params: { productId: PRODUCT_ID, newVendor } },
  })).raw);
  const pending = run.pending_approvals || [];
  return { run, approval: pending[0] || null };
}

async function approve(port, runId, approvalId) {
  const q = `approvalId=${encodeURIComponent(approvalId)}&decision=approved&decidedBy=operator`;
  const ch = JSON.parse((await request(port, { method: 'GET', path: '/approval-challenge?' + q })).raw);
  return request(port, {
    method: 'POST', path: '/orchestrate/approve',
    body: { runId, approvalId, decision: 'approved', decidedBy: 'operator', nonce: ch.nonce, signature: signPayloadString(ch.payload) },
  });
}

const OBJECTIVE = `Correct the vendor on Shopify product ${PRODUCT_ID}`;

async function main() {
  // ---------------------------------------------------------------------------------
  // (a) Creation persists the required compliance input
  // ---------------------------------------------------------------------------------

  let approvedId = null;

  await testAsync('(a) a correction approval PERSISTS its compliance input and computed verdict', async () => {
    await withServer(async (port) => {
      const { run, approval } = await runRealFlow(port, { newVendor: CANONICAL, objective: OBJECTIVE });
      assert.ok(approval, 'no pending approval was created');
      approvedId = approval.id;

      const stored = approvalStore.loadApprovalRecord(approval.id);
      assert.ok(stored, 'the approval is not in durable storage');
      const er = stored.approval_request.execution_request;

      assert.ok(er.compliance_input, 'compliance_input was not persisted');
      assert.strictEqual(er.compliance_input.content, CANONICAL, 'the stored content is not the value being written');
      assert.strictEqual(er.compliance_input.content_reference, PRODUCT_ID, 'the stored reference is not the target product');
      assert.strictEqual(er.compliance_input.provenance.source, 'shopify_vendor_correction');
      assert.ok(Array.isArray(er.compliance_input.provenance.evidence) && er.compliance_input.provenance.evidence.length > 0);

      assert.ok(er.compliance, 'the computed verdict was not persisted');
      assert.ok(['PASS', 'REVIEW'].includes(er.compliance.compliance_status), `unexpected verdict ${er.compliance.compliance_status}`);
      // Not hard-coded: the stored verdict is exactly what the engine produces from the input.
      assert.strictEqual(evaluateCompliance(er.compliance_input).status, er.compliance.compliance_status);
      void run;
    });
  });

  await testAsync('(a2) the input is DERIVED from the action - a different value stores different content', async () => {
    await withServer(async (port) => {
      const { approval } = await runRealFlow(port, { newVendor: 'Another Fixture Vendor', objective: OBJECTIVE });
      const stored = approvalStore.loadApprovalRecord(approval.id);
      assert.strictEqual(stored.approval_request.execution_request.compliance_input.content, 'Another Fixture Vendor');
    });
  });

  // ---------------------------------------------------------------------------------
  // (b) It survives reload
  // ---------------------------------------------------------------------------------

  await testAsync('(b) the persisted compliance input SURVIVES a reload from disk alone', async () => {
    // Its own run first. NOTE: /orchestrate numbers a run's first approval 'apr-1' every
    // time, so a later run overwrites an earlier one's stored record - see the reported
    // approval-id collision finding. This test therefore reads the record it just wrote.
    await withServer(async (port) => {
      const { approval } = await runRealFlow(port, { newVendor: CANONICAL, objective: OBJECTIVE });
      approvedId = approval.id;
    });
    delete require.cache[require.resolve('../../approvals/approvalStore')];
    const freshStore = require('../../approvals/approvalStore');
    const reloaded = freshStore.loadApprovalRecord(approvedId);
    assert.ok(reloaded, 'not recoverable after a fresh module load');
    const input = reloaded.approval_request.execution_request.compliance_input;
    assert.strictEqual(input.content, CANONICAL);
    assert.strictEqual(input.content_reference, PRODUCT_ID);
    // And it is still re-verifiable after the round trip.
    const verification = verifyComplianceForApprovalRequest(reloaded.approval_request);
    assert.strictEqual(verification.ok, true, verification.reason);
  });

  // ---------------------------------------------------------------------------------
  // (c) Dispatch re-verifies using that input, and the write completes
  // ---------------------------------------------------------------------------------

  await testAsync('(c) approved dispatch RE-VERIFIES compliance and the correction completes', async () => {
    vendorNow = STARTING_VENDOR;
    const before = mutationCalls;
    await withServer(async (port) => {
      const { run, approval } = await runRealFlow(port, { newVendor: CANONICAL, objective: OBJECTIVE });
      const res = await approve(port, run.run_id, approval.id);
      assert.strictEqual(res.status, 200, res.raw.slice(0, 300));
      const parsed = JSON.parse(res.raw);
      assert.strictEqual(parsed.step.completion_state, 'complete', JSON.stringify(parsed.step.errors));
      assert.deepStrictEqual(parsed.step.errors, []);
    });
    assert.strictEqual(mutationCalls, before + 1, 'the correction did not execute exactly once');
    assert.strictEqual(vendorNow, CANONICAL, 'the stubbed product did not receive the approved value');
  });

  // ---------------------------------------------------------------------------------
  // (d) A tampered verdict cannot replace re-verification
  // ---------------------------------------------------------------------------------

  await testAsync('(d) a FORGED verdict is refused - the engine is re-run, not believed', async () => {
    const stored = approvalStore.loadApprovalRecord(approvedId);
    const tampered = JSON.parse(JSON.stringify(stored.approval_request));
    // Claim PASS while the input itself produces something else.
    const realStatus = evaluateCompliance(tampered.execution_request.compliance_input).status;
    tampered.execution_request.compliance.compliance_status = realStatus === 'PASS' ? 'REVIEW' : 'PASS';
    const verification = verifyComplianceForApprovalRequest(tampered);
    assert.strictEqual(verification.ok, false, 'a forged verdict was accepted');
    assert.ok(/claims compliance status/.test(verification.reason), verification.reason);
  });

  await testAsync('(d2) a MODIFIED content with a stale verdict is refused', async () => {
    const stored = approvalStore.loadApprovalRecord(approvedId);
    const tampered = JSON.parse(JSON.stringify(stored.approval_request));
    // Swap the content for something that evaluates differently, keeping the old verdict.
    tampered.execution_request.compliance_input.content =
      'Every design is guaranteed copyright-free with no legal risk.';
    const verification = verifyComplianceForApprovalRequest(tampered);
    assert.strictEqual(verification.ok, false, 'modified content kept its old verdict');
  });

  // ---------------------------------------------------------------------------------
  // (e) BLOCK is an absolute stop
  // ---------------------------------------------------------------------------------

  await testAsync('(e) BLOCK prevents execution - no approval record is even created', async () => {
    const blockingValue = 'guaranteed copyright-free with no legal risk';
    // Confirm the fixture really does block, so this test cannot pass vacuously.
    const probe = buildCorrectionComplianceInput('shopify_vendor_correction', {
      research_params: { productId: PRODUCT_ID, newVendor: blockingValue },
    });
    assert.strictEqual(evaluateCompliance(probe).status, 'BLOCK', 'the fixture no longer produces BLOCK');

    const before = mutationCalls;
    await withServer(async (port) => {
      const { run, approval } = await runRealFlow(port, { newVendor: blockingValue, objective: OBJECTIVE });
      assert.strictEqual(approval, undefined === approval ? approval : null, 'a BLOCKed correction still created an approval');
      const plan = (run.routing && run.routing.plan) || [];
      const errors = plan.flatMap((step) => step.errors || []);
      assert.ok(errors.some((e) => /BLOCK/.test(e)), `expected a BLOCK refusal, got ${JSON.stringify(errors)}`);
    });
    assert.strictEqual(mutationCalls, before, 'a BLOCKed correction reached Shopify');
  });

  // ---------------------------------------------------------------------------------
  // (f) REVIEW still requires the existing human-approval path
  // ---------------------------------------------------------------------------------

  await testAsync('(f) REVIEW still requires the human approval path - never auto-executes', async () => {
    const before = mutationCalls;
    await withServer(async (port) => {
      const { approval } = await runRealFlow(port, { newVendor: CANONICAL, objective: OBJECTIVE });
      assert.strictEqual(approval.status, 'pending', 'the correction did not wait for a human');
      const stored = approvalStore.loadApprovalRecord(approval.id);
      assert.strictEqual(stored.execution_state, 'awaiting_decision');
      assert.strictEqual(stored.approval_request.execution_request.approval_provenance, undefined);
      // Dispatching it without a decision must refuse.
      const outcome = await executeApprovedCorrection(stored.approval_request, {});
      assert.notStrictEqual(outcome.status, 'success', 'an undecided approval executed');
    });
    assert.strictEqual(mutationCalls, before, 'a pending REVIEW correction reached Shopify');
  });

  // ---------------------------------------------------------------------------------
  // (g) Changing the action/target breaks the authorization relationship
  // ---------------------------------------------------------------------------------

  await testAsync('(g) changing the approved TARGET invalidates the fingerprint', async () => {
    const stored = approvalStore.loadApprovalRecord(approvedId);
    const original = stored.approval_request.execution_request;
    const fingerprintBefore = computeExecutionFingerprint(original);
    const movedTarget = { ...original, research_params: { ...original.research_params, productId: 'gid://fixture/Product/999' } };
    assert.notStrictEqual(computeExecutionFingerprint(movedTarget), fingerprintBefore, 'moving the target kept the same fingerprint');
    const changedValue = { ...original, research_params: { ...original.research_params, newVendor: 'Something Else' } };
    assert.notStrictEqual(computeExecutionFingerprint(changedValue), fingerprintBefore, 'changing the value kept the same fingerprint');
    // The compliance input is inside the fingerprint too, so it cannot be swapped either.
    const swappedInput = { ...original, compliance_input: { ...original.compliance_input, content: 'Something Else' } };
    assert.notStrictEqual(computeExecutionFingerprint(swappedInput), fingerprintBefore, 'the compliance input is outside the signature');
  });

  await testAsync('(g2) a mismatched content reference does not authorize the write', async () => {
    const before = mutationCalls;
    const stored = approvalStore.loadApprovalRecord(approvedId);
    const mismatched = JSON.parse(JSON.stringify(stored.approval_request));
    // The stored record targets one product; point the compliance input at another.
    mismatched.execution_request.compliance_input.content_reference = 'gid://fixture/Product/999';
    const { authorizePublishing } = require('../../approvals/publishAuthorization');
    const outcome = authorizePublishing({
      requests: [mismatched], requestId: mismatched.id, contentReference: PRODUCT_ID, specialistId: 'product',
    });
    assert.strictEqual(outcome.authorized, false, 'a mismatched reference was authorized');
    assert.strictEqual(mutationCalls, before);
  });

  // ---------------------------------------------------------------------------------
  // (h) + structural
  // ---------------------------------------------------------------------------------

  await testAsync('(h) only the stubbed Shopify functions were ever called', async () => {
    assert.ok(mutationCalls >= 1, 'the success path never ran, so this file proves nothing');
    assert.strictEqual(vendorNow, CANONICAL);
    assert.ok(global.fetch !== originalFetch, 'the network ban was lifted early');
  });

  await testAsync('compliance is not optional and no PASS is hard-coded for any correction', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'approvedCorrectionDispatch.js'), 'utf8');
    assert.ok(!/compliance_status\s*:\s*['"]PASS['"]/.test(source), 'a PASS verdict is hard-coded');
    // Every correction must describe its content, or it cannot be approved at all.
    for (const toolId of CORRECTION_TOOL_IDS) {
      const built = buildCorrectionComplianceInput(toolId, {
        research_params: { productId: 'p', newVendor: 'v', inventoryItemId: 'i', locationId: 'l', delta: 1, idempotencyKey: 'k', collectionId: 'c' },
      });
      assert.ok(built && typeof built.content === 'string' && built.content.length > 0, `${toolId} produces no compliance content`);
      assert.ok(built.content_reference, `${toolId} produces no content reference`);
    }
    // An incomplete request produces no input at all - never a gap-filled one.
    assert.strictEqual(buildCorrectionComplianceInput('shopify_vendor_correction', { research_params: { productId: 'p' } }), null);
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('complianceInputIntegration.test.js'));
  });

  global.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  global.fetch = originalFetch;
  console.error('Test harness error:', err);
  process.exit(1);
});
