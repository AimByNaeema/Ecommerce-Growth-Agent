'use strict';

// server.js's /autonomy endpoints and the durable-approval branch of /approval-challenge.
// Authentication, business scoping, read-only state, refusals, and one real signed decision
// over HTTP - with the Shopify write stubbed and no network reachable.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const [env, name] of [
  ['RUN_HISTORY_STORE_DIR', 'runs'],
  ['APPROVAL_STORE_DIR', 'approvals'],
  ['SCHEDULE_STORE_DIR', 'schedules'],
  ['SNAPSHOT_STORE_DIR', 'snapshots'],
  ['CIRCUIT_BREAKER_STORE_DIR', 'circuits'],
  ['VERIFICATION_STORE_DIR', 'verifications'],
  ['MEMORY_STORE_DIR', 'memory'],
]) {
  process.env[env] = fs.mkdtempSync(path.join(os.tmpdir(), `autonomy-endpoints-${name}-`));
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
delete process.env.AGENT_AUTONOMY_ENABLED;
delete process.env.VERCEL;

const { signPayloadString } = require('./approvalSigningTestKey');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { prepareApprovalExecutionRequest } = require('../../agent/core/orchestratorExecutionContract');
const { createAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const { createApp } = require('../../server');

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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

function request(port, { method, path: reqPath, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (auth) headers.Authorization = `Bearer ${TEST_API_KEY}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (err) {
          json = null;
        }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const PRODUCT_ID = 'gid://shopify/Product/1';
const NEW_VENDOR = 'Aurora Ceramics';

// A durable approval exactly as the autonomous cycle queues one, for the default business.
function queueAutonomousApproval(id, { autonomous = true } = {}) {
  const prepared = prepareApprovalExecutionRequest('shopify_vendor_correction', {
    objective: 'Correct the vendor on the product.',
    category: 'products',
    tool_id: 'shopify_vendor_correction',
    specialist_id: 'product',
    is_shared_infrastructure: false,
    business_id: null,
    research_params: { content: NEW_VENDOR, productId: PRODUCT_ID, newVendor: NEW_VENDOR },
    ...(autonomous ? { autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-http', job_id: 'fix-vendor', occurrence_key: '2026-03-04T09:00:00.000Z', platform: 'shopify' } } : {}),
  });
  return createAndPersistApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: prepared.executionRequest,
    reason: 'Changes a real product record in the connected store.',
  });
}

async function withMockedShopify(fn) {
  const savedUpdate = shopifyClient.updateProductVendor;
  const savedGet = shopifyClient.getProducts;
  const calls = [];
  shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
    calls.push({ productId, vendor });
    return { id: productId, vendor };
  };
  shopifyClient.getProducts = async () => [{ id: PRODUCT_ID, vendor: NEW_VENDOR, title: 'Mug' }];
  try {
    return await fn(calls);
  } finally {
    shopifyClient.updateProductVendor = savedUpdate;
    shopifyClient.getProducts = savedGet;
  }
}

(async () => {
  await withServer(async (port) => {
    await testAsync('every autonomy endpoint requires the API key', async () => {
      for (const [method, reqPath] of [
        ['GET', '/autonomy/state'],
        ['GET', '/autonomy/schedules'],
        ['POST', '/autonomy/schedules'],
        ['POST', '/autonomy/schedules/x/enabled'],
        ['POST', '/autonomy/approvals/decide'],
        ['POST', '/autonomy/cycle'],
      ]) {
        const res = await request(port, { method, path: reqPath, body: method === 'POST' ? {} : undefined, auth: false });
        assert.strictEqual(res.status, 401, `${method} ${reqPath} returned ${res.status}`);
      }
    });

    await testAsync('a business this credential is not authorized for is refused', async () => {
      const res = await request(port, { method: 'GET', path: '/autonomy/state?business_id=not-authorized-co' });
      assert.strictEqual(res.status, 403);
    });

    await testAsync('the state is read-only, reports autonomy off by default, and carries no secret', async () => {
      const res = await request(port, { method: 'GET', path: '/autonomy/state' });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.kill_switch, 'off');
      assert.strictEqual(res.body.storage.durable, true);
      for (const field of ['business_autonomy', 'enabled_platforms', 'schedules', 'recent_runs', 'pending_approvals']) {
        assert.ok(field in res.body, `missing ${field}`);
      }
      assert.ok(!res.raw.includes(TEST_API_KEY));
    });

    await testAsync('the cycle trigger refuses while the kill switch is off, and on non-durable storage', async () => {
      const off = await request(port, { method: 'POST', path: '/autonomy/cycle', body: {} });
      assert.strictEqual(off.status, 409);
      assert.strictEqual(off.body.reason_code, 'kill_switch_off');

      process.env.VERCEL = '1';
      try {
        const vercel = await request(port, { method: 'POST', path: '/autonomy/cycle', body: {} });
        assert.strictEqual(vercel.status, 503);
        assert.strictEqual(vercel.body.reason_code, 'storage_not_durable');
      } finally {
        delete process.env.VERCEL;
      }
    });

    await testAsync('an owner creates a schedule disabled, cannot duplicate it, and enables it explicitly', async () => {
      const body = { job_id: 'http-observe', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' } };
      const created = await request(port, { method: 'POST', path: '/autonomy/schedules', body });
      assert.strictEqual(created.status, 201, created.raw);
      assert.strictEqual(created.body.job.enabled, false);

      const duplicate = await request(port, { method: 'POST', path: '/autonomy/schedules', body });
      assert.strictEqual(duplicate.status, 409);

      const invalid = await request(port, { method: 'POST', path: '/autonomy/schedules', body: { ...body, job_id: 'http-amazon', task: { ...body.task, platform: 'amazon' } } });
      assert.strictEqual(invalid.status, 400);

      const enabled = await request(port, { method: 'POST', path: '/autonomy/schedules/http-observe/enabled', body: { enabled: true } });
      assert.strictEqual(enabled.status, 200, enabled.raw);
      assert.strictEqual(enabled.body.job.enabled, true);

      const missing = await request(port, { method: 'POST', path: '/autonomy/schedules/does-not-exist/enabled', body: { enabled: true } });
      assert.strictEqual(missing.status, 404);

      const listed = await request(port, { method: 'GET', path: '/autonomy/schedules' });
      assert.ok(listed.body.schedules.some((job) => job.job_id === 'http-observe' && job.enabled === true));
    });

    await testAsync('a non-autonomous durable approval is not offered a challenge through the autonomy branch', async () => {
      queueAutonomousApproval('apr-http-plain', { autonomous: false });
      const res = await request(port, { method: 'GET', path: '/approval-challenge?approvalId=apr-http-plain&decision=approved&decidedBy=owner%40example.com' });
      assert.strictEqual(res.status, 404);
    });

    await testAsync('a forged signature over HTTP is refused and nothing is written', async () => {
      queueAutonomousApproval('apr-http-forged');
      const challenge = await request(port, { method: 'GET', path: '/approval-challenge?approvalId=apr-http-forged&decision=approved&decidedBy=owner%40example.com' });
      assert.strictEqual(challenge.status, 200, challenge.raw);
      await withMockedShopify(async (calls) => {
        const res = await request(port, {
          method: 'POST',
          path: '/autonomy/approvals/decide',
          body: { approvalId: 'apr-http-forged', decision: 'approved', decidedBy: 'owner@example.com', nonce: challenge.body.nonce, signature: Buffer.from('forged').toString('base64') },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.reason_code, 'approval_verification_failed');
        assert.strictEqual(calls.length, 0);
      });
    });

    await testAsync('the owner decides a durable autonomous approval over HTTP: challenge -> sign -> executed once -> verified', async () => {
      queueAutonomousApproval('apr-http-owner');
      const state = await request(port, { method: 'GET', path: '/autonomy/state' });
      assert.ok(state.body.pending_approvals.some((item) => item.approval_id === 'apr-http-owner'), 'the pending approval is visible to the owner');

      const challenge = await request(port, { method: 'GET', path: '/approval-challenge?approvalId=apr-http-owner&decision=approved&decidedBy=owner%40example.com' });
      assert.strictEqual(challenge.status, 200, challenge.raw);
      const signature = signPayloadString(challenge.body.payload);

      await withMockedShopify(async (calls) => {
        const decided = await request(port, {
          method: 'POST',
          path: '/autonomy/approvals/decide',
          body: { approvalId: 'apr-http-owner', decision: 'approved', decidedBy: 'owner@example.com', nonce: challenge.body.nonce, signature },
        });
        assert.strictEqual(decided.status, 200, decided.raw);
        assert.strictEqual(decided.body.approval_request.status, 'approved');
        assert.strictEqual(decided.body.execution.status, 'success', decided.raw);
        assert.strictEqual(decided.body.verification.status, 'verified');
        assert.strictEqual(calls.length, 1);

        const replay = await request(port, {
          method: 'POST',
          path: '/autonomy/approvals/decide',
          body: { approvalId: 'apr-http-owner', decision: 'approved', decidedBy: 'owner@example.com', nonce: challenge.body.nonce, signature },
        });
        assert.strictEqual(replay.status, 409);
        assert.strictEqual(calls.length, 1);
      });

      const after = await request(port, { method: 'GET', path: '/autonomy/state' });
      assert.ok(!after.body.pending_approvals.some((item) => item.approval_id === 'apr-http-owner'));
      assert.ok(after.body.recent_runs.some((run) => run.kind === 'autonomous_approval_resolution'));
    });
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomyEndpoints.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
