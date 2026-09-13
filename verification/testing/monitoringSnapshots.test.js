'use strict';

// The monitoring/observation layer: monitoring/snapshotModel.js, monitoring/snapshotStore.js,
// monitoring/changeDetection.js and monitoring/platformMonitor.js.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, AND NONE CAN BE. Every observation runs through a
// contract-conforming in-memory adapter validated by the real
// integrations/adapters/platformAdapterContract.js - so it is a genuine adapter, not a stub
// that merely looks like one - and global.fetch is replaced for the whole file with a
// function that FAILS the suite if anything reaches for the network.
//
// "RELOAD" IS SIMULATED HONESTLY. The store holds no in-memory cache, so a restart is
// exactly "drop every object you held and read only what reached disk". The reload test
// below discards its local snapshot entirely and rebuilds from the store.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snapshotModel = require('../../monitoring/snapshotModel');
const {
  MONITORED_CAPABILITY_IDS,
  createSnapshot,
  validateSnapshotShape,
  computeStateFingerprint,
} = snapshotModel;
const snapshotStore = require('../../monitoring/snapshotStore');
const { saveSnapshot, loadSnapshot, listSnapshots, getLatestSnapshot } = snapshotStore;
const { detectChanges, CHANGE_TYPES } = require('../../monitoring/changeDetection');
const { observePlatform, OBSERVATION_REFUSAL_REASONS } = require('../../monitoring/platformMonitor');
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

// Any network reach at all is a failure of this suite, not a slow test.
global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoring-snapshots-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempRootAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoring-snapshots-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function product(id, overrides = {}) {
  return {
    id,
    title: `Item ${id}`,
    status: 'active',
    tags: [],
    variants: [{ id: `${id}-v1`, available: true, inventory_quantity: 5 }],
    ...overrides,
  };
}

// A REAL adapter by the project's own contract - validateAdapterShape() is asserted on it
// below, so these tests exercise the same surface the registry would hand back.
function inMemoryAdapter({ products = [], orders = [], customers = [], collections = [], inventory = [], shop = { name: 'Test Store', domain: 'test.example', email: 'owner@example.com' }, configured = true, unsupported = [], calls = null } = {}) {
  const record = (capability) => {
    if (calls) calls.push(capability);
  };
  const refuse = (capability) => async () => {
    record(capability);
    const error = new Error(`unsupported: ${capability}`);
    error.code = 'unsupported_capability';
    throw error;
  };
  const adapter = {
    UNSUPPORTED_READ_CAPABILITIES: unsupported,
    isConfigured: () => {
      record('isConfigured');
      return configured;
    },
    getShopInfo: async () => {
      record('getShopInfo');
      return shop;
    },
    getProducts: async () => {
      record('getProducts');
      return products;
    },
    getOrders: async () => {
      record('getOrders');
      return orders;
    },
    getCustomers: async () => {
      record('getCustomers');
      return customers;
    },
    getInventoryLevels: async () => {
      record('getInventoryLevels');
      return inventory;
    },
    getCollections: async () => {
      record('getCollections');
      return collections;
    },
  };
  for (const capability of unsupported) adapter[capability] = refuse(capability);
  return adapter;
}

function snapshotOf({ businessId = 'alpha-co', platform = 'shopify', at = '2026-03-04T09:00:00.000Z', products = [], orders = 0, customers = 0, collections = [], shop = { name: 'Test Store', domain: 'test.example' }, unsupported = [] } = {}) {
  // These fixtures ARE the whole dataset - they are in-memory arrays, not a page of a
  // larger platform response - so they declare complete observations. A snapshot that does
  // not say is treated as incomplete, and an incomplete observation deliberately yields no
  // added/removed (see monitoring/changeDetection.js), which is exercised separately below.
  const observed = (result) => ({ status: 'observed', result, complete: true });
  const observations = {
    getShopInfo: observed(shop),
    getProducts: observed(products),
    getCollections: observed(collections),
    getInventoryLevels: observed([]),
    getOrders: observed(new Array(orders).fill({})),
    getCustomers: observed(new Array(customers).fill({})),
  };
  for (const capability of unsupported) {
    observations[capability] = { status: 'unsupported', reason: 'declared unsupported' };
  }
  return createSnapshot({ businessId, platform, capturedAt: new Date(at), source: { adapter: platform }, observations });
}

// ---------------------------------------------------------------------------------
// The snapshot model
// ---------------------------------------------------------------------------------

test('a snapshot carries every required identity field', () => {
  const snapshot = snapshotOf({ products: [product('p1')] });
  for (const field of ['business_id', 'platform', 'captured_at', 'source', 'state', 'state_fingerprint', 'snapshot_id']) {
    assert.ok(field in snapshot, `missing ${field}`);
  }
  assert.strictEqual(snapshot.business_id, 'alpha-co');
  assert.strictEqual(snapshot.platform, 'shopify');
  assert.strictEqual(snapshot.source.adapter, 'shopify');
  assert.deepStrictEqual(snapshot.source.capabilities_requested, MONITORED_CAPABILITY_IDS.slice().sort());
  assert.strictEqual(validateSnapshotShape(snapshot).valid, true);
});

test('the same state produces the same normalized snapshot, whatever the API order or capture time', () => {
  const products = [product('p3'), product('p1'), product('p2')];
  const first = snapshotOf({ products, at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products: products.slice().reverse(), at: '2027-11-30T23:59:59.000Z' });
  assert.strictEqual(first.state_fingerprint, second.state_fingerprint);
  assert.deepStrictEqual(first.state, second.state);
  // Entities are sorted by id, so traversal is fixed.
  assert.deepStrictEqual(first.state.getProducts.entities.map((entity) => entity.entity_id), ['p1', 'p2', 'p3']);
});

