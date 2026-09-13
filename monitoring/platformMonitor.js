'use strict';

// The observation pass: capture one platform's current state for one business, persist it,
// and report what changed since the last valid snapshot.
//
// OBSERVES ONLY. This module reads. It does not execute, approve, publish, write to a
// platform, spend an advertising budget, schedule anything, or loop. It calls exactly the
// read capabilities monitoring/snapshotModel.js declares and nothing else, and it imports
// nothing from approvals/, integrations/shopify*Publishing, or the autonomy policy. A
// change it reports is information for a human or for a later, separately-scoped decision
// layer - never a trigger.
//
// IT NEVER NAMES A CONCRETE CLIENT. The adapter comes from
// integrations/adapters/adapterRegistry.js's getReadAdapter(), so this module does not know
// or care whether Shopify or Etsy answered, and a platform whose adapter does not exist
// (amazon, ebay) fails closed at the registry rather than here. There is no `require` of
// shopifyClient or etsyReadClient anywhere in monitoring/.
//
// A DISABLED PLATFORM IS NEVER QUERIED. The enablement gate runs BEFORE the adapter is even
// resolved, so a platform absent from the business's own enabled_platforms produces no
// adapter lookup, no isConfigured() call, and no request - not merely a discarded result.
// Enablement is read from configuration only; a credential never enables anything (see
// configuration/business.example.yaml's enabled_platforms). The predicate itself is
// agent/core/toolPermissions.js's isPlatformEnabledForBusiness, reused rather than restated.
//
// A REFUSAL IS NEVER A SNAPSHOT. Every fail-closed path returns `observed: false` with a
// reason code and writes nothing. A snapshot on disk always means a real, successful
// observation of an enabled platform - so a later diff can trust every baseline it loads.
//
// THE PREVIOUS SNAPSHOT IS READ BEFORE THE NEW ONE IS WRITTEN. Otherwise the newly-saved
// snapshot would be its own baseline and every run would report zero changes forever.

const { getReadAdapter } = require('../integrations/adapters/adapterRegistry');
const {
  validateAdapterShape,
  getDeclaredUnsupportedCapabilities,
  isUnsupportedCapabilityError,
  paginatedCapabilityName,
  supportsPaginatedRead,
  validatePageResult,
} = require('../integrations/adapters/platformAdapterContract');
const { isPlatformEnabledForBusiness } = require('../agent/core/toolPermissions');
const { MONITORED_CAPABILITY_IDS, createSnapshot } = require('./snapshotModel');
const { getLatestSnapshot, saveSnapshot, getDefaultSnapshotStoreDir } = require('./snapshotStore');
const { detectChanges } = require('./changeDetection');

// Why an observation did not happen. Machine-readable, so a caller switches on a code
// rather than on prose - the same convention agent/core/autonomyPolicy.js's reason codes
// follow.
const OBSERVATION_REFUSAL_REASONS = [
  'platform_not_enabled',
  'platform_enablement_unknown',
  'no_adapter',
  'adapter_not_conforming',
  'adapter_not_configured',
];

// How many records a single observation asks any one capability for. A fixed, modest page
// rather than an unbounded read: this runs repeatedly and must not become the largest
// request in the system. It is a request bound, not a business threshold - it asserts
// nothing about how many products or orders a business "should" have.
const DEFAULT_CAPABILITY_LIMIT = 50;

// A hard ceiling on how many pages one capability may fetch in a single observation.
// Not a business threshold: it stops a malformed adapter that never returns a null cursor
// from looping forever. Reaching it means the observation is INCOMPLETE, and it is
// reported as such rather than silently treated as the whole dataset.
const MAX_PAGES_PER_CAPABILITY = 100;

function refusal(businessId, platform, reasonCode, reason) {
  return {
    observed: false,
    business_id: typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null,
    platform: typeof platform === 'string' ? platform : null,
    reason_code: reasonCode,
    reason,
    snapshot: null,
    previous_snapshot_id: null,
    changes: null,
    saved_to: null,
  };
}

