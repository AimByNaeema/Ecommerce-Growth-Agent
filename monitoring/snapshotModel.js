'use strict';

// The schema for ONE monitoring snapshot: what a platform's observable state looked like
// at one moment, normalized so that two captures of the same state are byte-identical and
// can be compared without interpretation.
//
// SCOPE: schema, normalization and fingerprinting only. Pure functions, no I/O, no network,
// no adapter call - exactly the model/store/engine split agent/core/memoryRecordModel.js
// and approvals/approvalRequestModel.js already use. Persistence lives in
// monitoring/snapshotStore.js, capture in monitoring/platformMonitor.js, comparison in
// monitoring/changeDetection.js.
//
// NORMALIZATION IS THE WHOLE POINT. An adapter returns whatever its platform returns, in
// whatever order the API felt like. A snapshot must be DETERMINISTIC: the same underlying
// state observed twice has to produce the same fingerprint, or every second observation
// would invent changes that did not happen. So entities are sorted by id, fields are a
// fixed list per capability, and the fingerprint is computed over a key-sorted
// serialization rather than over raw JSON.
//
// ONLY FACTS ARE RECORDED - AND ONLY THE FACTS NEEDED TO COMPARE. A snapshot holds an
// entity's identity and the handful of fields whose change is itself a plain observable
// fact (a title, a status, a count, a stock total). It records no judgement, no score, no
// currency amount this project did not already receive as data, and nothing about WHY a
// value is what it is. monitoring/changeDetection.js is bound by the same rule.
//
// DELIBERATELY MINIMAL ON PERSONAL DATA. Orders and customers are reduced to a COUNT and
// nothing else - never a per-order or per-customer record - because "order count changed"
// and "customer count changed" are the observable facts this layer exists to report, and
// keeping an order list on disk would persist real customer data for no gain the diff can
// use. getShopInfo's email is dropped for the same reason: it identifies a person and
// changes nothing this layer can act on.
//
// NO CREDENTIAL EVER ENTERS A SNAPSHOT. Nothing here reads a token, and the store refuses
// to write a credential-shaped key even if something upstream somehow produced one.

const crypto = require('node:crypto');

const SNAPSHOT_VERSION = 1;

// The capabilities this layer observes, in fixed order, each with how its adapter result
// becomes comparable entities. Every id is a REAL capability from
// integrations/adapters/platformAdapterContract.js's REQUIRED_ADAPTER_CAPABILITIES - this
// list narrows that contract, it never extends it, and it invents no capability of its own.
const MONITORED_CAPABILITIES = [
  {
    id: 'getShopInfo',
    title: 'Shop identity',
    entity_kind: 'shop',
    // One fixed entity: the shop itself. Its configured identity changing IS the fact.
    fields: ['name', 'domain'],
  },
  {
    id: 'getProducts',
    title: 'Product catalog',
    entity_kind: 'product',
    fields: ['title', 'status', 'available', 'variant_count', 'inventory_total', 'tag_count'],
  },
  {
    id: 'getCollections',
    title: 'Collection catalog',
    entity_kind: 'collection',
    fields: ['title', 'products_count'],
  },
  {
    id: 'getInventoryLevels',
    title: 'Inventory levels',
    entity_kind: 'inventory_item',
    fields: ['sku', 'tracked', 'available_total'],
  },
  {
    id: 'getOrders',
    title: 'Order volume',
    entity_kind: 'order_aggregate',
    // A COUNT ONLY - see this file's header on personal data.
    fields: ['count'],
  },
  {
    id: 'getCustomers',
    title: 'Customer volume',
    entity_kind: 'customer_aggregate',
    fields: ['count'],
  },
];

const MONITORED_CAPABILITY_IDS = MONITORED_CAPABILITIES.map((capability) => capability.id);

// How a capability's observation turned out. A capability that the platform's adapter has
// DECLARED it cannot serve is 'unsupported' - never an empty success, which would read as
// "the platform has none of these" and is a different, checkable fact (see
// platformAdapterContract.js's own rule on exactly this).
const CAPABILITY_OBSERVATION_STATUSES = ['observed', 'unsupported', 'failed'];

