'use strict';

// autonomy/approvalResolution.js - the owner's decision on a durable autonomous approval.
// Negative and bypass paths: every way a decision could be forged, replayed, misdirected or
// stale, each proven to change nothing and write nothing to the platform.
//
// NO EXTERNAL API IS CALLED. The only Shopify functions the vendor correction uses are
// stubbed on the shared client object, and global.fetch fails the suite if reached.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHARED = {
  runs: fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-runs-')),
  memory: fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-memory-')),
};
process.env.RUN_HISTORY_STORE_DIR = SHARED.runs;
process.env.MEMORY_STORE_DIR = SHARED.memory;

// A real, temporary business whose own configuration enables Shopify - the Chief contract
// re-reads enablement at execution time, so an executing test needs one. Same convention as
// autonomyPolicy.test.js and businessIsolation.test.js: under the registry's fixed root,
// removed when this process exits.
const BUSINESS = 'autonomy-resolution-test-co';
const BUSINESS_DIR = path.join(__dirname, '..', '..', 'configuration', 'businesses', BUSINESS);
fs.mkdirSync(BUSINESS_DIR, { recursive: true });
fs.writeFileSync(path.join(BUSINESS_DIR, 'business.yaml'), [
  'business_name: "Autonomy Resolution Test Co"',
  'business_model: "D2C"',
  'platform: "Shopify"',
  'product_model: "in-house"',
  'target_markets: ["US"]',
  'countries: ["US"]',
  'currencies: ["USD"]',
  'product_categories: ["home"]',
  'customer_segments: ["homeowners"]',
  'brand:',
  '  name: "Autonomy Resolution Test Co"',
  'business_goals: ["grow"]',
  'marketing_channels: ["email"]',
  'enabled_platforms: [shopify]',
  '',
].join('\n'));
process.on('exit', () => fs.rmSync(BUSINESS_DIR, { recursive: true, force: true }));

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const {
  resolveAutonomousApproval,
  findPendingAutonomousApproval,
  listPendingAutonomousApprovals,
} = require('../../autonomy/approvalResolution');
const { prepareApprovalExecutionRequest } = require('../../agent/core/orchestratorExecutionContract');
const { createAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const approvalStore = require('../../approvals/approvalStore');
const circuitBreaker = require('../../reliability/circuitBreaker');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

const PRODUCT_ID = 'gid://shopify/Product/1';
const NEW_VENDOR = 'Aurora Ceramics';
const OWNER = 'owner@example.com';

function executionRequestFor(businessId, { autonomous = true, newVendor = NEW_VENDOR } = {}) {
  const request = {
    objective: 'Correct the vendor on the product.',
    category: 'products',
    tool_id: 'shopify_vendor_correction',
    specialist_id: 'product',
    is_shared_infrastructure: false,
    business_id: businessId,
    research_params: { content: newVendor, productId: PRODUCT_ID, newVendor },
    ...(autonomous
      ? { autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-test', job_id: 'fix-vendor', occurrence_key: '2026-03-04T09:00:00.000Z', platform: 'shopify' } }
      : {}),
  };
  const prepared = prepareApprovalExecutionRequest('shopify_vendor_correction', request);
  if (!prepared.ok) throw new Error(`fixture could not be prepared: ${prepared.reason}`);
  return prepared.executionRequest;
}

function queue(storeDir, id, businessId = BUSINESS, options = {}) {
  return createAndPersistApprovalRequest(
    {
      id,
      classification: 'externally_executable',
      specialistId: 'product',
      toolId: 'shopify_vendor_correction',
      executionRequest: executionRequestFor(businessId, options),
      reason: 'Changes a real product record in the connected store.',
    },
    { storeDir }
  );
}

async function withRoots(fn) {
  const roots = {};
  for (const name of ['approvals', 'verifications', 'circuits']) {
    roots[name] = fs.mkdtempSync(path.join(os.tmpdir(), `resolution-${name}-`));
  }
  try {
    return await fn(roots);
  } finally {
    for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
  }
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

function resolveWith(roots, overrides) {
  return resolveAutonomousApproval({
    businessId: BUSINESS,
    decision: 'approved',
    decidedBy: OWNER,
    approvalStoreDir: roots.approvals,
    verificationRootDir: roots.verifications,
    circuitRootDir: roots.circuits,
    ...overrides,
  });
}

const stateOf = (roots, id) => approvalStore.loadApprovalRecord(id, { storeDir: roots.approvals });

(async () => {
  await testAsync('only an autonomous-cycle approval can be resolved here', async () => {
    await withRoots(async (roots) => {
      const plain = queue(roots.approvals, 'apr-plain', BUSINESS, { autonomous: false });
      assert.strictEqual(findPendingAutonomousApproval('apr-plain', { businessId: BUSINESS, storeDir: roots.approvals }), null);
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-plain', authorization: signApproval({ request: plain, decidedBy: OWNER }) });
        assert.strictEqual(result.reason_code, 'approval_not_found');
        assert.strictEqual(calls.length, 0);
      });
      assert.strictEqual(stateOf(roots, 'apr-plain').approval_request.status, 'pending');
    });
  });

  await testAsync('business isolation: another business, or the default business, cannot reach it', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-alpha');
      for (const businessId of ['beta-co', null]) {
        assert.strictEqual(findPendingAutonomousApproval('apr-alpha', { businessId, storeDir: roots.approvals }), null);
        assert.strictEqual(listPendingAutonomousApprovals({ businessId, storeDir: roots.approvals }).length, 0);
        await withMockedShopify({}, async (calls) => {
          const result = await resolveWith(roots, { approvalId: 'apr-alpha', businessId, authorization: signApproval({ request: record, decidedBy: OWNER }) });
          assert.strictEqual(result.reason_code, 'approval_not_found');
          assert.strictEqual(calls.length, 0);
        });
      }
      assert.strictEqual(listPendingAutonomousApprovals({ businessId: BUSINESS, storeDir: roots.approvals }).length, 1);
    });
  });

  await testAsync('an incomplete decision is refused before anything is read or written', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-incomplete');
      const authorization = signApproval({ request: record, decidedBy: OWNER });
      const incomplete = [
        { approvalId: 'apr-incomplete', authorization: null },
        { approvalId: 'apr-incomplete', authorization: { nonce: authorization.nonce } },
        { approvalId: 'apr-incomplete', authorization, decidedBy: '' },
        { approvalId: 'apr-incomplete', authorization, decision: 'maybe' },
      ];
      for (const overrides of incomplete) {
        assert.strictEqual((await resolveWith(roots, overrides)).reason_code, 'invalid_request');
      }
      assert.strictEqual(stateOf(roots, 'apr-incomplete').approval_request.status, 'pending');
    });
  });

  await testAsync('a forged signature changes nothing and writes nothing', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-forged');
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-forged', authorization: signApprovalWithForeignKey({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.reason_code, 'approval_verification_failed');
        assert.strictEqual(calls.length, 0);
      });
      assert.strictEqual(stateOf(roots, 'apr-forged').approval_request.status, 'pending');
    });
  });

  await testAsync('a request changed after the challenge was signed is refused', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-tampered');
      const authorization = signApproval({ request: record, decidedBy: OWNER });
      const tampered = { ...record, execution_request: { ...record.execution_request, research_params: { ...record.execution_request.research_params, newVendor: 'Someone Else' } } };
      approvalStore.saveApprovalRecord(tampered, { storeDir: roots.approvals, executionState: 'awaiting_decision' });
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-tampered', authorization });
        assert.strictEqual(result.reason_code, 'approval_verification_failed');
        assert.strictEqual(calls.length, 0);
      });
      assert.strictEqual(stateOf(roots, 'apr-tampered').approval_request.status, 'pending');
    });
  });

  await testAsync('a signature for one approval cannot decide another', async () => {
    await withRoots(async (roots) => {
      const first = queue(roots.approvals, 'apr-first');
      queue(roots.approvals, 'apr-second');
      const authorization = signApproval({ request: first, decidedBy: OWNER });
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-second', authorization });
        assert.strictEqual(result.reason_code, 'approval_verification_failed');
        assert.strictEqual(calls.length, 0);
      });
      assert.strictEqual(stateOf(roots, 'apr-second').approval_request.status, 'pending');
    });
  });

  await testAsync('a rejection executes nothing and cannot be decided again', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-rejected');
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-rejected', decision: 'rejected', authorization: signApproval({ request: record, decision: 'rejected', decidedBy: OWNER }) });
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.approval_request.status, 'rejected');
        assert.strictEqual(result.execution, null);
        const again = await resolveWith(roots, { approvalId: 'apr-rejected', authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(again.reason_code, 'approval_not_pending');
        assert.strictEqual(calls.length, 0);
      });
    });
  });

  await testAsync('an open circuit leaves the approval pending and attempts nothing', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-circuit');
      const now = new Date();
      for (let index = 0; index < circuitBreaker.getFailureThreshold(); index += 1) {
        circuitBreaker.recordFailure({ businessId: BUSINESS, platform: 'shopify', action: 'shopify_vendor_correction', now, rootDir: roots.circuits });
      }
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-circuit', now, authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.reason_code, 'circuit_open');
        assert.strictEqual(calls.length, 0);
      });
      const envelope = stateOf(roots, 'apr-circuit');
      assert.strictEqual(envelope.execution_state, 'awaiting_decision');
      assert.strictEqual(envelope.approval_request.status, 'pending');
    });
  });

  await testAsync('a write the platform does not confirm is never recorded as verified or remembered', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-unconfirmed');
      await withMockedShopify({ rereadVendor: 'Someone Else' }, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-unconfirmed', authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(result.verification.verified, false);
        assert.strictEqual(result.verification.status, 'failed');
      });
      assert.ok(!listMemoryRecords(BUSINESS, { limit: 50 }).some((entry) => entry.id === 'autonomy-apr-unconfirmed'));
    });
  });

  await testAsync('a verified action is never applied twice, even from a restored stale record', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-once');
      await withMockedShopify({}, async (calls) => {
        const first = await resolveWith(roots, { approvalId: 'apr-once', authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(first.verification.status, 'verified');
        assert.strictEqual(calls.length, 1);

        // An old pending copy of the same approval reappears on disk (a restored backup).
        approvalStore.saveApprovalRecord(record, { storeDir: roots.approvals, executionState: 'awaiting_decision' });
        const stale = await resolveWith(roots, { approvalId: 'apr-once', authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(stale.reason_code, 'already_completed');
        assert.strictEqual(calls.length, 1, 'the verification record is the execute-once guard');
      });
    });
  });

  await testAsync('a platform not enabled for the business is refused at execution, after the decision, with nothing written', async () => {
    await withRoots(async (roots) => {
      const record = queue(roots.approvals, 'apr-unconfigured', 'unconfigured-test-co');
      await withMockedShopify({}, async (calls) => {
        const result = await resolveWith(roots, { approvalId: 'apr-unconfigured', businessId: 'unconfigured-test-co', authorization: signApproval({ request: record, decidedBy: OWNER }) });
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.execution.status, 'denied');
        assert.strictEqual(result.verification.status, 'failed');
        assert.strictEqual(result.verification.verified, false);
        assert.strictEqual(calls.length, 0, 'a stale or missing platform enablement never reaches the platform');
      });
      assert.ok(!listMemoryRecords('unconfigured-test-co', { limit: 50 }).some((entry) => entry.id === 'autonomy-apr-unconfigured'));
    });
  });

  test('the resolver adds no approval mechanism of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'approvalResolution.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of ['verifyApprovalAuthorization', 'issueApprovalChallenge', 'crypto', 'createPrivateKey', 'authorizePublishing', 'status = \'approved\'']) {
      assert.ok(!code.includes(forbidden), `approvalResolution.js must not contain ${forbidden}`);
    }
    assert.ok(code.includes('decideAndPersistApprovalRequest'), 'deciding goes through the existing workflow');
    assert.ok(code.includes('resumeApprovedExecution'), 'executing goes through the existing Chief contract');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomyApprovalResolution.test.js'));
  });

  for (const dir of Object.values(SHARED)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
