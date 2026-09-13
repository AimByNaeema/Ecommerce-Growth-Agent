'use strict';

// THE TWO ENDS OF THE CONSEQUENTIAL PATH, JOINED:
//
//   scheduler -> real compliance verdict -> autonomy policy -> APPROVAL_REQUIRED
//   -> durable approval request -> real Ed25519 human approval
//   -> resumeApprovedExecution -> integrations/approvedCorrectionDispatch.js
//   -> the existing integration module (compliance + publish authorization re-checked)
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE. shopifyClient's two functions are replaced on the
// shared module object for the one success case (this project's existing no-framework
// mocking convention), and global.fetch is replaced for the whole file with a function that
// FAILS the suite if anything reaches for the network.
//
// THE APPROVAL IS REAL. Every decision below is signed with a real Ed25519 key and verified
// by the real, unmodified gate. Nothing about approval is mocked, so "an agent cannot
// approve its own scheduled action" is evidence rather than assertion.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.VERIFICATION_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-correction-verifications-'));

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const dispatch = require('../../integrations/approvedCorrectionDispatch');
const { CORRECTION_TOOL_IDS, isCorrectionTool, executeApprovedCorrection } = dispatch;
const approvalStore = require('../../approvals/approvalStore');
const {
  createApprovalRequest,
  createAndPersistApprovalRequest,
  decideAndPersistApprovalRequest,
  loadPendingApprovalRequests,
} = require('../../approvals/approvalWorkflow');
const { resumeApprovedExecution } = require('../../agent/core/orchestratorExecutionContract');
const { useApprovalTestKey, signApproval } = require('./approvalSigningTestKey');
const { createScheduledJob } = require('../../scheduler/scheduleModel');
const scheduleStore = require('../../scheduler/scheduleStore');
const { runSchedulerPass, resolveComplianceVerdict } = require('../../scheduler/scheduleRunner');
const { runAutonomousCycle } = require('../../autonomy/autonomousCycle');
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { createAuditTracker } = require('../../audit/auditTrail');

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
const PRODUCT_ID = 'gid://shopify/Product/1';
const NEW_VENDOR = 'Aurora Ceramics';

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-correction-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withKillSwitch(value, fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  process.env[AUTONOMY_KILL_SWITCH_ENV] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

// Replaces the two shopifyClient functions the vendor correction uses, on the shared module
// object, and restores them afterwards. No network call is possible while this is active.
async function withMockedShopify({ updated = true, rereadVendor = NEW_VENDOR }, fn) {
  const savedUpdate = shopifyClient.updateProductVendor;
  const savedGet = shopifyClient.getProducts;
  const calls = [];
  shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
    calls.push({ productId, vendor });
    if (!updated) throw new Error('Shopify refused the mutation.');
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

const VENDOR_EXECUTION_REQUEST = {
  objective: 'Correct a product vendor field.',
  category: 'products',
  tool_id: 'shopify_vendor_correction',
  specialist_id: 'product',
  is_shared_infrastructure: false,
  business_id: 'alpha-co',
  research_params: { content: NEW_VENDOR, productId: PRODUCT_ID, newVendor: NEW_VENDOR, contentReference: 'vendor-correction-1' },
};

function pendingVendorRequest(id = 'apr-vendor-1', overrides = {}) {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: { ...VENDOR_EXECUTION_REQUEST, ...overrides },
    reason: 'Changes a real product record in the connected store.',
  });
}

// Creates, persists and genuinely approves one request with a real Ed25519 signature.
function approveForReal(storeDir, id = 'apr-vendor-1') {
  const record = createAndPersistApprovalRequest(
    {
      id,
      classification: 'externally_executable',
      specialistId: 'product',
      toolId: 'shopify_vendor_correction',
      executionRequest: VENDOR_EXECUTION_REQUEST,
      reason: 'Changes a real product record in the connected store.',
    },
    { storeDir }
  );
  const authorization = signApproval({ request: record, decision: 'approved', decidedBy: 'owner@example.com' });
  const updated = decideAndPersistApprovalRequest(
    [record],
    id,
    { decision: 'approved', decidedBy: 'owner@example.com', authorization },
    { storeDir }
  );
  return updated[0];
}