const SNAPSHOT_FIELDS = [
  { id: 'snapshot_version', description: 'Schema version of this snapshot envelope.' },
  { id: 'snapshot_id', description: 'Unique, filename-safe id for this capture: business, platform, capture time and state fingerprint.' },
  { id: 'business_id', description: 'The business this observation belongs to. null is the default single-business deployment.' },
  { id: 'platform', description: "The platform observed, from agent/core/channelModel.js's CHANNELS." },
  { id: 'captured_at', description: 'ISO-8601 UTC timestamp of the capture.' },
  { id: 'source', description: 'Which adapter answered, and which capabilities it was asked for - the source/capability identity.' },
  { id: 'state', description: 'The normalized, comparable state: one entry per monitored capability.' },
  { id: 'state_fingerprint', description: 'sha256 over the normalized state alone. Identical state always yields an identical fingerprint, whatever the capture time.' },
];

// ---------------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------------

// Key-sorted JSON, so object key insertion order can never change a fingerprint.
//
// DUPLICATED ON PURPOSE, not reused: approvals/approvalArchitecture.js has a private
// function of the same shape, and this step must not modify the approval architecture to
// widen its exported surface. Five lines of canonical serialization is the smaller cost.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function computeStateFingerprint(state) {
  return crypto.createHash('sha256').update(stableStringify(state)).digest('hex');
}

// ---------------------------------------------------------------------------------
// Normalizing one adapter result into comparable entities
// ---------------------------------------------------------------------------------

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// Sums a numeric field across a list, counting only genuinely numeric entries. A missing or
// unparseable quantity contributes 0 rather than being guessed at - and because it does so
// identically on every capture, it cannot manufacture a change by itself.
function sumNumeric(list, read) {
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const entry of list) {
    const value = Number(read(entry));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function normalizeShopInfo(result) {
  if (!result || typeof result !== 'object') return [];
  return [
    {
      entity_id: 'shop',
      fields: {
        name: toStringOrNull(result.name),
        domain: toStringOrNull(result.domain),
      },
    },
  ];
}

function normalizeProducts(result) {
  if (!Array.isArray(result)) return [];
  const entities = [];
  for (const product of result) {
    if (!product || typeof product !== 'object') continue;
    const entityId = toStringOrNull(product.id);
    if (entityId === null) continue;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    entities.push({
      entity_id: entityId,
      fields: {
        title: toStringOrNull(product.title),
        status: toStringOrNull(product.status),
        // A plain observable fact: at least one variant is purchasable. It says nothing
        // about why, and nothing about whether that matters.
        available: variants.some((variant) => variant && variant.available === true),
        variant_count: variants.length,
        inventory_total: sumNumeric(variants, (variant) => variant && variant.inventory_quantity),
        tag_count: Array.isArray(product.tags) ? product.tags.length : 0,
      },
    });
  }
  return entities;
}

function normalizeCollections(result) {
  if (!Array.isArray(result)) return [];
  const entities = [];
  for (const collection of result) {
    if (!collection || typeof collection !== 'object') continue;
    const entityId = toStringOrNull(collection.id);
    if (entityId === null) continue;
    entities.push({
      entity_id: entityId,
      fields: {
        title: toStringOrNull(collection.title),
        products_count: Number.isFinite(Number(collection.products_count)) ? Number(collection.products_count) : 0,
      },
    });
  }
  return entities;
}

function normalizeInventoryLevels(result) {
  if (!Array.isArray(result)) return [];
  const entities = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const entityId = toStringOrNull(item.id);
    if (entityId === null) continue;
    const levels = Array.isArray(item.levels) ? item.levels : [];
    entities.push({
      entity_id: entityId,
      fields: {
        sku: toStringOrNull(item.sku),
        tracked: item.tracked === true,
        available_total: sumNumeric(levels, (level) => level && level.available),
      },
    });
  }
  return entities;
}

// Orders and customers reduce to one counted aggregate each - see this file's header.
function normalizeCountOnly(entityId) {
  return (result) => [
    {
      entity_id: entityId,
      fields: { count: Array.isArray(result) ? result.length : 0 },
    },
  ];
}

