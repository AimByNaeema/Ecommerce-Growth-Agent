'use strict';

// THE LAST AUTONOMY GAPS, CLOSED AND PROVEN:
//
//   1. usage completeness     - a manual POST /run record carries the real usage ledger summary
//   2. entity verification    - an approved correction is verified by the shared verifier, and an
//                               identical, already-verified entity change is never applied again
//   3. approval expiry        - every autonomously queued approval expires at the business's own
//                               autonomy.approval_ttl_hours; no default exists
//   4. proof re-verification  - the stored Ed25519 proof is re-verified immediately before a write
//   5. schedule validation    - a mismatched observation schedule cannot be saved
//   6. honest visibility      - cycle status from real step outcomes; read-only latest-cycle state
//
// NO NETWORK. global.fetch fails the suite if anything reaches for it; shopifyClient's functions are
// replaced on the shared module object (this project's existing no-framework convention). Every
// approval is signed with a real Ed25519 key and verified by the real, unmodified gate.

const assert = require('node:assert');
const crypto = require('node:crypto');
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
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), `autonomy-completion-${name}-`));
  TEMP_DIRS.push(process.env[variable]);
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
delete process.env.AGENT_AUTONOMY_ENABLED;
delete process.env.VERCEL;

const BUSINESS = 'autonomy-completion-test-co';
const BUSINESS_DIR = path.join(__dirname, '..', '..', 'configuration', 'businesses', BUSINESS);
fs.mkdirSync(BUSINESS_DIR, { recursive: true });
fs.writeFileSync(path.join(BUSINESS_DIR, 'business.yaml'), [
  'business_name: "Autonomy Completion Test Co"',
  'business_model: "D2C"',
  'platform: "Shopify"',
  'product_model: "in-house"',
  'target_markets: ["US"]',
  'countries: ["US"]',
  'currencies: ["USD"]',
  'product_categories: ["home"]',
  'customer_segments: ["homeowners"]',
  'brand:',
  '  name: "Autonomy Completion Test Co"',
  'business_goals: ["grow"]',
  'marketing_channels: ["email"]',
  'enabled_platforms: [shopify]',
  '',
].join('\n'));
process.on('exit', () => {
  for (const dir of [BUSINESS_DIR, ...TEMP_DIRS]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // A synced folder can hold a lock for a moment; a leftover fixture never fails the suite.
    }
  }
});

