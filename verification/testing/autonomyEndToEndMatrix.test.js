'use strict';

// PROOF THAT THE CONTROLLED-AUTONOMY CHAIN IS CONNECTED THROUGH THE REAL ORCHESTRATION PATH.
//
//   MONITOR -> DETECT -> DATA/RESEARCH -> CHIEF DECISION/PLAN -> CAPABILITY RESOLUTION
//   -> POLICY -> SECURITY -> PERMISSION -> BUDGET -> COMPLIANCE -> AUTO-SAFE / APPROVAL
//   -> EXECUTE -> VERIFY -> AUDIT -> PERSIST -> NEXT CYCLE
//
// NOTHING BETWEEN THE TRIGGER AND THE PLATFORM IS INJECTED. Every cycle below is started with
// triggerAutonomousCycle({ businessId, now, env }) exactly as the CLI and POST /autonomy/cycle
// start one: the real business configuration (temporary configuration/businesses/<id>/), the
// real autonomy policy and kill switch, the real schedule/snapshot/circuit/verification/
// approval/run/memory stores (in temporary directories via their documented env overrides),
// the real adapter registry, the real Chief plan step and executor, the real compliance
// engine, the real Ed25519 approval verification and the real correction dispatch.
//
// ONLY THE EXTERNAL BOUNDARIES ARE STUBBED: the Shopify client's read/write functions, the Etsy
// read adapter's read functions, and the AI provider's sendMessage. global.fetch fails the
// suite if anything reaches for the network.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Real stores in temporary directories (read at call time by each store) ----------------
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
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), `autonomy-e2e-${name}-`));
  TEMP_DIRS.push(process.env[variable]);
}
delete process.env.VERCEL;
delete process.env.AGENT_AUTONOMY_ENABLED;

// --- Real business configurations (same convention as autonomyPolicy.test.js) --------------
const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');
const FIXTURE_DIRS = [];
function writeBusiness(id, { platforms, autonomy }) {
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
      `enabled_platforms: ${platforms}`,
      'autonomy:',
      ...autonomy.map((line) => `  ${line}`),
      '',
    ].join('\n')
  );
  FIXTURE_DIRS.push(dir);
}
process.on('exit', () => {
  for (const dir of [...FIXTURE_DIRS, ...TEMP_DIRS]) fs.rmSync(dir, { recursive: true, force: true });
});

const ALPHA = 'autonomy-e2e-alpha-co';
const BETA = 'autonomy-e2e-beta-co';
const OFF = 'autonomy-e2e-off-co';
const ETSY = 'autonomy-e2e-etsy-co';
const BUDGET = 'autonomy-e2e-budget-co';
writeBusiness(ALPHA, { platforms: '[shopify]', autonomy: ['enabled: true', 'daily_token_budget: 100000', 'approval_ttl_hours: 87600'] });
writeBusiness(BETA, { platforms: '[shopify]', autonomy: ['enabled: true', 'daily_token_budget: 100000', 'approval_ttl_hours: 87600'] });
writeBusiness(OFF, { platforms: '[shopify]', autonomy: ['enabled: false'] });
writeBusiness(ETSY, { platforms: '[etsy]', autonomy: ['enabled: true', 'daily_token_budget: 100000', 'approval_ttl_hours: 87600'] });
writeBusiness(BUDGET, { platforms: '[shopify]', autonomy: ['enabled: true', 'daily_token_budget: 10', 'approval_ttl_hours: 87600'] });

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyReadAdapter = require('../../integrations/adapters/etsyReadAdapter');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const { triggerAutonomousCycle } = require('../../autonomy/cycleTrigger');
const { resolveAutonomousApproval, listPendingAutonomousApprovals } = require('../../autonomy/approvalResolution');
const { createBusinessSchedule, setBusinessScheduleEnabled } = require('../../scheduler/scheduleManagement');
const { createScheduledJob } = require('../../scheduler/scheduleModel');
const scheduleStore = require('../../scheduler/scheduleStore');
const approvalStore = require('../../approvals/approvalStore');
const { listSnapshots, getLatestSnapshot } = require('../../monitoring/snapshotStore');
const executionVerification = require('../../reliability/executionVerification');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
const { readDailyUsage } = require('../../agent/core/dailyUsageAccounting');
const { createEmptyListingContentRecord } = require('../../agent/core/listingContentModel');
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { signApproval, signApprovalWithForeignKey } = require('./approvalSigningTestKey');

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