// Calls one read capability and classifies the outcome.
//
// A capability the adapter has DECLARED it cannot serve is never called - it is recorded as
// 'unsupported'. A call that throws the contract's own unsupported-capability error is
// recorded the same way, so an adapter that declares late is still handled honestly. Any
// other failure is 'failed' - never an empty success, because "the read did not work" and
// "the platform has none" are different facts and the diff treats them differently.
async function observeCapability(adapter, capabilityId, { businessId, limit, declaredUnsupported }) {
  if (declaredUnsupported.includes(capabilityId)) {
    return { status: 'unsupported', reason: `This platform's adapter declares '${capabilityId}' unsupported.`, complete: false };
  }
  const capability = adapter[capabilityId];
  if (typeof capability !== 'function') {
    return { status: 'failed', reason: `The adapter exposes no '${capabilityId}' function.`, complete: false };
  }
  try {
    // PAGINATED PATH - used only when the adapter genuinely exposes it (see
    // platformAdapterContract.js's optional pagination contract). Pages until the adapter
    // says there is no next cursor, which is the only thing that establishes "that was
    // all of it".
    if (supportsPaginatedRead(adapter, capabilityId)) {
      const pageFn = adapter[paginatedCapabilityName(capabilityId)];
      const items = [];
      let cursor = null;
      let complete = false;
      for (let page = 0; page < MAX_PAGES_PER_CAPABILITY; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const pageResult = await pageFn({ businessId, limit, cursor });
        const validation = validatePageResult(pageResult);
        if (!validation.valid) {
          // A malformed page is refused rather than partially consumed: half a page
          // quietly accepted is exactly how entities go missing and then read as removed.
          return {
            status: 'failed',
            reason: `The paginated '${capabilityId}' read returned a page that does not satisfy the adapter contract.`,
            complete: false,
          };
        }
        items.push(...pageResult.items);
        cursor = pageResult.next_cursor === undefined ? null : pageResult.next_cursor;
        if (cursor === null) {
          complete = true;
          break;
        }
      }
      return { status: 'observed', result: items, complete };
    }

    // UNPAGINATED PATH - one call, bounded by `limit`.
    //
    // Completeness is inferred from the limit alone, which is the plain meaning of asking
    // for at most N and being given fewer: there were no more. Receiving exactly N is
    // ambiguous - there may or may not be more - and ambiguity is recorded as INCOMPLETE,
    // never resolved in favour of "that was everything". Nothing about the platform is
    // assumed and no pagination parameter is invented.
    const result = await capability({ businessId, limit });
    const complete = Array.isArray(result) ? result.length < limit : true;
    return { status: 'observed', result, complete };
  } catch (err) {
    if (isUnsupportedCapabilityError(err)) {
      return { status: 'unsupported', reason: `This platform's adapter reports '${capabilityId}' unsupported.`, complete: false };
    }
    // The underlying message is not relayed into the snapshot - it can carry a URL or a
    // third-party detail, and the snapshot is persisted business data.
    return { status: 'failed', reason: `The '${capabilityId}' read did not complete.`, complete: false };
  }
}

// Observes one platform for one business.
//
// `enabledPlatforms` is REQUIRED and must be the business's own configured list (resolve it
// with configuration/businessRegistry.js's getEnabledPlatforms). It is passed in rather than
// read here for the same reason agent/core/toolPermissions.js takes it as an argument: this
// module then performs no configuration read of its own, and a caller cannot accidentally
// get a different answer from the one the permission gate used. Omitting it fails closed.
//
// `adapter` may be supplied to observe through an already-resolved, contract-conforming
// adapter instead of resolving one. It is validated against the same contract the registry
// enforces, so it can never be a stub that merely looks adapter-shaped. This is how the
// tests observe without a network call.
async function observePlatform({
  businessId = null,
  platform,
  enabledPlatforms = null,
  adapter = null,
  limit = DEFAULT_CAPABILITY_LIMIT,
  now = new Date(),
  rootDir = getDefaultSnapshotStoreDir(),
  persist = true,
} = {}) {
  // --- Gate 1: enablement. Runs before ANY adapter work - see this file's header. -------
  if (!Array.isArray(enabledPlatforms)) {
    return refusal(
      businessId,
      platform,
      'platform_enablement_unknown',
      'No enabled-platform list was supplied, so whether this platform may be observed is unknown. Nothing was queried.'
    );
  }
  if (!isPlatformEnabledForBusiness({ platform, enabledPlatforms })) {
    return refusal(
      businessId,
      platform,
      'platform_not_enabled',
      `Platform ${JSON.stringify(platform)} is not enabled for this business, so it was not queried. Enablement is stated in configuration only - a credential never enables a platform.`
    );
  }

  // --- Gate 2: an adapter that actually exists and conforms ----------------------------
  let resolved = adapter;
  if (!resolved) {
    try {
      resolved = getReadAdapter(platform);
    } catch (err) {
      return refusal(
        businessId,
        platform,
        'no_adapter',
        `This project has no conforming read adapter for platform ${JSON.stringify(platform)}, so it cannot be observed. No fallback was substituted.`
      );
    }
  }

  const conformance = validateAdapterShape(resolved);
  if (!conformance.valid) {
    return refusal(
      businessId,
      platform,
      'adapter_not_conforming',
      `The read adapter for ${JSON.stringify(platform)} does not conform to the platform adapter contract, so it was not used.`
    );
  }

  // --- Gate 3: the adapter can actually connect ----------------------------------------
  let configured = false;
  try {
    configured = resolved.isConfigured({ businessId }) === true;
  } catch (err) {
    configured = false;
  }
  if (!configured) {
    return refusal(
      businessId,
      platform,
      'adapter_not_configured',
      `The ${JSON.stringify(platform)} adapter is not configured for this business, so no read was attempted. Being enabled and being reachable are separate facts.`
    );
  }

  // --- The previous baseline, read BEFORE the new snapshot is written ------------------
  const previous = getLatestSnapshot({ businessId, platform, rootDir });

  // --- The reads -----------------------------------------------------------------------
  const declaredUnsupported = getDeclaredUnsupportedCapabilities(resolved);
  const observations = {};
  for (const capabilityId of MONITORED_CAPABILITY_IDS) {
    // Sequential on purpose: a monitoring pass must not open six concurrent requests
    // against a platform that rate-limits (Etsy enforces a per-application daily quota).
    // eslint-disable-next-line no-await-in-loop
    observations[capabilityId] = await observeCapability(resolved, capabilityId, {
      businessId,
      limit,
      declaredUnsupported,
    });
  }

  const snapshot = createSnapshot({
    businessId,
    platform,
    capturedAt: now,
    source: { adapter: platform, capabilities_requested: MONITORED_CAPABILITY_IDS },
    observations,
  });

  const changes = detectChanges(previous, snapshot);

  let savedTo = null;
  if (persist) {
    savedTo = saveSnapshot(snapshot, { rootDir });
  }

  return {
    observed: true,
    business_id: snapshot.business_id,
    platform,
    reason_code: null,
    reason: null,
    snapshot,
    previous_snapshot_id: previous ? previous.snapshot_id : null,
    changes,
    saved_to: savedTo,
  };
}

