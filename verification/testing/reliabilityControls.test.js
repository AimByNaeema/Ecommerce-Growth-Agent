'use strict';

// The reliability layer: reliability/circuitBreaker.js and reliability/executionVerification.js.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, AND NONE CAN BE. Verification reads through a
// contract-conforming in-memory adapter, and global.fetch is replaced for the whole file
// with a function that FAILS the suite if anything reaches for the network.
//
// THE BREAKER'S CLOCK IS AN ARGUMENT, NOT A TIMER. Every function takes `now`, so cooldown
// and recovery are tested exactly rather than by sleeping.
//
// "RESTART" IS SIMULATED HONESTLY: both stores hold no in-memory cache, so a restart is
// exactly "read only what reached disk".

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const circuitBreaker = require('../../reliability/circuitBreaker');
const {
  BREAKER_STATES,
  getFailureThreshold,
  getCooldownMinutes,
  checkCircuit,
  recordFailure,
  recordSuccess,
  resetCircuit,
  getCircuitState,
  listCircuits,
} = circuitBreaker;

const executionVerification = require('../../reliability/executionVerification');
const {
  VERIFICATION_STATUSES,
  VERIFIABLE_ENTITY_KINDS,
  computeIdempotencyKey,
  checkIdempotency,
  getVerificationRecord,
  planVerification,
  verifyExecution,
} = executionVerification;

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

const T0 = new Date('2026-03-04T09:00:00.000Z');
const minutesAfter = (base, minutes) => new Date(base.getTime() + minutes * 60 * 1000);

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempRootAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-test-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SCOPE = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_inventory_correction' };

// A REAL adapter by the project's own contract - asserted below.
function inMemoryAdapter({ products = [], collections = [], inventory = [], shop = { name: 'Test', domain: 'test.example', email: null }, unsupported = [] } = {}) {
  const refuse = (capability) => async () => {
    const error = new Error(`unsupported: ${capability}`);
    error.code = 'unsupported_capability';
    throw error;
  };
  const adapter = {
    UNSUPPORTED_READ_CAPABILITIES: unsupported,
    isConfigured: () => true,
    getShopInfo: async () => shop,
    getProducts: async () => products,
    getOrders: async () => [],
    getCustomers: async () => [],
    getInventoryLevels: async () => inventory,
    getCollections: async () => collections,
  };
  for (const capability of unsupported) adapter[capability] = refuse(capability);
  return adapter;
}

// ---------------------------------------------------------------------------------
// CIRCUIT BREAKER
// ---------------------------------------------------------------------------------

test('a fresh circuit is closed and permits an attempt', () => {
  withTempRoot((rootDir) => {
    const check = checkCircuit({ ...SCOPE, now: T0, rootDir });
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.state, 'closed');
    assert.strictEqual(check.trial, false);
    assert.deepStrictEqual(BREAKER_STATES, ['closed', 'open', 'half_open']);
  });
});

test('the breaker trips at the failure threshold and then blocks', () => {
  withTempRoot((rootDir) => {
    const threshold = getFailureThreshold();
    for (let attempt = 0; attempt < threshold - 1; attempt += 1) {
      recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
      assert.strictEqual(checkCircuit({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir }).allowed, true, 'below the threshold it must still permit attempts');
    }
    recordFailure({ ...SCOPE, now: minutesAfter(T0, threshold), rootDir });

    const blocked = checkCircuit({ ...SCOPE, now: minutesAfter(T0, threshold), rootDir });
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.state, 'open');
    assert.strictEqual(blocked.reason_code, 'circuit_open');
    // Asking again does not wear it down.
    assert.strictEqual(checkCircuit({ ...SCOPE, now: minutesAfter(T0, threshold), rootDir }).allowed, false);
  });
});