// ---------------------------------------------------------------------------------
// FIX 1 - the correction execution path
// ---------------------------------------------------------------------------------

test('the three corrections are dispatchable, and nothing else is', () => {
  assert.deepStrictEqual(CORRECTION_TOOL_IDS.slice().sort(), [
    'shopify_collection_membership_update',
    'shopify_inventory_correction',
    'shopify_vendor_correction',
  ]);
  assert.strictEqual(isCorrectionTool('shopify_vendor_correction'), true);
  assert.strictEqual(isCorrectionTool('product_data_retrieval'), false);
  assert.strictEqual(isCorrectionTool('market_research'), false);
});

test('the dispatch authorizes from durable state only - never from its caller', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'approvedCorrectionDispatch.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  // It reads the durable store, and the record it authorizes with comes from there.
  assert.ok(code.includes("require('../approvals/approvalStore')"));
  assert.ok(code.includes('loadApprovalRecord'));
  assert.ok(code.includes('const requests = [stored]'), 'the authorization array must be built from the STORED record');
  // It has no way to accept an approval, a status, or an approver from a caller.
  for (const forbidden of ['decidedApprovalRequest.status', 'options.requests', 'approvalContext.requests']) {
    assert.ok(!code.includes(forbidden), `dispatch must not read ${forbidden}`);
  }
  // And it neither verifies nor produces a signature.
  for (const forbidden of ['verifyApprovalAuthorization', 'createPrivateKey', 'crypto.sign', 'decideApprovalRequest']) {
    assert.ok(!code.includes(forbidden), `dispatch must not contain ${forbidden}`);
  }
});