module.exports = {
  OBSERVATION_REFUSAL_REASONS,
  DEFAULT_CAPABILITY_LIMIT,
  observeCapability,
  observePlatform,
};

if (require.main === module) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // A contract-conforming read adapter over in-memory data. No network, no credential.
  function demoAdapter(products) {
    return {
      UNSUPPORTED_READ_CAPABILITIES: ['getInventoryLevels'],
      isConfigured: () => true,
      getShopInfo: async () => ({ name: 'Demo Store', domain: 'demo.example', email: 'owner@example.com' }),
      getProducts: async () => products,
      getOrders: async () => [{}, {}],
      getCustomers: async () => [],
      getInventoryLevels: async () => {
        throw new Error('declared unsupported');
      },
      getCollections: async () => [],
    };
  }

  (async () => {
    console.log('Smart E-Commerce Growth AI Agent - platform monitor (observation only):\n');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-monitor-demo-'));
    const shared = { businessId: 'demo-co', platform: 'shopify', rootDir };

    console.log('A disabled platform is refused before anything is queried:');
    const disabled = await observePlatform({ ...shared, enabledPlatforms: ['etsy'], adapter: demoAdapter([]) });
    console.log(`  ${disabled.reason_code}: ${disabled.reason}\n`);

    console.log('Amazon stays unsupported even when a config tries to enable it. It is refused at the');
    console.log('FIRST gate, not the adapter one: an unrecognized platform can never be enabled, so the');
    console.log('registry is never even consulted for it:');
    const unsupported = await observePlatform({ ...shared, platform: 'amazon', enabledPlatforms: ['amazon'] });
    console.log(`  ${unsupported.reason_code}: ${unsupported.reason}`);
    console.log('  (the adapter registry would refuse it too - two independent refusals, not one)\n');

    const first = await observePlatform({
      ...shared,
      enabledPlatforms: ['shopify'],
      adapter: demoAdapter([{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 5 }] }]),
      now: new Date('2026-03-04T09:00:00.000Z'),
    });
    console.log(`First observation  -> baseline: ${first.changes.baseline}, changes: ${JSON.stringify(first.changes.counts)}`);

    const second = await observePlatform({
      ...shared,
      enabledPlatforms: ['shopify'],
      adapter: demoAdapter([{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] }]),
      now: new Date('2026-03-05T09:00:00.000Z'),
    });
    console.log(`Second observation -> changes: ${JSON.stringify(second.changes.counts)}`);
    for (const entry of second.changes.changes) {
      console.log(`  ${entry.change_type} ${entry.capability}/${entry.entity_id} ${entry.field}: ${JSON.stringify(entry.previous_value)} -> ${JSON.stringify(entry.current_value)}`);
    }

    const third = await observePlatform({
      ...shared,
      enabledPlatforms: ['shopify'],
      adapter: demoAdapter([{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: false, inventory_quantity: 0 }] }]),
      now: new Date('2026-03-06T09:00:00.000Z'),
    });
    console.log(`\nThird observation, same state -> changes: ${JSON.stringify(third.changes.counts)} (identical: ${third.changes.identical})`);
    console.log('\nNo line above says why anything changed, or whether it matters. That is deliberate.');

    fs.rmSync(rootDir, { recursive: true, force: true });
  })();
}