// ---------------------------------------------------------------------------------
// External boundaries only
// ---------------------------------------------------------------------------------

const PRODUCT_ID = 'gid://shopify/Product/1';
const OWNER = 'owner@example.com';
const REVIEW_VENDOR = 'Aurora Ceramics';
// A different intended state for the same product - used where a scenario needs a change that
// has NOT already been applied and verified (test 4 applies REVIEW_VENDOR, which can then never
// be applied again).
const DISTINCT_VENDOR = 'Aurora Ceramics Studio';
const { prepareApprovalExecutionRequest } = require('../../agent/core/orchestratorExecutionContract');
const { createAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const BLOCKING_VENDOR = 'guaranteed copyright-free with no legal risk';

const shop = { stock: { [ALPHA]: 5, [BETA]: 5, [BUDGET]: 5 }, vendor: 'Old Vendor', failProductsRead: false, failWrite: false, ignoreWrite: false, reads: [], writes: [] };
Object.assign(shopifyClient, {
  isConfigured: () => true,
  getShopInfo: async ({ businessId } = {}) => {
    shop.reads.push({ businessId, capability: 'getShopInfo' });
    return { name: `Shop ${businessId}`, domain: `${businessId}.example`, email: null };
  },
  getProducts: async ({ businessId } = {}) => {
    shop.reads.push({ businessId, capability: 'getProducts' });
    if (shop.failProductsRead) throw new Error('Shopify read failed.');
    const stock = shop.stock[businessId] === undefined ? 0 : shop.stock[businessId];
    return [{ id: PRODUCT_ID, title: 'Mug', status: 'active', vendor: shop.vendor, tags: [], variants: [{ available: stock > 0, inventory_quantity: stock }] }];
  },
  getCollections: async () => [],
  getInventoryLevels: async () => [],
  getOrders: async () => [],
  getCustomers: async () => [],
  updateProductVendor: async ({ productId, vendor }) => {
    if (shop.failWrite) throw new Error('Shopify refused the mutation.');
    shop.writes.push({ productId, vendor });
    if (!shop.ignoreWrite) shop.vendor = vendor;
    return { id: productId, vendor };
  },
});
Object.assign(etsyReadAdapter, {
  isConfigured: () => true,
  getShopInfo: async () => ({ name: 'Etsy Shop', domain: null, email: null }),
  getProducts: async () => [],
});
const ai = { calls: 0 };
aiProviderSelector.sendMessage = async () => {
  ai.calls += 1;
  return { text: 'Review the stock change on Mug.', model: 'stub-model', stopReason: 'end_turn', usage: { input_tokens: 12, output_tokens: 18 } };
};

// ---------------------------------------------------------------------------------
// Helpers - all real paths
// ---------------------------------------------------------------------------------

const T0 = new Date('2026-03-04T09:07:00.000Z');
const T1 = new Date('2026-03-04T10:07:00.000Z');
const T1_SAME_WINDOW = new Date('2026-03-04T10:41:00.000Z');
const T2 = new Date('2026-03-04T11:07:00.000Z');
const T3 = new Date('2026-03-04T12:07:00.000Z');
const T4 = new Date('2026-03-04T13:07:00.000Z');
const ON = { [AUTONOMY_KILL_SWITCH_ENV]: 'true' };

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

const trigger = (businessId, now, env = ON) => triggerAutonomousCycle({ businessId, now, env });
const outcomesOf = (cycle) => Object.fromEntries(cycle.steps.map((step) => [step.job_id, step.outcome]));
const stepOf = (cycle, jobId) => cycle.steps.find((step) => step.job_id === jobId) || {};
const recordOf = (cycle) => runHistoryStore.getRunRecordById(cycle.cycle_id);
const summariesOf = (record) => record.result.audit_trail.map((event) => event.summary);
const count = (list, text) => list.filter((entry) => entry === text).length;
const fieldsPassedTo = (record, toolId) =>
  record.result.audit_trail
    .filter((event) => event.type === 'data_access' && event.tool_id === toolId && event.detail && Array.isArray(event.detail.fields))
    .flatMap((event) => event.detail.fields);

function scheduleEnabled(businessId, jobId, task) {
  const created = createBusinessSchedule({ businessId, jobId, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0 });
  assert.strictEqual(created.ok, true, `schedule refused: ${created.reason} ${JSON.stringify(created.errors || [])}`);
  const enabled = setBusinessScheduleEnabled({ businessId, jobId, enabled: true, now: T0 });
  assert.strictEqual(enabled.ok, true, `enable refused: ${enabled.reason}`);
}

function vendorFollowUp(newVendor) {
  return {
    tool_id: 'shopify_vendor_correction',
    objective: 'Correct the vendor on the changed product.',
    params: { content: newVendor, productId: PRODUCT_ID, newVendor },
  };
}

function storedRecord(approvalId, businessId) {
  return approvalStore.loadApprovalRecord(approvalId, { expectedBusinessId: businessId }).approval_request;
}

const lastOccurrence = (businessId, jobId) => scheduleStore.loadScheduledJob(jobId, { businessId }).last_occurrence_key;

(async () => {
  await withKillSwitchOn(async () => {
    // The owner's explicit schedules, through the real management path and real policy.
    scheduleEnabled(ALPHA, 'watch', {
      tool_id: 'product_data_retrieval',
      objective: 'Observe the catalogue.',
      platform: 'shopify',
      follow_ups: [
        { tool_id: 'business_configuration_retrieval', objective: 'Retrieve the store configuration for the changed store.' },
        { tool_id: 'ai_reasoning_completion', objective: 'Recommend what the owner should review about this stock change.' },
        { tool_id: 'listing_quality_check', objective: 'Check listing quality for the changed product.' },
        { tool_id: 'listing_quality_check', objective: 'Check listing quality for the changed product.', params: { listingRecord: createEmptyListingContentRecord('Mug') } },
        vendorFollowUp(REVIEW_VENDOR),
        vendorFollowUp(BLOCKING_VENDOR),
      ],
    });
    scheduleEnabled(BETA, 'watch', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify', follow_ups: [vendorFollowUp('Beta Vendor Co')] });

    // ---------------------------------------------------------------------------
    // 1. Safe read-only autonomous action
    // ---------------------------------------------------------------------------
    await testAsync('1 read-only: observation runs through the real adapter registry, is persisted and audited, and starts nothing', async () => {
      const cycle = await trigger(ALPHA, T0);
      assert.strictEqual(cycle.triggered, true, cycle.reason);
      assert.deepStrictEqual(outcomesOf(cycle), { watch: 'observed' });
      assert.strictEqual(listSnapshots({ businessId: ALPHA, platform: 'shopify' }).length, 1);
      assert.ok(shop.reads.some((read) => read.businessId === ALPHA && read.capability === 'getProducts'), 'the real registry reached the Shopify client');
      const record = recordOf(cycle);
      assert.strictEqual(record.kind, 'autonomous_cycle');
      assert.ok(record.result.usage_summary.by_category.tool_call.count >= 1);
      assert.strictEqual(ai.calls, 0);
      assert.strictEqual(shop.writes.length, 0);
    });

    // ---------------------------------------------------------------------------
    // 2, 3, 4, 5, 6, 15 - a real change through the Chief's plan step
    // ---------------------------------------------------------------------------
    let t1Cycle;
    await testAsync('2+3 a detected change runs data and recommendation capabilities auto-safe through the Chief plan step', async () => {
      shop.stock[ALPHA] = 0;
      t1Cycle = await trigger(ALPHA, T1);
      assert.strictEqual(t1Cycle.triggered, true, t1Cycle.reason);
      assert.strictEqual(stepOf(t1Cycle, 'watch').outcome, 'observed');
      assert.strictEqual(stepOf(t1Cycle, 'watch--follow-up-1').outcome, 'executed', JSON.stringify(stepOf(t1Cycle, 'watch--follow-up-1')));
      assert.strictEqual(stepOf(t1Cycle, 'watch--follow-up-2').outcome, 'executed', JSON.stringify(stepOf(t1Cycle, 'watch--follow-up-2')));
      assert.strictEqual(ai.calls, 1, 'the recommendation reached the AI provider through the real executor');

      const summaries = summariesOf(recordOf(t1Cycle));
      assert.strictEqual(count(summaries, "Invoking tool 'business_configuration_retrieval'."), 1, 'executed by the real Chief executor');
      assert.strictEqual(count(summaries, "Invoking tool 'ai_reasoning_completion'."), 1);
      assert.ok(fieldsPassedTo(recordOf(t1Cycle), 'business_configuration_retrieval').includes('detected_changes'), "the monitor's change reached the capability");
      assert.ok(recordOf(t1Cycle).result.usage_summary.by_category.model_call.count >= 1, 'model spend is on the cycle record');
      assert.strictEqual(readDailyUsage({ businessId: ALPHA, now: T1 }).coverage_complete, true, "the day's spend stays measurable");
    });

    await testAsync('capability resolution stops missing input before dispatch, without tripping the circuit breaker', async () => {
      const step = stepOf(t1Cycle, 'watch--follow-up-3');
      assert.strictEqual(step.outcome, 'blocked', JSON.stringify(step));
      assert.strictEqual(step.reason_code, 'capability_not_dispatched');
      const summaries = summariesOf(recordOf(t1Cycle));
      assert.strictEqual(count(summaries, "Invoking tool 'listing_quality_check'."), 1, 'only the follow-up with real input was dispatched');
      assert.strictEqual(
        require('../../reliability/circuitBreaker').checkCircuit({ businessId: ALPHA, platform: 'shopify', action: 'listing_quality_check', now: T1 }).allowed,
        true
      );
    });

    await testAsync('15a verification failure: an analysis that returns no usable result is never recorded as executed', async () => {
      const step = stepOf(t1Cycle, 'watch--follow-up-4');
      assert.strictEqual(step.outcome, 'verification_failed', JSON.stringify(step));
      assert.strictEqual(step.reason_code, 'result_unverified');
    });

    await testAsync('4+5 a consequential correction with compliance REVIEW is queued for the owner, never executed', async () => {
      assert.strictEqual(stepOf(t1Cycle, 'watch--follow-up-5').outcome, 'approval_required');
      const pending = listPendingAutonomousApprovals({ businessId: ALPHA });
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].compliance_status, 'REVIEW');
      assert.strictEqual(pending[0].platform, 'shopify');
      assert.strictEqual(shop.writes.length, 0);
    });

    await testAsync('6 compliance BLOCK queues nothing', async () => {
      const step = stepOf(t1Cycle, 'watch--follow-up-6');
      assert.strictEqual(step.outcome, 'blocked');
      assert.strictEqual(step.reason_code, 'compliance_block');
      assert.ok(!listPendingAutonomousApprovals({ businessId: ALPHA }).some((item) => item.approval_id.includes('follow-up-6')));
    });

    // ---------------------------------------------------------------------------
    // 12, 16, 4 - the owner's decision, execution, verification, audit, persistence
    // ---------------------------------------------------------------------------
    let t1ApprovalId;
    await testAsync('12+16 a forged signature, or another business, cannot decide the approval', async () => {
      t1ApprovalId = listPendingAutonomousApprovals({ businessId: ALPHA })[0].approval_id;
      const record = storedRecord(t1ApprovalId, ALPHA);
      const forged = await resolveAutonomousApproval({ approvalId: t1ApprovalId, businessId: ALPHA, decision: 'approved', decidedBy: OWNER, now: T1, authorization: signApprovalWithForeignKey({ request: record, decidedBy: OWNER }) });
      assert.strictEqual(forged.reason_code, 'approval_verification_failed');
      const foreign = await resolveAutonomousApproval({ approvalId: t1ApprovalId, businessId: BETA, decision: 'approved', decidedBy: OWNER, now: T1, authorization: signApproval({ request: record, decidedBy: OWNER }) });
      assert.strictEqual(foreign.reason_code, 'approval_not_found');
      assert.strictEqual(shop.writes.length, 0);
    });

    await testAsync('4 approved -> executed once -> independently verified -> audited -> persisted -> remembered', async () => {
      const record = storedRecord(t1ApprovalId, ALPHA);
      const result = await resolveAutonomousApproval({ approvalId: t1ApprovalId, businessId: ALPHA, decision: 'approved', decidedBy: OWNER, now: T1, authorization: signApproval({ request: record, decidedBy: OWNER }) });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.execution.status, 'success', result.execution.error || '');
      assert.strictEqual(result.verification.status, 'verified');
      assert.deepStrictEqual(shop.writes, [{ productId: PRODUCT_ID, vendor: REVIEW_VENDOR }]);
      assert.strictEqual(executionVerification.getVerificationRecord(result.verification.idempotency_key, { businessId: ALPHA }).status, 'verified');
      const resolution = runHistoryStore.getRunRecordById(result.run_id);
      assert.strictEqual(resolution.kind, 'autonomous_approval_resolution');
      assert.ok(resolution.result.audit_trail.some((event) => /SUCCEEDED and was independently re-read/.test(event.summary)), 'the real correction integration ran and re-read');
      assert.ok(listMemoryRecords(ALPHA, { limit: 50 }).some((entry) => entry.id === `autonomy-${t1ApprovalId}`));
    });

    // ---------------------------------------------------------------------------
    // 13. Duplicate occurrence / idempotency
    // ---------------------------------------------------------------------------
    await testAsync('13 duplicates: the same window does nothing again, and an executed approval cannot be replayed', async () => {
      const again = await trigger(ALPHA, T1_SAME_WINDOW);
      assert.strictEqual(again.considered, 0);
      assert.strictEqual(ai.calls, 1);
      const record = storedRecord(t1ApprovalId, ALPHA);
      const replay = await resolveAutonomousApproval({ approvalId: t1ApprovalId, businessId: ALPHA, decision: 'approved', decidedBy: OWNER, now: T1, authorization: signApproval({ request: record, decidedBy: OWNER }) });
      assert.strictEqual(replay.reason_code, 'approval_not_pending');
      assert.strictEqual(shop.writes.length, 1);
    });

    // ---------------------------------------------------------------------------
    // NEXT CYCLE reads what was verified; 14 external execution failure
    // ---------------------------------------------------------------------------
    await testAsync('next cycle: the verified outcome from memory reaches the next capability', async () => {
      shop.stock[ALPHA] = 3;
      const cycle = await trigger(ALPHA, T2);
      assert.strictEqual(stepOf(cycle, 'watch--follow-up-1').outcome, 'executed');
      assert.ok(fieldsPassedTo(recordOf(cycle), 'business_configuration_retrieval').includes('relevant_memory'), 'memory from the verified action was passed on');
      // The follow-up asks for the vendor change test 4 already applied and verified. It is not
      // queued again - an approval for it could never execute - and the owner is not asked.
      const repeat = stepOf(cycle, 'watch--follow-up-5');
      assert.strictEqual(repeat.outcome, 'blocked', JSON.stringify(repeat));
      assert.strictEqual(repeat.reason_code, 'already_completed');
      assert.strictEqual(listPendingAutonomousApprovals({ businessId: ALPHA }).length, 0, 'an already-applied change is never queued for approval again');
    });

    await testAsync('14 external failure: a refused platform write is recorded as failed, never verified, never remembered, never retried', async () => {
      // A DISTINCT change (a different vendor value), queued exactly as the cycle queues one, so
      // the refused write is exercised on a change that has not already been verified.
      const approvalId = 'apr-matrix-refused-write';
      const prepared = prepareApprovalExecutionRequest('shopify_vendor_correction', {
        objective: 'Correct the vendor on the changed product.',
        category: 'products',
        tool_id: 'shopify_vendor_correction',
        specialist_id: 'product',
        is_shared_infrastructure: false,
        business_id: ALPHA,
        research_params: { content: DISTINCT_VENDOR, productId: PRODUCT_ID, newVendor: DISTINCT_VENDOR },
        autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-matrix-14', job_id: 'watch--follow-up-5', occurrence_key: T2.toISOString(), platform: 'shopify' },
      });
      assert.strictEqual(prepared.ok, true, prepared.reason);
      createAndPersistApprovalRequest({
        id: approvalId,
        classification: 'externally_executable',
        specialistId: 'product',
        toolId: 'shopify_vendor_correction',
        executionRequest: prepared.executionRequest,
        reason: 'Changes a real product record in the connected store.',
      });
      assert.ok(listPendingAutonomousApprovals({ businessId: ALPHA }).some((item) => item.approval_id === approvalId), 'a different intended state is not a duplicate');
      const record = storedRecord(approvalId, ALPHA);
      shop.failWrite = true;
      try {
        const result = await resolveAutonomousApproval({ approvalId, businessId: ALPHA, decision: 'approved', decidedBy: OWNER, now: T2, authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.execution.status, 'error');
        assert.strictEqual(result.verification.status, 'failed');
        assert.strictEqual(runHistoryStore.getRunRecordById(result.run_id).status, 'error');
        const retry = await resolveAutonomousApproval({ approvalId, businessId: ALPHA, decision: 'approved', decidedBy: OWNER, now: T2, authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(retry.reason_code, 'approval_not_pending');
      } finally {
        shop.failWrite = false;
      }
      assert.strictEqual(shop.writes.length, 1);
      assert.ok(!listMemoryRecords(ALPHA, { limit: 50 }).some((entry) => entry.id === `autonomy-${approvalId}`));
    });

    await testAsync('14 external failure: a failed platform read is recorded honestly and starts no follow-up', async () => {
      shop.failProductsRead = true;
      const aiBefore = ai.calls;
      try {
        shop.stock[ALPHA] = 9;
        const cycle = await trigger(ALPHA, T3);
        assert.deepStrictEqual(outcomesOf(cycle), { watch: 'observed' }, 'no follow-up may act on a change the monitor could not establish');
        assert.ok(JSON.stringify(getLatestSnapshot({ businessId: ALPHA, platform: 'shopify' })).includes('"failed"'));
      } finally {
        shop.failProductsRead = false;
      }
      assert.strictEqual(ai.calls, aiBefore);
    });

    // ---------------------------------------------------------------------------
    // 15b and 16 - a second business
    // ---------------------------------------------------------------------------
    await testAsync('16 isolation: one business\'s cycles never claim, observe or decide another\'s work', async () => {
      const alphaOccurrence = lastOccurrence(ALPHA, 'watch');
      assert.strictEqual(lastOccurrence(BETA, 'watch'), null, 'ALPHA\'s cycles never claimed BETA\'s job');
      assert.strictEqual(listSnapshots({ businessId: BETA, platform: 'shopify' }).length, 0, 'ALPHA\'s cycles never observed for BETA');

      await trigger(BETA, T0);
      shop.stock[BETA] = 0;
      const cycle = await trigger(BETA, T1);
      assert.strictEqual(stepOf(cycle, 'watch--follow-up-1').outcome, 'approval_required');
      assert.strictEqual(lastOccurrence(ALPHA, 'watch'), alphaOccurrence, 'BETA\'s cycles never claimed ALPHA\'s job');
      const betaPending = listPendingAutonomousApprovals({ businessId: BETA });
      assert.strictEqual(betaPending.length, 1);
      assert.ok(!listPendingAutonomousApprovals({ businessId: ALPHA }).some((item) => item.approval_id === betaPending[0].approval_id));
    });

    await testAsync('15b verification failure: a write the platform does not reflect is recorded as failed, not verified', async () => {
      const approvalId = listPendingAutonomousApprovals({ businessId: BETA })[0].approval_id;
      const record = storedRecord(approvalId, BETA);
      shop.ignoreWrite = true;
      try {
        const result = await resolveAutonomousApproval({ approvalId, businessId: BETA, decision: 'approved', decidedBy: OWNER, now: T1, authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.verification.verified, false);
        assert.strictEqual(result.verification.status, 'failed');
        assert.ok(runHistoryStore.getRunRecordById(result.run_id).result.audit_trail.some((event) => /independent re-read shows vendor=/.test(event.summary)), 'the real re-read disagreed');
      } finally {
        shop.ignoreWrite = false;
      }
      assert.ok(!listMemoryRecords(BETA, { limit: 50 }).some((entry) => entry.id === `autonomy-${approvalId}`));
    });

    // ---------------------------------------------------------------------------
    // 9. Disabled autonomy (business, kill switch) and non-durable storage
    // ---------------------------------------------------------------------------
    await testAsync('9 disabled autonomy: a business without autonomy, a closed kill switch, or non-durable storage starts nothing', async () => {
      scheduleEnabled(OFF, 'watch', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' });
      const off = await trigger(OFF, T0);
      assert.strictEqual(off.triggered, false);
      assert.strictEqual(off.reason_code, 'business_autonomy_disabled');
      assert.strictEqual(lastOccurrence(OFF, 'watch'), null);

      const before = lastOccurrence(ALPHA, 'watch');
      const killed = await trigger(ALPHA, T4, {});
      assert.strictEqual(killed.reason_code, 'kill_switch_off');
      const vercel = await trigger(ALPHA, T4, { ...ON, VERCEL: '1' });
      assert.strictEqual(vercel.reason_code, 'storage_not_durable');
      assert.strictEqual(lastOccurrence(ALPHA, 'watch'), before, 'a refused trigger never consumes an occurrence');
    });

    // ---------------------------------------------------------------------------
    // 10. Budget exceeded
    // ---------------------------------------------------------------------------
    await testAsync('10 budget exceeded: real spend already recorded today blocks the job before any read', async () => {
      runHistoryStore.saveRunRecord({
        run_id: 'budget-seed-run',
        business_id: BUDGET,
        kind: 'orchestrate',
        status: 'success',
        created_at: T0.toISOString(),
        result: { usage_summary: { run_id: 'budget-seed-run', business_id: BUDGET, total_events: 1, by_category: { model_call: { count: 1, tokens_input: 0, tokens_output: 50, tokens_total: 50 }, tool_call: { count: 0 } } } },
      });
      scheduleEnabled(BUDGET, 'watch', { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' });
      const cycle = await trigger(BUDGET, T0);
      assert.strictEqual(cycle.triggered, true, cycle.reason);
      assert.strictEqual(stepOf(cycle, 'watch').outcome, 'blocked');
      assert.strictEqual(stepOf(cycle, 'watch').reason_code, 'daily_budget_exhausted');
      assert.ok(!shop.reads.some((read) => read.businessId === BUDGET), 'nothing was read');
      assert.strictEqual(listSnapshots({ businessId: BUDGET, platform: 'shopify' }).length, 0);
    });

    // ---------------------------------------------------------------------------
    // 11. Permission denied
    // ---------------------------------------------------------------------------
    await testAsync('11 permission denied: an unavailable capability is refused at creation, and a tampered job is refused by the policy', async () => {
      const refused = createBusinessSchedule({ businessId: ALPHA, jobId: 'unavailable', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'verification', objective: 'Verify.', platform: null }, now: T0 });
      assert.strictEqual(refused.reason_code, 'tool_not_implemented');

      // Written straight to the store, bypassing management - the policy is the backstop.
      scheduleStore.saveScheduledJob(createScheduledJob({ jobId: 'tampered-permission', businessId: BUDGET, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'verification', objective: 'Verify.', platform: null }, now: T0 }));
      const cycle = await trigger(BUDGET, T1);
      const step = stepOf(cycle, 'tampered-permission');
      assert.strictEqual(step.outcome, 'blocked');
      // 'verification' carries no action classification, so the policy's compliance gate
      // (gate 3) refuses it before tool authorization (gate 4) is reached - either refusal is
      // the policy failing closed, and neither lets anything dispatch.
      assert.ok(['compliance_verdict_missing', 'unauthorized_tool'].includes(step.reason_code), `unexpected refusal: ${step.reason_code}`);
      assert.ok(!summariesOf(recordOf(cycle)).includes("Invoking tool 'verification'."), 'the Chief never dispatched it');
    });

    // ---------------------------------------------------------------------------
    // 7, 8. Unsupported and disabled platforms
    // ---------------------------------------------------------------------------
    await testAsync('7+8 unsupported and disabled platforms: no Amazon job can exist, a disabled Shopify job is refused, Etsy reports what it cannot read', async () => {
      const amazon = createBusinessSchedule({ businessId: ETSY, jobId: 'amazon', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'amazon' }, now: T0 });
      assert.strictEqual(amazon.reason_code, 'invalid_schedule');
      const disabled = createBusinessSchedule({ businessId: ETSY, jobId: 'shopify', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify' }, now: T0 });
      assert.strictEqual(disabled.reason_code, 'platform_not_enabled');

      scheduleStore.saveScheduledJob(createScheduledJob({ jobId: 'tampered-shopify', businessId: ETSY, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify' }, now: T0 }));
      scheduleEnabled(ETSY, 'etsy-listings', { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe Etsy listings.', platform: 'etsy' });

      const cycle = await trigger(ETSY, T0);
      assert.strictEqual(stepOf(cycle, 'tampered-shopify').outcome, 'blocked');
      assert.strictEqual(stepOf(cycle, 'tampered-shopify').reason_code, 'unauthorized_platform');
      assert.ok(!shop.reads.some((read) => read.businessId === ETSY), 'a disabled platform is never queried');

      assert.strictEqual(stepOf(cycle, 'etsy-listings').outcome, 'observed', JSON.stringify(stepOf(cycle, 'etsy-listings')));
      const snapshot = JSON.stringify(getLatestSnapshot({ businessId: ETSY, platform: 'etsy' }));
      assert.ok(snapshot.includes('"unsupported"'), 'capabilities Etsy cannot serve are recorded as unsupported, never as zero');
    });

    // ---------------------------------------------------------------------------
    // 12. Security: credentials never enter the loop
    // ---------------------------------------------------------------------------
    await testAsync('12 security: a credential-shaped parameter is refused at creation, and a tampered job file carrying one never runs', async () => {
      const refused = createBusinessSchedule({ businessId: ETSY, jobId: 'secret', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe.', platform: 'etsy', params: { api_key: 'nope' } }, now: T0 });
      assert.strictEqual(refused.reason_code, 'invalid_schedule');

      const businessDir = path.join(process.env.SCHEDULE_STORE_DIR, ETSY);
      const clean = createScheduledJob({ jobId: 'tampered-secret', businessId: ETSY, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe.', platform: 'etsy' }, now: T0 });
      fs.writeFileSync(path.join(businessDir, 'tampered-secret.json'), JSON.stringify(clean));
      assert.ok(scheduleStore.listDueJobs({ businessId: ETSY, now: T1 }).some((job) => job.job_id === 'tampered-secret'), 'control: the clean file is a real due job');

      fs.writeFileSync(path.join(businessDir, 'tampered-secret.json'), JSON.stringify({ ...clean, task: { ...clean.task, params: { access_token: 'stolen' } } }));
      assert.ok(!scheduleStore.listDueJobs({ businessId: ETSY, now: T1 }).some((job) => job.job_id === 'tampered-secret'));
      const cycle = await trigger(ETSY, T1);
      assert.ok(!cycle.steps.some((step) => step.job_id === 'tampered-secret'));
      assert.ok(!JSON.stringify(runHistoryStore.getRunRecordById(cycle.cycle_id)).includes('stolen'));
    });
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomyEndToEndMatrix.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
