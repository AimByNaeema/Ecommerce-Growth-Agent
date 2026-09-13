'use strict';

// Deterministic comparison of two monitoring snapshots: what was added, removed, changed,
// and what stayed the same.
//
// DETERMINISTIC MEANS DETERMINISTIC. The same pair of snapshots always produces the same
// change list, in the same order, with the same wording. Nothing here reads a clock, a
// random value, an environment variable or a file - the only inputs are the two snapshots
// handed in. Ordering is fully specified (capability, then change type, then entity id,
// then field), so a caller can diff two diffs.
//
// IT REPORTS FACTS AND REFUSES TO INTERPRET THEM. A change says exactly one thing: this
// field of this entity held X and now holds Y. It never says why, never says whether that
// is good, bad, important, profitable, expected, or what customers will do about it, and
// never projects revenue or demand. Those are claims that would need evidence this layer
// does not have and does not gather, and CLAUDE.md rule 8 forbids presenting an
// unverified claim as a fact. A consumer that wants meaning must bring its own evidence.
//
// NO FALSE HISTORY. Comparing against no previous snapshot yields ZERO changes, not a list
// of everything that exists. A first observation has nothing to differ from, and reporting
// a whole catalog as "added" the first time the monitor ever runs would be a fabricated
// event. The result says `baseline: true` so a caller can tell the two cases apart.
//
// UNCOMPARABLE IS NOT UNCHANGED. If a capability was observed in one snapshot but was
// unsupported or failed in the other, its entities are not compared at all - they are
// reported as not_comparable. Treating a failed read as "everything was removed" would be
// the single most damaging false positive this module could produce.
//
// OBSERVES ONLY. Nothing in monitoring/ executes, approves, publishes, or writes anything
// to any platform. This module in particular takes two plain objects and returns a third.

const { MONITORED_CAPABILITIES, MONITORED_CAPABILITY_IDS, stableStringify } = require('./snapshotModel');

const CHANGE_TYPES = ['added', 'removed', 'changed', 'unchanged'];

// Fixed ordering rank, so the output order never depends on object iteration order.
const CHANGE_TYPE_RANK = { added: 0, removed: 1, changed: 2, unchanged: 3 };

const CAPABILITY_COMPARISON_STATUSES = ['compared', 'compared_partial', 'not_comparable'];

// The entity kind each capability's entities are, for a change record. Looked up from the
// model rather than restated, so the two files can never disagree.
const ENTITY_KIND_BY_CAPABILITY = MONITORED_CAPABILITIES.reduce((map, capability) => {
  map[capability.id] = capability.entity_kind;
  return map;
}, {});

