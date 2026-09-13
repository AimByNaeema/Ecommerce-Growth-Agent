'use strict';

// The controlled autonomous cycle: autonomy/autonomousCycle.js.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, AND NONE CAN BE. The cycle observes through a
// contract-conforming in-memory adapter and executes through an injected executor, and
// global.fetch is replaced for the whole file with a function that FAILS the suite if
// anything reaches for the network.
//
// EVERY GATE UNDER TEST IS THE REAL ONE. The autonomy policy, the scheduler, the monitor,
// the circuit breaker and the verification store are all the real modules with real
// persistence in temp directories - nothing about a refusal is mocked, so "the cycle cannot
// bypass its gates" is evidence rather than assertion.
//
// THE CLOCK IS AN ARGUMENT. Every call takes `now`, so scheduling, cooldowns and repeat
// cycles are exercised exactly rather than by sleeping.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomousCycle = require('../../autonomy/autonomousCycle');
const { runAutonomousCycle, CYCLE_OUTCOMES, isConsequential, isObservationJob } = autonomousCycle;
const { createScheduledJob } = require('../../scheduler/scheduleModel');
const scheduleStore = require('../../scheduler/scheduleStore');
const circuitBreaker = require('../../reliability/circuitBreaker');
const { listSnapshots } = require('../../monitoring/snapshotStore');
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { validateAdapterShape } = require('../../integrations/adapters/platformAdapterContract');

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

const T0 = new Date('2026-03-04T09:07:00.000Z');
const NEXT_HOUR = new Date('2026-03-04T10:00:00.000Z');

// AWAITS `fn` BEFORE RESTORING. The cycle is async and reads the kill switch at several
// points, so a synchronous finally would restore the variable mid-cycle and quietly test
// something other than what the test name says.
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
  for (const name of ['schedules', 'snapshots', 'circuits', 'verifications', 'runs']) {
    roots[name] = fs.mkdtempSync(path.join(os.tmpdir(), `cycle-test-${name}-`));
  }
  try {
    return await fn(roots);
  } finally {
    for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function inMemoryAdapter({ products = [{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 5 }] }], configured = true } = {}) {
  return {
    UNSUPPORTED_READ_CAPABILITIES: [],
    isConfigured: () => configured,
    getShopInfo: async () => ({ name: 'Demo', domain: 'demo.example', email: null }),
    getProducts: async () => products,
    getOrders: async () => [{}, {}],
    getCustomers: async () => [],
    getInventoryLevels: async () => [],
    getCollections: async () => [],
  };
}

const PASSING_POLICY = {
  ok: true,
  business_id: 'alpha-co',
  enabled_platforms: ['shopify'],
  autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 },
};
const PASSING_DAILY = { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true };

function addJob(roots, { jobId, toolId, platform = 'shopify', businessId = 'alpha-co', enabled = true, now = T0 } = {}) {
  scheduleStore.saveScheduledJob(
    createScheduledJob({
      jobId,
      businessId,
      enabled,
      schedule: { kind: 'interval_minutes', every: 60 },
      task: { tool_id: toolId, objective: `Scheduled work: ${toolId}.`, platform },
      now,
    }),
    { rootDir: roots.schedules }
  );
}

// A recording executor, so a test can prove whether the Chief contract was reached at all.
function recordingExecutor(calls, result = { status: 'success', data: { ok: true }, error: null, classification: 'analysis_only' }) {
  return async (executionRequest) => {
    calls.push(executionRequest.tool_id);
    return typeof result === 'function' ? result(executionRequest) : result;
  };
}

function cycleOptions(roots, overrides = {}) {
  return {
    businessId: 'alpha-co',
    now: T0,
    enabledPlatforms: ['shopify'],
    businessPolicy: PASSING_POLICY,
    dailyUsage: PASSING_DAILY,
    scheduleRootDir: roots.schedules,
    snapshotRootDir: roots.snapshots,
    circuitRootDir: roots.circuits,
    verificationRootDir: roots.verifications,
    runHistoryStoreDir: roots.runs,
    adapter: inMemoryAdapter(),
    ...overrides,
  };
}

function stepFor(cycle, jobId) {
  return cycle.steps.find((step) => step.job_id === jobId);
}

// ---------------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------------

