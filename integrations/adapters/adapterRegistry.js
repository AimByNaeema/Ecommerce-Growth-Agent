'use strict';

// The ADAPTER REGISTRY: the one place a platform id becomes a read adapter.
//
// WHY IT EXISTS. Before this file, every platform-touching tool named its adapter by
// require()ing the concrete module - tools/productDataRetrievalTool.js required
// shopifyClient, tools/etsyShopDataTool.js required etsyReadClient - so "which platform am
// I reading?" was answered by an import statement, at module load, identically for every
// business. A tool could not be pointed at a different platform without editing it, and a
// second platform meant a second branch in every consumer. This registry is the seam:
// getReadAdapter(platform) resolves it once, and the tool no longer knows or cares which
// module answered.
//
// WHAT IT IS NOT. It is not a plugin loader, not a factory and not a dependency-injection
// container. It holds a fixed, hand-written map of the adapters that actually exist in this
// repository, and resolves nothing else. There is no dynamic require, no path building from
// a platform id, and no filesystem scan - a platform reaches this map by a deliberate source
// edit when its adapter genuinely lands, never at runtime.
//
// FAIL CLOSED, AND SAY WHICH KIND OF "NO" IT IS. An unknown platform, a platform with no
// adapter, and a registered adapter that does not conform are three different problems and
// get three different errors. None of them returns a partial, a null, or a stub adapter:
// there is no code path here that hands back something a caller could accidentally call.
//
// CONFORMANCE IS CHECKED BEFORE USE, NOT ASSUMED. Every resolution validates the adapter
// against integrations/adapters/platformAdapterContract.js and refuses a non-conforming one,
// so a capability that went missing (or a declaration that names a capability that is not
// one) is caught at the seam rather than as a TypeError deep inside a tool. The check is
// structural and free - typeof checks over an already-loaded module, no I/O, no network - so
// it runs on every call rather than being cached into a stale "it was fine once".
//
// THE MODULE OBJECT IS RETURNED AS-IS. getReadAdapter() hands back the real adapter module,
// never a wrapper or proxy. That is deliberate: this project's tests substitute behavior by
// mocking global.fetch or by property access on a required module (see
// tools/aiReasoningCompletion.js's header for the established convention), and a wrapper
// would silently break both while looking equivalent.
//
// ENABLEMENT IS SOMEONE ELSE'S JOB. Resolving an adapter says only "this platform has a
// conforming adapter in this repository". Whether a BUSINESS may use it is decided by
// agent/core/toolPermissions.js's platform gate from that business's own enabled_platforms
// configuration, before a tool is ever dispatched; whether it can physically connect is
// decided by the adapter's own isConfigured(). Three separate questions, three separate
// places - conflating any two of them is what this architecture exists to avoid.

const { isValidChannel, CHANNELS } = require('../../agent/core/channelModel');
const { validateAdapterShape, getDeclaredUnsupportedCapabilities } = require('./platformAdapterContract');

// The read adapters that actually exist, by platform id. Hand-written on purpose (see this
// file's header). Both entries satisfy platformAdapterContract.js's read contract:
//   shopify - the full 7-capability surface, natively.
//   etsy    - via integrations/adapters/etsyReadAdapter.js, a shim over the read client,
//             serving 3 capabilities and DECLARING the other 4 unsupported rather than
//             faking them (see that file's header).
//
// Amazon and eBay are deliberately absent: no adapter for either exists in this repository,
// and listing a platform here before its adapter lands would make getReadAdapter() resolve
// something that cannot work. They fail closed as unregistered platforms, which is the
// truthful answer.
const READ_ADAPTERS = {
  shopify: require('./shopifyClient'),
  etsy: require('./etsyReadAdapter'),
};

// The platforms this registry can resolve today. Derived from READ_ADAPTERS, never
// hand-listed a second time, so it cannot drift from what is actually registered.
const REGISTERED_READ_PLATFORMS = Object.keys(READ_ADAPTERS);

function hasReadAdapter(platform) {
  return typeof platform === 'string' && Object.prototype.hasOwnProperty.call(READ_ADAPTERS, platform);
}

