'use strict';

// THE ONE TRUTHFUL ANSWER to "is platform X supported by this project, and how far?".
//
// WHY IT EXISTS. Platform names appear in several places for several different reasons -
// agent/core/channelModel.js's CHANNELS (a real read adapter exists),
// integrations/adapters/adapterRegistry.js's READ_ADAPTERS (it is actually wired), and
// compliance/compliancePolicy.js's RECOGNIZED_PLATFORMS (the compliance layer will accept
// it as CONTEXT). Those lists answer different questions and do not agree, which is
// correct: 'amazon' appears in the third and in neither of the first two. Without one
// place that says so plainly, a reader can see "amazon" in the codebase and reasonably
// conclude Amazon is supported. It is not.
//
// EVERYTHING HERE IS DERIVED, NOTHING IS ASSERTED. Each status below is computed from the
// modules that actually decide it. There is no hand-maintained "supported: true" flag that
// could drift from reality, and adding a platform name to this file cannot make it work -
// the only way a platform becomes readable is for a conforming adapter to land in
// adapterRegistry.js, and the only way it becomes enableable is for channelModel.js to
// recognize it because that adapter exists.
//
// AMAZON AND EBAY ARE UNSUPPORTED, AND THIS FILE IS WHERE THAT IS SAID OUT LOUD.
// Their names exist in this project for exactly one reason: the compliance layer will
// accept them as a stated CONTEXT so that content intended for them can be checked against
// this project's own rules. That is not integration, and it grants nothing:
//   - they cannot be listed in a business's enabled_platforms (tools/configValidator.js
//     rejects the value, so a config naming them fails validation);
//   - they cannot resolve a read adapter (adapterRegistry.js refuses them);
//   - they cannot be monitored, scheduled, or verified (each of those gates refuses first);
//   - they have no publishing path of any kind;
//   - and compliance returns REVIEW for them, never PASS, because this project holds no
//     structured rules for either marketplace and refuses to invent any.
//
// WHAT REAL ONBOARDING WOULD ACTUALLY TAKE - AND WHAT IT WOULD NOT. See
// ONBOARDING_REQUIREMENTS below. The core autonomy system does not need to change: the
// scheduler, monitor, policy, breaker, verification and audit layers are all platform-
// agnostic and reach a platform only through getReadAdapter(). Onboarding is adapter +
// credentials + configuration + compliance rules + verification coverage. It is
// deliberately NOT represented here as a smaller job than it is.

const { CHANNELS, isValidChannel } = require('../../agent/core/channelModel');
const { REGISTERED_READ_PLATFORMS, hasReadAdapter, describeReadAdapter } = require('./adapterRegistry');
const { RECOGNIZED_PLATFORMS } = require('../../compliance/compliancePolicy');

// How far this project genuinely goes with a platform.
//
//   integrated  - a conforming read adapter exists and is registered, and the platform may
//                 be enabled for a business.
//   context_only- the name is accepted as compliance CONTEXT and nothing else. No adapter,
//                 no enablement, no reads, no writes.
//   unknown     - the project does not recognize this name at all.
const SUPPORT_LEVELS = ['integrated', 'context_only', 'unknown'];

// The publishing adapters that genuinely exist in this repository, and whether each can
// actually publish today. Hand-written like adapterRegistry.js's READ_ADAPTERS and for the
// same reason: a platform reaches this map by a deliberate source edit when its adapter
// really lands, never at runtime.
//
// NOTE WHAT IS AND IS NOT CLAIMED. Shopify has real, working write paths (blog articles and
// the three product/inventory/collection corrections), all of which check the app's granted
// scopes before any mutation and refuse without them. Etsy has an adapter FILE whose own
// header states it cannot publish - it is missing both credentials and a verified request
// mapping - so it is recorded here as present-but-unavailable rather than as publishing
// support. Amazon and eBay have nothing at all.
const PUBLISHING_PATHS = {
  shopify: {
    available: true,
    modules: ['integrations/shopifyBlogPublishing.js', 'integrations/shopifyVendorCorrection.js', 'integrations/shopifyInventoryCorrection.js', 'integrations/shopifyCollectionMembership.js'],
    note: 'Real write paths exist. Each checks the app\'s genuinely granted Admin API scopes before any mutation and refuses - making zero mutation attempts - when the required scope is absent. Every one of them still requires a verified human approval before it runs.',
  },
  etsy: {
    available: false,
    modules: ['integrations/adapters/etsyClient.js'],
    note: 'An adapter file exists, and it cannot publish. Its own header states the two missing external capabilities: the three ETSY_* credentials, and a verified Etsy request mapping including seller-specific ids that only exist inside a real seller account. publishListing() throws a clear error naming the gap and makes no network call.',
  },
};

