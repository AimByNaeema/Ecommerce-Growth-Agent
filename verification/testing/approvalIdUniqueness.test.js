'use strict';

// DURABLE APPROVAL ID UNIQUENESS - one run's approval must never overwrite another's.
//
// THE DEFECT THIS PINS. Every orchestrator run starts its own approval tracker, so the
// first approval of EVERY run was numbered 'apr-1'. That was harmless while approvals
// lived only in memory. Once approvals/approvalStore.js began persisting them, the id
// became a FILENAME - so a second run silently overwrote the first run's stored approval,
// leaving the first human signature bound to an execution request no longer in the store.
//
// WHAT THESE TESTS ASSERT. That two real runs produce two different durable records, that
// both survive independently, and that a signature for one cannot move to the other. A
// test that only checked "an approval was stored" would have passed throughout the broken
// period, because one file was always written - just the same file twice.
//
// NO SHOPIFY CALL ANYWHERE IN THIS FILE. global.fetch throws, and the correction path's
// Shopify functions are in-memory stubs that record every call so the count can be
// asserted at the end.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { signPayloadString } = require('./approvalSigningTestKey');

process.env.APPROVAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-id-store-'));
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-id-runs-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const originalFetch = global.fetch;
global.fetch = async (url) => { throw new Error('NETWORK CALL ATTEMPTED in an approval-id test: ' + url); };

const approvalStore = require('../../approvals/approvalStore');
const { computeExecutionFingerprint } = require('../../approvals/approvalArchitecture');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { createApp } = require('../../server');

const PRODUCT_A = 'gid://fixture/Product/A';
const PRODUCT_B = 'gid://fixture/Product/B';
const VENDOR_A = 'Fixture Vendor Alpha';
const VENDOR_B = 'Fixture Vendor Beta';

let mutationCalls = 0;
const vendors = { [PRODUCT_A]: 'starting alpha', [PRODUCT_B]: 'starting beta' };
shopifyClient.isConfigured = () => true;
shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
  mutationCalls += 1;
  vendors[productId] = vendor;
  return { id: productId, vendor };
};
shopifyClient.getProducts = async () => Object.entries(vendors).map(([id, vendor]) => ({
  id, title: 'Fixture', status: 'ACTIVE', vendor, tags: [], variants: [], collections: [], metafields: [],
}));

let passed = 0;
let failed = 0;

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

async function startRun(port, productId, newVendor) {
  const run = JSON.parse((await request(port, {
    method: 'POST', path: '/orchestrate',
    body: { objective: `Correct the vendor on Shopify product ${productId}`, research_params: { productId, newVendor } },
  })).raw);
  return { runId: run.run_id, approval: (run.pending_approvals || [])[0] };
}

async function challengeFor(port, approvalId) {
  const q = `approvalId=${encodeURIComponent(approvalId)}&decision=approved&decidedBy=operator`;
  return JSON.parse((await request(port, { method: 'GET', path: '/approval-challenge?' + q })).raw);
}