const NORMALIZERS = {
  getShopInfo: normalizeShopInfo,
  getProducts: normalizeProducts,
  getCollections: normalizeCollections,
  getInventoryLevels: normalizeInventoryLevels,
  getOrders: normalizeCountOnly('orders'),
  getCustomers: normalizeCountOnly('customers'),
};

// Turns one adapter result into sorted, comparable entities. Sorting is what makes the
// snapshot deterministic: two captures of the same catalog compare equal no matter what
// order the platform listed it in.
function normalizeCapabilityResult(capabilityId, result) {
  const normalize = NORMALIZERS[capabilityId];
  if (!normalize) return [];
  const entities = normalize(result);
  entities.sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  return entities;
}

// ---------------------------------------------------------------------------------
// Building a snapshot
// ---------------------------------------------------------------------------------

// Filename-safe compaction of an ISO timestamp: 2026-03-04T09:00:00.000Z -> 20260304T090000000Z
function compactTimestamp(iso) {
  return String(iso).replace(/[-:.]/g, '');
}

function businessKey(businessId) {
  return businessId === null || businessId === undefined || businessId === '' ? '_default' : String(businessId);
}

// Composes one snapshot from already-collected capability observations.
//
// `observations` is a map of capabilityId -> { status, result?, reason? }. The caller
// (monitoring/platformMonitor.js) performs the reads; this function only shapes them, so
// the model stays pure and a test can build a snapshot without any adapter at all.
//
// THE FINGERPRINT COVERS THE STATE AND NOTHING ELSE - not the capture time, not the
// snapshot id. That is what makes "the same state observed twice" detectable at all.
function createSnapshot({ businessId = null, platform, capturedAt = new Date(), source = {}, observations = {} } = {}) {
  if (typeof platform !== 'string' || platform.trim() === '') {
    throw new Error('createSnapshot requires a non-empty `platform`.');
  }
  const capturedIso = capturedAt instanceof Date ? capturedAt.toISOString() : new Date(capturedAt).toISOString();
  const normalizedBusinessId =
    typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;

  const state = {};
  for (const capability of MONITORED_CAPABILITIES) {
    const observation = observations[capability.id];
    if (!observation || !CAPABILITY_OBSERVATION_STATUSES.includes(observation.status)) {
      // An observation that was never attempted is recorded as such, never as an empty
      // success - an absent reading and a genuinely empty catalog are different facts.
      state[capability.id] = { status: 'failed', reason: 'not_observed', entities: [], complete: false };
      continue;
    }
    if (observation.status !== 'observed') {
      state[capability.id] = {
        status: observation.status,
        reason: typeof observation.reason === 'string' ? observation.reason : null,
        entities: [],
        complete: false,
      };
      continue;
    }
    state[capability.id] = {
      status: 'observed',
      reason: null,
      entities: normalizeCapabilityResult(capability.id, observation.result),
      // WHETHER THE WHOLE DATASET WAS SEEN. An observation that stopped at a page
      // boundary holds a PREFIX of the platform's data, not all of it. Recorded
      // explicitly, and part of the fingerprint, because a truncated observation is a
      // genuinely different observation from a complete one - and because
      // monitoring/changeDetection.js must refuse to infer removals from a prefix.
      // Defaults to true only when the caller states it: an observation that does not
      // say is treated as incomplete, which is the safe direction.
      complete: observation.complete === true,
    };
  }

  const stateFingerprint = computeStateFingerprint(state);

  return {
    snapshot_version: SNAPSHOT_VERSION,
    snapshot_id: `${businessKey(normalizedBusinessId)}-${platform}-${compactTimestamp(capturedIso)}-${stateFingerprint.slice(0, 12)}`,
    business_id: normalizedBusinessId,
    platform,
    captured_at: capturedIso,
    source: {
      adapter: typeof source.adapter === 'string' ? source.adapter : null,
      capabilities_requested: Array.isArray(source.capabilities_requested)
        ? source.capabilities_requested.slice().sort()
        : MONITORED_CAPABILITY_IDS.slice().sort(),
    },
    state,
    state_fingerprint: stateFingerprint,
  };
}