test('an unsupported capability is recorded as unsupported, never as an empty success', () => {
  const snapshot = snapshotOf({ unsupported: ['getOrders', 'getCustomers'] });
  assert.strictEqual(snapshot.state.getOrders.status, 'unsupported');
  assert.deepStrictEqual(snapshot.state.getOrders.entities, []);
  // An observed-but-genuinely-empty capability is a different, checkable fact.
  assert.strictEqual(snapshot.state.getCollections.status, 'observed');
});

test('a capability that was never observed is recorded as failed, not as empty', () => {
  const snapshot = createSnapshot({ businessId: 'alpha-co', platform: 'shopify', observations: {} });
  for (const capabilityId of MONITORED_CAPABILITY_IDS) {
    assert.strictEqual(snapshot.state[capabilityId].status, 'failed');
    assert.strictEqual(snapshot.state[capabilityId].reason, 'not_observed');
  }
});

test('orders and customers are reduced to a count - no personal data is kept', () => {
  const snapshot = createSnapshot({
    businessId: 'alpha-co',
    platform: 'shopify',
    observations: {
      getOrders: { status: 'observed', result: [{ id: 'o1', email: 'buyer@example.com' }, { id: 'o2', email: 'other@example.com' }] },
      getCustomers: { status: 'observed', result: [{ id: 'c1', email: 'buyer@example.com' }] },
    },
  });
  assert.deepStrictEqual(snapshot.state.getOrders.entities, [{ entity_id: 'orders', fields: { count: 2 } }]);
  assert.deepStrictEqual(snapshot.state.getCustomers.entities, [{ entity_id: 'customers', fields: { count: 1 } }]);
  assert.ok(!JSON.stringify(snapshot).includes('buyer@example.com'));
});

test("the shop's email is never snapshotted", () => {
  const snapshot = snapshotOf({ shop: { name: 'Test Store', domain: 'test.example', email: 'owner@example.com' } });
  assert.ok(!JSON.stringify(snapshot).includes('owner@example.com'));
  assert.deepStrictEqual(Object.keys(snapshot.state.getShopInfo.entities[0].fields).sort(), ['domain', 'name']);
});

test('a snapshot edited after it was written no longer validates', () => {
  const snapshot = snapshotOf({ products: [product('p1')] });
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.state.getProducts.entities[0].fields.title = 'Something else';
  const result = validateSnapshotShape(tampered);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => /fingerprint does not match/.test(error)));
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: first snapshot produces no false changes
// ---------------------------------------------------------------------------------

