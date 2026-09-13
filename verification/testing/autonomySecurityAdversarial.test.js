'use strict';

// ADVERSARIAL PROOF FOR THE AUTONOMOUS EXECUTION PATH.
//
// Complements autonomyApprovalResolution.test.js, autonomyEndpoints.test.js,
// autonomyEndToEndMatrix.test.js and platformGenerality.test.js, which already prove forged
// and foreign-key signatures, tampered requests, one approval's signature against another,
// cross-business decisions, rejection, open circuits, unconfirmed writes, stale restored
// records, disabled/unsupported platforms, autonomy off, budgets and compliance BLOCK. This
// file covers what those do not: client-supplied approval/compliance/publish flags, swapped
// decision or approver, an expired challenge, a platform changed after signing, malformed
// authorization, a missing verification key, concurrent double decisions, fabricated or
// planted "approved" records, and a redirected content reference.
//
// Nothing here is stubbed except the external boundary (the Shopify client's read and write
// functions). The trigger, policy, compliance engine, Ed25519 verification, stores, Chief
// contract and correction dispatch are all real. global.fetch fails the suite if reached.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_DIRS = [];
for (const [variable, name] of [
  ['RUN_HISTORY_STORE_DIR', 'runs'],
  ['MEMORY_STORE_DIR', 'memory'],
  ['SCHEDULE_STORE_DIR', 'schedules'],
  ['SNAPSHOT_STORE_DIR', 'snapshots'],
  ['CIRCUIT_BREAKER_STORE_DIR', 'circuits'],
  ['VERIFICATION_STORE_DIR', 'verifications'],
  ['APPROVAL_STORE_DIR', 'approvals'],
]) {
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), `autonomy-adversarial-${name}-`));
  TEMP_DIRS.push(process.env[variable]);
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
delete process.env.VERCEL;
delete process.env.AGENT_AUTONOMY_ENABLED;
delete process.env.AUTHORIZED_BUSINESS_IDS;

const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');
const FIXTURE_DIRS = [];
function writeBusiness(id) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'business.yaml'),
    [
      `business_name: "${id}"`,
      'business_model: "D2C"',
      'platform: "Shopify"',
      'product_model: "in-house"',
      'target_markets: ["US"]',
      'countries: ["US"]',
      'currencies: ["USD"]',
      'product_categories: ["home"]',
      'customer_segments: ["homeowners"]',
      'brand:',
      `  name: "${id}"`,
      'business_goals: ["grow"]',
      'marketing_channels: ["email"]',
      'enabled_platforms: [shopify]',
      'autonomy:',
      '  enabled: true',
      '  daily_token_budget: 100000',
      '',
    ].join('\n')
  );
  FIXTURE_DIRS.push(dir);
}
process.on('exit', () => {
  for (const dir of [...FIXTURE_DIRS, ...TEMP_DIRS]) fs.rmSync(dir, { recursive: true, force: true });
});

// Separate businesses so a deliberately failed execution in one test never moves another
// test's circuit breaker.
const RESOLVE = 'autonomy-adversarial-resolve-co';
const RACE = 'autonomy-adversarial-race-co';
const REDIRECT = 'autonomy-adversarial-redirect-co';
const CYCLE = 'autonomy-adversarial-cycle-co';
for (const id of [RESOLVE, RACE, REDIRECT, CYCLE]) writeBusiness(id);

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { APPROVAL_PUBLIC_KEY_ENV } = require('../../approvals/approvalArchitecture');
const { signApproval, useApprovalTestKey } = require('./approvalSigningTestKey');
const { prepareApprovalExecutionRequest, resumeApprovedExecution } = require('../../agent/core/orchestratorExecutionContract');
const { createAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const approvalStore = require('../../approvals/approvalStore');
const { resolveAutonomousApproval, listPendingAutonomousApprovals } = require('../../autonomy/approvalResolution');
const { triggerAutonomousCycle } = require('../../autonomy/cycleTrigger');
const { createBusinessSchedule, setBusinessScheduleEnabled } = require('../../scheduler/scheduleManagement');
const scheduleStore = require('../../scheduler/scheduleStore');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
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

// --- External boundary only --------------------------------------------------------------
const PRODUCT_ID = 'gid://shopify/Product/1';
const OTHER_PRODUCT_ID = 'gid://shopify/Product/999';
const OWNER = 'owner@example.com';
const REVIEW_VENDOR = 'Aurora Ceramics';
const BLOCKING_VENDOR = 'guaranteed copyright-free with no legal risk';

const shop = { vendor: 'Old Vendor', writes: [] };
Object.assign(shopifyClient, {
  isConfigured: () => true,
  getShopInfo: async ({ businessId } = {}) => ({ name: `Shop ${businessId}`, domain: null, email: null }),
  getProducts: async () => [{ id: PRODUCT_ID, title: 'Mug', status: 'active', vendor: shop.vendor, tags: [], variants: [] }],
  getCollections: async () => [],
  getInventoryLevels: async () => [],
  getOrders: async () => [],
  getCustomers: async () => [],
  updateProductVendor: async ({ productId, vendor }) => {
    shop.writes.push({ productId, vendor });
    shop.vendor = vendor;
    return { id: productId, vendor };
  },
});

// --- Fixtures ------------------------------------------------------------------------------
function autonomousRequest(businessId, params = {}) {
  const prepared = prepareApprovalExecutionRequest('shopify_vendor_correction', {
    objective: 'Correct the vendor on the product.',
    category: 'products',
    tool_id: 'shopify_vendor_correction',
    specialist_id: 'product',
    is_shared_infrastructure: false,
    business_id: businessId,
    research_params: { content: REVIEW_VENDOR, productId: PRODUCT_ID, newVendor: REVIEW_VENDOR, ...params },
    autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-adversarial', job_id: 'fix-vendor', occurrence_key: '2026-03-04T09:00:00.000Z', platform: 'shopify' },
  });
  if (!prepared.ok) throw new Error(`fixture could not be prepared: ${prepared.reason}`);
  return prepared.executionRequest;
}

function queue(id, businessId, params = {}) {
  return createAndPersistApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: autonomousRequest(businessId, params),
    reason: 'Changes a real product record in the connected store.',
  });
}