function capabilityEntry(snapshot, capabilityId) {
  const state = snapshot && snapshot.state;
  const entry = state && state[capabilityId];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

function entitiesById(entry) {
  const map = new Map();
  if (!entry || !Array.isArray(entry.entities)) return map;
  for (const entity of entry.entities) {
    if (!entity || typeof entity !== 'object') continue;
    if (typeof entity.entity_id !== 'string') continue;
    map.set(entity.entity_id, entity.fields && typeof entity.fields === 'object' ? entity.fields : {});
  }
  return map;
}

// Deterministic field ordering: the model's declared field list first, in its declared
// order, then any remaining keys sorted. A field the model does not declare can still be
// reported rather than silently dropped, but it can never reorder the declared ones.
function orderedFieldNames(capabilityId, previousFields, currentFields) {
  const declared = (MONITORED_CAPABILITIES.find((capability) => capability.id === capabilityId) || {}).fields || [];
  const seen = new Set(declared);
  const extra = [];
  for (const key of Object.keys(previousFields).concat(Object.keys(currentFields))) {
    if (!seen.has(key)) {
      seen.add(key);
      extra.push(key);
    }
  }
  extra.sort();
  return declared.concat(extra);
}

function valuesEqual(a, b) {
  return stableStringify(a === undefined ? null : a) === stableStringify(b === undefined ? null : b);
}

function change(capabilityId, changeType, entityId, extra = {}) {
  return {
    capability: capabilityId,
    entity_kind: ENTITY_KIND_BY_CAPABILITY[capabilityId] || null,
    change_type: changeType,
    entity_id: entityId,
    field: null,
    previous_value: null,
    current_value: null,
    ...extra,
  };
}

// Compares one capability's entities between two snapshots.
function compareCapability(capabilityId, previousEntry, currentEntry, { includeUnchanged }) {
  // A PREFIX IS NOT A SET. When either side stopped short of the whole dataset, an id
  // missing from one side proves nothing - it may simply be on a page nobody fetched. So
  // a partial comparison reports FIELD CHANGES ONLY, on entities present in both, and
  // never an added or a removed. This is the single most damaging false positive this
  // module could produce, and it is refused structurally rather than heuristically.
  const partial = !(previousEntry && previousEntry.complete === true && currentEntry && currentEntry.complete === true);
  // An aggregate describes the WHOLE set, so a prefix of the set gives a wrong value for
  // it rather than a partial one. Never compared from an incomplete observation.
  const isAggregate = String(ENTITY_KIND_BY_CAPABILITY[capabilityId] || '').endsWith('_aggregate');
  if (partial && isAggregate) {
    return {
      capability: capabilityId,
      status: 'not_comparable',
      reason: 'This capability reports a count over the whole set, and at least one observation was incomplete. A count taken from part of the data is a wrong number, not a partial one, so nothing is compared and no change is reported.',
      changes: [],
    };
  }

  // Either side unobservable means there is nothing honest to compare. Reported as its own
  // status rather than folded into the change list - see this file's header.
  if (!previousEntry || !currentEntry || previousEntry.status !== 'observed' || currentEntry.status !== 'observed') {
    return {
      capability: capabilityId,
      status: 'not_comparable',
      reason: `Comparable only when both snapshots observed this capability (previous: ${previousEntry ? previousEntry.status : 'absent'}, current: ${currentEntry ? currentEntry.status : 'absent'}).`,
      changes: [],
    };
  }

  const previous = entitiesById(previousEntry);
  const current = entitiesById(currentEntry);
  const changes = [];

  // Sorted union of ids, so traversal order is fixed regardless of insertion order.
  const allIds = Array.from(new Set([...previous.keys(), ...current.keys()])).sort();

  for (const entityId of allIds) {
    const before = previous.get(entityId);
    const after = current.get(entityId);

    if (before === undefined) {
      // Unseen in a partial previous observation is not evidence of an addition.
      if (partial) continue;
      changes.push(change(capabilityId, 'added', entityId, { current_value: after }));
      continue;
    }
    if (after === undefined) {
      // Unseen in a partial current observation is NEVER a removal - see above.
      if (partial) continue;
      changes.push(change(capabilityId, 'removed', entityId, { previous_value: before }));
      continue;
    }

    let entityChanged = false;
    for (const field of orderedFieldNames(capabilityId, before, after)) {
      const beforeValue = field in before ? before[field] : null;
      const afterValue = field in after ? after[field] : null;
      if (valuesEqual(beforeValue, afterValue)) continue;
      entityChanged = true;
      changes.push(
        change(capabilityId, 'changed', entityId, { field, previous_value: beforeValue, current_value: afterValue })
      );
    }
    if (!entityChanged && includeUnchanged) {
      changes.push(change(capabilityId, 'unchanged', entityId, { current_value: after }));
    }
  }

  // Stable sort key: change type first, then entity id, then field. Within one capability
  // this fully determines the order - there is no pair of changes this leaves ambiguous,
  // because (type, entity, field) is unique by construction.
  changes.sort((a, b) => {
    if (CHANGE_TYPE_RANK[a.change_type] !== CHANGE_TYPE_RANK[b.change_type]) {
      return CHANGE_TYPE_RANK[a.change_type] - CHANGE_TYPE_RANK[b.change_type];
    }
    if (a.entity_id !== b.entity_id) return a.entity_id < b.entity_id ? -1 : 1;
    const aField = a.field || '';
    const bField = b.field || '';
    if (aField !== bField) return aField < bField ? -1 : 1;
    return 0;
  });

  return {
    capability: capabilityId,
    status: partial ? 'compared_partial' : 'compared',
    reason: partial
      ? 'One or both observations of this capability were incomplete, so only field changes on entities seen in both are reported. Additions and removals cannot be established from a partial observation and none were inferred.'
      : null,
    changes,
  };
}

// Compares a current snapshot against the previous one.
//
// `previousSnapshot` of null is the FIRST observation: zero changes, `baseline: true`.
// Both snapshots must belong to the same business and platform - comparing across either
// would be meaningless, and is refused rather than producing a diff nobody should trust.
function detectChanges(previousSnapshot, currentSnapshot, { includeUnchanged = false } = {}) {
  if (!currentSnapshot || typeof currentSnapshot !== 'object') {
    throw new Error('detectChanges requires a current snapshot.');
  }

  const summary = {
    business_id: currentSnapshot.business_id === undefined ? null : currentSnapshot.business_id,
    platform: currentSnapshot.platform || null,
    current_snapshot_id: currentSnapshot.snapshot_id || null,
    previous_snapshot_id: null,
    baseline: false,
    identical: false,
    changes: [],
    capabilities: [],
    counts: { added: 0, removed: 0, changed: 0, unchanged: 0 },
  };

  if (!previousSnapshot) {
    // A first observation has no history. Reporting its whole catalog as "added" would be
    // a fabricated event, so it reports nothing at all.
    summary.baseline = true;
    summary.capabilities = MONITORED_CAPABILITY_IDS.map((capabilityId) => ({
      capability: capabilityId,
      status: 'not_comparable',
      reason: 'First observation for this business and platform - there is no previous snapshot to compare against.',
      changes: [],
    }));
    return summary;
  }

  if (previousSnapshot.platform !== currentSnapshot.platform) {
    throw new Error(
      `detectChanges refuses to compare snapshots from different platforms ('${previousSnapshot.platform}' and '${currentSnapshot.platform}').`
    );
  }
  const previousBusiness = previousSnapshot.business_id === undefined ? null : previousSnapshot.business_id;
  if (previousBusiness !== summary.business_id) {
    throw new Error('detectChanges refuses to compare snapshots from different businesses.');
  }

  summary.previous_snapshot_id = previousSnapshot.snapshot_id || null;

  // The idempotency shortcut, and the honest one: identical normalized state means the
  // fingerprints match, and there is nothing to report. The per-capability comparison below
  // still runs, so `identical` is a statement about the fingerprints rather than a way of
  // skipping work that might have found something.
  summary.identical = Boolean(
    previousSnapshot.state_fingerprint && previousSnapshot.state_fingerprint === currentSnapshot.state_fingerprint
  );

  for (const capabilityId of MONITORED_CAPABILITY_IDS) {
    const result = compareCapability(
      capabilityId,
      capabilityEntry(previousSnapshot, capabilityId),
      capabilityEntry(currentSnapshot, capabilityId),
      { includeUnchanged }
    );
    summary.capabilities.push(result);
    summary.changes.push(...result.changes);
  }

  for (const entry of summary.changes) {
    if (entry.change_type in summary.counts) summary.counts[entry.change_type] += 1;
  }

  return summary;
}

module.exports = {
  CHANGE_TYPES,
  CAPABILITY_COMPARISON_STATUSES,
  ENTITY_KIND_BY_CAPABILITY,
  detectChanges,
};

if (require.main === module) {
  const { createSnapshot } = require('./snapshotModel');
  console.log('Smart E-Commerce Growth AI Agent - monitoring change detection:\n');

  const build = (products, orderCount, at) =>
    createSnapshot({
      businessId: 'demo-co',
      platform: 'shopify',
      capturedAt: new Date(at),
      source: { adapter: 'demo' },
      observations: {
        getShopInfo: { status: 'observed', result: { name: 'Demo Store', domain: 'demo.example' } },
        getProducts: { status: 'observed', result: products },
        getCollections: { status: 'observed', result: [] },
        getInventoryLevels: { status: 'unsupported', reason: 'not served by this adapter' },
        getOrders: { status: 'observed', result: new Array(orderCount).fill({}) },
        getCustomers: { status: 'observed', result: [] },
      },
    });

  const first = build(
    [
      { id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 5 }] },
      { id: 'p2', title: 'Rug', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 2 }] },
    ],
    10,
    '2026-03-04T09:00:00.000Z'
  );

  console.log('First observation - no history, so no changes are invented:');
  console.log(JSON.stringify(detectChanges(null, first).counts), '- baseline:', detectChanges(null, first).baseline, '\n');

  const second = build(
    [
      { id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] },
      { id: 'p3', title: 'Shelf', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 7 }] },
    ],
    12,
    '2026-03-05T09:00:00.000Z'
  );

  const diff = detectChanges(first, second);
  console.log('Second observation:');
  for (const entry of diff.changes) {
    const detail = entry.field
      ? `${entry.field}: ${JSON.stringify(entry.previous_value)} -> ${JSON.stringify(entry.current_value)}`
      : '';
    console.log(`  ${entry.change_type.padEnd(9)} ${entry.capability}/${entry.entity_id} ${detail}`);
  }
  console.log('\ncounts:', JSON.stringify(diff.counts));
  console.log('\nEvery line above is a fact. None of them says why, or whether it matters - that');
  console.log('would need evidence this layer neither has nor gathers.');

  console.log('\nSame state observed again produces nothing:');
  console.log(JSON.stringify(detectChanges(second, build(
    [
      { id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] },
      { id: 'p3', title: 'Shelf', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 7 }] },
    ],
    12,
    '2026-03-06T09:00:00.000Z'
  )).counts));
}