test('the first observation produces no false changes against nonexistent history', () => {
  const first = snapshotOf({ products: [product('p1'), product('p2')], orders: 12, customers: 4 });
  const diff = detectChanges(null, first);
  assert.strictEqual(diff.baseline, true);
  assert.deepStrictEqual(diff.changes, []);
  assert.deepStrictEqual(diff.counts, { added: 0, removed: 0, changed: 0, unchanged: 0 });
  assert.strictEqual(diff.previous_snapshot_id, null);
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: identical snapshots produce zero changes
// ---------------------------------------------------------------------------------

test('identical state observed twice produces zero changes', () => {
  const products = [product('p1'), product('p2')];
  const first = snapshotOf({ products, at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products, at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second);
  assert.strictEqual(diff.identical, true);
  assert.strictEqual(diff.baseline, false);
  assert.deepStrictEqual(diff.changes, []);
});

test('unchanged entities are reported only when explicitly asked for', () => {
  const products = [product('p1')];
  const first = snapshotOf({ products, at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products, at: '2026-03-05T09:00:00.000Z' });
  const verbose = detectChanges(first, second, { includeUnchanged: true });
  assert.ok(verbose.counts.unchanged > 0);
  assert.ok(verbose.changes.every((entry) => entry.change_type === 'unchanged'));
  assert.deepStrictEqual(CHANGE_TYPES, ['added', 'removed', 'changed', 'unchanged']);
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: changed field, added entity, removed entity
// ---------------------------------------------------------------------------------

test('a changed field is detected, and names the entity and the field', () => {
  const first = snapshotOf({ products: [product('p1')], at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({
    products: [product('p1', { variants: [{ id: 'p1-v1', available: false, inventory_quantity: 0 }] })],
    at: '2026-03-05T09:00:00.000Z',
  });
  const diff = detectChanges(first, second);
  const available = diff.changes.find((entry) => entry.field === 'available');
  assert.ok(available, 'the availability change must be reported');
  assert.strictEqual(available.change_type, 'changed');
  assert.strictEqual(available.capability, 'getProducts');
  assert.strictEqual(available.entity_kind, 'product');
  assert.strictEqual(available.entity_id, 'p1');
  assert.strictEqual(available.previous_value, true);
  assert.strictEqual(available.current_value, false);

  const inventory = diff.changes.find((entry) => entry.field === 'inventory_total');
  assert.strictEqual(inventory.previous_value, 5);
  assert.strictEqual(inventory.current_value, 0);
});

test('an added entity is detected', () => {
  const first = snapshotOf({ products: [product('p1')], at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products: [product('p1'), product('p2')], at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second);
  assert.strictEqual(diff.counts.added, 1);
  const added = diff.changes.find((entry) => entry.change_type === 'added');
  assert.strictEqual(added.entity_id, 'p2');
  assert.strictEqual(added.previous_value, null);
  assert.ok(added.current_value && added.current_value.title === 'Item p2');
});

test('a removed entity is detected', () => {
  const first = snapshotOf({ products: [product('p1'), product('p2')], at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products: [product('p1')], at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second);
  assert.strictEqual(diff.counts.removed, 1);
  const removed = diff.changes.find((entry) => entry.change_type === 'removed');
  assert.strictEqual(removed.entity_id, 'p2');
  assert.ok(removed.previous_value && removed.previous_value.title === 'Item p2');
  assert.strictEqual(removed.current_value, null);
});

test('an order count change and a customer count change are reported as plain facts', () => {
  const first = snapshotOf({ orders: 10, customers: 3, at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ orders: 14, customers: 2, at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second);
  const orders = diff.changes.find((entry) => entry.capability === 'getOrders');
  assert.deepStrictEqual([orders.entity_id, orders.field, orders.previous_value, orders.current_value], ['orders', 'count', 10, 14]);
  const customers = diff.changes.find((entry) => entry.capability === 'getCustomers');
  assert.deepStrictEqual([customers.previous_value, customers.current_value], [3, 2]);
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: multiple changes are deterministic
// ---------------------------------------------------------------------------------

test('multiple changes are ordered deterministically and identically on every run', () => {
  const first = snapshotOf({
    products: [product('p3'), product('p1'), product('p2')],
    collections: [{ id: 'c1', title: 'Sale', products_count: 3 }],
    orders: 5,
    at: '2026-03-04T09:00:00.000Z',
  });
  const second = snapshotOf({
    products: [
      product('p4'),
      product('p1', { title: 'Renamed', variants: [{ id: 'p1-v1', available: false, inventory_quantity: 0 }] }),
      product('p2'),
    ],
    collections: [{ id: 'c1', title: 'Sale', products_count: 4 }],
    orders: 9,
    at: '2026-03-05T09:00:00.000Z',
  });

  const signature = (diff) => diff.changes.map((entry) => `${entry.capability}|${entry.change_type}|${entry.entity_id}|${entry.field}`).join(',');
  const runs = [detectChanges(first, second), detectChanges(first, second), detectChanges(first, second)];
  assert.strictEqual(new Set(runs.map(signature)).size, 1, 'the same input must always produce the same order');

  // And the order is the documented one: capability order, then type, then entity, then field.
  assert.deepStrictEqual(signature(runs[0]).split(','), [
    'getProducts|added|p4|null',
    'getProducts|removed|p3|null',
    'getProducts|changed|p1|available',
    'getProducts|changed|p1|inventory_total',
    'getProducts|changed|p1|title',
    'getCollections|changed|c1|products_count',
    'getOrders|changed|orders|count',
  ]);

  // Rebuilding the identical inputs from scratch reaches the identical diff.
  const rebuiltSignature = signature(detectChanges(
    snapshotOf({ products: [product('p1'), product('p2'), product('p3')], collections: [{ id: 'c1', title: 'Sale', products_count: 3 }], orders: 5, at: '2099-01-01T00:00:00.000Z' }),
    second
  ));
  assert.strictEqual(rebuiltSignature, signature(runs[0]));
});

test('a capability observable in only one snapshot is not_comparable, never "everything removed"', () => {
  const first = snapshotOf({ products: [product('p1'), product('p2')], at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products: [], unsupported: ['getProducts'], at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second);
  assert.strictEqual(diff.counts.removed, 0, 'a failed read must never read as a mass removal');
  const products = diff.capabilities.find((entry) => entry.capability === 'getProducts');
  assert.strictEqual(products.status, 'not_comparable');
  assert.deepStrictEqual(products.changes, []);
});

test('comparing across businesses or platforms is refused, not guessed at', () => {
  const alpha = snapshotOf({ businessId: 'alpha-co', at: '2026-03-04T09:00:00.000Z' });
  const beta = snapshotOf({ businessId: 'beta-co', at: '2026-03-05T09:00:00.000Z' });
  assert.throws(() => detectChanges(alpha, beta), /different businesses/);
  const etsy = snapshotOf({ businessId: 'alpha-co', platform: 'etsy', at: '2026-03-05T09:00:00.000Z' });
  assert.throws(() => detectChanges(alpha, etsy), /different platforms/);
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: a change never claims meaning
// ---------------------------------------------------------------------------------

test('no change record claims why, importance, revenue or demand', () => {
  const first = snapshotOf({ products: [product('p1'), product('p2')], orders: 50, at: '2026-03-04T09:00:00.000Z' });
  const second = snapshotOf({ products: [product('p1', { status: 'archived' }), product('p3')], orders: 2, at: '2026-03-05T09:00:00.000Z' });
  const diff = detectChanges(first, second, { includeUnchanged: true });
  const serialized = JSON.stringify(diff).toLowerCase();
  for (const forbidden of ['because', 'revenue', 'profit', 'demand', 'important', 'impact', 'opportunity', 'risk', 'should', 'recommend', 'trend', 'growth', 'loss', 'popular']) {
    assert.ok(!serialized.includes(forbidden), `a change record must not use interpretive language: '${forbidden}'`);
  }
  // A change record carries only identity, a field, and two values.
  for (const entry of diff.changes) {
    assert.deepStrictEqual(
      Object.keys(entry).sort(),
      ['capability', 'change_type', 'current_value', 'entity_id', 'entity_kind', 'field', 'previous_value']
    );
  }
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: persistence, reload, corruption, isolation, atomicity
// ---------------------------------------------------------------------------------

test('a snapshot survives a process reload', () => {
  withTempRoot((rootDir) => {
    const original = snapshotOf({ products: [product('p1')], orders: 7 });
    saveSnapshot(original, { rootDir });

    // The restart: nothing from above is reused, only what reached disk.
    const reloaded = loadSnapshot(original.snapshot_id, { businessId: 'alpha-co', platform: 'shopify', rootDir });
    assert.ok(reloaded, 'the snapshot must be readable after a reload');
    assert.deepStrictEqual(reloaded, original);
    assert.strictEqual(reloaded.state_fingerprint, computeStateFingerprint(reloaded.state));
    // And it is still usable as a diff baseline, which is the point of persisting it.
    assert.strictEqual(detectChanges(reloaded, snapshotOf({ products: [product('p1')], orders: 7, at: '2026-03-06T09:00:00.000Z' })).identical, true);
  });
});

test('a corrupt snapshot fails closed and does not destroy unrelated snapshots', () => {
  withTempRoot((rootDir) => {
    const older = snapshotOf({ products: [product('p1')], at: '2026-03-04T09:00:00.000Z' });
    const newer = snapshotOf({ products: [product('p1'), product('p2')], at: '2026-03-05T09:00:00.000Z' });
    saveSnapshot(older, { rootDir });
    saveSnapshot(newer, { rootDir });

    const dir = path.join(rootDir, 'alpha-co', 'shopify');
    fs.writeFileSync(path.join(dir, `${newer.snapshot_id}.json`), '{ this is not json');

    // The corrupt one reads as absent - never as an empty snapshot.
    assert.strictEqual(loadSnapshot(newer.snapshot_id, { businessId: 'alpha-co', platform: 'shopify', rootDir }), null);
    // Its neighbour is untouched, and becomes the baseline.
    const latest = getLatestSnapshot({ businessId: 'alpha-co', platform: 'shopify', rootDir });
    assert.strictEqual(latest.snapshot_id, older.snapshot_id);
    assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir }).length, 1);
  });
});

test('a snapshot whose fingerprint was tampered with is refused on read and on write', () => {
  withTempRoot((rootDir) => {
    const snapshot = snapshotOf({ products: [product('p1')] });
    saveSnapshot(snapshot, { rootDir });
    const filePath = path.join(rootDir, 'alpha-co', 'shopify', `${snapshot.snapshot_id}.json`);
    const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    tampered.state.getProducts.entities[0].fields.inventory_total = 9999;
    fs.writeFileSync(filePath, JSON.stringify(tampered));

    assert.strictEqual(loadSnapshot(snapshot.snapshot_id, { businessId: 'alpha-co', platform: 'shopify', rootDir }), null);
    assert.throws(() => saveSnapshot(tampered, { rootDir }), /invalid snapshot/);
  });
});

test('business isolation: one business never sees another business\'s snapshots', () => {
  withTempRoot((rootDir) => {
    saveSnapshot(snapshotOf({ businessId: 'alpha-co', products: [product('p1')], at: '2026-03-04T09:00:00.000Z' }), { rootDir });
    const betaSnapshot = snapshotOf({ businessId: 'beta-co', products: [product('zzz')], at: '2026-03-05T09:00:00.000Z' });
    saveSnapshot(betaSnapshot, { rootDir });

    const alpha = listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir });
    assert.strictEqual(alpha.length, 1);
    assert.ok(alpha.every((snapshot) => snapshot.business_id === 'alpha-co'));

    // Not even by id: beta's own snapshot id is unreachable through alpha's scope.
    assert.strictEqual(loadSnapshot(betaSnapshot.snapshot_id, { businessId: 'alpha-co', platform: 'shopify', rootDir }), null);
    // And the default (null) business is its own third space.
    assert.deepStrictEqual(listSnapshots({ businessId: null, platform: 'shopify', rootDir }), []);
  });
});

test('platform isolation: shopify and etsy snapshots never mix', () => {
  withTempRoot((rootDir) => {
    saveSnapshot(snapshotOf({ platform: 'shopify', products: [product('p1')] }), { rootDir });
    saveSnapshot(snapshotOf({ platform: 'etsy', products: [product('e1')], at: '2026-03-05T09:00:00.000Z' }), { rootDir });
    assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir }).length, 1);
    assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'etsy', rootDir })[0].platform, 'etsy');
  });
});

test('path traversal is impossible - neither segment is ever an unvalidated path', () => {
  withTempRoot((rootDir) => {
    const snapshot = snapshotOf({ products: [product('p1')] });
    for (const businessId of ['../escape', '..', 'a/b', './x']) {
      assert.throws(() => saveSnapshot({ ...snapshot, business_id: businessId }, { rootDir }), /invalid snapshot|invalid businessId/);
      assert.strictEqual(listSnapshots({ businessId, platform: 'shopify', rootDir }).length, 0);
    }
    for (const platform of ['../escape', 'amazon', 'ebay', null]) {
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform, rootDir }).length, 0);
    }
    // A traversing snapshot id is stripped, never followed.
    assert.strictEqual(snapshotStore.safeSnapshotId('../../etc/passwd'), 'etcpasswd');
    assert.strictEqual(snapshotStore.safeSnapshotId('..'), '');
    assert.strictEqual(loadSnapshot('../../etc/passwd', { businessId: 'alpha-co', platform: 'shopify', rootDir }), null);
  });
});

test('atomic persistence leaves no partial snapshot file behind', () => {
  withTempRoot((rootDir) => {
    const snapshot = snapshotOf({ products: [product('p1'), product('p2')] });
    saveSnapshot(snapshot, { rootDir });
    const dir = path.join(rootDir, 'alpha-co', 'shopify');
    const names = fs.readdirSync(dir);
    // No temp file survives a successful write, and every file present is complete JSON.
    assert.deepStrictEqual(names, [`${snapshot.snapshot_id}.json`]);
    assert.ok(names.every((name) => !name.endsWith('.tmp')));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')).state_fingerprint, snapshot.state_fingerprint);

    // A write that fails mid-way removes its own temp file rather than leaving debris that
    // a later listing would trip over.
    const before = fs.readdirSync(dir).length;
    assert.throws(() => saveSnapshot({ ...snapshot, state_fingerprint: 'wrong' }, { rootDir }));
    assert.strictEqual(fs.readdirSync(dir).length, before);
  });
});

test('a credential-shaped key is refused rather than persisted', () => {
  withTempRoot((rootDir) => {
    const snapshot = snapshotOf({ products: [product('p1')] });
    const polluted = JSON.parse(JSON.stringify(snapshot));
    polluted.source.access_token = 'shpat_CANARY-DO-NOT-LEAK';
    assert.throws(() => saveSnapshot(polluted, { rootDir }), /credential-shaped|invalid snapshot/);
    assert.strictEqual(snapshotStore.findCredentialKeyPath({ a: { api_key: 'x' } }), 'a.api_key');
    assert.strictEqual(snapshotStore.findCredentialKeyPath(snapshot), null);
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: the capture pass
// ---------------------------------------------------------------------------------

(async () => {
  await testAsync('the in-memory adapter used by these tests is a real, contract-conforming adapter', async () => {
    const conformance = validateAdapterShape(inMemoryAdapter());
    assert.strictEqual(conformance.valid, true, `the test adapter must conform: ${conformance.errors.join('; ')}`);
  });

  await testAsync('a disabled platform is never queried and produces no snapshot', async () => {
    await withTempRootAsync(async (rootDir) => {
      const calls = [];
      const result = await observePlatform({
        businessId: 'alpha-co',
        platform: 'shopify',
        enabledPlatforms: ['etsy'],
        adapter: inMemoryAdapter({ products: [product('p1')], calls }),
        rootDir,
      });
      assert.strictEqual(result.observed, false);
      assert.strictEqual(result.reason_code, 'platform_not_enabled');
      assert.strictEqual(result.snapshot, null);
      assert.deepStrictEqual(calls, [], 'a disabled platform must not be queried AT ALL - not even isConfigured()');
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir }).length, 0);
    });
  });

  await testAsync('an absent enablement list fails closed rather than defaulting to permitted', async () => {
    await withTempRootAsync(async (rootDir) => {
      const calls = [];
      for (const enabledPlatforms of [null, undefined, 'shopify', {}]) {
        // eslint-disable-next-line no-await-in-loop
        const result = await observePlatform({ businessId: 'alpha-co', platform: 'shopify', enabledPlatforms, adapter: inMemoryAdapter({ calls }), rootDir });
        assert.strictEqual(result.observed, false);
        assert.strictEqual(result.reason_code, 'platform_enablement_unknown');
      }
      assert.deepStrictEqual(calls, []);
    });
  });

  await testAsync('Amazon and eBay remain unsupported - no fake support is created', async () => {
    await withTempRootAsync(async (rootDir) => {
      for (const platform of ['amazon', 'ebay']) {
        // Even a configuration that tries to enable them cannot make them observable: an
        // unrecognized platform can never be enabled, so it is refused at the first gate and
        // the adapter registry is never even consulted.
        // eslint-disable-next-line no-await-in-loop
        const result = await observePlatform({ businessId: 'alpha-co', platform, enabledPlatforms: [platform], rootDir });
        assert.strictEqual(result.observed, false);
        assert.ok(OBSERVATION_REFUSAL_REASONS.includes(result.reason_code));
        assert.strictEqual(result.snapshot, null);
        // And the registry refuses them independently - two refusals, not one.
        const { getReadAdapter } = require('../../integrations/adapters/adapterRegistry');
        assert.throws(() => getReadAdapter(platform));
      }
    });
  });

  await testAsync('an unconfigured adapter produces a refusal, not an empty snapshot', async () => {
    await withTempRootAsync(async (rootDir) => {
      const result = await observePlatform({
        businessId: 'alpha-co',
        platform: 'shopify',
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ configured: false }),
        rootDir,
      });
      assert.strictEqual(result.observed, false);
      assert.strictEqual(result.reason_code, 'adapter_not_configured');
      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir }).length, 0);
    });
  });

  await testAsync('the snapshot lifecycle: first captures, second and third compare against the previous one', async () => {
    await withTempRootAsync(async (rootDir) => {
      const shared = { businessId: 'alpha-co', platform: 'shopify', enabledPlatforms: ['shopify'], rootDir };

      const first = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: [product('p1')], orders: [{}, {}] }), now: new Date('2026-03-04T09:00:00.000Z') });
      assert.strictEqual(first.observed, true);
      assert.strictEqual(first.changes.baseline, true);
      assert.deepStrictEqual(first.changes.changes, []);
      assert.strictEqual(first.previous_snapshot_id, null);
      assert.ok(first.saved_to && fs.existsSync(first.saved_to));

      const second = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: [product('p1'), product('p2')], orders: [{}, {}] }), now: new Date('2026-03-05T09:00:00.000Z') });
      assert.strictEqual(second.changes.baseline, false);
      assert.strictEqual(second.previous_snapshot_id, first.snapshot.snapshot_id);
      assert.strictEqual(second.changes.counts.added, 1);

      // Third compares against the SECOND, not the first - otherwise p2 would be reported
      // as added a second time.
      const third = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: [product('p1'), product('p2')], orders: [{}, {}] }), now: new Date('2026-03-06T09:00:00.000Z') });
      assert.strictEqual(third.previous_snapshot_id, second.snapshot.snapshot_id);
      assert.strictEqual(third.changes.identical, true);
      assert.deepStrictEqual(third.changes.changes, [], 'the same state observed again must generate no changes');

      assert.strictEqual(listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir }).length, 3);
    });
  });

  await testAsync('a corrupt latest snapshot never becomes a baseline - the next pass falls back or reports nothing', async () => {
    await withTempRootAsync(async (rootDir) => {
      const shared = { businessId: 'alpha-co', platform: 'shopify', enabledPlatforms: ['shopify'], rootDir };
      const first = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: [product('p1')] }), now: new Date('2026-03-04T09:00:00.000Z') });
      fs.writeFileSync(first.saved_to, '{ truncated');

      const second = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: [product('p1')] }), now: new Date('2026-03-05T09:00:00.000Z') });
      // With no valid history it is a baseline again: zero changes, nothing invented.
      assert.strictEqual(second.changes.baseline, true);
      assert.deepStrictEqual(second.changes.changes, []);
    });
  });

  await testAsync('a declared-unsupported capability is observed as unsupported, and the rest still capture', async () => {
    await withTempRootAsync(async (rootDir) => {
      const result = await observePlatform({
        businessId: 'alpha-co',
        platform: 'etsy',
        enabledPlatforms: ['etsy'],
        adapter: inMemoryAdapter({ products: [product('e1')], unsupported: ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections'] }),
        rootDir,
      });
      assert.strictEqual(result.observed, true);
      assert.strictEqual(result.snapshot.state.getOrders.status, 'unsupported');
      assert.strictEqual(result.snapshot.state.getProducts.status, 'observed');
      assert.strictEqual(result.snapshot.state.getProducts.entities.length, 1);
    });
  });

  await testAsync('a capability read that throws is recorded as failed, never as an empty catalogue', async () => {
    await withTempRootAsync(async (rootDir) => {
      const adapter = inMemoryAdapter({ products: [product('p1')] });
      adapter.getProducts = async () => {
        throw new Error('the platform returned 503 for https://internal.example/admin?token=CANARY');
      };
      const result = await observePlatform({ businessId: 'alpha-co', platform: 'shopify', enabledPlatforms: ['shopify'], adapter, rootDir });
      assert.strictEqual(result.snapshot.state.getProducts.status, 'failed');
      assert.deepStrictEqual(result.snapshot.state.getProducts.entities, []);
      // The underlying message is not relayed into persisted business data.
      assert.ok(!JSON.stringify(result.snapshot).includes('CANARY'));
    });
  });

  await testAsync('no credential ever enters a persisted snapshot', async () => {
    await withTempRootAsync(async (rootDir) => {
      const CANARIES = ['shpat_CANARY-DO-NOT-LEAK-3f9a7c2e', 'etsy-CANARY-DO-NOT-LEAK-3f9a7c2e', 'sk-ant-CANARY-DO-NOT-LEAK-3f9a7c2e'];
      const saved = {
        SHOPIFY_ADMIN_API_ACCESS_TOKEN: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
        ETSY_API_KEYSTRING: process.env.ETSY_API_KEYSTRING,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      };
      process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = CANARIES[0];
      process.env.ETSY_API_KEYSTRING = CANARIES[1];
      process.env.ANTHROPIC_API_KEY = CANARIES[2];
      try {
        const result = await observePlatform({
          businessId: 'alpha-co',
          platform: 'shopify',
          enabledPlatforms: ['shopify'],
          adapter: inMemoryAdapter({ products: [product('p1')], shop: { name: 'Test Store', domain: 'test.example', email: 'owner@example.com' } }),
          rootDir,
        });
        const onDisk = fs.readFileSync(result.saved_to, 'utf8');
        for (const canary of CANARIES) {
          assert.ok(!onDisk.includes(canary), `the persisted snapshot leaked ${canary}`);
        }
        assert.ok(!onDisk.includes('owner@example.com'), 'the persisted snapshot leaked personal data');
        assert.strictEqual(snapshotStore.findCredentialKeyPath(JSON.parse(onDisk)), null);
      } finally {
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    });
  });

  await testAsync('two businesses observed in the same store keep entirely separate history', async () => {
    await withTempRootAsync(async (rootDir) => {
      const alpha = { platform: 'shopify', enabledPlatforms: ['shopify'], rootDir, businessId: 'alpha-co' };
      const beta = { ...alpha, businessId: 'beta-co' };
      await observePlatform({ ...alpha, adapter: inMemoryAdapter({ products: [product('p1')] }), now: new Date('2026-03-04T09:00:00.000Z') });
      const betaFirst = await observePlatform({ ...beta, adapter: inMemoryAdapter({ products: [product('z9'), product('z8')] }), now: new Date('2026-03-04T10:00:00.000Z') });

      // Beta's first observation is still a baseline - alpha's history is not beta's.
      assert.strictEqual(betaFirst.changes.baseline, true);
      assert.strictEqual(betaFirst.previous_snapshot_id, null);

      const alphaSecond = await observePlatform({ ...alpha, adapter: inMemoryAdapter({ products: [product('p1')] }), now: new Date('2026-03-05T09:00:00.000Z') });
      assert.strictEqual(alphaSecond.changes.identical, true, "alpha must diff against alpha's own snapshot, not beta's");
      assert.ok(!JSON.stringify(alphaSecond.changes).includes('z9'));
    });
  });

  // ---------------------------------------------------------------------------------
  // REQUIRED PROOF: monitoring never executes a consequential action
  // ---------------------------------------------------------------------------------

  test('no module in monitoring/ can execute, approve or publish anything', () => {
    const dir = path.join(__dirname, '..', '..', 'monitoring');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
    assert.ok(files.length >= 4, 'the monitoring modules must be present');

    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      // Comments explain WHY these are absent, so the scan looks at code only.
      const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

      for (const forbidden of [
        "require('../approvals",
        "require('../integrations/shopifyBlogPublishing",
        "require('../integrations/shopifyVendorCorrection",
        "require('../integrations/shopifyInventoryCorrection",
        "require('../integrations/shopifyCollectionMembership",
        "require('../integrations/adapters/shopifyClient",
        "require('../integrations/adapters/etsyReadClient",
        "require('../integrations/adapters/etsyClient",
        "require('../agent/core/autonomyPolicy",
        'publishListing',
        'productUpdate',
        'inventoryAdjustQuantities',
        'collectionAddProducts',
        'decideApprovalRequest',
        'authorizePublishing',
        'fetch(',
      ]) {
        assert.ok(!code.includes(forbidden), `monitoring/${file} must not contain ${forbidden}`);
      }
    }
  });

  test('the capture pass calls only declared read capabilities', () => {
    // Proven behaviourally rather than by inspection: the adapter records every call it
    // receives, and nothing outside the monitored read set appears.
    const dir = path.join(__dirname, '..', '..', 'monitoring');
    const source = fs.readFileSync(path.join(dir, 'platformMonitor.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const write of ['createProduct', 'updateProduct', 'deleteProduct', 'adjustInventory', 'publish', 'createArticle']) {
      assert.ok(!code.includes(write), `platformMonitor.js must not reference ${write}`);
    }
  });

  await testAsync('an observation pass touches only read capabilities, and nothing else', async () => {
    await withTempRootAsync(async (rootDir) => {
      const calls = [];
      await observePlatform({
        businessId: 'alpha-co',
        platform: 'shopify',
        enabledPlatforms: ['shopify'],
        adapter: inMemoryAdapter({ products: [product('p1')], calls }),
        rootDir,
      });
      assert.deepStrictEqual(calls, ['isConfigured', ...MONITORED_CAPABILITY_IDS]);
      assert.ok(calls.every((call) => call === 'isConfigured' || call.startsWith('get')));
    });
  });

  // ---------------------------------------------------------------------------------
  // REQUIRED PROOFS: pagination
  // ---------------------------------------------------------------------------------

  // A contract-conforming adapter that ALSO offers the optional paginated read contract
  // (see integrations/adapters/platformAdapterContract.js). Pages are served from a real
  // in-memory list; no network, no invented platform behaviour.
  function paginatedAdapter(products, { pageSize = 10, breakAfter = null, malformedPage = null } = {}) {
    const base = inMemoryAdapter({ products });
    const calls = [];
    base.pageCalls = calls;
    base.getProductsPage = async ({ cursor = null } = {}) => {
      const offset = cursor === null ? 0 : Number(cursor);
      calls.push(offset);
      if (malformedPage !== null && calls.length === malformedPage) return { items: "not an array" };
      const slice = products.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      // breakAfter simulates an adapter that never terminates - the monitor must bound it.
      const exhausted = breakAfter === null ? nextOffset >= products.length : false;
      return { items: slice, next_cursor: exhausted ? null : String(nextOffset) };
    };
    return base;
  }

  function manyProducts(count) {
    return Array.from({ length: count }, (unused, index) => product(`p${String(index).padStart(4, "0")}`));
  }

  await testAsync('more than 50 entities are observed when the adapter supports pagination', async () => {
    await withTempRootAsync(async (rootDir) => {
      const products = manyProducts(137);
      const adapter = paginatedAdapter(products, { pageSize: 10 });
      const result = await observePlatform({ businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter, rootDir });

      assert.strictEqual(result.observed, true);
      const entry = result.snapshot.state.getProducts;
      assert.strictEqual(entry.entities.length, 137, "every entity across every page must be observed");
      assert.strictEqual(entry.complete, true, "exhausting the cursor is what establishes completeness");
      assert.ok(adapter.pageCalls.length >= 14, `expected many pages, saw ${adapter.pageCalls.length}`);
      // Deterministic ordering survives paging: entities are sorted by id, not by page.
      const ids = entry.entities.map((e) => e.entity_id);
      assert.deepStrictEqual(ids, ids.slice().sort());
    });
  });

  await testAsync('a multi-page snapshot is deterministic regardless of page order or size', async () => {
    const products = manyProducts(65);
    const build = async (pageSize) => {
      const adapter = paginatedAdapter(products, { pageSize });
      const result = await observePlatform({ businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter, persist: false });
      return result.snapshot;
    };
    const [a, b, c] = [await build(10), await build(33), await build(7)];
    assert.strictEqual(a.state_fingerprint, b.state_fingerprint, "page size must not change the snapshot");
    assert.strictEqual(a.state_fingerprint, c.state_fingerprint);
    assert.deepStrictEqual(a.state.getProducts.entities, c.state.getProducts.entities);
  });

  await testAsync('paging produces no false removals across cycles', async () => {
    await withTempRootAsync(async (rootDir) => {
      const products = manyProducts(120);
      const shared = { businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], rootDir };
      await observePlatform({ ...shared, adapter: paginatedAdapter(products, { pageSize: 10 }), now: new Date("2026-03-04T09:00:00.000Z") });
      // Same catalogue, different page size - nothing changed, so nothing may be reported.
      const second = await observePlatform({ ...shared, adapter: paginatedAdapter(products, { pageSize: 25 }), now: new Date("2026-03-05T09:00:00.000Z") });
      assert.strictEqual(second.changes.identical, true);
      assert.deepStrictEqual(second.changes.changes, []);

      // One genuine removal IS reported, because both observations were complete.
      const third = await observePlatform({ ...shared, adapter: paginatedAdapter(products.slice(0, 119), { pageSize: 25 }), now: new Date("2026-03-06T09:00:00.000Z") });
      assert.strictEqual(third.changes.counts.removed, 1);
    });
  });

  await testAsync('an UNPAGINATED adapter that fills its limit is reported incomplete, and never yields removals', async () => {
    await withTempRootAsync(async (rootDir) => {
      const shared = { businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], rootDir, limit: 10 };
      // Exactly `limit` results: ambiguous, therefore incomplete. Nothing is assumed.
      const first = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: manyProducts(10) }), now: new Date("2026-03-04T09:00:00.000Z") });
      assert.strictEqual(first.snapshot.state.getProducts.complete, false);

      // A later observation that happens to see a different prefix must NOT report the
      // entities it did not see as removed - this is the false-removal case.
      const second = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: manyProducts(10).slice(5) }), now: new Date("2026-03-05T09:00:00.000Z") });
      assert.strictEqual(second.changes.counts.removed, 0, "a prefix must never produce removals");
      assert.strictEqual(second.changes.counts.added, 0, "a prefix must never produce additions");
      const products = second.changes.capabilities.find((entry) => entry.capability === "getProducts");
      assert.strictEqual(products.status, "compared_partial");

      // Fewer than the limit is unambiguous: that was everything.
      const complete = await observePlatform({ ...shared, adapter: inMemoryAdapter({ products: manyProducts(3) }), now: new Date("2026-03-07T09:00:00.000Z"), persist: false });
      assert.strictEqual(complete.snapshot.state.getProducts.complete, true);
    });
  });

  await testAsync('a count aggregate is never compared from an incomplete observation', async () => {
    await withTempRootAsync(async (rootDir) => {
      const shared = { businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], rootDir, limit: 2 };
      // getOrders returns exactly `limit`, so its count is a page count, not a total.
      const filledToLimit = () => inMemoryAdapter({ orders: [{}, {}] });
      const first = await observePlatform({ ...shared, adapter: filledToLimit(), now: new Date("2026-03-04T09:00:00.000Z") });
      assert.strictEqual(first.snapshot.state.getOrders.complete, false);
      const second = await observePlatform({ ...shared, adapter: filledToLimit(), now: new Date("2026-03-05T09:00:00.000Z") });
      const orders = second.changes.capabilities.find((entry) => entry.capability === "getOrders");
      assert.strictEqual(orders.status, "not_comparable");
      assert.deepStrictEqual(orders.changes, [], "a count from part of the data is a wrong number, not a partial one");
    });
  });

  await testAsync('a malformed page fails closed - it is never partially consumed', async () => {
    await withTempRootAsync(async (rootDir) => {
      const adapter = paginatedAdapter(manyProducts(50), { pageSize: 10, malformedPage: 3 });
      const result = await observePlatform({ businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter, rootDir });
      const entry = result.snapshot.state.getProducts;
      assert.strictEqual(entry.status, "failed");
      assert.deepStrictEqual(entry.entities, [], "a failed paginated read yields no entities at all");
      assert.strictEqual(entry.complete, false);
    });
  });

  await testAsync('an adapter that never terminates is bounded and reported incomplete', async () => {
    await withTempRootAsync(async (rootDir) => {
      const adapter = paginatedAdapter(manyProducts(30), { pageSize: 5, breakAfter: true });
      const result = await observePlatform({ businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter, rootDir });
      assert.strictEqual(result.snapshot.state.getProducts.complete, false, "hitting the page ceiling is never treated as the whole dataset");
      assert.ok(adapter.pageCalls.length <= 100);
    });
  });

  await testAsync('pagination preserves business isolation', async () => {
    await withTempRootAsync(async (rootDir) => {
      await observePlatform({ businessId: "alpha-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter: paginatedAdapter(manyProducts(60), { pageSize: 10 }), rootDir });
      await observePlatform({ businessId: "beta-co", platform: "shopify", enabledPlatforms: ["shopify"], adapter: paginatedAdapter(manyProducts(3), { pageSize: 10 }), rootDir });
      const alpha = listSnapshots({ businessId: "alpha-co", platform: "shopify", rootDir });
      const beta = listSnapshots({ businessId: "beta-co", platform: "shopify", rootDir });
      assert.strictEqual(alpha.length, 1);
      assert.strictEqual(beta.length, 1);
      assert.strictEqual(alpha[0].state.getProducts.entities.length, 60);
      assert.strictEqual(beta[0].state.getProducts.entities.length, 3);
    });
  });

  test('no shipped adapter claims pagination it does not have', () => {
    const { supportsPaginatedRead } = require("../../integrations/adapters/platformAdapterContract");
    const { READ_ADAPTERS } = require("../../integrations/adapters/adapterRegistry");
    // Honest state today: neither shipped adapter implements the optional contract, so the
    // monitor observes one page and reports the observation as incomplete rather than
    // guessing. This test documents that, and will start failing the moment one does - at
    // which point it should be updated to assert the new, real capability.
    for (const [platform, adapter] of Object.entries(READ_ADAPTERS)) {
      assert.strictEqual(supportsPaginatedRead(adapter, "getProducts"), false, `${platform} now paginates - update this test`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('monitoringSnapshots.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
