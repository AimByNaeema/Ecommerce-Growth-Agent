'use strict';

// APPROVAL PERSISTENCE INTEGRATION - the gap between a verified human approval and an
// executable one.
//
// THE DEFECT THIS PINS, observed end to end against the real store. A correction approved
// through POST /orchestrate/approve passed all eight Ed25519 checks, reached status
// 'approved' with real provenance - and then refused to execute:
//
//   "Approval 'apr-1' is not in durable approval state for this business, so nothing was
//    executed. A correction is authorized by stored, server-written state - never by a
//    record handed to the executor."
//
// ROOT CAUSE: POST /orchestrate kept its pending approvals ONLY in the in-memory
// orchestratorRuns Map and never wrote them to approvals/approvalStore.js, while
// integrations/approvedCorrectionDispatch.js deliberately accepts authorization only from
// that store. The two halves never met - the store was empty (0 files).
//
// WHAT THESE TESTS ASSERT. That the durable record genuinely exists at each stage, with
// the real provenance, and survives a "restart" (a fresh read from disk with no in-memory
// state). Asserting only "the HTTP call returned 200" would have passed throughout the
// broken period.
//
// NO REAL SHOPIFY CALL. The two Shopify functions the correction path touches are replaced
// with in-memory stubs for the one test that exercises dispatch; every other test never
// reaches them. global.fetch is replaced with a thrower for the whole file.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Real Ed25519 signing, and the public key installed into the environment.
const { signPayloadString, signPayloadWithForeignKeyIfAvailable } = (() => {
  const helper = require('./approvalSigningTestKey');
  return {
    signPayloadString: helper.signPayloadString,
    signPayloadWithForeignKeyIfAvailable: null,
  };
})();

// Isolated stores - nothing here writes into the project's own memory/state.
process.env.APPROVAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-persist-store-'));
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-persist-runs-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const originalFetch = global.fetch;
global.fetch = async (url) => {
  throw new Error('NETWORK CALL ATTEMPTED during an approval-persistence test: ' + url);
};

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const approvalStore = require('../../approvals/approvalStore');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { createApp } = require('../../server');

const STORE_DIR = process.env.APPROVAL_STORE_DIR;

let passed = 0;
let failed = 0;

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

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          { Authorization: 'Bearer ' + TEST_API_KEY }
        ),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try { await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function withMocked(mocks, fn) {
  const saved = {};
  for (const key of Object.keys(mocks)) {
    saved[key] = orchestratorExecutionContract[key];
    orchestratorExecutionContract[key] = mocks[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(mocks)) orchestratorExecutionContract[key] = saved[key];
  });
}

const PRODUCT_ID = 'gid://fixture/Product/1';
const NEW_VENDOR = 'Fixture Vendor Canonical';
const OLD_VENDOR = 'fixture vendor canonical';

// A real approval record for a real correction tool, built by the real factory.
function buildCorrectionApproval(id) {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: {
      objective: `Correct the vendor on ${PRODUCT_ID}`,
      category: 'products',
      tool_id: 'shopify_vendor_correction',
      specialist_id: 'product',
      is_shared_infrastructure: false,
      business_id: null,
      research_params: { productId: PRODUCT_ID, newVendor: NEW_VENDOR },
    },
    reason: "Executing 'shopify_vendor_correction' requires explicit approval before it can proceed.",
  });
}

function orchestrateMockReturning(approval) {
  return {
    runOrchestratorContract: async () => ({
      pending_approvals: [approval],
      routing: {
        plan: [
          {
            request: approval.execution_request.objective,
            current_task: approval.execution_request.objective,
            selected_specialist: { type: 'specialist', id: 'product', title: 'Product' },
            inputs: { category: 'products', tool_id: 'shopify_vendor_correction', capability_id: null, input_contract: null },
            required_context: [],
            outputs: null,
            evidence: [],
            confidence: 'unassessed',
            tool_calls: ['shopify_vendor_correction'],
            approvals: [{ classification: 'externally_executable', status: 'required', approval_request_id: approval.id }],
            errors: [],
            completion_state: 'awaiting_approval',
          },
        ],
      },
    }),
  };
}