// What adding a real Amazon or eBay account would actually require. Stated so the work is
// visible and so nobody has to guess whether the core system would need rewriting.
//
// IT WOULD NOT REQUIRE A CORE REWRITE, and that is the point of the architecture built so
// far: every layer above the adapter reaches a platform only through getReadAdapter(), and
// every permission decision already reads configuration rather than credentials.
const ONBOARDING_REQUIREMENTS = [
  {
    id: 'read_adapter',
    title: 'A conforming read adapter',
    description:
      "A module under integrations/adapters/ satisfying platformAdapterContract.js - serving the capabilities the platform's API genuinely offers, and DECLARING the rest unsupported rather than faking them (the pattern etsyReadAdapter.js already follows). Registered in adapterRegistry.js by an explicit source edit.",
    blocks_without: 'Any read, any snapshot, any change detection, and any verification.',
  },
  {
    id: 'credentials',
    title: 'Real account credentials and authorization',
    description:
      "Amazon SP-API and eBay's APIs both require a registered developer application plus seller-granted authorization; neither can be obtained or simulated from inside this repository. Credentials resolve through the existing per-business model (configuration/businessRegistry.js), so no new credential system is needed.",
    blocks_without: 'Any live call. The adapter would report isConfigured() false and refuse.',
  },
  {
    id: 'channel_vocabulary',
    title: 'Recognition in channelModel.js',
    description:
      "CHANNELS defines the platforms this project can actually read from BECAUSE an adapter exists. A platform is added there when its adapter lands - not before - which is what then allows it to appear in a business's enabled_platforms.",
    blocks_without: 'Enablement. tools/configValidator.js rejects the platform in enabled_platforms, so the config fails validation.',
  },
  {
    id: 'explicit_enablement',
    title: 'Explicit per-business enablement',
    description:
      "The business must list the platform in its own business.yaml enabled_platforms. This stays true no matter what else is configured: credentials never enable a platform, and they never will - the two are independent facts and both are required.",
    blocks_without: 'Every platform-bound tool, the monitor, the scheduler and verification - each refuses first.',
  },
  {
    id: 'compliance_rules',
    title: "Structured rules for that marketplace's own policy",
    description:
      "compliance/compliancePolicy.js holds no rules for Amazon or eBay, and none are invented. Until real structured rules are supplied, the engine returns a platform_policy_undetermined REVIEW finding, so the verdict is REVIEW - never PASS.",
    blocks_without: 'Any autonomous PASS. Content for these platforms always requires human review.',
  },
  {
    id: 'verification_coverage',
    title: 'A read path that can confirm a change',
    description:
      "reliability/executionVerification.js re-reads through the adapter to confirm a consequential action. A platform whose adapter cannot observe the changed entity returns 'unverifiable', which is not a pass.",
    blocks_without: 'Trustworthy consequential execution. An unverifiable action is treated as a failure.',
  },
  {
    id: 'publishing_path',
    title: 'A publishing adapter, approval and verification path',
    description:
      'Deliberately last. Publishing is not implemented for a platform until its adapter, permissions, compliance rules, human-approval path and verification coverage all genuinely exist - the same bar Etsy publishing has not yet cleared.',
    blocks_without: 'Any write. There is no publishing path for these platforms at all.',
  },
];

// Every platform name this project can name anywhere, from the real sources. Sorted, so the
// list is stable.
function knownPlatformNames() {
  return Array.from(new Set([...CHANNELS, ...REGISTERED_READ_PLATFORMS, ...RECOGNIZED_PLATFORMS])).sort();
}