async function main() {
  let runOne = null;
  let runTwo = null;

  // ---------------------------------------------------------------------------------
  // (a) Two runs, two distinct durable ids
  // ---------------------------------------------------------------------------------

  await testAsync('(a) two separate runs CANNOT share a durable approval id', async () => {
    await withServer(async (port) => {
      runOne = await startRun(port, PRODUCT_A, VENDOR_A);
      runTwo = await startRun(port, PRODUCT_B, VENDOR_B);

      assert.ok(runOne.approval && runTwo.approval, 'both runs must produce a pending approval');
      assert.notStrictEqual(runOne.approval.id, runTwo.approval.id, 'both runs produced the SAME approval id');
      // And the id is still readable, not opaque: it names its run and its sequence.
      for (const entry of [runOne, runTwo]) {
        assert.ok(/-apr-1$/.test(entry.approval.id), `unexpected id shape: ${entry.approval.id}`);
        assert.ok(entry.approval.id.length > 'apr-1'.length, 'the id carries no run prefix');
      }
      // Two files on disk, not one overwritten.
      const files = fs.readdirSync(process.env.APPROVAL_STORE_DIR).filter((n) => n.endsWith('.json'));
      assert.strictEqual(files.length, 2, `expected 2 stored approvals, found ${files.length}`);
    });
  });

  // ---------------------------------------------------------------------------------
  // (b) Both remain independently recoverable, with their own content
  // ---------------------------------------------------------------------------------

  await testAsync('(b) both approvals remain INDEPENDENTLY recoverable with their own targets', async () => {
    const a = approvalStore.loadApprovalRecord(runOne.approval.id);
    const b = approvalStore.loadApprovalRecord(runTwo.approval.id);
    assert.ok(a, 'the first run\'s approval was lost');
    assert.ok(b, 'the second run\'s approval was lost');
    assert.strictEqual(a.approval_request.execution_request.research_params.productId, PRODUCT_A);
    assert.strictEqual(b.approval_request.execution_request.research_params.productId, PRODUCT_B);
    assert.strictEqual(a.approval_request.execution_request.research_params.newVendor, VENDOR_A);
    assert.strictEqual(b.approval_request.execution_request.research_params.newVendor, VENDOR_B);
    // Each carries its own compliance input, still pointing at its own product.
    assert.strictEqual(a.approval_request.execution_request.compliance_input.content_reference, PRODUCT_A);
    assert.strictEqual(b.approval_request.execution_request.compliance_input.content_reference, PRODUCT_B);
  });

  // ---------------------------------------------------------------------------------
  // (c) + (d) Each challenge is bound to its own approval; A cannot authorize B
  // ---------------------------------------------------------------------------------

  await testAsync('(c) each challenge and fingerprint is bound to its OWN approval id', async () => {
    await withServer(async (port) => {
      const one = await startRun(port, PRODUCT_A, VENDOR_A);
      const two = await startRun(port, PRODUCT_B, VENDOR_B);
      const chOne = await challengeFor(port, one.approval.id);
      const chTwo = await challengeFor(port, two.approval.id);

      assert.strictEqual(chOne.request_id, one.approval.id);
      assert.strictEqual(chTwo.request_id, two.approval.id);
      assert.notStrictEqual(chOne.nonce, chTwo.nonce, 'two challenges shared a nonce');
      assert.notStrictEqual(chOne.execution_fingerprint, chTwo.execution_fingerprint, 'two different actions shared a fingerprint');

      // The id is inside the signed payload, so a payload cannot be reused for the other.
      assert.ok(chOne.payload.includes(one.approval.id));
      assert.ok(chTwo.payload.includes(two.approval.id));
      assert.ok(!chOne.payload.includes(two.approval.id));

      // The fingerprint really is the one over that approval's own execution request.
      const storedOne = approvalStore.loadApprovalRecord(one.approval.id);
      assert.strictEqual(computeExecutionFingerprint(storedOne.approval_request.execution_request), chOne.execution_fingerprint);
    });
  });

  await testAsync('(d) approval A CANNOT authorize approval B', async () => {
    const before = mutationCalls;
    await withServer(async (port) => {
      const one = await startRun(port, PRODUCT_A, VENDOR_A);
      const two = await startRun(port, PRODUCT_B, VENDOR_B);
      const chOne = await challengeFor(port, one.approval.id);
      const signatureForOne = signPayloadString(chOne.payload);

      // Present run one's genuine nonce + signature against run two's approval.
      const res = await request(port, {
        method: 'POST', path: '/orchestrate/approve',
        body: { runId: two.runId, approvalId: two.approval.id, decision: 'approved', decidedBy: 'operator', nonce: chOne.nonce, signature: signatureForOne },
      });
      assert.strictEqual(res.status, 400, 'one approval\'s signature authorized another');

      // B stays pending and unsigned in durable state.
      const storedTwo = approvalStore.loadApprovalRecord(two.approval.id);
      assert.strictEqual(storedTwo.approval_request.status, 'pending');
      assert.strictEqual(storedTwo.execution_state, 'awaiting_decision');
    });
    assert.strictEqual(mutationCalls, before, 'a cross-approval attempt reached Shopify');
  });

  // ---------------------------------------------------------------------------------
  // (e) Single-use protection still holds, per id
  // ---------------------------------------------------------------------------------

  await testAsync('(e) a nonce remains SINGLE-USE, and the genuine decision stands', async () => {
    await withServer(async (port) => {
      const one = await startRun(port, PRODUCT_A, VENDOR_A);
      const ch = await challengeFor(port, one.approval.id);
      const body = { runId: one.runId, approvalId: one.approval.id, decision: 'approved', decidedBy: 'operator', nonce: ch.nonce, signature: signPayloadString(ch.payload) };

      const first = await request(port, { method: 'POST', path: '/orchestrate/approve', body });
      assert.strictEqual(first.status, 200, first.raw.slice(0, 250));
      const second = await request(port, { method: 'POST', path: '/orchestrate/approve', body });
      assert.strictEqual(second.status, 400, 'a replayed nonce was accepted');

      const stored = approvalStore.loadApprovalRecord(one.approval.id);
      assert.strictEqual(stored.approval_request.status, 'approved', 'the genuine decision must stand');
      assert.strictEqual(stored.approval_request.execution_request.approval_provenance.method, 'ed25519_signature');
    });
  });

  // ---------------------------------------------------------------------------------
  // (f) Business isolation still holds on the stored record
  // ---------------------------------------------------------------------------------

  await testAsync('(f) business isolation is unchanged - a foreign business cannot load it', async () => {
    const anyId = runOne.approval.id;
    assert.ok(approvalStore.loadApprovalRecord(anyId), 'the record should load with no business filter');
    assert.strictEqual(
      approvalStore.loadApprovalRecord(anyId, { expectedBusinessId: 'some-other-business' }),
      null,
      'a record was returned to a business it does not belong to'
    );
  });

  // ---------------------------------------------------------------------------------
  // (i) + structural
  // ---------------------------------------------------------------------------------

  await testAsync('(i) NO REAL Shopify mutation occurred - only the in-memory stub was reached', async () => {
    // Test (e) deliberately completes one genuine approval, which then executes the
    // correction. That execution lands on the stub installed at the top of this file, which
    // is the point: it proves the path ran without any real Shopify call. What must hold is
    // that nothing reached the network and nothing touched an unapproved product.
    assert.ok(global.fetch !== originalFetch, 'the network ban was lifted early');
    assert.strictEqual(typeof shopifyClient.updateProductVendor, 'function');
    // Exactly one correction executed, and only against the product its approval named.
    assert.strictEqual(mutationCalls, 1, `expected the single approved correction, saw ${mutationCalls}`);
    assert.strictEqual(vendors[PRODUCT_A], VENDOR_A, 'the approved product did not receive its approved value');
    // PRODUCT_B was never approved in this file, so it must be untouched - this is the
    // assertion that would catch one approval acting on another approval's target.
    assert.strictEqual(vendors[PRODUCT_B], 'starting beta', 'an unapproved product was modified');
  });

  await testAsync('a tracker with no prefix keeps the original sequence (other orchestrators unchanged)', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'), 'utf8');
    assert.ok(/function approvalIdFor/.test(source), 'the id helper is gone');
    assert.ok(/id_prefix: runId/.test(source), 'the run no longer supplies its id as the prefix');
    // The fallback is what keeps growthWorkflow/optimizationCycle behaviour identical.
    assert.ok(/prefix \? `\$\{prefix\}-apr-\$\{sequence\}` : `apr-\$\{sequence\}`/.test(source), 'the unprefixed fallback is gone');
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('approvalIdUniqueness.test.js'));
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