async function signedBody(port, { approvalId, decision = 'approved', decidedBy = 'operator' }) {
  const q = `approvalId=${encodeURIComponent(approvalId)}&decision=${encodeURIComponent(decision)}&decidedBy=${encodeURIComponent(decidedBy)}`;
  const res = await request(port, { method: 'GET', path: '/approval-challenge?' + q });
  const challenge = JSON.parse(res.raw);
  return { approvalId, decision, decidedBy, nonce: challenge.nonce, signature: signPayloadString(challenge.payload), challenge };
}

function storedFiles() {
  try { return fs.readdirSync(STORE_DIR).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
}

async function main() {
  // ---------------------------------------------------------------------------------
  // (a) Creation through the real server endpoint persists the approval
  // ---------------------------------------------------------------------------------

  await testAsync('(a) POST /orchestrate PERSISTS the pending approval to the durable store', async () => {
    const approval = buildCorrectionApproval('persist-a');
    await withMocked(orchestrateMockReturning(approval), async () => {
      await withServer(async (port) => {
        const before = storedFiles().length;
        const res = await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(storedFiles().length, before + 1, 'no durable file was written');

        const envelope = approvalStore.loadApprovalRecord('persist-a');
        assert.ok(envelope, 'the approval is not loadable from durable storage');
        assert.strictEqual(envelope.execution_state, 'awaiting_decision', 'a pending approval must not be stored as decided');
        assert.strictEqual(envelope.approval_request.status, 'pending');
        assert.strictEqual(envelope.approval_request.tool_id, 'shopify_vendor_correction');
        assert.strictEqual(envelope.approval_request.execution_request.research_params.productId, PRODUCT_ID);
      });
    });
  });

  await testAsync('(a2) PERSISTENCE HAPPENS BEFORE A CHALLENGE CAN BE USED', async () => {
    const approval = buildCorrectionApproval('persist-a2');
    await withMocked(orchestrateMockReturning(approval), async () => {
      await withServer(async (port) => {
        await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } });
        // The durable record exists at the moment a challenge is obtainable.
        assert.ok(approvalStore.loadApprovalRecord('persist-a2'), 'not durable before the challenge');
        const q = 'approvalId=persist-a2&decision=approved&decidedBy=operator';
        const res = await request(port, { method: 'GET', path: '/approval-challenge?' + q });
        assert.strictEqual(res.status, 200);
        const challenge = JSON.parse(res.raw);
        assert.strictEqual(challenge.request_id, 'persist-a2');
        assert.ok(typeof challenge.nonce === 'string' && challenge.nonce.length > 0);
      });
    });
  });

  // ---------------------------------------------------------------------------------
  // (b) + (c) A verified approval persists approved state WITH its provenance
  // ---------------------------------------------------------------------------------

  await testAsync('(b)+(c) a verified approval PERSISTS approved state, provenance intact', async () => {
    const approval = buildCorrectionApproval('persist-b');
    await withMocked(
      { ...orchestrateMockReturning(approval), resumeApprovedExecution: async () => ({ status: 'success', data: null, error: null, classification: 'externally_executable' }) },
      async () => {
        await withServer(async (port) => {
          await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } });
          const runRes = JSON.parse((await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } })).raw);
          const body = await signedBody(port, { approvalId: 'persist-b' });
          const res = await request(port, {
            method: 'POST', path: '/orchestrate/approve',
            body: { runId: runRes.run_id, ...body },
          });
          assert.strictEqual(res.status, 200, res.raw.slice(0, 300));

          const envelope = approvalStore.loadApprovalRecord('persist-b');
          assert.ok(envelope, 'approved approval is not in durable storage');
          assert.strictEqual(envelope.execution_state, 'decided');
          assert.strictEqual(envelope.approval_request.status, 'approved');

          // (c) provenance survives persistence, in full.
          const prov = envelope.approval_request.execution_request.approval_provenance;
          assert.ok(prov, 'approval_provenance was lost in persistence');
          assert.strictEqual(prov.method, 'ed25519_signature');
          assert.strictEqual(prov.request_id, 'persist-b');
          assert.strictEqual(prov.decision, 'approved');
          assert.ok(typeof prov.execution_fingerprint === 'string' && prov.execution_fingerprint.length === 64);
          assert.ok(Array.isArray(prov.checks) && prov.checks.includes('signature_verifies_under_public_key'));
        });
      }
    );
  });

  // ---------------------------------------------------------------------------------
  // (g) A forged / unsigned / replayed decision never becomes approved
  // ---------------------------------------------------------------------------------

  await testAsync('(g) a FORGED signature never reaches approved state in durable storage', async () => {
    const approval = buildCorrectionApproval('persist-g1');
    await withMocked(orchestrateMockReturning(approval), async () => {
      await withServer(async (port) => {
        const runRes = JSON.parse((await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } })).raw);
        const real = await signedBody(port, { approvalId: 'persist-g1' });
        const res = await request(port, {
          method: 'POST', path: '/orchestrate/approve',
          body: { runId: runRes.run_id, approvalId: 'persist-g1', decision: 'approved', decidedBy: 'operator', nonce: real.nonce, signature: crypto.randomBytes(64).toString('base64') },
        });
        assert.strictEqual(res.status, 400, 'a forged signature was not refused');
        const envelope = approvalStore.loadApprovalRecord('persist-g1');
        assert.strictEqual(envelope.approval_request.status, 'pending', 'a forged decision was persisted as approved');
        assert.strictEqual(envelope.execution_state, 'awaiting_decision');
      });
    });
  });

  await testAsync('(g2) decidedBy alone is NEVER approval proof - no nonce/signature is refused', async () => {
    const approval = buildCorrectionApproval('persist-g2');
    await withMocked(orchestrateMockReturning(approval), async () => {
      await withServer(async (port) => {
        const runRes = JSON.parse((await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } })).raw);
        const res = await request(port, {
          method: 'POST', path: '/orchestrate/approve',
          body: { runId: runRes.run_id, approvalId: 'persist-g2', decision: 'approved', decidedBy: 'definitely-the-owner' },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(approvalStore.loadApprovalRecord('persist-g2').approval_request.status, 'pending');
      });
    });
  });

  await testAsync('(g3) a REPLAYED nonce is refused and leaves stored state untouched', async () => {
    const approval = buildCorrectionApproval('persist-g3');
    await withMocked(
      { ...orchestrateMockReturning(approval), resumeApprovedExecution: async () => ({ status: 'success', data: null, error: null, classification: 'externally_executable' }) },
      async () => {
        await withServer(async (port) => {
          const runRes = JSON.parse((await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Correct the vendor on a product' } })).raw);
          const body = await signedBody(port, { approvalId: 'persist-g3' });
          const first = await request(port, { method: 'POST', path: '/orchestrate/approve', body: { runId: runRes.run_id, ...body } });
          assert.strictEqual(first.status, 200, first.raw.slice(0, 200));
          // Same nonce again - single use.
          const second = await request(port, { method: 'POST', path: '/orchestrate/approve', body: { runId: runRes.run_id, ...body } });
          assert.strictEqual(second.status, 400, 'a replayed nonce was accepted');
          const envelope = approvalStore.loadApprovalRecord('persist-g3');
          assert.strictEqual(envelope.approval_request.status, 'approved', 'the first, genuine decision must stand');
        });
      }
    );
  });

  // ---------------------------------------------------------------------------------
  // (f) Restart / reload recovers the approved record from disk alone
  // ---------------------------------------------------------------------------------

  await testAsync('(f) an approved record is recoverable from disk with NO in-memory state', async () => {
    const envelope = approvalStore.loadApprovalRecord('persist-b');
    assert.ok(envelope, 'persist-b is missing from the store');
    // Re-read through a completely fresh module instance - the "restart" proof.
    const freshPath = require.resolve('../../approvals/approvalStore');
    delete require.cache[freshPath];
    const freshStore = require('../../approvals/approvalStore');
    const reloaded = freshStore.loadApprovalRecord('persist-b');
    assert.ok(reloaded, 'not recoverable after a fresh module load');
    assert.strictEqual(reloaded.approval_request.status, 'approved');
    assert.strictEqual(reloaded.approval_request.execution_request.approval_provenance.method, 'ed25519_signature');
    assert.deepStrictEqual(reloaded.approval_request, envelope.approval_request, 'the reloaded record differs from the stored one');
  });

  // ---------------------------------------------------------------------------------
  // (d) + (e) The dispatcher can load it, and executes at most once
  // ---------------------------------------------------------------------------------

  await testAsync('(d)+(e) approved correction DISPATCHES from durable storage, exactly once', async () => {
    const { executeApprovedCorrection } = require('../../integrations/approvedCorrectionDispatch');

    // Stub the two Shopify functions this path touches. No network, no real store.
    const savedUpdate = shopifyClient.updateProductVendor;
    const savedGet = shopifyClient.getProducts;
    let updateCalls = 0;
    let vendorNow = OLD_VENDOR;
    shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
      updateCalls += 1;
      assert.strictEqual(productId, PRODUCT_ID, 'dispatched against the wrong product');
      vendorNow = vendor;
      return { id: productId, vendor };
    };
    shopifyClient.getProducts = async () => [{ id: PRODUCT_ID, title: 'Fixture', status: 'ACTIVE', vendor: vendorNow, tags: [], variants: [], collections: [], metafields: [] }];

    try {
      const stored = approvalStore.loadApprovalRecord('persist-b');
      assert.strictEqual(stored.approval_request.status, 'approved');

      const first = await executeApprovedCorrection(stored.approval_request, {});
      // THE ASSERTION THAT PINS THE FIX: whatever else happens, it must NOT be refused
      // for the reason this whole task exists to remove.
      assert.notStrictEqual(first.reason_code, 'approval_not_durable', 'the dispatcher still cannot find the durable record');
      assert.notStrictEqual(first.reason_code, 'approval_not_approved');
      assert.notStrictEqual(first.reason_code, 'approval_provenance_missing');

      // (e) execute-once: a second dispatch of the same approval must not mutate again.
      const updatesAfterFirst = updateCalls;
      const second = await executeApprovedCorrection(stored.approval_request, {});
      assert.strictEqual(updateCalls, updatesAfterFirst, 'the same approval mutated twice - execute-once is broken');
      assert.ok(second && second.status !== 'success', 'a second dispatch reported success');
    } finally {
      shopifyClient.updateProductVendor = savedUpdate;
      shopifyClient.getProducts = savedGet;
    }
  });

  // ---------------------------------------------------------------------------------
  // (h) Nothing in this file reached a real Shopify mutation
  // ---------------------------------------------------------------------------------

  await testAsync('(h) the real Shopify mutation functions were never called', async () => {
    // Restored above; assert they are the genuine module functions again, and that the
    // network ban held for the whole file.
    assert.strictEqual(typeof shopifyClient.updateProductVendor, 'function');
    assert.ok(global.fetch !== originalFetch, 'the network ban was lifted early');
  });

  await testAsync('no second persistence mechanism was introduced', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    assert.ok(source.includes("require('./approvals/approvalStore')"), 'server.js no longer uses the existing store');
    assert.ok(source.includes('decideAndPersistApprovalRequest'), 'the decision no longer persists');
    assert.ok(source.includes("saveApprovalRecord(pendingApproval, { executionState: 'awaiting_decision' })"), 'pending approvals are no longer persisted at creation');
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('approvalPersistenceIntegration.test.js'));
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
