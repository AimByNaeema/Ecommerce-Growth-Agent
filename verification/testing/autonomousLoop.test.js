'use strict';

// THE CONNECTED CONTROLLED-AUTONOMY LOOP, END TO END:
//
//   owner schedule -> trigger -> scheduler -> monitor -> detected change -> Chief capability
//   -> policy/permission/budget/compliance -> auto-safe analysis OR durable approval
//   -> owner's Ed25519 decision -> execute once -> independent verification -> audit
//   -> run record with usage -> verified memory -> next cycle reads it
//
// NO EXTERNAL API IS CALLED. Observation goes through a contract-conforming in-memory adapter,
// analysis through an injected executor, and the one Shopify write through a stub on the
// shared client object. global.fetch fails the suite if anything reaches for the network.
// Every gate is the real module with real persistence in temp directories.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHARED = {
  runs: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-runs-')),
  memory: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-memory-')),
};
process.env.RUN_HISTORY_STORE_DIR = SHARED.runs;
process.env.MEMORY_STORE_DIR = SHARED.memory;

// A real, temporary business whose own configuration enables Shopify - the Chief contract
// re-reads enablement at execution time, so an executing test needs one. Same convention as
// autonomyPolicy.test.js and businessIsolation.test.js: under the registry's fixed root,
// removed when this process exits.
const LOOP_BUSINESS = 'autonomy-loop-test-co';
const LOOP_BUSINESS_DIR = path.join(__dirname, '..', '..', 'configuration', 'businesses', LOOP_BUSINESS);
fs.mkdirSync(LOOP_BUSINESS_DIR, { recursive: true });
fs.writeFileSync(path.join(LOOP_BUSINESS_DIR, 'business.yaml'), [
  'business_name: "Autonomy Loop Test Co"',
  'business_model: "D2C"',
  'platform: "Shopify"',
  'product_model: "in-house"',
  'target_markets: ["US"]',
  'countries: ["US"]',
  'currencies: ["USD"]',
  'product_categories: ["home"]',
  'customer_segments: ["homeowners"]',
  'brand:',
  '  name: "Autonomy Loop Test Co"',
  'business_goals: ["grow"]',
  'marketing_channels: ["email"]',
  'enabled_platforms: [shopify]',
  '',
].join('\n'));
process.on('exit', () => fs.rmSync(LOOP_BUSINESS_DIR, { recursive: true, force: true }));

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { runAutonomousCycle, followUpTrigger } = require('../../autonomy/autonomousCycle');
const { triggerAutonomousCycle, checkDurableStorage } = require('../../autonomy/cycleTrigger');
const { parseArgs } = require('../../autonomy/runCycleCli');
const { resolveAutonomousApproval, listPendingAutonomousApprovals } = require('../../autonomy/approvalResolution');
const { createBusinessSchedule, setBusinessScheduleEnabled } = require('../../scheduler/scheduleManagement');
const { createScheduledJob, validateTask } = require('../../scheduler/scheduleModel');
const scheduleStore = require('../../scheduler/scheduleStore');
const approvalStore = require('../../approvals/approvalStore');
const { loadPendingApprovalRequests } = require('../../approvals/approvalWorkflow');
const executionVerification = require('../../reliability/executionVerification');
const { readDailyUsage } = require('../../agent/core/dailyUsageAccounting');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
const { getMaxPlanStepsPerRun } = require('../../agent/core/executionBounds');
const { AUTONOMY_KILL_SWITCH_ENV, evaluateAutonomyPolicy } = require('../../agent/core/autonomyPolicy');
const { signApproval } = require('./approvalSigningTestKey');

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

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

const PRODUCT_ID = 'gid://shopify/Product/1';
const NEW_VENDOR = 'Aurora Ceramics';
const BLOCKING_VENDOR = 'guaranteed copyright-free with no legal risk';
const T0 = new Date('2026-03-04T09:07:00.000Z');
const T1 = new Date('2026-03-04T10:07:00.000Z');
const T2 = new Date('2026-03-04T11:07:00.000Z');
const PASSING_DAILY = { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true };