// Structural validation. Used by the store on every read, so a snapshot that was corrupted,
// hand-edited, or written by an older incompatible version is refused rather than compared
// against - a malformed previous snapshot would otherwise produce a diff full of invented
// changes.
function validateSnapshotShape(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { valid: false, errors: ['snapshot must be an object'] };
  }
  for (const field of SNAPSHOT_FIELDS) {
    if (!(field.id in snapshot)) errors.push(`missing field: ${field.id}`);
  }
  if (snapshot.snapshot_version !== SNAPSHOT_VERSION) {
    errors.push(`snapshot_version must be ${SNAPSHOT_VERSION}, got ${JSON.stringify(snapshot.snapshot_version)}`);
  }
  if (typeof snapshot.platform !== 'string' || snapshot.platform.trim() === '') {
    errors.push('platform must be a non-empty string');
  }
  if (snapshot.business_id !== null && typeof snapshot.business_id !== 'string') {
    errors.push('business_id must be a string or null');
  }
  if (typeof snapshot.captured_at !== 'string' || Number.isNaN(new Date(snapshot.captured_at).getTime())) {
    errors.push('captured_at must be an ISO-8601 timestamp');
  }
  if (!snapshot.state || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)) {
    errors.push('state must be an object');
  } else {
    for (const capabilityId of MONITORED_CAPABILITY_IDS) {
      const entry = snapshot.state[capabilityId];
      if (!entry || typeof entry !== 'object') {
        errors.push(`state.${capabilityId} is missing`);
        continue;
      }
      if (!CAPABILITY_OBSERVATION_STATUSES.includes(entry.status)) {
        errors.push(`state.${capabilityId}.status must be one of: ${CAPABILITY_OBSERVATION_STATUSES.join(', ')}`);
      }
      if (!Array.isArray(entry.entities)) errors.push(`state.${capabilityId}.entities must be an array`);
      if (typeof entry.complete !== 'boolean') errors.push(`state.${capabilityId}.complete must be a boolean`);
    }
  }
  // The fingerprint must still match the state it claims to describe. This is what catches
  // a snapshot whose contents were edited after it was written.
  if (errors.length === 0 && computeStateFingerprint(snapshot.state) !== snapshot.state_fingerprint) {
    errors.push('state_fingerprint does not match state - the snapshot has been altered since it was written');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SNAPSHOT_VERSION,
  SNAPSHOT_FIELDS,
  MONITORED_CAPABILITIES,
  MONITORED_CAPABILITY_IDS,
  CAPABILITY_OBSERVATION_STATUSES,
  stableStringify,
  computeStateFingerprint,
  normalizeCapabilityResult,
  businessKey,
  createSnapshot,
  validateSnapshotShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - monitoring snapshot model:\n');
  console.log(`Monitored capabilities: ${MONITORED_CAPABILITY_IDS.join(', ')}\n`);

  const observations = {
    getShopInfo: { status: 'observed', result: { name: 'Demo Store', domain: 'demo.example', email: 'owner@example.com' } },
    getProducts: {
      status: 'observed',
      result: [
        { id: 'p2', title: 'Second', status: 'active', tags: ['a'], variants: [{ available: true, inventory_quantity: 4 }] },
        { id: 'p1', title: 'First', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] },
      ],
    },
    getOrders: { status: 'observed', result: [{}, {}, {}] },
    getCustomers: { status: 'unsupported', reason: 'This platform declares no customer read capability.' },
  };

  const snapshot = createSnapshot({ businessId: 'demo-co', platform: 'shopify', capturedAt: new Date('2026-03-04T09:00:00.000Z'), source: { adapter: 'demo' }, observations });
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('\nNote the products are sorted by id regardless of the order the platform returned them,');
  console.log('and that getShopInfo\'s email is NOT in the snapshot.');

  const reordered = createSnapshot({
    businessId: 'demo-co',
    platform: 'shopify',
    capturedAt: new Date('2026-06-06T18:30:00.000Z'),
    source: { adapter: 'demo' },
    observations: { ...observations, getProducts: { status: 'observed', result: observations.getProducts.result.slice().reverse() } },
  });
  console.log(`\nSame state, different capture time and API ordering -> same fingerprint: ${reordered.state_fingerprint === snapshot.state_fingerprint}`);
}