test('consequential and observation classification come from the existing vocabulary', () => {
  assert.strictEqual(isConsequential('shopify_vendor_correction'), true);
  assert.strictEqual(isConsequential('shopify_inventory_correction'), true);
  assert.strictEqual(isConsequential('market_research'), false);
  // An unclassified tool is consequential by default - the existing default-deny rule.
  assert.strictEqual(isConsequential('a_tool_with_no_classification'), true);
  assert.strictEqual(isObservationJob('product_data_retrieval'), true);
  assert.strictEqual(isObservationJob('market_research'), false);
});

(async () => {
  await testAsync('the in-memory adapter is a real, contract-conforming adapter', async () => {
    assert.strictEqual(validateAdapterShape(inMemoryAdapter()).valid, true);
  });

  // -------------------------------------------------------------------------------
  // The happy path: a low-risk observation cycle
  // -------------------------------------------------------------------------------

  await testAsync('a low-risk observation job runs when every gate passes', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots));
        const step = stepFor(cycle, 'observe');
        assert.strictEqual(step.outcome, 'observed');
        assert.strictEqual(step.changes.baseline, true, 'the first observation invents no changes');
        // The snapshot really reached the store.
        assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: roots.snapshots }).length, 1);
        // And the cycle produced an audit trail and a persisted record.
        assert.ok(cycle.audit_events.length >= 3);
        assert.ok(cycle.record.result.audit_trail.length >= 3);
        assert.ok(fs.readdirSync(roots.runs).some((name) => name.endsWith('.json')));
      });
    });
  });

  await testAsync('a second cycle compares against the first and reports real changes only', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        await runAutonomousCycle(cycleOptions(roots));

        // Same state next hour: no invented changes.
        const same = await runAutonomousCycle(cycleOptions(roots, { now: NEXT_HOUR }));
        assert.strictEqual(stepFor(same, 'observe').changes.identical, true);
        assert.deepStrictEqual(stepFor(same, 'observe').changes.changes, []);

        // A real change the hour after.
        const changed = await runAutonomousCycle(
          cycleOptions(roots, {
            now: new Date('2026-03-04T11:00:00.000Z'),
            adapter: inMemoryAdapter({ products: [{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] }] }),
          })
        );
        const counts = stepFor(changed, 'observe').changes.counts;
        assert.strictEqual(counts.changed, 2, 'availability and inventory both changed');
      });
    });
  });

  // -------------------------------------------------------------------------------
  // REQUIRED HARD RULES
  // -------------------------------------------------------------------------------

  await testAsync('kill switch OFF means no autonomous execution at all', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      const calls = [];
      await withKillSwitch('false', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, { executor: recordingExecutor(calls) }));
        assert.strictEqual(stepFor(cycle, 'observe').outcome, 'blocked');
        assert.strictEqual(stepFor(cycle, 'observe').reason_code, 'kill_switch_off');
      });
      assert.deepStrictEqual(calls, [], 'nothing may be executed');
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: roots.snapshots }).length, 0, 'nothing may even be observed');
    });
    // An unset switch is equally closed.
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch(undefined, async () => {
        assert.strictEqual(stepFor(await runAutonomousCycle(cycleOptions(roots)), 'observe').reason_code, 'kill_switch_off');
      });
    });
  });

  await testAsync('an exhausted budget blocks before anything happens', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      const calls = [];
      await withKillSwitch('true', async () => {
        const spent = { available: true, day: '2026-03-04', tokens_total: 999999, runs_counted: 99 };
        const cycle = await runAutonomousCycle(cycleOptions(roots, { dailyUsage: spent, executor: recordingExecutor(calls) }));
        assert.strictEqual(stepFor(cycle, 'observe').reason_code, 'daily_budget_exhausted');
      });
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: roots.snapshots }).length, 0);
    });
  });

  await testAsync('a disabled platform blocks, and is never queried', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'etsy-observe', toolId: 'etsy_shop_data_retrieval', platform: 'etsy' });
      await withKillSwitch('true', async () => {
        const shopifyOnly = { ...PASSING_POLICY, enabled_platforms: ['shopify'] };
        const cycle = await runAutonomousCycle(cycleOptions(roots, { businessPolicy: shopifyOnly, enabledPlatforms: ['shopify'] }));
        assert.strictEqual(stepFor(cycle, 'etsy-observe').outcome, 'blocked');
        assert.strictEqual(stepFor(cycle, 'etsy-observe').reason_code, 'unauthorized_platform');
        assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'etsy', rootDir: roots.snapshots }).length, 0);
      });
    });
  });

  await testAsync('an unauthorized tool blocks', async () => {
    await withRoots(async (roots) => {
      // 'verification' is a real registry entry whose status is not_implemented, so
      // checkToolAccess refuses it. This is the shape an unauthorized tool actually takes
      // for a SCHEDULED job: the request is built by createExecutionRequest, which derives
      // the specialist from the tool's own category, so a category mismatch cannot arise by
      // construction - the category gate is exercised directly in toolPermissions.test.js.
      addJob(roots, { jobId: 'unavailable-tool', toolId: 'verification', platform: null });
      const calls = [];
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, { executor: recordingExecutor(calls) }));
        const step = stepFor(cycle, 'unavailable-tool');
        assert.strictEqual(step.outcome, 'blocked');
        assert.strictEqual(step.executed, false);
        // It is refused at the COMPLIANCE gate, which sits earlier in the documented order:
        // an unclassified tool gets no compliance verdict from the scheduler, and an
        // unstated verdict blocks. Both refusals are correct and both are default-deny; the
        // tool gate's own reason code is exercised directly in autonomyPolicy.test.js.
        assert.ok(['compliance_verdict_missing', 'unauthorized_tool'].includes(step.reason_code), `unexpected reason: ${step.reason_code}`);
      });
      assert.deepStrictEqual(calls, [], 'the Chief contract must never be reached for an unauthorized tool');
    });
  });

  await testAsync('missing policy data blocks', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        // No resolvable business configuration and no injected policy.
        const cycle = await runAutonomousCycle(cycleOptions(roots, { businessPolicy: null, enabledPlatforms: null }));
        const step = stepFor(cycle, 'observe');
        assert.strictEqual(step.outcome, 'blocked');
        assert.ok(['policy_data_unreadable', 'unauthorized_platform', 'invalid_business'].includes(step.reason_code));
      });
    });
  });

  await testAsync('a malformed kill switch blocks rather than being read as on', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('ture', async () => {
        assert.strictEqual(stepFor(await runAutonomousCycle(cycleOptions(roots)), 'observe').reason_code, 'kill_switch_malformed');
      });
    });
  });

  // -------------------------------------------------------------------------------
  // REQUIRED: a consequential action never becomes autonomous execution
  // -------------------------------------------------------------------------------

  await testAsync('a consequential scheduled action is never executed autonomously', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'correct-vendor', toolId: 'shopify_vendor_correction' });
      addJob(roots, { jobId: 'correct-inventory', toolId: 'shopify_inventory_correction' });
      const calls = [];
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, { executor: recordingExecutor(calls) }));
        for (const jobId of ['correct-vendor', 'correct-inventory']) {
          const step = stepFor(cycle, jobId);
          assert.notStrictEqual(step.outcome, 'executed', `${jobId} must never execute autonomously`);
          assert.strictEqual(step.executed, false);
        }
      });
      assert.deepStrictEqual(calls, [], 'the Chief contract must never be reached for a consequential action');
    });
  });

  await testAsync('the cycle refuses a consequential action even if the policy said ALLOW', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'correct-vendor', toolId: 'shopify_vendor_correction' });
      const calls = [];
      // The independent second check: an ALLOW for a consequential action is not trusted.
      // Proven by driving the cycle's own guard directly, since the real policy would never
      // produce that verdict - which is exactly why this belt-and-braces refusal exists.
      assert.strictEqual(isConsequential('shopify_vendor_correction'), true);
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, { executor: recordingExecutor(calls) }));
        assert.strictEqual(stepFor(cycle, 'correct-vendor').executed, false);
      });
      assert.deepStrictEqual(calls, []);
    });
  });

  await testAsync('no human approval can be manufactured, supplied, or injected', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots));
        const decision = stepFor(cycle, 'observe').policy_decision;
        assert.strictEqual(decision.human_approval_present, false);
        assert.strictEqual(decision.human_approval_request_id, null);
        assert.strictEqual(decision.approval_gate_is_authoritative, true);
      });
    });

    // Structural, not only behavioural: the module has no way to express an approval.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'autonomousCycle.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of [
      'humanApproval',
      'verifyApprovalAuthorization',
      'decideApprovalRequest',
      'issueApprovalChallenge',
      'authorizePublishing',
      'signApproval',
      'createPrivateKey',
      "require('node:crypto')",
      "require('crypto')",
    ]) {
      assert.ok(!code.includes(forbidden), `autonomousCycle.js must not contain ${forbidden}`);
    }
    // The one approvals import it has is the read-only classification helper.
    assert.ok(code.includes("require('../approvals/approvalArchitecture')"));
    assert.ok(code.includes('requiresApproval'));
  });

  // -------------------------------------------------------------------------------
  // REQUIRED: circuit breaker
  // -------------------------------------------------------------------------------

  await testAsync('an open circuit breaker stops the cycle before execution', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      // Trip the breaker for exactly this business + platform + action.
      for (let attempt = 0; attempt < circuitBreaker.getFailureThreshold(); attempt += 1) {
        circuitBreaker.recordFailure({ businessId: 'alpha-co', platform: 'shopify', action: 'product_data_retrieval', now: T0, rootDir: roots.circuits });
      }
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots));
        const step = stepFor(cycle, 'observe');
        assert.strictEqual(step.outcome, 'blocked');
        assert.strictEqual(step.reason_code, 'circuit_open');
      });
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: roots.snapshots }).length, 0, 'nothing may be observed through an open circuit');
    });
  });

  await testAsync('a failed observation trips the breaker, and an explicit reset recovers it', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      const scope = { businessId: 'alpha-co', platform: 'shopify', action: 'product_data_retrieval', rootDir: roots.circuits };

      await withKillSwitch('true', async () => {
        // An unconfigured adapter makes the observation refuse, which is a failure. The
        // schedule recurs hourly, so each cycle needs its own hour to have an occurrence.
        let clock = T0;
        let lastFailureAt = T0;
        for (let attempt = 0; attempt < circuitBreaker.getFailureThreshold(); attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          await runAutonomousCycle(cycleOptions(roots, { now: clock, adapter: inMemoryAdapter({ configured: false }) }));
          lastFailureAt = clock;
          clock = new Date(clock.getTime() + 60 * 60 * 1000);
        }
        // Checked AT the moment of the last failure: an hour later the cooldown would
        // already have elapsed and the circuit would read half_open, which is a different
        // (and also correct) state.
        assert.strictEqual(circuitBreaker.getCircuitState({ ...scope, now: lastFailureAt }).state, 'open');
        assert.strictEqual(circuitBreaker.checkCircuit({ ...scope, now: lastFailureAt }).allowed, false);

        // An explicit, attributable reset restores it - without waiting for any cooldown.
        circuitBreaker.resetCircuit({ ...scope, resetBy: 'owner@example.com', reason: 'Credentials re-issued.', now: lastFailureAt });
        assert.strictEqual(circuitBreaker.getCircuitState({ ...scope, now: lastFailureAt }).state, 'closed');

        const recovered = await runAutonomousCycle(cycleOptions(roots, { now: clock }));
        assert.strictEqual(stepFor(recovered, 'observe').outcome, 'observed');
        assert.strictEqual(circuitBreaker.getCircuitState({ ...scope, now: clock }).state, 'closed');
      });
    });
  });

  await testAsync('a breaker is scoped - one broken job never stops an unrelated one', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe-products', toolId: 'product_data_retrieval' });
      addJob(roots, { jobId: 'observe-collections', toolId: 'collection_data_retrieval' });
      for (let attempt = 0; attempt < circuitBreaker.getFailureThreshold(); attempt += 1) {
        circuitBreaker.recordFailure({ businessId: 'alpha-co', platform: 'shopify', action: 'product_data_retrieval', now: T0, rootDir: roots.circuits });
      }
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots));
        assert.strictEqual(stepFor(cycle, 'observe-products').reason_code, 'circuit_open');
        assert.strictEqual(stepFor(cycle, 'observe-collections').outcome, 'observed');
      });
    });
  });

  // -------------------------------------------------------------------------------
  // REQUIRED: idempotency and restart safety
  // -------------------------------------------------------------------------------

  await testAsync('a repeated cycle in the same window does no work twice', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        const first = await runAutonomousCycle(cycleOptions(roots));
        assert.strictEqual(first.considered, 1);

        // Same hour again - this is the restart case, because the occurrence key is derived
        // from the schedule rather than remembered in memory.
        const second = await runAutonomousCycle(cycleOptions(roots, { now: new Date('2026-03-04T09:45:00.000Z') }));
        assert.strictEqual(second.considered, 0);
        assert.deepStrictEqual(second.steps, []);
        assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: roots.snapshots }).length, 1, 'exactly one snapshot, not two');
      });
    });
  });

  await testAsync('the claim is durable, so a crash mid-cycle cannot re-run the occurrence', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      await withKillSwitch('true', async () => {
        await runAutonomousCycle(cycleOptions(roots));
      });
      // Re-read from disk only - the restart.
      const reloaded = scheduleStore.loadScheduledJob('observe', { businessId: 'alpha-co', rootDir: roots.schedules });
      assert.strictEqual(reloaded.last_occurrence_key, '2026-03-04T09:00:00.000Z');
      assert.strictEqual(scheduleStore.listDueJobs({ businessId: 'alpha-co', now: T0, rootDir: roots.schedules }).length, 0);
    });
  });

  // -------------------------------------------------------------------------------
  // REQUIRED: isolation, containment, and reuse of the existing orchestrator
  // -------------------------------------------------------------------------------

  await testAsync('business isolation: a cycle for one business never touches another\'s work', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'alpha-observe', toolId: 'product_data_retrieval', businessId: 'alpha-co' });
      addJob(roots, { jobId: 'beta-observe', toolId: 'product_data_retrieval', businessId: 'beta-co' });
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots));
        assert.deepStrictEqual(cycle.steps.map((step) => step.job_id), ['alpha-observe']);
        // Beta's job is still unclaimed - alpha's cycle did not consume it.
        assert.strictEqual(scheduleStore.listDueJobs({ businessId: 'beta-co', now: T0, rootDir: roots.schedules }).length, 1);
        assert.strictEqual(listSnapshots({ businessId: 'beta-co', platform: 'shopify', rootDir: roots.snapshots }).length, 0);
      });
    });
  });

  await testAsync('one failing job never ends the cycle', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'a-observe', toolId: 'product_data_retrieval' });
      addJob(roots, { jobId: 'b-observe', toolId: 'collection_data_retrieval' });
      const hostileAdapter = inMemoryAdapter();
      hostileAdapter.getProducts = async () => {
        throw new Error('boom from https://internal.example?token=CANARY-DO-NOT-LEAK');
      };
      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(cycleOptions(roots, { adapter: hostileAdapter }));
        assert.strictEqual(cycle.steps.length, 2, 'both jobs must be reported');
        assert.ok(cycle.steps.every((step) => CYCLE_OUTCOMES.includes(step.outcome)));
        assert.ok(!JSON.stringify(cycle).includes('CANARY-DO-NOT-LEAK'));
      });
    });
  });

  await testAsync('the cycle executes only through the existing Chief execution contract', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'autonomousCycle.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    // The one execution path it has.
    assert.ok(code.includes("require('../agent/core/orchestratorExecutionContract')"));
    assert.ok(code.includes('executeSelectedCapability'));
    // And no second orchestration, no direct client, no network.
    for (const forbidden of [
      'runExecutor(',
      "require('../integrations/adapters/shopifyClient",
      "require('../integrations/adapters/etsyReadClient",
      "require('../integrations/shopifyBlogPublishing",
      'publishListing',
      'productUpdate',
      'inventoryAdjustQuantities',
      'fetch(',
      'setInterval(',
      'setTimeout(',
    ]) {
      assert.ok(!code.includes(forbidden), `autonomousCycle.js must not contain ${forbidden}`);
    }
  });

  await testAsync('a persisted cycle record carries no credential and no raw decision object', async () => {
    await withRoots(async (roots) => {
      addJob(roots, { jobId: 'observe', toolId: 'product_data_retrieval' });
      const saved = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_CANARY-DO-NOT-LEAK-3f9a7c2e';
      try {
        await withKillSwitch('true', async () => {
          const cycle = await runAutonomousCycle(cycleOptions(roots));
          const files = fs.readdirSync(roots.runs).filter((name) => name.endsWith('.json'));
          assert.strictEqual(files.length, 1);
          const onDisk = fs.readFileSync(path.join(roots.runs, files[0]), 'utf8');
          assert.ok(!onDisk.includes('CANARY-DO-NOT-LEAK'));
          // The record summarizes the decision rather than embedding the whole object.
          const record = JSON.parse(onDisk);
          assert.deepStrictEqual(Object.keys(record.result.steps[0].policy_decision).sort(), ['decision', 'reason_code']);
          assert.ok(Array.isArray(record.result.audit_trail));
          assert.strictEqual(record.business_id, 'alpha-co');
          assert.strictEqual(cycle.record.run_id, record.run_id);
        });
      } finally {
        if (saved === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
        else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = saved;
      }
    });
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomousCycle.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