// Resolves one platform's read adapter, or throws.
//
// Checks in order, each with its own distinct error:
//   1. the platform must be a recognized channel (agent/core/channelModel.js's CHANNELS) -
//      an unknown string like 'amazon' or a typo is refused here, reusing the project's one
//      platform vocabulary rather than inventing a second;
//   2. that channel must have an adapter registered above - a recognized platform with no
//      adapter is a different failure from an unrecognized one, and says so;
//   3. that adapter must still conform to the read contract - refused with the validator's
//      own error list, never used "anyway".
//
// Returns the adapter module itself. Never returns null, undefined, or a stub: a caller that
// gets a value back always has something safe to call.
function getReadAdapter(platform) {
  if (!isValidChannel(platform)) {
    throw new Error(
      `No read adapter for platform ${JSON.stringify(platform)}: it is not a platform this project recognizes ` +
        `(recognized: ${CHANNELS.join(', ')}). A platform is only recognized once a real adapter for it exists ` +
        'under integrations/adapters/.'
    );
  }

  if (!hasReadAdapter(platform)) {
    throw new Error(
      `Platform '${platform}' is recognized but has no read adapter registered in ` +
        `integrations/adapters/adapterRegistry.js (registered: ${REGISTERED_READ_PLATFORMS.join(', ')}). ` +
        'Nothing was resolved, and no fallback adapter was substituted.'
    );
  }

  const adapter = READ_ADAPTERS[platform];
  const conformance = validateAdapterShape(adapter);
  if (!conformance.valid) {
    throw new Error(
      `The registered read adapter for '${platform}' does not conform to ` +
        `integrations/adapters/platformAdapterContract.js: ${conformance.errors.join('; ')}. ` +
        'It was not returned - a non-conforming adapter is refused rather than used partially.'
    );
  }

  return adapter;
}

// What a platform's adapter will and will not answer, without resolving it for use. Lets a
// caller (or a reader) see a platform's real read surface up front - `supported` and
// `unsupported` come from the adapter's own declaration, never from an assumption that every
// platform looks like Shopify.
//
// Throws for an unknown or unregistered platform, exactly like getReadAdapter().
function describeReadAdapter(platform) {
  const adapter = getReadAdapter(platform);
  const conformance = validateAdapterShape(adapter);
  return {
    platform,
    supported: conformance.supported,
    unsupported: conformance.unsupported,
    declared_unsupported: getDeclaredUnsupportedCapabilities(adapter),
  };
}

// WHICH SCHEDULED TOOLS MEAN "OBSERVE THIS PLATFORM", declared beside the adapter that
// serves the read. When one of these is scheduled, autonomy/autonomousCycle.js runs a
// monitoring pass (snapshot + change detection) for that platform instead of a capability
// execution. Declared HERE, per platform, so core autonomy carries no platform-specific list:
// onboarding a platform means registering its adapter and its observation tools in this one
// file, with no edit to the cycle.
//
// Each id must be a real, implemented tools/toolRegistry.js read tool bound to that platform
// (verified by verification/testing/platformGenerality.test.js). A platform with no registered
// read adapter has no observation tools, whatever this map says - so Amazon and eBay, which
// have no adapter, can never be observed.
const OBSERVATION_TOOLS = {
  shopify: ['product_data_retrieval', 'collection_data_retrieval', 'analytics_data_retrieval'],
  etsy: ['etsy_shop_data_retrieval', 'etsy_listing_data_retrieval'],
};

// The observation tools for one platform, read live (never cached), or [] when the platform
// has no registered read adapter.
function getObservationToolIds(platform) {
  if (!hasReadAdapter(platform)) return [];
  const declared = Object.prototype.hasOwnProperty.call(OBSERVATION_TOOLS, platform) ? OBSERVATION_TOOLS[platform] : null;
  return Array.isArray(declared) ? declared.slice() : [];
}

// Whether this tool observes the given platform.
function isObservationToolFor(toolId, platform) {
  return typeof toolId === 'string' && getObservationToolIds(platform).includes(toolId);
}

// Whether this tool observes ANY platform with a registered read adapter.
function isObservationTool(toolId) {
  return typeof toolId === 'string' && Object.keys(READ_ADAPTERS).some((platform) => isObservationToolFor(toolId, platform));
}

module.exports = {
  READ_ADAPTERS,
  REGISTERED_READ_PLATFORMS,
  OBSERVATION_TOOLS,
  hasReadAdapter,
  getReadAdapter,
  describeReadAdapter,
  getObservationToolIds,
  isObservationToolFor,
  isObservationTool,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - adapter registry (platform id -> read adapter):\n');
  console.log(`Registered read platforms: ${REGISTERED_READ_PLATFORMS.join(', ')}\n`);

  for (const platform of REGISTERED_READ_PLATFORMS) {
    const described = describeReadAdapter(platform);
    console.log(`[${platform}]`);
    console.log(`  supported:   ${described.supported.join(', ')}`);
    console.log(`  unsupported: ${described.unsupported.join(', ') || '(none - the full read surface)'}`);
  }

  console.log('\nA platform with no adapter fails closed rather than resolving something unusable:');
  for (const platform of ['amazon', 'ebay', 'woocommerce', 'Shopify', null]) {
    try {
      getReadAdapter(platform);
      console.log(`  ${JSON.stringify(platform)} -> resolved (unexpected)`);
    } catch (err) {
      console.log(`  ${JSON.stringify(platform)} -> refused: ${err.message.split(':')[0]}`);
    }
  }

  console.log('\nResolving an adapter is not permission to use it: a business must also have the platform');
  console.log("enabled in its own enabled_platforms configuration (agent/core/toolPermissions.js's platform gate).");
}