test('a success resets the failure count before the threshold is reached', () => {
  withTempRoot((rootDir) => {
    recordFailure({ ...SCOPE, now: T0, rootDir });
    recordFailure({ ...SCOPE, now: minutesAfter(T0, 1), rootDir });
    recordSuccess({ ...SCOPE, now: minutesAfter(T0, 2), rootDir });
    assert.strictEqual(getCircuitState({ ...SCOPE, now: minutesAfter(T0, 2), rootDir }).consecutive_failures, 0);
    // The next failure starts counting from one again.
    recordFailure({ ...SCOPE, now: minutesAfter(T0, 3), rootDir });
    assert.strictEqual(checkCircuit({ ...SCOPE, now: minutesAfter(T0, 3), rootDir }).allowed, true);
  });
});

test('an open circuit becomes half_open after the cooldown and permits exactly one trial', () => {
  withTempRoot((rootDir) => {
    for (let attempt = 0; attempt < getFailureThreshold(); attempt += 1) {
      recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
    }
    const stillOpen = checkCircuit({ ...SCOPE, now: minutesAfter(T0, getCooldownMinutes() - 1), rootDir });
    assert.strictEqual(stillOpen.allowed, false, 'the cooldown must actually be waited out');

    const after = minutesAfter(T0, getFailureThreshold() + getCooldownMinutes() + 1);
    const trial = checkCircuit({ ...SCOPE, now: after, rootDir });
    assert.strictEqual(trial.allowed, true);
    assert.strictEqual(trial.state, 'half_open');
    assert.strictEqual(trial.trial, true);

    // EXACTLY one. A second caller while the trial is outstanding is refused.
    const second = checkCircuit({ ...SCOPE, now: after, rootDir });
    assert.strictEqual(second.allowed, false);
    assert.strictEqual(second.reason_code, 'trial_in_progress');
  });
});

test('a successful trial closes the circuit; a failed trial reopens it immediately', () => {
  withTempRoot((rootDir) => {
    const trip = () => {
      for (let attempt = 0; attempt < getFailureThreshold(); attempt += 1) {
        recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
      }
    };
    trip();
    const after = minutesAfter(T0, getFailureThreshold() + getCooldownMinutes() + 1);
    checkCircuit({ ...SCOPE, now: after, rootDir });
    recordSuccess({ ...SCOPE, now: after, rootDir });
    assert.strictEqual(getCircuitState({ ...SCOPE, now: after, rootDir }).state, 'closed');

    // Now trip it again and fail the trial.
    trip();
    const secondWindow = minutesAfter(after, getCooldownMinutes() + 1);
    assert.strictEqual(checkCircuit({ ...SCOPE, now: secondWindow, rootDir }).trial, true);
    recordFailure({ ...SCOPE, now: secondWindow, rootDir });
    const reopened = checkCircuit({ ...SCOPE, now: secondWindow, rootDir });
    assert.strictEqual(reopened.allowed, false, 'a failed trial must reopen the circuit at once, not grant another');
    assert.strictEqual(reopened.state, 'open');
  });
});

test('recovery by explicit reset requires a stated actor and reason, and is recorded', () => {
  withTempRoot((rootDir) => {
    for (let attempt = 0; attempt < getFailureThreshold(); attempt += 1) {
      recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
    }
    assert.strictEqual(checkCircuit({ ...SCOPE, now: T0, rootDir }).allowed, false);

    for (const bad of [undefined, '', '   ']) {
      assert.throws(() => resetCircuit({ ...SCOPE, resetBy: bad, reason: 'fixed the integration', rootDir }), /resetBy/);
      assert.throws(() => resetCircuit({ ...SCOPE, resetBy: 'owner@example.com', reason: bad, rootDir }), /reason/);
    }

    const reset = resetCircuit({ ...SCOPE, resetBy: 'owner@example.com', reason: 'Credentials were re-issued.', now: T0, rootDir });
    assert.strictEqual(reset.state, 'closed');
    assert.strictEqual(reset.consecutive_failures, 0);
    assert.strictEqual(reset.last_reset_by, 'owner@example.com');
    assert.strictEqual(reset.last_reset_reason, 'Credentials were re-issued.');
    assert.strictEqual(checkCircuit({ ...SCOPE, now: T0, rootDir }).allowed, true);
  });
});