// The truthful status of one platform. Every field is derived from the module that decides
// it - see this file's header.
function describePlatformSupport(platform) {
  const name = typeof platform === 'string' ? platform.trim().toLowerCase() : null;
  const readAdapterRegistered = Boolean(name) && hasReadAdapter(name);
  const mayBeEnabled = Boolean(name) && isValidChannel(name);
  const complianceContext = Boolean(name) && RECOGNIZED_PLATFORMS.includes(name);

  const level = readAdapterRegistered && mayBeEnabled
    ? 'integrated'
    : complianceContext
      ? 'context_only'
      : 'unknown';

  const publishing = (name && PUBLISHING_PATHS[name]) || { available: false, modules: [], note: 'No publishing path of any kind exists for this platform in this repository.' };

  let readCapabilities = { supported: [], unsupported: [] };
  if (readAdapterRegistered) {
    const described = describeReadAdapter(name);
    readCapabilities = { supported: described.supported, unsupported: described.unsupported };
  }

  return {
    platform: name,
    support_level: level,
    // Can a business turn this on? Enablement is still explicit per business even when true.
    may_be_enabled: mayBeEnabled,
    read_adapter_registered: readAdapterRegistered,
    read_capabilities_supported: readCapabilities.supported,
    read_capabilities_unsupported: readCapabilities.unsupported,
    // Monitoring, scheduling and verification all reach a platform through the read adapter,
    // so each is exactly as available as that adapter is.
    can_be_monitored: readAdapterRegistered,
    can_be_verified: readAdapterRegistered,
    publishing_available: publishing.available,
    publishing_modules: publishing.modules,
    publishing_note: publishing.note,
    compliance_context_recognized: complianceContext,
    // No structured rules means the engine cannot determine this platform's policy, so its
    // verdict can never be PASS. Derived from whether rules exist, never asserted.
    compliance_can_pass: false,
    compliance_note:
      'compliance/compliancePolicy.js ships no structured platform rules for ANY platform, so every platform-policy check currently yields a platform_policy_undetermined REVIEW finding. No platform can reach PASS on that check without real rules being supplied in policy_context.platform_rules.',
    production_ready: false,
    production_ready_note:
      'This project asserts production readiness for no platform. Real readiness is a statement about a specific connected account, its credentials, its granted scopes and its verified behaviour - none of which a source file can establish.',
  };
}

// Every known platform, described. The one place to look for "what do we actually support".
function describeAllPlatformSupport() {
  return knownPlatformNames().map((platform) => describePlatformSupport(platform));
}

// The platforms that are named in this project but genuinely not integrated. Amazon and eBay
// are here, and they stay here until a real adapter lands.
function listUnsupportedPlatforms() {
  return describeAllPlatformSupport().filter((entry) => entry.support_level !== 'integrated');
}

// A blunt predicate for a caller that only wants a yes or a no.
function isPlatformIntegrated(platform) {
  return describePlatformSupport(platform).support_level === 'integrated';
}

module.exports = {
  SUPPORT_LEVELS,
  PUBLISHING_PATHS,
  ONBOARDING_REQUIREMENTS,
  knownPlatformNames,
  describePlatformSupport,
  describeAllPlatformSupport,
  listUnsupportedPlatforms,
  isPlatformIntegrated,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - platform support (derived, never asserted):\n');

  for (const entry of describeAllPlatformSupport()) {
    console.log(`[${entry.platform}] ${entry.support_level}`);
    console.log(`  may be enabled:     ${entry.may_be_enabled}`);
    console.log(`  read adapter:       ${entry.read_adapter_registered ? entry.read_capabilities_supported.join(', ') : 'none'}`);
    if (entry.read_capabilities_unsupported.length > 0) {
      console.log(`  declared unsupported: ${entry.read_capabilities_unsupported.join(', ')}`);
    }
    console.log(`  monitor / verify:   ${entry.can_be_monitored} / ${entry.can_be_verified}`);
    console.log(`  publishing:         ${entry.publishing_available}`);
    console.log(`  production ready:   ${entry.production_ready}`);
    console.log('');
  }

  console.log('Amazon and eBay, stated plainly:');
  for (const entry of listUnsupportedPlatforms().filter((item) => ['amazon', 'ebay'].includes(item.platform))) {
    console.log(`  ${entry.platform}: ${entry.support_level} - no adapter, cannot be enabled, cannot be monitored, verified or published to.`);
  }

  console.log('\nWhat real onboarding would take (and it is NOT a core rewrite):');
  for (const requirement of ONBOARDING_REQUIREMENTS) {
    console.log(`  - ${requirement.title}`);
    console.log(`      without it: ${requirement.blocks_without}`);
  }
}