function policyFor(businessId, overrides = {}) {
  return {
    ok: true,
    business_id: businessId,
    enabled_platforms: ['shopify'],
    autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 },
    ...overrides,
  };
}

async function withKillSwitch(value, fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  if (value === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
  else process.env[AUTONOMY_KILL_SWITCH_ENV] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

async function withRoots(fn) {
  const roots = {};
  for (const name of ['schedules', 'snapshots', 'circuits', 'verifications', 'approvals']) {
    roots[name] = fs.mkdtempSync(path.join(os.tmpdir(), `loop-${name}-`));
  }
  try {
    return await fn(roots);
  } finally {
    for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A contract-conforming adapter whose one product's stock is the only thing that varies.
function adapterWithStock(quantity) {
  return {
    UNSUPPORTED_READ_CAPABILITIES: [],
    isConfigured: () => true,
    getShopInfo: async () => ({ name: 'Demo', domain: 'demo.example', email: null }),
    getProducts: async () => [{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: quantity > 0, inventory_quantity: quantity }] }],
    getOrders: async () => [{}, {}],
    getCustomers: async () => [],
    getInventoryLevels: async () => [],
    getCollections: async () => [],
  };
}

function recordingExecutor(calls) {
  return async (executionRequest) => {
    calls.push({ tool_id: executionRequest.tool_id, research_params: executionRequest.research_params });
    return { status: 'success', data: { ok: true }, error: null, classification: 'analysis_only' };
  };
}

function cycleOptions(roots, businessId, overrides = {}) {
  return {
    businessId,
    now: T0,
    enabledPlatforms: ['shopify'],
    businessPolicy: policyFor(businessId),
    dailyUsage: PASSING_DAILY,
    scheduleRootDir: roots.schedules,
    snapshotRootDir: roots.snapshots,
    circuitRootDir: roots.circuits,
    verificationRootDir: roots.verifications,
    approvalRootDir: roots.approvals,
    runHistoryStoreDir: SHARED.runs,
    adapter: adapterWithStock(5),
    ...overrides,
  };
}

function saveJob(roots, { jobId, businessId, task, enabled = true }) {
  scheduleStore.saveScheduledJob(
    createScheduledJob({ jobId, businessId, enabled, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0 }),
    { rootDir: roots.schedules }
  );
}

function vendorParams(newVendor = NEW_VENDOR, content = NEW_VENDOR) {
  return { content, productId: PRODUCT_ID, newVendor };
}

async function withMockedShopify({ rereadVendor = NEW_VENDOR } = {}, fn) {
  const savedUpdate = shopifyClient.updateProductVendor;
  const savedGet = shopifyClient.getProducts;
  const calls = [];
  shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
    calls.push({ productId, vendor });
    return { id: productId, vendor };
  };
  shopifyClient.getProducts = async () => [{ id: PRODUCT_ID, vendor: rereadVendor, title: 'Mug' }];
  try {
    return await fn(calls);
  } finally {
    shopifyClient.updateProductVendor = savedUpdate;
    shopifyClient.getProducts = savedGet;
  }
}

const stepFor = (cycle, jobId) => cycle.steps.find((step) => step.job_id === jobId);

(async () => {
  // -------------------------------------------------------------------------------
  // Budget accounting: a cycle can no longer block the cycles after it
  // -------------------------------------------------------------------------------

  await testAsync('a cycle records its usage, so the next cycle is not blocked by unknown spend', async () => {
    await withRoots(async (roots) => {
      const business = 'usage-co';
      saveJob(roots, { jobId: 'observe', businessId: business, task: { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' } });
      await withKillSwitch('true', async () => {
        const first = await runAutonomousCycle(cycleOptions(roots, business, { dailyUsage: null }));
        assert.strictEqual(stepFor(first, 'observe').outcome, 'observed');
        assert.ok(first.record.result.usage_summary && first.record.result.usage_summary.by_category, 'the cycle record must carry a usage ledger summary');
        assert.strictEqual(first.record.result.usage_summary.by_category.tool_call.count, 1, 'the observation read is counted');

        const daily = readDailyUsage({ businessId: business, now: T0 });
        assert.strictEqual(daily.coverage_complete, true, 'the day stays measurable after a cycle');

        const second = await runAutonomousCycle(cycleOptions(roots, business, { dailyUsage: null, now: T1 }));
        assert.strictEqual(stepFor(second, 'observe').outcome, 'observed', `second cycle blocked: ${stepFor(second, 'observe').reason_code}`);
      });
    });
  });

  await testAsync('control: a run with no usage ledger really does block the daily gate', async () => {
    const business = 'gamma-co';
    runHistoryStore.saveRunRecord({ run_id: 'uninstrumented-run', business_id: business, status: 'success', created_at: T0.toISOString(), result: {} });
    await withKillSwitch('true', async () => {
      const decision = evaluateAutonomyPolicy({
        businessId: business,
        specialistId: 'product',
        toolId: 'product_data_retrieval',
        platform: 'shopify',
        complianceVerdict: 'not_applicable',
        humanApproval: null,
        now: T0,
        businessPolicy: policyFor(business),
      });
      assert.strictEqual(decision.reason_code, 'daily_budget_unverifiable');
    });
  });

  // -------------------------------------------------------------------------------
  // Approval queueing: the same refusals and compliance input as the Chief
  // -------------------------------------------------------------------------------

  await testAsync('a queued correction approval carries the compliance input its execution re-verifies', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'fix-vendor', businessId: 'alpha-co', task: { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: 'shopify', params: vendorParams() } });
      const calls = [];
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls) }));
        assert.strictEqual(stepFor(cycle, 'fix-vendor').outcome, 'approval_required');
      });
      const pending = loadPendingApprovalRequests({ storeDir: roots.approvals });
      assert.strictEqual(pending.length, 1);
      assert.ok(pending[0].execution_request.compliance_input, 'compliance input must be attached before the human signs');
      assert.ok(['PASS', 'REVIEW'].includes(pending[0].execution_request.compliance.compliance_status));
      assert.strictEqual(pending[0].execution_request.autonomy.origin, 'autonomous_cycle');
      assert.strictEqual(pending[0].execution_request.autonomy.platform, 'shopify', 'the signed request names the platform it acts on');
      assert.strictEqual(pending[0].execution_request.autonomy.job_id, 'fix-vendor');
      assert.deepStrictEqual(calls, [], 'nothing consequential reaches the executor');
    });
  });

  await testAsync('compliance BLOCK on the written value queues no approval at all', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'fix-vendor', businessId: 'alpha-co', task: { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: 'shopify', params: vendorParams(BLOCKING_VENDOR, NEW_VENDOR) } });
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, 'alpha-co'));
        const step = stepFor(cycle, 'fix-vendor');
        assert.strictEqual(step.outcome, 'blocked');
        assert.strictEqual(step.reason_code, 'compliance_block');
        assert.strictEqual(step.approval_request_id, null);
      });
      assert.strictEqual(loadPendingApprovalRequests({ storeDir: roots.approvals }).length, 0);
    });
  });

  await testAsync('a correction that does not state what it writes queues no approval', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'fix-vendor', businessId: 'alpha-co', task: { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: 'shopify', params: { content: NEW_VENDOR } } });
      await withKillSwitch('true', async () => {
        const step = stepFor(await runAutonomousCycle(cycleOptions(roots, 'alpha-co')), 'fix-vendor');
        assert.strictEqual(step.outcome, 'blocked');
        assert.strictEqual(step.reason_code, 'compliance_unevaluable');
      });
      assert.strictEqual(loadPendingApprovalRequests({ storeDir: roots.approvals }).length, 0);
    });
  });

  await testAsync('a correction with no explicit instruction to mutate queues no approval', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'fix-vendor', businessId: 'alpha-co', task: { tool_id: 'shopify_vendor_correction', objective: 'Review the product vendor field.', platform: 'shopify', params: vendorParams() } });
      await withKillSwitch('true', async () => {
        const step = stepFor(await runAutonomousCycle(cycleOptions(roots, 'alpha-co')), 'fix-vendor');
        assert.strictEqual(step.outcome, 'blocked');
        assert.strictEqual(step.reason_code, 'mutation_intent_missing');
      });
      assert.strictEqual(loadPendingApprovalRequests({ storeDir: roots.approvals }).length, 0);
    });
  });

  // -------------------------------------------------------------------------------
  // Monitoring -> Chief: follow-ups only on a real, established change
  // -------------------------------------------------------------------------------

  test('the follow-up trigger preserves incomplete-observation semantics', () => {
    assert.strictEqual(followUpTrigger(null).reason_code, 'no_observation');
    assert.strictEqual(followUpTrigger({ baseline: true, counts: { added: 1 } }).reason_code, 'baseline_observation');
    assert.strictEqual(followUpTrigger({ identical: true, counts: { changed: 1 } }).reason_code, 'no_change');
    assert.strictEqual(followUpTrigger({ counts: { added: 0, removed: 0, changed: 0 }, capabilities: [{ status: 'compared' }] }).reason_code, 'no_change');
    assert.strictEqual(followUpTrigger({ counts: { changed: 2 }, capabilities: [{ status: 'not_comparable' }] }).reason_code, 'not_comparable');
    assert.strictEqual(followUpTrigger({ counts: { changed: 2 }, capabilities: [{ status: 'compared_partial' }] }).triggered, true);
  });

  test('follow-up declarations are validated and can never pre-declare a detected change', () => {
    const base = { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify' };
    assert.strictEqual(validateTask({ ...base, follow_ups: [{ tool_id: 'listing_quality_check', objective: 'Check.' }] }).valid, true);
    const invalid = [
      { follow_ups: 'listing_quality_check' },
      { follow_ups: [{ tool_id: 'not_a_tool', objective: 'x' }] },
      { follow_ups: [{ tool_id: 'listing_quality_check' }] },
      { follow_ups: [{ tool_id: 'listing_quality_check', objective: 'x', platform: 'etsy' }] },
      { follow_ups: [{ tool_id: 'listing_quality_check', objective: 'x', follow_ups: [] }] },
      { follow_ups: [{ tool_id: 'listing_quality_check', objective: 'x', params: { detected_changes: { counts: { changed: 99 } } } }] },
      { follow_ups: [{ tool_id: 'listing_quality_check', objective: 'x', params: { relevant_memory: [] } }] },
      { follow_ups: [{ tool_id: 'listing_quality_check', objective: 'x', params: { api_key: 'nope' } }] },
      { follow_ups: Array.from({ length: getMaxPlanStepsPerRun() + 1 }, () => ({ tool_id: 'listing_quality_check', objective: 'x' })) },
    ];
    for (const extra of invalid) {
      assert.strictEqual(validateTask({ ...base, ...extra }).valid, false, `should be invalid: ${JSON.stringify(extra).slice(0, 80)}`);
    }
  });

  await testAsync('a first observation and an unchanged one start no follow-up', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'observe', businessId: 'alpha-co', task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify', follow_ups: [{ tool_id: 'listing_quality_check', objective: 'Check listing quality.' }] } });
      const calls = [];
      await withKillSwitch('true', async () => {
        const baseline = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls) }));
        assert.strictEqual(baseline.steps.length, 1);
        const unchanged = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls), now: T1 }));
        assert.strictEqual(unchanged.steps.length, 1);
      });
      assert.deepStrictEqual(calls, [], 'no change means no follow-up work and no spend');
    });
  });

  await testAsync('a real change runs the declared analysis through the Chief path with the monitor\'s own change', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'observe', businessId: 'alpha-co', task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify', follow_ups: [{ tool_id: 'listing_quality_check', objective: 'Check listing quality.' }] } });
      const calls = [];
      await withKillSwitch('true', async () => {
        await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls) }));
        const changed = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls), now: T1, adapter: adapterWithStock(0) }));
        const observed = stepFor(changed, 'observe');
        const followUp = stepFor(changed, 'observe--follow-up-1');
        assert.strictEqual(observed.outcome, 'observed');
        assert.ok(followUp, 'the follow-up step must be reported');
        assert.strictEqual(followUp.outcome, 'executed');
        assert.strictEqual(followUp.parent_job_id, 'observe');
        assert.ok(changed.record.result.steps.some((step) => step.parent_job_id === 'observe'));

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].tool_id, 'listing_quality_check');
        const detected = calls[0].research_params.detected_changes;
        assert.strictEqual(detected.current_snapshot_id, observed.changes.current_snapshot_id);
        assert.deepStrictEqual(detected.counts, observed.changes.counts);
        assert.strictEqual(detected.changes_included, true);
        assert.ok(detected.counts.changed > 0);
      });
    });
  });

  await testAsync('a consequential follow-up is queued for approval and never executed', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, {
        jobId: 'observe',
        businessId: 'alpha-co',
        task: {
          tool_id: 'product_data_retrieval',
          objective: 'Observe.',
          platform: 'shopify',
          follow_ups: [{ tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the changed product.', params: vendorParams() }],
        },
      });
      const calls = [];
      await withKillSwitch('true', async () => {
        await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls) }));
        const changed = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { executor: recordingExecutor(calls), now: T1, adapter: adapterWithStock(0) }));
        const step = stepFor(changed, 'observe--follow-up-1');
        assert.strictEqual(step.outcome, 'approval_required');
        assert.strictEqual(step.executed, false);
      });
      assert.deepStrictEqual(calls, []);
      const pending = loadPendingApprovalRequests({ storeDir: roots.approvals });
      assert.strictEqual(pending.length, 1);
      assert.ok(pending[0].execution_request.research_params.detected_changes, 'the human signs over the change that prompted the action');
    });
  });

  await testAsync('an observation cannot be a follow-up, so one change cannot fan out', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'observe', businessId: 'alpha-co', task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify', follow_ups: [{ tool_id: 'collection_data_retrieval', objective: 'Observe again.' }] } });
      await withKillSwitch('true', async () => {
        await runAutonomousCycle(cycleOptions(roots, 'alpha-co'));
        const changed = await runAutonomousCycle(cycleOptions(roots, 'alpha-co', { now: T1, adapter: adapterWithStock(0) }));
        assert.strictEqual(stepFor(changed, 'observe--follow-up-1').reason_code, 'follow_up_not_actionable');
      });
    });
  });

  // -------------------------------------------------------------------------------
  // The production trigger: can only ever refuse, and never consumes an occurrence doing so
  // -------------------------------------------------------------------------------

  await testAsync('the trigger refuses on non-durable storage, a closed or malformed kill switch, or disabled autonomy', async () => {
    await withRoots(async (roots) => {
      saveJob(roots, { jobId: 'observe', businessId: 'alpha-co', task: { tool_id: 'product_data_retrieval', objective: 'Observe.', platform: 'shopify' } });
      const options = { businessId: 'alpha-co', now: T0, businessPolicy: policyFor('alpha-co'), cycleOptions: cycleOptions(roots, 'alpha-co') };

      assert.strictEqual(checkDurableStorage({ VERCEL: '1' }).durable, false);
      assert.strictEqual(checkDurableStorage({}).durable, true);

      const cases = [
        [{ ...options, env: { VERCEL: '1', [AUTONOMY_KILL_SWITCH_ENV]: 'true' } }, 'storage_not_durable'],
        [{ ...options, env: {} }, 'kill_switch_off'],
        [{ ...options, env: { [AUTONOMY_KILL_SWITCH_ENV]: 'false' } }, 'kill_switch_off'],
        [{ ...options, env: { [AUTONOMY_KILL_SWITCH_ENV]: 'maybe' } }, 'kill_switch_malformed'],
        [{ ...options, env: { [AUTONOMY_KILL_SWITCH_ENV]: 'true' }, businessPolicy: policyFor('alpha-co', { autonomy: { enabled: false, daily_token_budget: null, daily_run_budget: null } }) }, 'business_autonomy_disabled'],
        [{ ...options, env: { [AUTONOMY_KILL_SWITCH_ENV]: 'true' }, businessPolicy: { ok: false, reason_code: 'policy_data_malformed' } }, 'policy_data_malformed'],
      ];
      for (const [input, expected] of cases) {
        const result = await triggerAutonomousCycle(input);
        assert.strictEqual(result.triggered, false);
        assert.strictEqual(result.reason_code, expected);
      }
      const job = scheduleStore.loadScheduledJob('observe', { businessId: 'alpha-co', rootDir: roots.schedules });
      assert.strictEqual(job.last_occurrence_key, null, 'a refused trigger must not consume the occurrence');
    });
  });

  test('the CLI accepts only an explicit business argument', () => {
    assert.strictEqual(parseArgs(['--business', 'alpha-co']).businessId, 'alpha-co');
    assert.strictEqual(parseArgs([]).businessId, null);
    assert.ok(parseArgs(['--business']).errors.length > 0);
    assert.ok(parseArgs(['--enable-autonomy']).errors.length > 0);
  });

  // -------------------------------------------------------------------------------
  // THE WHOLE LOOP
  // -------------------------------------------------------------------------------

  await testAsync('end to end: schedule -> observe -> change -> analysis + approval -> signed -> executed once -> verified -> memory -> next cycle', async () => {
    await withRoots(async (roots) => {
      const business = LOOP_BUSINESS;
      const policy = policyFor(business);
      const env = { [AUTONOMY_KILL_SWITCH_ENV]: 'true' };
      const calls = [];
      const baseCycle = (overrides) => ({ ...cycleOptions(roots, business, { executor: recordingExecutor(calls) }), dailyUsage: null, ...overrides });

      // 1. The owner declares the schedule explicitly. It is saved disabled.
      const created = createBusinessSchedule({
        businessId: business,
        jobId: 'watch-catalogue',
        schedule: { kind: 'interval_minutes', every: 60 },
        task: {
          tool_id: 'product_data_retrieval',
          objective: 'Observe the catalogue.',
          platform: 'shopify',
          follow_ups: [
            { tool_id: 'listing_quality_check', objective: 'Check listing quality on the changed products.' },
            { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the changed product.', params: vendorParams() },
          ],
        },
        now: T0,
        rootDir: roots.schedules,
        businessPolicy: policy,
      });
      assert.strictEqual(created.ok, true, created.reason);
      assert.strictEqual(created.job.enabled, false);

      await withKillSwitch('true', async () => {
        const whileDisabled = await triggerAutonomousCycle({ businessId: business, now: T0, env, businessPolicy: policy, cycleOptions: baseCycle({}) });
        assert.strictEqual(whileDisabled.considered, 0, 'a disabled schedule does nothing');

        assert.strictEqual(setBusinessScheduleEnabled({ businessId: business, jobId: 'watch-catalogue', enabled: true, rootDir: roots.schedules, businessPolicy: policy }).ok, true);

        // 2. Baseline observation. No change can be claimed, so nothing follows.
        const baseline = await triggerAutonomousCycle({ businessId: business, now: T0, env, businessPolicy: policy, cycleOptions: baseCycle({}) });
        assert.deepStrictEqual(baseline.steps.map((step) => step.outcome), ['observed']);

        // 3. A real change: the analysis runs, the correction is queued - nothing written.
        const changed = await triggerAutonomousCycle({ businessId: business, now: T1, env, businessPolicy: policy, cycleOptions: baseCycle({ now: T1, adapter: adapterWithStock(0) }) });
        const outcomes = Object.fromEntries(changed.steps.map((step) => [step.job_id, step.outcome]));
        assert.deepStrictEqual(outcomes, {
          'watch-catalogue': 'observed',
          'watch-catalogue--follow-up-1': 'executed',
          'watch-catalogue--follow-up-2': 'approval_required',
        });
        assert.deepStrictEqual(calls.map((call) => call.tool_id), ['listing_quality_check']);

        const pending = listPendingAutonomousApprovals({ businessId: business, storeDir: roots.approvals });
        assert.strictEqual(pending.length, 1);
        const approvalId = pending[0].approval_id;

        // 4. The OWNER signs. Nothing in the agent can perform this step.
        const stored = approvalStore.loadApprovalRecord(approvalId, { expectedBusinessId: business, storeDir: roots.approvals }).approval_request;
        const authorization = signApproval({ request: stored, decision: 'approved', decidedBy: 'owner@example.com' });

        await withMockedShopify({}, async (shopifyCalls) => {
          const resolution = await resolveAutonomousApproval({
            approvalId,
            businessId: business,
            decision: 'approved',
            decidedBy: 'owner@example.com',
            authorization,
            now: T1,
            approvalStoreDir: roots.approvals,
            verificationRootDir: roots.verifications,
            circuitRootDir: roots.circuits,
          });
          assert.strictEqual(resolution.ok, true, resolution.reason);
          assert.strictEqual(resolution.execution.status, 'success', resolution.execution.error || '');
          assert.strictEqual(resolution.verification.status, 'verified');
          assert.deepStrictEqual(shopifyCalls, [{ productId: PRODUCT_ID, vendor: NEW_VENDOR }]);

          // 5. Verified, audited, recorded with usage, and remembered.
          const verificationRecord = executionVerification.getVerificationRecord(resolution.verification.idempotency_key, { businessId: business, rootDir: roots.verifications });
          assert.strictEqual(verificationRecord.status, 'verified');
          const runRecord = runHistoryStore.getRunRecordById(resolution.run_id);
          assert.strictEqual(runRecord.kind, 'autonomous_approval_resolution');
          assert.ok(runRecord.result.usage_summary.by_category);
          assert.ok(runRecord.result.audit_trail.length > 0);
          assert.ok(listMemoryRecords(business, { limit: 50 }).some((record) => record.id === `autonomy-${approvalId}`), 'the verified outcome must reach memory');

          // 6. It cannot be replayed.
          const replay = await resolveAutonomousApproval({
            approvalId,
            businessId: business,
            decision: 'approved',
            decidedBy: 'owner@example.com',
            authorization,
            approvalStoreDir: roots.approvals,
            verificationRootDir: roots.verifications,
            circuitRootDir: roots.circuits,
          });
          assert.strictEqual(replay.ok, false);
          assert.strictEqual(replay.reason_code, 'approval_not_pending');
          assert.strictEqual(shopifyCalls.length, 1, 'executed exactly once');
        });

        // 7. Same window again: nothing re-runs and nothing is re-queued.
        const sameWindow = await triggerAutonomousCycle({ businessId: business, now: new Date('2026-03-04T10:52:00.000Z'), env, businessPolicy: policy, cycleOptions: baseCycle({ now: new Date('2026-03-04T10:52:00.000Z'), adapter: adapterWithStock(0) }) });
        assert.strictEqual(sameWindow.considered, 0);
        assert.strictEqual(listPendingAutonomousApprovals({ businessId: business, storeDir: roots.approvals }).length, 0);

        // 8. NEXT CYCLE: another change, and the analysis now receives what was verified.
        calls.length = 0;
        const next = await triggerAutonomousCycle({ businessId: business, now: T2, env, businessPolicy: policy, cycleOptions: baseCycle({ now: T2, adapter: adapterWithStock(3) }) });
        assert.ok(next.steps.some((step) => step.job_id === 'watch-catalogue--follow-up-1' && step.outcome === 'executed'));
        const memory = calls[0].research_params.relevant_memory;
        assert.ok(Array.isArray(memory) && memory.some((entry) => entry.summary.includes(approvalId)), 'the next cycle must see the verified outcome');
        // The new occurrence asks for the vendor change that was just applied and verified, so it is
        // not queued again - an approval for it could never execute.
        assert.ok(next.steps.some((step) => step.job_id === 'watch-catalogue--follow-up-2' && step.outcome === 'blocked' && step.reason_code === 'already_completed'));
        assert.strictEqual(listPendingAutonomousApprovals({ businessId: business, storeDir: roots.approvals }).length, 0, 'an already-applied change is not queued again');

        // 9. The day's spend stays measurable across every autonomous run.
        assert.strictEqual(readDailyUsage({ businessId: business, now: T2 }).coverage_complete, true);
      });
    });
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomousLoop.test.js'));
  });

  for (const dir of Object.values(SHARED)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