test('breaker state survives a restart - a broken thing is not forgotten', () => {
  withTempRoot((rootDir) => {
    for (let attempt = 0; attempt < getFailureThreshold(); attempt += 1) {
      recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
    }
    // The restart: nothing is held in memory, the next read comes only from disk.
    const reloaded = getCircuitState({ ...SCOPE, now: T0, rootDir });
    assert.strictEqual(reloaded.state, 'open');
    assert.strictEqual(reloaded.consecutive_failures, getFailureThreshold());
    assert.strictEqual(checkCircuit({ ...SCOPE, now: T0, rootDir }).allowed, false);
  });
});

test('circuits are scoped: business, platform and action are all independent', () => {
  withTempRoot((rootDir) => {
    for (let attempt = 0; attempt < getFailureThreshold(); attempt += 1) {
      recordFailure({ ...SCOPE, now: minutesAfter(T0, attempt), rootDir });
    }
    assert.strictEqual(checkCircuit({ ...SCOPE, now: T0, rootDir }).allowed, false);
    // A different action, platform, or business is untouched.
    assert.strictEqual(checkCircuit({ ...SCOPE, action: 'shopify_vendor_correction', now: T0, rootDir }).allowed, true);
    assert.strictEqual(checkCircuit({ ...SCOPE, platform: 'etsy', now: T0, rootDir }).allowed, true);
    assert.strictEqual(checkCircuit({ ...SCOPE, businessId: 'beta-co', now: T0, rootDir }).allowed, true);
    // And one business cannot even see another's circuits.
    assert.strictEqual(listCircuits({ businessId: 'alpha-co', now: T0, rootDir }).length, 1);
    assert.strictEqual(listCircuits({ businessId: 'beta-co', now: T0, rootDir }).length, 0);
  });
});

test('an invalid scope is refused rather than becoming a path or a shared circuit', () => {
  withTempRoot((rootDir) => {
    for (const businessId of ['../escape', 'not a valid id']) {
      const check = checkCircuit({ ...SCOPE, businessId, now: T0, rootDir });
      assert.strictEqual(check.allowed, false);
      assert.strictEqual(check.reason_code, 'invalid_scope');
    }
    assert.strictEqual(circuitBreaker.circuitKey({ businessId: 'alpha-co', platform: 'shopify', action: '' }), null);
    assert.strictEqual(checkCircuit({ ...SCOPE, action: '..', now: T0, rootDir }).allowed, false);
  });
});

test('the breaker thresholds are counts and minutes - never money', () => {
  assert.ok(Number.isInteger(getFailureThreshold()) && getFailureThreshold() > 0);
  assert.ok(Number.isInteger(getCooldownMinutes()) && getCooldownMinutes() > 0);
  withTempRoot((rootDir) => {
    const state = getCircuitState({ ...SCOPE, now: T0, rootDir });
    assert.ok(!/[$€£]|\bcost\b|\bprice\b|\brevenue\b/i.test(JSON.stringify(state)));
  });
});