const envelopeOf = (id) => approvalStore.loadApprovalRecord(id);
const decide = (overrides) =>
  resolveAutonomousApproval({ businessId: RESOLVE, decision: 'approved', decidedBy: OWNER, ...overrides });

function assertUntouched(id, writesBefore) {
  const envelope = envelopeOf(id);
  assert.strictEqual(envelope.execution_state, 'awaiting_decision', 'the durable state did not move');
  assert.strictEqual(envelope.approval_request.status, 'pending');
  assert.ok(!envelope.approval_request.execution_request.approval_provenance, 'no provenance was recorded');
  assert.strictEqual(shop.writes.length, writesBefore, 'nothing reached the platform');
}

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${TEST_API_KEY}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
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

const ON = { [AUTONOMY_KILL_SWITCH_ENV]: 'true' };
const T0 = new Date('2026-03-04T09:07:00.000Z');
const T1 = new Date('2026-03-04T10:07:00.000Z');
const T2 = new Date('2026-03-04T11:07:00.000Z');

(async () => {
  // =========================================================================================
  // Client-supplied approval, compliance and publish flags, and malformed authorization
  // =========================================================================================
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await testAsync('client-supplied approved=true, compliance=PASS, provenance and publish authorization over HTTP decide nothing', async () => {
      queue('apr-http-flags', null);
      const writes = shop.writes.length;
      const flags = {
        approved: true,
        status: 'approved',
        compliance: 'PASS',
        compliance_status: 'PASS',
        publish_authorized: true,
        publishAuthorization: { granted: true },
        approval_provenance: { method: 'ed25519_signature', decided_by: OWNER },
        human_approval: { verified: true },
      };
      const base = { approvalId: 'apr-http-flags', decision: 'approved', decidedBy: OWNER, ...flags };

      const noSignature = await request(port, { method: 'POST', path: '/autonomy/approvals/decide', body: base });
      assert.strictEqual(noSignature.status, 400, noSignature.raw);
      assert.strictEqual(noSignature.body.reason_code, 'invalid_request');

      // An authorization object nested where the endpoint does not read it is not authorization.
      const nested = await request(port, { method: 'POST', path: '/autonomy/approvals/decide', body: { ...base, authorization: { nonce: 'n', signature: 's' } } });
      assert.strictEqual(nested.body.reason_code, 'invalid_request');

      const invented = await request(port, { method: 'POST', path: '/autonomy/approvals/decide', body: { ...base, nonce: 'invented-nonce', signature: Buffer.from('yes').toString('base64') } });
      assert.strictEqual(invented.status, 400);
      assert.strictEqual(invented.body.reason_code, 'approval_verification_failed');

      assertUntouched('apr-http-flags', writes);
    });

    await testAsync('malformed authorization over HTTP is refused and nothing is written', async () => {
      queue('apr-http-malformed', null);
      const writes = shop.writes.length;
      const challenge = await request(port, { method: 'GET', path: `/approval-challenge?approvalId=apr-http-malformed&decision=approved&decidedBy=${encodeURIComponent(OWNER)}` });
      assert.strictEqual(challenge.status, 200, challenge.raw);
      const base = { approvalId: 'apr-http-malformed', decision: 'approved', decidedBy: OWNER };
      const malformed = [
        { nonce: challenge.body.nonce, signature: 12345 },
        { nonce: [challenge.body.nonce], signature: 'abc' },
        { nonce: challenge.body.nonce, signature: '   ' },
        { nonce: challenge.body.nonce, signature: '%%%not-base64%%%' },
        { nonce: challenge.body.nonce, signature: 'A'.repeat(4096) },
        { nonce: challenge.body.nonce, signature: { $ne: null } },
      ];
      for (const fields of malformed) {
        const res = await request(port, { method: 'POST', path: '/autonomy/approvals/decide', body: { ...base, ...fields } });
        assert.strictEqual(res.status, 400, `${JSON.stringify(fields).slice(0, 60)} -> ${res.raw}`);
        assert.ok(['invalid_request', 'approval_verification_failed'].includes(res.body.reason_code), res.raw);
      }
      assertUntouched('apr-http-malformed', writes);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // =========================================================================================
  // Provenance: every way a real signature could be redirected, aged or stripped
  // =========================================================================================
  await testAsync('a signature for another decision or another approver cannot be redirected', async () => {
    const record = queue('apr-swap', RESOLVE);
    const writes = shop.writes.length;
    const signedRejection = signApproval({ request: record, decision: 'rejected', decidedBy: OWNER });
    assert.strictEqual((await decide({ approvalId: 'apr-swap', authorization: signedRejection })).reason_code, 'approval_verification_failed');
    const signedByOther = signApproval({ request: record, decidedBy: 'someone-else@example.com' });
    assert.strictEqual((await decide({ approvalId: 'apr-swap', authorization: signedByOther })).reason_code, 'approval_verification_failed');
    assertUntouched('apr-swap', writes);
  });

  await testAsync('a stale (expired) challenge is refused even with a valid signature, and stays refused', async () => {
    const record = queue('apr-stale', RESOLVE);
    const writes = shop.writes.length;
    const authorization = signApproval({ request: record, decidedBy: OWNER });
    const realNow = Date.now;
    Date.now = () => realNow() + 24 * 60 * 60 * 1000;
    let result;
    try {
      result = await decide({ approvalId: 'apr-stale', authorization });
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(result.reason_code, 'approval_verification_failed');
    assert.ok(/expired/i.test(result.reason), result.reason);
    assert.strictEqual((await decide({ approvalId: 'apr-stale', authorization })).reason_code, 'approval_verification_failed');
    assertUntouched('apr-stale', writes);
  });

  await testAsync('a signature is bound to its platform: moving the action to another platform voids it', async () => {
    const record = queue('apr-platform', RESOLVE);
    const writes = shop.writes.length;
    const authorization = signApproval({ request: record, decidedBy: OWNER });
    const moved = {
      ...record,
      execution_request: { ...record.execution_request, autonomy: { ...record.execution_request.autonomy, platform: 'etsy' } },
    };
    approvalStore.saveApprovalRecord(moved, { executionState: 'awaiting_decision' });
    assert.strictEqual((await decide({ approvalId: 'apr-platform', authorization })).reason_code, 'approval_verification_failed');
    assertUntouched('apr-platform', writes);
  });

  await testAsync('missing authorization key: with no verification key configured, a correctly signed decision is refused', async () => {
    const record = queue('apr-no-key', RESOLVE);
    const writes = shop.writes.length;
    const authorization = signApproval({ request: record, decidedBy: OWNER });
    delete process.env[APPROVAL_PUBLIC_KEY_ENV];
    let result;
    try {
      result = await decide({ approvalId: 'apr-no-key', authorization });
    } finally {
      useApprovalTestKey();
    }
    assert.strictEqual(result.reason_code, 'approval_verification_failed');
    assertUntouched('apr-no-key', writes);
  });

  await testAsync('a corrupted durable approval, or a malformed approval id, resolves nothing', async () => {
    const record = queue('apr-corrupt', RESOLVE);
    const writes = shop.writes.length;
    const authorization = signApproval({ request: record, decidedBy: OWNER });
    fs.writeFileSync(path.join(process.env.APPROVAL_STORE_DIR, 'apr-corrupt.json'), '{"envelope_version":');
    assert.strictEqual((await decide({ approvalId: 'apr-corrupt', authorization })).reason_code, 'approval_not_found');
    for (const id of ['../apr-corrupt', 'apr-corrupt.json', '', null, { id: 'apr-corrupt' }]) {
      assert.notStrictEqual((await decide({ approvalId: id, authorization })).ok, true, `approval id ${JSON.stringify(id)}`);
    }
    assert.strictEqual(shop.writes.length, writes);
  });

  // =========================================================================================
  // Execution: fabricated records, duplicates, redirected targets
  // =========================================================================================
  await testAsync('a fabricated "approved" record handed straight to the executor is never executed', async () => {
    const writes = shop.writes.length;
    const fabricated = {
      id: 'apr-fabricated',
      status: 'approved',
      classification: 'externally_executable',
      specialist_id: 'product',
      tool_id: 'shopify_vendor_correction',
      decided_by: OWNER,
      execution_request: { ...autonomousRequest(RESOLVE), approval_provenance: { method: 'ed25519_signature', decided_by: OWNER } },
    };
    const notStored = await resumeApprovedExecution(fabricated);
    assert.strictEqual(notStored.status, 'error');
    assert.ok(/not in durable approval state/.test(notStored.error), notStored.error);

    // A real pending record, with an "approved" copy of it passed in by the caller.
    const pending = queue('apr-fabricated-copy', RESOLVE);
    const copy = { ...pending, status: 'approved', execution_request: { ...pending.execution_request, approval_provenance: { method: 'ed25519_signature' } } };
    const notApproved = await resumeApprovedExecution(copy);
    assert.strictEqual(notApproved.status, 'error');
    assertUntouched('apr-fabricated-copy', writes);
  });

  await testAsync('duplicate execution: two concurrently submitted valid decisions execute the action exactly once', async () => {
    const record = queue('apr-race', RACE);
    const writes = shop.writes.length;
    const first = signApproval({ request: record, decidedBy: OWNER });
    const second = signApproval({ request: record, decidedBy: OWNER });
    const results = await Promise.all([
      resolveAutonomousApproval({ approvalId: 'apr-race', businessId: RACE, decision: 'approved', decidedBy: OWNER, authorization: first }),
      resolveAutonomousApproval({ approvalId: 'apr-race', businessId: RACE, decision: 'approved', decidedBy: OWNER, authorization: second }),
    ]);
    const succeeded = results.filter((result) => result.ok);
    assert.strictEqual(succeeded.length, 1, JSON.stringify(results.map((result) => result.reason_code)));
    assert.strictEqual(succeeded[0].verification.status, 'verified');
    assert.ok(results.some((result) => ['approval_not_pending', 'already_completed'].includes(result.reason_code)));
    assert.strictEqual(shop.writes.length, writes + 1, 'exactly one platform write');
    assert.strictEqual(envelopeOf('apr-race').execution_state, 'executed');
  });

  await testAsync('a client-supplied content reference or publish flag cannot redirect an approval to another entity', async () => {
    const record = queue('apr-redirect', REDIRECT, { contentReference: OTHER_PRODUCT_ID, publish_authorized: true });
    const writes = shop.writes.length;
    const result = await resolveAutonomousApproval({ approvalId: 'apr-redirect', businessId: REDIRECT, decision: 'approved', decidedBy: OWNER, authorization: signApproval({ request: record, decidedBy: OWNER }) });
    assert.strictEqual(result.ok, true, result.reason);
    assert.notStrictEqual(result.execution.status, 'success', JSON.stringify(result.execution));
    assert.strictEqual(result.verification.verified, false);
    assert.strictEqual(shop.writes.length, writes, 'publish authorization refused the redirected reference before any write');
    assert.ok(!listMemoryRecords(REDIRECT, { limit: 50 }).some((entry) => entry.id === 'autonomy-apr-redirect'));
  });

  // =========================================================================================
  // The real trigger: laundered compliance, injected approval flags, planted approvals
  // =========================================================================================
  // The policy inside the cycle reads the kill switch from the process, like the matrix suite's
  // withKillSwitchOn: the trigger's env alone is not enough, which is itself fail-closed.
  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  const trigger = (now) => triggerAutonomousCycle({ businessId: CYCLE, now, env: ON });
  const stepOf = (cycle, jobId) => cycle.steps.find((step) => step.job_id === jobId) || {};
  const schedule = (jobId, task) => {
    const created = createBusinessSchedule({ businessId: CYCLE, jobId, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0 });
    if (!created.ok) return created;
    const enabled = setBusinessScheduleEnabled({ businessId: CYCLE, jobId, enabled: true, now: T0 });
    assert.strictEqual(enabled.ok, true, enabled.reason);
    return created;
  };
  const injected = { approved: true, compliance: 'PASS', compliance_status: 'PASS', publish_authorized: true, approval_provenance: { method: 'ed25519_signature' } };

  await testAsync('client-supplied compliance=PASS and approved=true cannot launder a BLOCK or skip approval in the cycle', async () => {
    const writes = shop.writes.length;

    // Flags on the task itself are either refused or dropped - never stored.
    const taskLevel = schedule('task-flags', { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: 'shopify', ...injected, params: { content: REVIEW_VENDOR, productId: PRODUCT_ID, newVendor: REVIEW_VENDOR } });
    if (taskLevel.ok) {
      const stored = scheduleStore.loadScheduledJob('task-flags', { businessId: CYCLE });
      for (const key of Object.keys(injected)) assert.ok(!(key in stored.task), `task.${key} must not be stored`);
    }

    // Benign declared content + a PASS claim, while the value actually written would BLOCK.
    const laundered = schedule('laundered', {
      tool_id: 'shopify_vendor_correction',
      objective: 'Correct the vendor on the product.',
      platform: 'shopify',
      params: { ...injected, content: REVIEW_VENDOR, productId: PRODUCT_ID, newVendor: BLOCKING_VENDOR },
    });
    assert.strictEqual(laundered.ok, true, laundered.reason);

    // Approval flags on an otherwise REVIEW-able correction.
    const flagged = schedule('flagged', {
      tool_id: 'shopify_vendor_correction',
      objective: 'Correct the vendor on the product.',
      platform: 'shopify',
      params: { ...injected, content: REVIEW_VENDOR, productId: PRODUCT_ID, newVendor: REVIEW_VENDOR },
    });
    assert.strictEqual(flagged.ok, true, flagged.reason);

    const cycle = await trigger(T1);
    assert.strictEqual(cycle.triggered, true, cycle.reason);

    const launderedStep = stepOf(cycle, 'laundered');
    assert.strictEqual(launderedStep.outcome, 'blocked', JSON.stringify(launderedStep));
    assert.strictEqual(launderedStep.reason_code, 'compliance_block');

    assert.strictEqual(stepOf(cycle, 'flagged').outcome, 'approval_required', JSON.stringify(stepOf(cycle, 'flagged')));
    if (taskLevel.ok) assert.strictEqual(stepOf(cycle, 'task-flags').outcome, 'approval_required');

    const pending = listPendingAutonomousApprovals({ businessId: CYCLE });
    assert.ok(!pending.some((item) => item.job_id === 'laundered'), 'a BLOCK queues nothing');
    const flaggedApproval = pending.find((item) => item.job_id === 'flagged');
    assert.ok(flaggedApproval, 'the flagged correction waits for a human');
    const stored = envelopeOf(flaggedApproval.approval_id);
    assert.strictEqual(stored.approval_request.status, 'pending');
    assert.ok(!stored.approval_request.execution_request.approval_provenance, 'a client-supplied provenance never becomes the record provenance');
    assert.strictEqual(stored.approval_request.execution_request.compliance.compliance_status, 'REVIEW', 'the verdict is computed, never the claimed PASS');
    assert.strictEqual(shop.writes.length, writes);
  });

  await testAsync('a durable approval planted as "approved" is never executed by a later cycle or by the resolver', async () => {
    const writes = shop.writes.length;
    const target = listPendingAutonomousApprovals({ businessId: CYCLE }).find((item) => item.job_id === 'flagged');
    assert.ok(target, 'precondition: the flagged approval is pending');
    const envelope = envelopeOf(target.approval_id);
    const planted = {
      ...envelope.approval_request,
      status: 'approved',
      decided_by: OWNER,
      decided_at: new Date().toISOString(),
      execution_request: { ...envelope.approval_request.execution_request, approval_provenance: { method: 'ed25519_signature', decided_by: OWNER } },
    };
    approvalStore.saveApprovalRecord(planted, { executionState: 'decided' });

    const next = await trigger(T2);
    assert.strictEqual(next.triggered, true, next.reason);
    assert.ok(!next.steps.some((step) => step.outcome === 'executed'), JSON.stringify(next.steps));
    assert.strictEqual(shop.writes.length, writes, 'the cycle only queues; it never executes an approval, planted or real');

    const result = await resolveAutonomousApproval({ approvalId: target.approval_id, businessId: CYCLE, decision: 'approved', decidedBy: OWNER, authorization: { nonce: 'x', signature: 'y' } });
    assert.strictEqual(result.reason_code, 'approval_not_pending');
    assert.strictEqual(shop.writes.length, writes);
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomySecurityAdversarial.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