const { signApproval } = require('./approvalSigningTestKey');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { executeApprovedCorrection, checkCorrectionAlreadyVerified } = require('../../integrations/approvedCorrectionDispatch');
const approvalStore = require('../../approvals/approvalStore');
const { createApprovalRequest, createAndPersistApprovalRequest, decideAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const {
  APPROVAL_PUBLIC_KEY_ENV,
  APPROVAL_PAYLOAD_VERSION,
  CHALLENGE_TTL_ENV,
  computeExecutionFingerprint,
  verifyRecordedProvenance,
} = require('../../approvals/approvalArchitecture');
const { resolveAutonomousApproval, listPendingAutonomousApprovals, findPendingAutonomousApproval } = require('../../autonomy/approvalResolution');
const executionVerification = require('../../reliability/executionVerification');
const { runAutonomousCycle, deriveCycleStatus } = require('../../autonomy/autonomousCycle');
const scheduleStore = require('../../scheduler/scheduleStore');
const { createScheduledJob } = require('../../scheduler/scheduleModel');
const { createBusinessSchedule } = require('../../scheduler/scheduleManagement');
const { validateAutonomyConfig, readAutonomyConfig } = require('../../tools/configValidator');
const { evaluateAutonomyPolicy, AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { readDailyUsage } = require('../../agent/core/dailyUsageAccounting');
const { appendUsageEvent } = require('../../usage/usageTracker');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
const { createApp } = require('../../server');

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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

const OWNER = 'owner@example.com';
const LOCATION = 'gid://shopify/Location/1';
const T0 = new Date('2026-03-04T09:07:00.000Z');
const hoursAfter = (date, hours) => new Date(date.getTime() + hours * 60 * 60 * 1000);

// ---------------------------------------------------------------------------------
// An in-memory Shopify: every write and read is recorded, and a test can make the store
// ignore a write or show a different value to one particular read.
// ---------------------------------------------------------------------------------
const shop = {
  products: {},
  inventory: {},
  writes: [],
  productReads: 0,
  ignoreWrite: false,
  // (readNumber, products) => products - lets a test change what ONE read observes.
  productReadView: null,
};

function product(id) {
  if (!shop.products[id]) shop.products[id] = { id, title: 'Mug', vendor: 'Original Vendor', collections: [] };
  return shop.products[id];
}

shopifyClient.isConfigured = () => true;
shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
  shop.writes.push({ kind: 'vendor', productId, vendor });
  if (!shop.ignoreWrite) product(productId).vendor = vendor;
  return { id: productId, vendor };
};
shopifyClient.addProductsToCollection = async ({ collectionId, productIds }) => {
  shop.writes.push({ kind: 'collection', collectionId, productIds });
  for (const id of productIds) {
    if (!shop.ignoreWrite) product(id).collections.push({ id: collectionId, title: 'Free Designs' });
  }
  return { id: collectionId };
};
shopifyClient.adjustInventoryQuantities = async ({ changes }) => {
  shop.writes.push({ kind: 'inventory', changes });
  return {
    changes: changes.map((change) => {
      const levels = shop.inventory[change.inventoryItemId];
      const level = levels.find((entry) => entry.locationId === change.locationId);
      if (!shop.ignoreWrite) level.available += change.delta;
      return { name: 'available', delta: change.delta, quantityAfterChange: level.available, item: { id: change.inventoryItemId }, location: { id: change.locationId } };
    }),
  };
};
shopifyClient.getProducts = async () => {
  shop.productReads += 1;
  const snapshot = Object.values(shop.products).map((entry) => JSON.parse(JSON.stringify(entry)));
  return typeof shop.productReadView === 'function' ? shop.productReadView(shop.productReads, snapshot) : snapshot;
};
shopifyClient.getInventoryItemsByIds = async ({ inventoryItemIds }) =>
  inventoryItemIds.map((id) => ({ id, levels: JSON.parse(JSON.stringify(shop.inventory[id] || [])) }));
shopifyClient.getInventoryLevels = async () =>
  Object.entries(shop.inventory).map(([id, levels]) => ({ id, sku: null, tracked: true, levels: JSON.parse(JSON.stringify(levels)) }));

// ---------------------------------------------------------------------------------
// Approvals, exactly as the cycle and the /orchestrate path create them
// ---------------------------------------------------------------------------------
function executionRequestFor(toolId, params, { businessId = BUSINESS, autonomous = true } = {}) {
  const prepared = orchestratorExecutionContract.prepareApprovalExecutionRequest(toolId, {
    objective: 'Correct the product record.',
    category: 'products',
    tool_id: toolId,
    specialist_id: 'product',
    is_shared_infrastructure: false,
    business_id: businessId,
    research_params: params,
    ...(autonomous
      ? { autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-completion', job_id: 'fix', occurrence_key: '2026-03-04T09:00:00.000Z', platform: 'shopify' } }
      : {}),
  });
  if (!prepared.ok) throw new Error(`fixture could not be prepared: ${prepared.reason}`);
  return prepared.executionRequest;
}

function queue(id, toolId, params, { businessId = BUSINESS, autonomous = true, expiresAt = null } = {}) {
  return createAndPersistApprovalRequest(
    {
      id,
      classification: 'externally_executable',
      specialistId: 'product',
      toolId,
      executionRequest: executionRequestFor(toolId, params, { businessId, autonomous }),
      reason: 'Changes a real product record in the connected store.',
    },
    expiresAt ? { expiresAt } : {}
  );
}

const vendorParams = (productId, vendor) => ({ content: vendor, productId, newVendor: vendor });

// Decides a stored approval with a real signature (the decision itself never checks expiry or
// executes anything - that is what makes it usable to build a decided-but-unexecuted record).
function decide(record, businessId = BUSINESS) {
  const authorization = signApproval({ request: record, decision: 'approved', decidedBy: OWNER });
  const updated = decideAndPersistApprovalRequest([record], record.id, { decision: 'approved', decidedBy: OWNER, expectedBusinessId: businessId, authorization });
  return updated.find((entry) => entry.id === record.id);
}

function resolve(record, overrides = {}) {
  return resolveAutonomousApproval({
    approvalId: record.id,
    businessId: BUSINESS,
    decision: 'approved',
    decidedBy: OWNER,
    authorization: signApproval({ request: record, decision: 'approved', decidedBy: OWNER }),
    ...overrides,
  });
}

const envelopeOf = (id) => approvalStore.loadApprovalRecord(id);
const rememberedFor = (id) => listMemoryRecords(BUSINESS, { limit: 200 }).some((entry) => entry.id === `autonomy-${id}`);

async function withKillSwitchOn(fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

const PASSING_DAILY = { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true };
const policyWith = (autonomy) => ({ ok: true, business_id: BUSINESS, enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, ...autonomy } });

function scheduleJob(jobId, task, { schedules = undefined } = {}) {
  scheduleStore.saveScheduledJob(
    createScheduledJob({ jobId, businessId: BUSINESS, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0 }),
    schedules ? { rootDir: schedules } : {}
  );
}

function freshScheduleRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-completion-cycle-schedules-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function httpRequest(port, { method, path: reqPath, body }) {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((resolvePromise) => server.once('listening', resolvePromise));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

(async () => {
  // =================================================================================
  // GAP 2 - entity-level verification and idempotency
  // =================================================================================
  await testAsync('an approved correction is verified by BOTH the integration re-read and the shared verifier', async () => {
    const record = queue('apr-entity-first', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/101', 'Aurora Ceramics'));
    const readsBefore = shop.productReads;
    const writesBefore = shop.writes.length;
    const result = await resolve(record);
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.execution.status, 'success', result.execution.error || '');
    assert.strictEqual(result.verification.status, 'verified');
    assert.strictEqual(shop.writes.length, writesBefore + 1);
    assert.ok(shop.productReads - readsBefore >= 2, 'the integration re-read and the shared verifier each read the platform');
    const check = checkCorrectionAlreadyVerified('shopify_vendor_correction', record.execution_request);
    assert.strictEqual(check.applicable, true);
    assert.strictEqual(check.allowed, false, 'the entity change is recorded as verified in the shared store');
    assert.strictEqual(executionVerification.getVerificationRecord(check.idempotency_key, { businessId: BUSINESS }).entity_kind, 'product');
    assert.ok(rememberedFor('apr-entity-first'));
  });

  await testAsync('the identical entity change through ANOTHER approval is refused before deciding, with zero writes', async () => {
    const record = queue('apr-entity-second', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/101', 'Aurora Ceramics'));
    const writesBefore = shop.writes.length;
    const result = await resolve(record);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason_code, 'already_completed');
    assert.strictEqual(shop.writes.length, writesBefore);
    assert.strictEqual(envelopeOf('apr-entity-second').execution_state, 'awaiting_decision', 'nothing was decided or written');
  });

  await testAsync('the identical entity change reaching the dispatcher directly (another path) executes nothing and consumes no claim', async () => {
    const record = queue('apr-entity-direct', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/101', 'Aurora Ceramics'), { autonomous: false });
    const decided = decide(record);
    const writesBefore = shop.writes.length;
    const outcome = await executeApprovedCorrection(decided);
    assert.strictEqual(outcome.status, 'error');
    assert.strictEqual(outcome.reason_code, 'already_completed');
    assert.strictEqual(shop.writes.length, writesBefore);
    assert.strictEqual(envelopeOf('apr-entity-direct').execution_state, 'decided');
  });

  await testAsync('a different intended state for the same entity is not a false duplicate', async () => {
    const record = queue('apr-entity-other-value', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/101', 'Aurora Ceramics Studio'));
    assert.strictEqual(checkCorrectionAlreadyVerified('shopify_vendor_correction', record.execution_request).allowed, true);
    const writesBefore = shop.writes.length;
    const result = await resolve(record);
    assert.strictEqual(result.verification.status, 'verified', JSON.stringify(result.verification));
    assert.strictEqual(shop.writes.length, writesBefore + 1);
  });

  await testAsync('the integration re-read agrees but the shared verifier does not: mismatch, never verified, never remembered', async () => {
    const productId = 'gid://shopify/Product/102';
    const record = queue('apr-entity-mismatch', 'shopify_vendor_correction', vendorParams(productId, 'Birch Works'));
    const startRead = shop.productReads;
    // The integration's own re-read (the first read after the write) sees the new vendor; the
    // shared verifier's independent read (the second) sees something else.
    shop.productReadView = (readNumber, products) =>
      readNumber === startRead + 2 ? products.map((entry) => (entry.id === productId ? { ...entry, vendor: 'Someone Else' } : entry)) : products;
    try {
      const result = await resolve(record);
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.verification.verified, false);
      assert.strictEqual(result.verification.status, 'mismatch');
    } finally {
      shop.productReadView = null;
    }
    assert.ok(!rememberedFor('apr-entity-mismatch'));
    assert.strictEqual(checkCorrectionAlreadyVerified('shopify_vendor_correction', record.execution_request).allowed, true, 'an unverified change is not recorded as completed');
  });

  await testAsync('the integration re-read disagrees: recorded as a failure under the entity key, never verified', async () => {
    const record = queue('apr-entity-ignored', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/103', 'Cedar Goods'));
    shop.ignoreWrite = true;
    try {
      const result = await resolve(record);
      assert.strictEqual(result.verification.verified, false);
      assert.strictEqual(result.verification.status, 'failed');
    } finally {
      shop.ignoreWrite = false;
    }
    const key = checkCorrectionAlreadyVerified('shopify_vendor_correction', record.execution_request).idempotency_key;
    const stored = executionVerification.getVerificationRecord(key, { businessId: BUSINESS });
    assert.strictEqual(stored.status, 'failed');
    assert.strictEqual(stored.reason_code, 'integration_reread_unconfirmed');
    assert.ok(!rememberedFor('apr-entity-ignored'));
  });

  await testAsync('an inventory correction with no known baseline is reported unverifiable - no baseline is invented', async () => {
    shop.inventory['gid://shopify/InventoryItem/1'] = [{ locationId: LOCATION, available: 2 }];
    const record = queue('apr-inventory-unknown', 'shopify_inventory_correction', {
      inventoryItemId: 'gid://shopify/InventoryItem/1',
      locationId: LOCATION,
      delta: 3,
      idempotencyKey: 'restore-item-1',
    });
    const result = await resolve(record);
    assert.strictEqual(result.execution.status, 'success', result.execution.error || '');
    assert.strictEqual(result.verification.status, 'unverifiable');
    assert.strictEqual(result.verification.reason_code, 'baseline_unknown');
    assert.strictEqual(checkCorrectionAlreadyVerified('shopify_inventory_correction', record.execution_request).applicable, false);
  });

  await testAsync('an inventory correction with a stated baseline is verified at exactly that location', async () => {
    shop.inventory['gid://shopify/InventoryItem/2'] = [{ locationId: 'gid://shopify/Location/9', available: 40 }, { locationId: LOCATION, available: 1 }];
    const record = queue('apr-inventory-known', 'shopify_inventory_correction', {
      inventoryItemId: 'gid://shopify/InventoryItem/2',
      locationId: LOCATION,
      delta: 4,
      changeFromQuantity: 1,
      idempotencyKey: 'restore-item-2',
    });
    const result = await resolve(record);
    assert.strictEqual(result.verification.status, 'verified', JSON.stringify(result.verification));
    assert.strictEqual(shop.inventory['gid://shopify/InventoryItem/2'][1].available, 5);
  });

  await testAsync('a collection membership change is verified on the product, where membership is observable', async () => {
    const productId = 'gid://shopify/Product/104';
    product(productId);
    const record = queue('apr-collection', 'shopify_collection_membership_update', { collectionId: 'gid://shopify/Collection/7', productId });
    const result = await resolve(record);
    assert.strictEqual(result.verification.status, 'verified', JSON.stringify(result.verification));
    assert.strictEqual(checkCorrectionAlreadyVerified('shopify_collection_membership_update', record.execution_request).allowed, false);
  });

  await testAsync('business binding: a caller naming a different business for a stored approval executes nothing', async () => {
    const record = queue('apr-binding', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/105', 'Dune Supply'));
    const decided = decide(record);
    const writesBefore = shop.writes.length;
    const outcome = await executeApprovedCorrection({ ...decided, execution_request: { ...decided.execution_request, business_id: null } });
    assert.strictEqual(outcome.reason_code, 'approval_identity_mismatch');
    assert.strictEqual(shop.writes.length, writesBefore);
    assert.strictEqual(envelopeOf('apr-binding').execution_state, 'decided');
  });

  // =================================================================================
  // GAP 3 - autonomous approval expiry
  // =================================================================================
  test('approval_ttl_hours is validated and read, and has no default', () => {
    assert.strictEqual(readAutonomyConfig({ autonomy: { enabled: true } }).approval_ttl_hours, null);
    assert.strictEqual(readAutonomyConfig({ autonomy: { enabled: true, approval_ttl_hours: 24 } }).approval_ttl_hours, 24);
    assert.strictEqual(validateAutonomyConfig({ autonomy: { enabled: true, approval_ttl_hours: 24 } }).valid, true);
    for (const bad of [0, -1, 1.5, 'soon']) {
      const result = validateAutonomyConfig({ autonomy: { enabled: true, approval_ttl_hours: bad } });
      assert.strictEqual(result.valid, false, `approval_ttl_hours ${bad} must be refused`);
      assert.ok(/approval_ttl_hours/.test(result.errors[0]));
    }
  });

  test('an autonomous business with no approval_ttl_hours is refused by the policy - it fails closed', () => {
    withKillSwitchOnSync(() => {
      const base = { businessId: null, specialistId: 'research', toolId: 'market_research', complianceVerdict: 'PASS', dailyUsage: PASSING_DAILY };
      const missing = evaluateAutonomyPolicy({ ...base, businessPolicy: { ...policyWith({ approval_ttl_hours: null }), business_id: null, enabled_platforms: ['shopify', 'etsy'] } });
      assert.strictEqual(missing.decision, 'BLOCK');
      assert.strictEqual(missing.reason_code, 'approval_ttl_not_configured');
      const present = evaluateAutonomyPolicy({ ...base, businessPolicy: { ...policyWith({ approval_ttl_hours: 24 }), business_id: null, enabled_platforms: ['shopify', 'etsy'] } });
      assert.notStrictEqual(present.reason_code, 'approval_ttl_not_configured');
    });
  });

  await testAsync('the cycle stores an expiry of exactly now + approval_ttl_hours on the approval it queues', async () => {
    const schedules = freshScheduleRoot();
    scheduleJob('ttl-vendor', { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: vendorParams('gid://shopify/Product/201', 'Elm House') }, { schedules });
    await withKillSwitchOn(async () => {
      const cycle = await runAutonomousCycle({ businessId: BUSINESS, now: T0, enabledPlatforms: ['shopify'], businessPolicy: policyWith({ approval_ttl_hours: 5 }), dailyUsage: PASSING_DAILY, scheduleRootDir: schedules });
      const step = cycle.steps.find((entry) => entry.job_id === 'ttl-vendor');
      assert.strictEqual(step.outcome, 'approval_required', JSON.stringify(step));
      assert.strictEqual(envelopeOf(step.approval_request_id).expires_at, '2026-03-04T14:07:00.000Z');
    });
  });

  await testAsync('a cycle for a business without approval_ttl_hours queues nothing', async () => {
    const schedules = freshScheduleRoot();
    scheduleJob('no-ttl-vendor', { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: vendorParams('gid://shopify/Product/202', 'Fern & Co') }, { schedules });
    await withKillSwitchOn(async () => {
      const cycle = await runAutonomousCycle({ businessId: BUSINESS, now: T0, enabledPlatforms: ['shopify'], businessPolicy: policyWith({ approval_ttl_hours: null }), dailyUsage: PASSING_DAILY, scheduleRootDir: schedules });
      const step = cycle.steps.find((entry) => entry.job_id === 'no-ttl-vendor');
      assert.strictEqual(step.outcome, 'blocked');
      assert.strictEqual(step.reason_code, 'approval_ttl_not_configured');
      assert.strictEqual(step.approval_request_id, null);
    });
  });

  await testAsync('an expired approval is omitted from pending, gets no challenge, and is refused as approval_expired with zero writes', async () => {
    const record = queue('apr-expiring', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/203', 'Grove Lane'), { expiresAt: hoursAfter(T0, 1).toISOString() });
    const before = hoursAfter(T0, 0.5);
    const after = hoursAfter(T0, 2);
    assert.ok(listPendingAutonomousApprovals({ businessId: BUSINESS, now: before }).some((item) => item.approval_id === 'apr-expiring' && item.expires_at));
    assert.ok(findPendingAutonomousApproval('apr-expiring', { businessId: BUSINESS, now: before }));
    assert.ok(!listPendingAutonomousApprovals({ businessId: BUSINESS, now: after }).some((item) => item.approval_id === 'apr-expiring'));
    assert.strictEqual(findPendingAutonomousApproval('apr-expiring', { businessId: BUSINESS, now: after }), null);

    const writesBefore = shop.writes.length;
    const result = await resolve(record, { now: after });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason_code, 'approval_expired');
    assert.strictEqual(shop.writes.length, writesBefore);
    assert.strictEqual(envelopeOf('apr-expiring').execution_state, 'awaiting_decision');
  });

  await testAsync('an approval decided in time but executed after its expiry cannot execute', async () => {
    const record = queue('apr-expired-exec', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/204', 'Harbor Mill'), { expiresAt: hoursAfter(T0, 1).toISOString() });
    const decided = decide(record);
    const writesBefore = shop.writes.length;
    const outcome = await executeApprovedCorrection(decided, { now: hoursAfter(T0, 2) });
    assert.strictEqual(outcome.reason_code, 'approval_expired');
    assert.strictEqual(shop.writes.length, writesBefore);
  });

  await testAsync('a genuine approval still inside its expiry executes and verifies', async () => {
    const record = queue('apr-in-time', 'shopify_vendor_correction', vendorParams('gid://shopify/Product/205', 'Ivy Row'), { expiresAt: '2999-01-01T00:00:00.000Z' });
    const result = await resolve(record);
    assert.strictEqual(result.verification.status, 'verified', JSON.stringify(result.verification));
  });

  await testAsync('once an approval expires, a later occurrence may queue a fresh one', async () => {
    const schedules = freshScheduleRoot();
    scheduleJob('refresh-vendor', { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: vendorParams('gid://shopify/Product/206', 'Juniper Lane') }, { schedules });
    await withKillSwitchOn(async () => {
      const options = { businessId: BUSINESS, enabledPlatforms: ['shopify'], businessPolicy: policyWith({ approval_ttl_hours: 1 }), dailyUsage: PASSING_DAILY, scheduleRootDir: schedules };
      const first = await runAutonomousCycle({ ...options, now: T0 });
      const firstStep = first.steps.find((entry) => entry.job_id === 'refresh-vendor');
      assert.strictEqual(firstStep.approval_state, 'pending');

      const later = hoursAfter(T0, 2);
      const second = await runAutonomousCycle({ ...options, now: later });
      const secondStep = second.steps.find((entry) => entry.job_id === 'refresh-vendor');
      assert.strictEqual(secondStep.outcome, 'approval_required', JSON.stringify(secondStep));
      assert.notStrictEqual(secondStep.reason_code, 'approval_already_pending', 'an expired approval does not stand in for a new one');
      assert.notStrictEqual(secondStep.approval_request_id, firstStep.approval_request_id);
      assert.strictEqual(secondStep.approval_state, 'pending');
    });
  });

  test('the signing-challenge window stays separate from the approval expiry', () => {
    assert.strictEqual(CHALLENGE_TTL_ENV, 'APPROVAL_CHALLENGE_TTL_MS');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'approvalArchitecture.js'), 'utf8');
    assert.ok(!source.includes('approval_ttl_hours'), 'the challenge window never reads the business approval expiry');
  });

  // =================================================================================
  // GAP 4 - stored approval proof re-verified immediately before mutation
  // =================================================================================
  function decidedFixture(id, productId) {
    return decide(queue(id, 'shopify_vendor_correction', vendorParams(productId, 'Kestrel Works')));
  }

  test('verifyRecordedProvenance accepts a genuine record and binds it to business, action and platform', () => {
    const decided = decidedFixture('apr-proof-unit', 'gid://shopify/Product/301');
    assert.strictEqual(verifyRecordedProvenance(decided, { businessId: BUSINESS, toolId: 'shopify_vendor_correction', platform: 'shopify' }).valid, true);
    assert.strictEqual(verifyRecordedProvenance(decided, { businessId: 'another-co' }).failed_check, 'business_binding');
    assert.strictEqual(verifyRecordedProvenance(decided, { toolId: 'shopify_inventory_correction' }).failed_check, 'action_binding');
    assert.strictEqual(verifyRecordedProvenance(decided, { platform: 'etsy' }).failed_check, 'platform_binding');
  });

  function tamperings(decided) {
    const clone = () => JSON.parse(JSON.stringify(decided));
    const signature = clone();
    const bytes = Buffer.from(signature.execution_request.approval_provenance.signature, 'base64');
    bytes[0] ^= 0xff;
    signature.execution_request.approval_provenance.signature = bytes.toString('base64');
    const fingerprint = clone();
    fingerprint.execution_request.approval_provenance.execution_fingerprint = 'f'.repeat(64);
    const params = clone();
    params.execution_request.research_params.newVendor = 'Changed After Approval';
    params.execution_request.research_params.content = 'Changed After Approval';
    return { 'a modified signature': [signature, 'signature_verifies_under_public_key'], 'a modified fingerprint': [fingerprint, 'fingerprint_matches_request'], 'parameters changed after approval': [params, 'fingerprint_matches_request'] };
  }

  await testAsync('a forged, re-signed, re-fingerprinted or edited stored record is refused with zero writes and no claim', async () => {
    const decided = decidedFixture('apr-proof-tamper', 'gid://shopify/Product/302');
    for (const [label, [tampered, failedCheck]] of Object.entries(tamperings(decided))) {
      assert.strictEqual(verifyRecordedProvenance(tampered).failed_check, failedCheck, label);
      approvalStore.saveApprovalRecord(tampered, { executionState: 'decided' });
      const writesBefore = shop.writes.length;
      const outcome = await executeApprovedCorrection(tampered);
      assert.strictEqual(outcome.reason_code, 'approval_provenance_invalid', `${label}: ${outcome.error}`);
      assert.strictEqual(shop.writes.length, writesBefore, `${label} must not write`);
      assert.strictEqual(envelopeOf('apr-proof-tamper').execution_state, 'decided', `${label} must not consume the claim`);
    }

    // A record that was never signed at all, planted as approved with plausible provenance.
    const planted = createApprovalRequest({
      id: 'apr-proof-forged',
      classification: 'externally_executable',
      specialistId: 'product',
      toolId: 'shopify_vendor_correction',
      executionRequest: executionRequestFor('shopify_vendor_correction', vendorParams('gid://shopify/Product/303', 'Forged Vendor')),
      reason: 'planted',
    });
    planted.status = 'approved';
    planted.decided_by = OWNER;
    planted.decided_at = new Date().toISOString();
    planted.execution_request = {
      ...planted.execution_request,
      approval_provenance: {
        method: 'ed25519_signature',
        payload_version: APPROVAL_PAYLOAD_VERSION,
        request_id: planted.id,
        decision: 'approved',
        decided_by: OWNER,
        execution_fingerprint: computeExecutionFingerprint(planted.execution_request),
        nonce: 'invented-nonce',
        issued_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        signature: crypto.randomBytes(64).toString('base64'),
      },
    };
    approvalStore.saveApprovalRecord(planted, { executionState: 'decided' });
    const writesBefore = shop.writes.length;
    const forged = await executeApprovedCorrection(planted);
    assert.strictEqual(forged.reason_code, 'approval_provenance_invalid');
    assert.strictEqual(shop.writes.length, writesBefore);
  });

  await testAsync('with no public key configured, even a genuine stored approval is not trusted', async () => {
    const decided = decidedFixture('apr-proof-nokey', 'gid://shopify/Product/304');
    const saved = process.env[APPROVAL_PUBLIC_KEY_ENV];
    delete process.env[APPROVAL_PUBLIC_KEY_ENV];
    const writesBefore = shop.writes.length;
    try {
      const outcome = await executeApprovedCorrection(decided);
      assert.strictEqual(outcome.reason_code, 'approval_provenance_invalid');
      assert.ok(/public_key_configured/.test(outcome.error));
    } finally {
      process.env[APPROVAL_PUBLIC_KEY_ENV] = saved;
    }
    assert.strictEqual(shop.writes.length, writesBefore);
    // The same genuine record, with the key restored, executes through the existing path.
    const outcome = await executeApprovedCorrection(decided, { enabledPlatforms: ['shopify'] });
    assert.strictEqual(outcome.status, 'success', outcome.error || '');
    assert.strictEqual(outcome.entity_verification.status, 'verified');
  });

  // =================================================================================
  // GAP 5 - schedule platform validation
  // =================================================================================
  test('an observation schedule must target the platform its capability observes', () => {
    const rootDir = freshScheduleRoot();
    const policy = { ok: true, business_id: 'schedule-co', enabled_platforms: ['shopify', 'etsy'], autonomy: { enabled: false, daily_token_budget: null, daily_run_budget: null, approval_ttl_hours: null } };
    const create = (jobId, task) => createBusinessSchedule({ businessId: 'schedule-co', jobId, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0, rootDir, businessPolicy: policy });

    for (const [jobId, task] of [
      ['etsy-on-shopify', { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe listings.', platform: 'shopify' }],
      ['shopify-on-etsy', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'etsy' }],
      ['no-platform', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.' }],
      ['mismatched-follow-up', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify', follow_ups: [{ tool_id: 'etsy_shop_data_retrieval', objective: 'Observe the shop.' }] }],
    ]) {
      const result = create(jobId, task);
      assert.strictEqual(result.ok, false, jobId);
      assert.strictEqual(result.reason_code, 'observation_platform_mismatch', `${jobId}: ${result.reason}`);
      assert.strictEqual(scheduleStore.loadScheduledJob(jobId, { businessId: 'schedule-co', rootDir }), null, `${jobId} was saved`);
    }

    for (const [jobId, task] of [
      ['shopify-observe', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' }],
      ['etsy-observe', { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe listings.', platform: 'etsy' }],
    ]) {
      const result = create(jobId, task);
      assert.strictEqual(result.ok, true, `${jobId}: ${result.reason}`);
      assert.strictEqual(result.job.enabled, false, 'a valid schedule is still saved disabled');
    }

    // Amazon and eBay gain nothing: no observation capability is declared for them.
    for (const platform of ['amazon', 'ebay']) {
      const result = createBusinessSchedule({
        businessId: 'schedule-co',
        jobId: `observe-${platform}`,
        schedule: { kind: 'interval_minutes', every: 60 },
        task: { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform },
        now: T0,
        rootDir,
        businessPolicy: { ...policy, enabled_platforms: ['shopify', 'etsy', platform] },
      });
      assert.strictEqual(result.ok, false, platform);
    }
  });

  // =================================================================================
  // GAP 6 - honest cycle status and read-only visibility
  // =================================================================================
  test('cycle status is derived from what the steps actually did', () => {
    assert.strictEqual(deriveCycleStatus([]), 'success');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'observed' }, { outcome: 'executed', verification: 'verified' }, { outcome: 'approval_required', approval_state: 'pending' }]), 'success');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'observed' }, { outcome: 'blocked' }]), 'partial');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'blocked' }, { outcome: 'execution_failed' }]), 'error');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'executed', verification: 'unverifiable' }]), 'error');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'approval_required', approval_state: null }]), 'error', 'an approval that was not queued is not a success');
    assert.strictEqual(deriveCycleStatus([{ outcome: 'observed' }, { outcome: 'not_claimed' }]), 'success', 'another process holding an occurrence is neutral');
  });

  await testAsync('a cycle whose every job is blocked is recorded as an error, not a success', async () => {
    const schedules = freshScheduleRoot();
    scheduleJob('blocked-mismatch', { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe listings.', platform: 'shopify' }, { schedules });
    await withKillSwitchOn(async () => {
      const cycle = await runAutonomousCycle({ businessId: BUSINESS, now: T0, enabledPlatforms: ['shopify'], businessPolicy: policyWith({ approval_ttl_hours: 24 }), dailyUsage: PASSING_DAILY, scheduleRootDir: schedules });
      assert.ok(cycle.steps.every((step) => step.outcome === 'blocked'), JSON.stringify(cycle.steps.map((step) => step.outcome)));
      assert.strictEqual(cycle.record.status, 'error');
      assert.strictEqual(runHistoryStore.getRunRecordById(cycle.cycle_id).status, 'error');
    });
  });

  await testAsync('GET /autonomy/state shows the latest cycle as allow-listed fields only, for this business only', async () => {
    const leaky = 'CANARY-DO-NOT-LEAK-7c1e';
    runHistoryStore.saveRunRecord({
      run_id: 'cycle-_default-state-test',
      kind: 'autonomous_cycle',
      business_id: null,
      status: 'partial',
      created_at: '2026-03-05T09:00:00.000Z',
      summary: 'Autonomous cycle: 1 observed, 1 blocked.',
      result: {
        steps: [
          { job_id: 'watch', outcome: 'observed', reason_code: null, verification: null, approval_request_id: null, parent_job_id: null, change_counts: { added: 1 }, reason: leaky },
          { job_id: 'watch--follow-up-1', outcome: 'blocked', reason_code: 'already_completed', verification: 'verified', approval_request_id: null, parent_job_id: 'watch', policy_decision: { decision: 'BLOCK', trace: leaky } },
        ],
        audit_trail: [{ summary: leaky }],
      },
    });
    runHistoryStore.saveRunRecord({
      run_id: `cycle-${BUSINESS}-state-test`,
      kind: 'autonomous_cycle',
      business_id: BUSINESS,
      status: 'success',
      created_at: '2026-03-06T09:00:00.000Z',
      summary: 'Another business.',
      result: { steps: [{ job_id: 'other-business-job', outcome: 'observed' }] },
    });

    await withServer(async (port) => {
      const res = await httpRequest(port, { method: 'GET', path: '/autonomy/state' });
      assert.strictEqual(res.status, 200, res.raw);
      const latest = res.body.latest_cycle;
      assert.strictEqual(latest.run_id, 'cycle-_default-state-test');
      assert.strictEqual(latest.status, 'partial');
      assert.deepStrictEqual(Object.keys(latest.steps[1]).sort(), ['approval_request_id', 'job_id', 'outcome', 'parent_job_id', 'reason_code', 'verification_status']);
      assert.strictEqual(latest.steps[1].reason_code, 'already_completed');
      assert.strictEqual(latest.steps[1].verification_status, 'verified');
      assert.ok(!res.raw.includes(leaky), 'nothing outside the allow-list reaches the response');
      assert.ok(!res.raw.includes('other-business-job'), "another business's cycle is never shown");
      assert.ok(!res.raw.includes(TEST_API_KEY));
    });
  });

  test('the Autonomy dashboard page only reads - it has no mutation path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
    const start = source.indexOf('async function loadAutonomy()');
    const end = source.indexOf('\n  }\n', start);
    assert.ok(start !== -1 && end !== -1);
    const body = source.slice(start, end);
    const fetches = body.match(/apiFetch\([^)]*\)/g) || [];
    assert.deepStrictEqual(fetches, ["apiFetch('/autonomy/state')"]);
    assert.ok(!/method\s*:/.test(body), 'no request method other than the default GET');
    assert.ok(body.includes('latest_cycle'), 'the latest cycle is rendered');
  });

  // =================================================================================
  // GAP 1 - usage completeness for manual POST /run
  // =================================================================================
  await testAsync('POST /run records the real usage ledger, so a manual run keeps the day measurable', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-completion-manual-runs-'));
    TEMP_DIRS.push(runsDir);
    const savedRunsDir = process.env.RUN_HISTORY_STORE_DIR;
    const savedBuildPlanStep = orchestratorExecutionContract.buildPlanStep;
    process.env.RUN_HISTORY_STORE_DIR = runsDir;
    // The step records one real model call on the ledger the endpoint passes in.
    orchestratorExecutionContract.buildPlanStep = async (...args) => {
      const ledger = args[11];
      appendUsageEvent(ledger, { category: 'model_call', tokens: { input: 5, output: 7, total: 12 }, model: 'test-model', quantity: 12, status: 'success', summary: 'One model call.' });
      return {
        request: 'objective',
        current_task: 'objective',
        selected_specialist: { type: 'specialist', id: 'research', title: 'research' },
        inputs: { category: 'test', tool_id: 'test_tool', capability_id: null, input_contract: null },
        required_context: [],
        outputs: { summary: 'done' },
        evidence: [{ tool_id: 'test_tool', status: 'success' }],
        confidence: 'high',
        tool_calls: ['test_tool'],
        approvals: [],
        errors: [],
        completion_state: 'complete',
      };
    };
    try {
      await withServer(async (port) => {
        const res = await httpRequest(port, { method: 'POST', path: '/run', body: { specialist: 'research', objective: 'Measure me.' } });
        assert.strictEqual(res.status, 200, res.raw);
        assert.strictEqual(res.body.usage_summary.by_category.model_call.tokens_total, 12);
        const saved = runHistoryStore.getRunRecordById(res.body.run_id);
        assert.strictEqual(saved.result.usage_summary.by_category.model_call.count, 1, 'the saved record carries what actually ran');
      });
      const complete = readDailyUsage({ businessId: null, now: new Date(), storeDir: runsDir });
      assert.strictEqual(complete.coverage_complete, true);
      assert.strictEqual(complete.tokens_total, 12);

      // A record with no usage still fails closed.
      runHistoryStore.saveRunRecord({ run_id: 'run-without-usage', kind: 'run', status: 'success', summary: 'no ledger', created_at: new Date().toISOString(), result: {} });
      const incomplete = readDailyUsage({ businessId: null, now: new Date(), storeDir: runsDir });
      assert.strictEqual(incomplete.coverage_complete, false);
      assert.strictEqual(incomplete.runs_missing_usage, 1);
    } finally {
      orchestratorExecutionContract.buildPlanStep = savedBuildPlanStep;
      process.env.RUN_HISTORY_STORE_DIR = savedRunsDir;
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomyCompletion.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

function withKillSwitchOnSync(fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}