test('the breaker can never grant permission - it only ever withholds it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'reliability', 'circuitBreaker.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  for (const forbidden of ['evaluateAutonomyPolicy', 'verifyApprovalAuthorization', 'decideApprovalRequest', 'authorizePublishing', 'requiresApproval', 'fetch(']) {
    assert.ok(!code.includes(forbidden), `circuitBreaker.js must not contain ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------
// FIRST-CLASS VERIFY
// ---------------------------------------------------------------------------------

(async () => {
  await testAsync('the in-memory adapter used here is a real, contract-conforming adapter', async () => {
    assert.strictEqual(validateAdapterShape(inMemoryAdapter()).valid, true);
  });

  await testAsync('a correctly applied change verifies', async () => {
    await withTempRootAsync(async (rootDir) => {
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'shopify',
        action: 'shopify_vendor_correction',
        entityKind: 'product',
        entityId: 'p1',
        expected: { brand: 'Correct Vendor' },
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Correct Vendor', title: 'Lamp' }] }),
        rootDir,
      });
      assert.strictEqual(record.status, 'verified');
      assert.strictEqual(record.verified, true);
      assert.ok(record.findings.every((finding) => finding.matched));
      assert.ok(VERIFICATION_STATUSES.includes(record.status));
    });
  });

  await testAsync('a wrongly applied change is a mismatch, and names the field', async () => {
    await withTempRootAsync(async (rootDir) => {
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'shopify',
        action: 'shopify_vendor_correction',
        entityKind: 'product',
        entityId: 'p1',
        expected: { brand: 'Correct Vendor' },
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Something Else', title: 'Lamp' }] }),
        rootDir,
      });
      assert.strictEqual(record.status, 'mismatch');
      assert.strictEqual(record.verified, false);
      assert.strictEqual(record.reason_code, 'state_mismatch');
      const finding = record.findings.find((entry) => entry.field === 'brand');
      assert.deepStrictEqual([finding.expected, finding.observed, finding.matched], ['Correct Vendor', 'Something Else', false]);
    });
  });

  await testAsync('a missing target entity is not_found, never a silent pass', async () => {
    await withTempRootAsync(async (rootDir) => {
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'shopify',
        action: 'shopify_vendor_correction',
        entityKind: 'product',
        entityId: 'p-gone',
        expected: { brand: 'Correct Vendor' },
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Correct Vendor' }] }),
        rootDir,
      });
      assert.strictEqual(record.status, 'not_found');
      assert.strictEqual(record.verified, false);
    });
  });

  await testAsync('an unintended mutation is detected where a baseline exists', async () => {
    await withTempRootAsync(async (rootDir) => {
      const shared = {
        businessId: 'alpha-co',
        platform: 'shopify',
        action: 'shopify_vendor_correction',
        entityKind: 'product',
        entityId: 'p1',
        expected: { brand: 'Correct Vendor' },
        enabledPlatforms: ['shopify'],
        rootDir,
      };
      const collateral = await verifyExecution({
        ...shared,
        baseline: { title: 'Lamp' },
        unexpectedFields: ['title'],
        adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Correct Vendor', title: 'Renamed by accident' }] }),
      });
      assert.strictEqual(collateral.status, 'mismatch');
      assert.strictEqual(collateral.reason_code, 'unintended_mutation');
      assert.deepStrictEqual(collateral.unintended_mutations, [{ field: 'title', before: 'Lamp', after: 'Renamed by accident' }]);

      // Without a baseline nothing is asserted about collateral change - it is never
      // claimed absent merely because it was not looked for.
      const noBaseline = await verifyExecution({
        ...shared,
        entityId: 'p2',
        unexpectedFields: ['title'],
        adapter: inMemoryAdapter({ products: [{ id: 'p2', brand: 'Correct Vendor', title: 'Anything' }] }),
      });
      assert.strictEqual(noBaseline.status, 'verified');
      assert.deepStrictEqual(noBaseline.unintended_mutations, []);
    });
  });

  await testAsync('a platform that cannot answer is unverifiable - no fake verification', async () => {
    await withTempRootAsync(async (rootDir) => {
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'etsy',
        action: 'some_inventory_change',
        entityKind: 'inventory_item',
        entityId: 'i1',
        expected: { available_total: 5 },
        enabledPlatforms: ['etsy'],
        adapter: inMemoryAdapter({ unsupported: ['getInventoryLevels'] }),
        rootDir,
      });
      assert.strictEqual(record.status, 'unverifiable');
      assert.strictEqual(record.verified, false, 'unverifiable must never count as success');
      assert.strictEqual(record.reason_code, 'capability_unsupported');

      // An entity kind nothing here observes is equally unverifiable.
      const plan = planVerification({ businessId: 'alpha-co', platform: 'shopify', entityKind: 'advertisement', enabledPlatforms: ['shopify'] });
      assert.strictEqual(plan.verifiable, false);
      assert.strictEqual(plan.reason_code, 'entity_kind_not_observable');
      assert.deepStrictEqual(VERIFIABLE_ENTITY_KINDS.sort(), ['collection', 'inventory_item', 'product', 'shop']);
    });
  });

  await testAsync('a disabled platform is not read even to verify', async () => {
    await withTempRootAsync(async (rootDir) => {
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'etsy',
        action: 'x',
        entityKind: 'product',
        entityId: 'e1',
        expected: { title: 'anything' },
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ products: [{ id: 'e1', title: 'anything' }] }),
        rootDir,
      });
      assert.strictEqual(record.status, 'unverifiable');
      assert.strictEqual(record.reason_code, 'platform_not_enabled');
    });
  });

  await testAsync('a failed verification read is reported as failed, and leaks nothing', async () => {
    await withTempRootAsync(async (rootDir) => {
      const adapter = inMemoryAdapter();
      adapter.getProducts = async () => {
        throw new Error('503 from https://internal.example/admin?token=CANARY-DO-NOT-LEAK');
      };
      const record = await verifyExecution({
        businessId: 'alpha-co',
        platform: 'shopify',
        action: 'x',
        entityKind: 'product',
        entityId: 'p1',
        expected: { brand: 'v' },
        enabledPlatforms: ['shopify'],
        adapter,
        rootDir,
      });
      assert.strictEqual(record.status, 'failed');
      assert.strictEqual(record.verified, false);
      assert.ok(!JSON.stringify(record).includes('CANARY-DO-NOT-LEAK'));
    });
  });

  // ---------------------------------------------------------------------------------
  // REQUIRED PROOFS: retry protection / no duplicate consequential action
  // ---------------------------------------------------------------------------------

  await testAsync('the same intended change always computes the same idempotency key', async () => {
    const intent = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected: { brand: 'V' } };
    assert.strictEqual(computeIdempotencyKey(intent), computeIdempotencyKey({ ...intent }));
    // Key order in `expected` must not matter.
    assert.strictEqual(
      computeIdempotencyKey({ ...intent, expected: { a: 1, b: 2 } }),
      computeIdempotencyKey({ ...intent, expected: { b: 2, a: 1 } })
    );
    // A different target, value, action, platform or business is a different action.
    for (const different of [
      { entityId: 'p2' },
      { expected: { brand: 'W' } },
      { action: 'shopify_inventory_correction' },
      { platform: 'etsy' },
      { businessId: 'beta-co' },
    ]) {
      assert.notStrictEqual(computeIdempotencyKey({ ...intent, ...different }), computeIdempotencyKey(intent));
    }
  });

  await testAsync('an already-verified change is never applied a second time', async () => {
    await withTempRootAsync(async (rootDir) => {
      const intent = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected: { brand: 'Correct Vendor' } };
      const key = computeIdempotencyKey(intent);

      assert.strictEqual(checkIdempotency(key, { businessId: 'alpha-co', rootDir }).allowed, true, 'a change never made must be permitted');

      await verifyExecution({ ...intent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Correct Vendor' }] }), rootDir });

      const retry = checkIdempotency(key, { businessId: 'alpha-co', rootDir });
      assert.strictEqual(retry.allowed, false);
      assert.strictEqual(retry.reason_code, 'already_completed');

      // A restart changes nothing: the key is derived and the record is on disk.
      assert.strictEqual(getVerificationRecord(key, { businessId: 'alpha-co', rootDir }).status, 'verified');
      assert.strictEqual(checkIdempotency(key, { businessId: 'alpha-co', rootDir }).allowed, false);
    });
  });

  await testAsync('a completed record is never downgraded by later drift', async () => {
    await withTempRootAsync(async (rootDir) => {
      const intent = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected: { brand: 'Correct Vendor' } };
      const key = computeIdempotencyKey(intent);
      await verifyExecution({ ...intent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Correct Vendor' }] }), rootDir });

      // Someone else changes the value afterwards and the action is re-verified.
      const later = await verifyExecution({ ...intent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Changed By Someone' }] }), rootDir });
      assert.strictEqual(later.status, 'mismatch', 'the caller must still be told about the drift');
      // But the completion stands, so the duplicate guard does not silently reopen.
      assert.strictEqual(getVerificationRecord(key, { businessId: 'alpha-co', rootDir }).status, 'verified');
      assert.strictEqual(checkIdempotency(key, { businessId: 'alpha-co', rootDir }).allowed, false);
    });
  });

  await testAsync('a change that FAILED may still be retried', async () => {
    await withTempRootAsync(async (rootDir) => {
      const intent = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected: { brand: 'Correct Vendor' } };
      await verifyExecution({ ...intent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'Wrong' }] }), rootDir });
      // Retrying something that did not happen is legitimate - the breaker is what stops
      // that becoming a loop.
      assert.strictEqual(checkIdempotency(computeIdempotencyKey(intent), { businessId: 'alpha-co', rootDir }).allowed, true);
    });
  });

  await testAsync('business isolation: one business\'s completion never satisfies another\'s', async () => {
    await withTempRootAsync(async (rootDir) => {
      const alphaIntent = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected: { brand: 'V' } };
      await verifyExecution({ ...alphaIntent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'V' }] }), rootDir });

      const alphaKey = computeIdempotencyKey(alphaIntent);
      assert.strictEqual(checkIdempotency(alphaKey, { businessId: 'alpha-co', rootDir }).allowed, false);
      // Beta computes a different key for the same-looking change, and cannot read alpha's.
      assert.notStrictEqual(computeIdempotencyKey({ ...alphaIntent, businessId: 'beta-co' }), alphaKey);
      assert.strictEqual(getVerificationRecord(alphaKey, { businessId: 'beta-co', rootDir }), null);
      assert.strictEqual(checkIdempotency(alphaKey, { businessId: 'beta-co', rootDir }).allowed, true);
    });
  });

  await testAsync('a verification record never carries a credential', async () => {
    await withTempRootAsync(async (rootDir) => {
      const saved = {
        SHOPIFY_ADMIN_API_ACCESS_TOKEN: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      };
      process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_CANARY-DO-NOT-LEAK-3f9a7c2e';
      try {
        const intent = { businessId: 'alpha-co', platform: 'shopify', action: 'x', entityKind: 'product', entityId: 'p1', expected: { brand: 'V' } };
        await verifyExecution({ ...intent, enabledPlatforms: ['shopify'], adapter: inMemoryAdapter({ products: [{ id: 'p1', brand: 'V' }] }), rootDir });
        const onDisk = fs.readFileSync(path.join(rootDir, 'alpha-co', `${computeIdempotencyKey(intent)}.json`), 'utf8');
        assert.ok(!onDisk.includes('CANARY-DO-NOT-LEAK'));
        assert.strictEqual(executionVerification.findCredentialKeyPath(JSON.parse(onDisk)), null);
        assert.throws(
          () => executionVerification.saveVerificationRecord({ ...JSON.parse(onDisk), access_token: 'x' }, { rootDir }),
          /credential-shaped/
        );
      } finally {
        if (saved.SHOPIFY_ADMIN_API_ACCESS_TOKEN === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
        else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = saved.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      }
    });
  });

  test('verification verifies - it never repairs, retries or writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'reliability', 'executionVerification.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of [
      'productUpdate',
      'inventoryAdjustQuantities',
      'collectionAddProducts',
      'publishListing',
      'authorizePublishing',
      'decideApprovalRequest',
      "require('../approvals",
      "require('../integrations/adapters/shopifyClient",
      "require('../integrations/adapters/etsyReadClient",
      'fetch(',
      'setTimeout(',
    ]) {
      assert.ok(!code.includes(forbidden), `executionVerification.js must not contain ${forbidden}`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('reliabilityControls.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