(async () => {
  await testAsync('a forged in-memory approval cannot execute a correction', async () => {
    await withStore(async (storeDir) => {
      // A perfectly-shaped record that was never stored, never signed, never approved by
      // anyone. This is the attack the durable-state rule exists to stop.
      const forged = {
        ...pendingVendorRequest('apr-forged'),
        status: 'approved',
        decided_by: 'attacker@example.com',
        decided_at: new Date().toISOString(),
      };
      await withMockedShopify({}, async (calls) => {
        const outcome = await executeApprovedCorrection(forged, { storeDir });
        assert.strictEqual(outcome.status, 'error');
        assert.strictEqual(outcome.reason_code, 'approval_not_durable');
        assert.deepStrictEqual(calls, [], 'no Shopify call may be made for a forged approval');
      });
    });
  });

  await testAsync('a stored but UNDECIDED approval cannot execute a correction', async () => {
    await withStore(async (storeDir) => {
      const record = createAndPersistApprovalRequest(
        {
          id: 'apr-pending',
          classification: 'externally_executable',
          specialistId: 'product',
          toolId: 'shopify_vendor_correction',
          executionRequest: VENDOR_EXECUTION_REQUEST,
          reason: 'Changes a real product record.',
        },
        { storeDir }
      );
      await withMockedShopify({}, async (calls) => {
        const outcome = await executeApprovedCorrection({ ...record, status: 'approved' }, { storeDir });
        assert.strictEqual(outcome.status, 'error');
        assert.strictEqual(outcome.reason_code, 'approval_not_approved');
        assert.deepStrictEqual(calls, []);
      });
    });
  });

  await testAsync('a stored approval with no Ed25519 provenance cannot execute a correction', async () => {
    await withStore(async (storeDir) => {
      // Approved-looking durable state that never went through the signature gate.
      const record = pendingVendorRequest('apr-noprov');
      approvalStore.saveApprovalRecord(
        { ...record, status: 'approved', decided_by: 'owner@example.com', decided_at: new Date().toISOString() },
        { storeDir, executionState: 'decided' }
      );
      await withMockedShopify({}, async (calls) => {
        const outcome = await executeApprovedCorrection(record, { storeDir });
        assert.strictEqual(outcome.status, 'error');
        assert.strictEqual(outcome.reason_code, 'approval_provenance_missing');
        assert.deepStrictEqual(calls, []);
      });
    });
  });

  await testAsync('a genuinely approved correction executes, exactly once', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        const decided = approveForReal(storeDir);
        assert.strictEqual(decided.status, 'approved');
        assert.strictEqual(decided.execution_request.approval_provenance.method, 'ed25519_signature');

        await withMockedShopify({}, async (calls) => {
          const first = await executeApprovedCorrection(decided, { storeDir, auditTracker: createAuditTracker('run-1') });
          assert.strictEqual(first.status, 'success', first.error || '');
          assert.strictEqual(first.correction_status, 'corrected');
          assert.deepStrictEqual(calls, [{ productId: PRODUCT_ID, vendor: NEW_VENDOR }]);

          // EXECUTE-ONCE, including across a restart: the durable record is claimed, and a
          // second attempt - from any process - is refused rather than repeating the change.
          const second = await executeApprovedCorrection(decided, { storeDir });
          assert.strictEqual(second.status, 'error');
          assert.strictEqual(second.reason_code, 'already_executed');
          assert.strictEqual(calls.length, 1, 'the mutation must never happen twice');
        });
      });
    });
  });

  await testAsync('a correction whose approved request omits a parameter executes nothing', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        const record = createAndPersistApprovalRequest(
          {
            id: 'apr-missing',
            classification: 'externally_executable',
            specialistId: 'product',
            toolId: 'shopify_vendor_correction',
            executionRequest: { ...VENDOR_EXECUTION_REQUEST, research_params: { content: NEW_VENDOR } },
            reason: 'Changes a real product record.',
          },
          { storeDir }
        );
        const authorization = signApproval({ request: record, decision: 'approved', decidedBy: 'owner@example.com' });
        const updated = decideAndPersistApprovalRequest([record], 'apr-missing', { decision: 'approved', decidedBy: 'owner@example.com', authorization }, { storeDir });

        await withMockedShopify({}, async (calls) => {
          const outcome = await executeApprovedCorrection(updated[0], { storeDir });
          assert.strictEqual(outcome.status, 'error');
          assert.strictEqual(outcome.reason_code, 'missing_parameters');
          assert.deepStrictEqual(calls, [], 'nothing is substituted for a missing parameter');
        });
      });
    });
  });

  await testAsync('business isolation: another business cannot execute this correction', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        const decided = approveForReal(storeDir, 'apr-isolated');
        // Same approval id, a different business on the record being acted on.
        const foreign = { ...decided, execution_request: { ...decided.execution_request, business_id: 'beta-co' } };
        await withMockedShopify({}, async (calls) => {
          const outcome = await executeApprovedCorrection(foreign, { storeDir });
          assert.strictEqual(outcome.status, 'error');
          assert.strictEqual(outcome.reason_code, 'approval_not_durable');
          assert.deepStrictEqual(calls, []);
        });
      });
    });
  });

  await testAsync('resumeApprovedExecution reaches the correction, and an unapproved one never does', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        const decided = approveForReal(storeDir, 'apr-resume');
        await withMockedShopify({}, async (calls) => {
          const outcome = await resumeApprovedExecution(decided, undefined, createAuditTracker('run-2'), null, null, null, { storeDir });
          assert.strictEqual(outcome.status, 'success', outcome.error || '');
          assert.strictEqual(calls.length, 1);
        });

        // A pending record never executes - resumeApprovedExecution refuses before dispatch.
        await withMockedShopify({}, async (calls) => {
          const pending = pendingVendorRequest('apr-still-pending');
          const outcome = await resumeApprovedExecution(pending, undefined, null, null, null, null, { storeDir });
          assert.strictEqual(outcome.status, 'approval_required');
          assert.deepStrictEqual(calls, []);
        });
      });
    });
  });

  // ---------------------------------------------------------------------------------
  // FIX 2 - scheduler to durable approval
  // ---------------------------------------------------------------------------------

  test('the scheduler computes a REAL compliance verdict for declared content', () => {
    // Content-free consequential work still gets no verdict - nothing is fabricated.
    assert.strictEqual(resolveComplianceVerdict('shopify_vendor_correction', null), null);
    assert.strictEqual(
      resolveComplianceVerdict('shopify_vendor_correction', { task: { platform: 'shopify', params: {} } }),
      null
    );
    // Declared content produces a real engine verdict, never an invented PASS.
    const verdict = resolveComplianceVerdict('shopify_vendor_correction', {
      task: { platform: 'shopify', params: { content: NEW_VENDOR } },
    });
    assert.ok(['PASS', 'REVIEW', 'BLOCK'].includes(verdict), `unexpected verdict: ${verdict}`);
    // A read tool is still 'not_applicable' - it produces no content to check.
    assert.strictEqual(resolveComplianceVerdict('product_data_retrieval', null), 'not_applicable');
  });

  test('a scheduled job may declare parameters, but never a credential', () => {
    const good = createScheduledJob({
      jobId: 'vendor-fix',
      businessId: 'alpha-co',
      enabled: true,
      schedule: { kind: 'interval_minutes', every: 60 },
      task: { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: { content: NEW_VENDOR, productId: PRODUCT_ID, newVendor: NEW_VENDOR } },
      now: T0,
    });
    assert.strictEqual(good.task.params.newVendor, NEW_VENDOR);
    for (const key of ['access_token', 'apiKey', 'client_secret']) {
      assert.throws(
        () => createScheduledJob({
          jobId: 'bad',
          businessId: 'alpha-co',
          enabled: true,
          schedule: { kind: 'interval_minutes', every: 60 },
          task: { tool_id: 'shopify_vendor_correction', objective: 'x', platform: 'shopify', params: { [key]: 'secret' } },
          now: T0,
        }),
        /credential-shaped/
      );
    }
  });

  await testAsync('a consequential scheduled job now reaches APPROVAL_REQUIRED, never ALLOW', async () => {
    await withStore(async (rootDir) => {
      scheduleStore.saveScheduledJob(
        createScheduledJob({
          jobId: 'vendor-fix',
          businessId: 'alpha-co',
          enabled: true,
          schedule: { kind: 'interval_minutes', every: 60 },
          task: { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: { content: NEW_VENDOR, productId: PRODUCT_ID, newVendor: NEW_VENDOR } },
          now: T0,
        }),
        { rootDir }
      );
      await withKillSwitch('true', async () => {
        const result = runSchedulerPass({
          businessId: 'alpha-co',
          now: T0,
          rootDir,
          enabledPlatforms: ['shopify'],
          businessPolicy: { ok: true, business_id: 'alpha-co', enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 } },
          dailyUsage: { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true },
        });
        assert.strictEqual(result.results[0].outcome, 'approval_required');
        assert.strictEqual(result.results[0].reason_code, 'human_approval_required');
        // The declared parameters became part of the execution request a human will sign.
        assert.strictEqual(result.results[0].execution_request.research_params.newVendor, NEW_VENDOR);
      });
    });
  });

  await testAsync('the cycle queues a DURABLE approval, and never a duplicate', async () => {
    const roots = {};
    for (const name of ['schedules', 'snapshots', 'circuits', 'verifications', 'approvals', 'runs']) {
      roots[name] = fs.mkdtempSync(path.join(os.tmpdir(), `flow-${name}-`));
    }
    try {
      scheduleStore.saveScheduledJob(
        createScheduledJob({
          jobId: 'vendor-fix',
          businessId: 'alpha-co',
          enabled: true,
          schedule: { kind: 'interval_minutes', every: 60 },
          task: { tool_id: 'shopify_vendor_correction', objective: 'Correct a vendor.', platform: 'shopify', params: { content: NEW_VENDOR, productId: PRODUCT_ID, newVendor: NEW_VENDOR } },
          now: T0,
        }),
        { rootDir: roots.schedules }
      );

      const options = {
        businessId: 'alpha-co',
        now: T0,
        enabledPlatforms: ['shopify'],
        businessPolicy: { ok: true, business_id: 'alpha-co', enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 } },
        dailyUsage: { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true },
        scheduleRootDir: roots.schedules,
        snapshotRootDir: roots.snapshots,
        circuitRootDir: roots.circuits,
        verificationRootDir: roots.verifications,
        approvalRootDir: roots.approvals,
        runHistoryStoreDir: roots.runs,
      };

      await withKillSwitch('true', async () => {
        const cycle = await runAutonomousCycle(options);
        const step = cycle.steps.find((entry) => entry.job_id === 'vendor-fix');
        assert.strictEqual(step.outcome, 'approval_required');
        assert.strictEqual(step.executed, false);
        assert.strictEqual(step.approval_state, 'pending');

        // It is genuinely durable: a restart rebuilds it from disk alone.
        const pending = loadPendingApprovalRequests({ storeDir: roots.approvals });
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].tool_id, 'shopify_vendor_correction');
        assert.strictEqual(pending[0].execution_request.business_id, 'alpha-co');
        assert.strictEqual(pending[0].execution_request.research_params.newVendor, NEW_VENDOR);

        // The id is derived from the occurrence, so a repeated cycle queues nothing new.
        await runAutonomousCycle({ ...options, now: new Date('2026-03-04T09:45:00.000Z') });
        assert.strictEqual(loadPendingApprovalRequests({ storeDir: roots.approvals }).length, 1, 'no duplicate approval may be queued');
      });
    } finally {
      for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('the cycle never signs, decides, or satisfies the approval it queued', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'autonomousCycle.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    // It may CREATE a pending request. It may not decide one.
    assert.ok(code.includes('createAndPersistApprovalRequest'));
    for (const forbidden of ['decideApprovalRequest', 'decideAndPersistApprovalRequest', 'signApproval', 'verifyApprovalAuthorization', 'humanApproval', 'authorizePublishing']) {
      assert.ok(!code.includes(forbidden), `the cycle must not contain ${forbidden}`);
    }
  });

  await testAsync('end to end: scheduled -> queued -> really signed -> executed once', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        // The queued request, exactly as the cycle persists it.
        const queued = createAndPersistApprovalRequest(
          {
            id: 'apr-vendor-fix-20260304T090000000Z',
            classification: 'externally_executable',
            specialistId: 'product',
            toolId: 'shopify_vendor_correction',
            executionRequest: VENDOR_EXECUTION_REQUEST,
            reason: 'Changes a real product record in the connected store.',
          },
          { storeDir }
        );

        // A HUMAN signs it. This is the only step no part of the agent can perform.
        const authorization = signApproval({ request: queued, decision: 'approved', decidedBy: 'owner@example.com' });
        const updated = decideAndPersistApprovalRequest(
          [queued],
          queued.id,
          { decision: 'approved', decidedBy: 'owner@example.com', expectedBusinessId: 'alpha-co', authorization },
          { storeDir }
        );

        await withMockedShopify({}, async (calls) => {
          const outcome = await resumeApprovedExecution(updated[0], undefined, createAuditTracker('run-e2e'), null, null, null, { storeDir });
          assert.strictEqual(outcome.status, 'success', outcome.error || '');
          assert.strictEqual(calls.length, 1);
          assert.deepStrictEqual(calls[0], { productId: PRODUCT_ID, vendor: NEW_VENDOR });

          // And a restart cannot replay it.
          const replay = await resumeApprovedExecution(updated[0], undefined, null, null, null, null, { storeDir });
          assert.strictEqual(replay.status, 'error');
          assert.strictEqual(calls.length, 1);
        });
      });
    });
  });

  await testAsync('a tampered approved request is refused by the signature gate, so nothing executes', async () => {
    await useApprovalTestKey(async () => {
      await withStore(async (storeDir) => {
        const queued = createAndPersistApprovalRequest(
          {
            id: 'apr-tampered',
            classification: 'externally_executable',
            specialistId: 'product',
            toolId: 'shopify_vendor_correction',
            executionRequest: VENDOR_EXECUTION_REQUEST,
            reason: 'Changes a real product record.',
          },
          { storeDir }
        );
        const authorization = signApproval({ request: queued, decision: 'approved', decidedBy: 'owner@example.com' });
        // The vendor is changed AFTER the signature was produced over the original request.
        const tampered = { ...queued, execution_request: { ...VENDOR_EXECUTION_REQUEST, research_params: { ...VENDOR_EXECUTION_REQUEST.research_params, newVendor: 'Someone Else' } } };
        assert.throws(
          () => decideAndPersistApprovalRequest([tampered], 'apr-tampered', { decision: 'approved', decidedBy: 'owner@example.com', authorization }, { storeDir }),
          /.*/,
          'a signature must not cover a request that changed after it was signed'
        );
        // Still pending in durable state, so nothing can execute it.
        const stored = approvalStore.loadApprovalRecord('apr-tampered', { storeDir });
        assert.strictEqual(stored.approval_request.status, 'pending');
      });
    });
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('approvedCorrectionFlow.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
