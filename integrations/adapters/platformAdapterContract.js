'use strict';

// The Platform Adapter Contract: the required capability surface every per-platform
// adapter under integrations/adapters/ (starting with shopifyClient.js) must expose,
// and the normalized, platform-independent return shape each capability documents.
// This is a specification and a structural checker only - no execution logic, no
// network call, no new adapter, no change to integrations/adapters/shopifyClient.js.
// Same "architecture/rules file" convention as approvals/approvalArchitecture.js: a
// list of entries + a lookup helper + a validator, not a data record schema.
//
// WHY THIS FILE EXISTS: the multi-platform architecture review found that
// integrations/adapters/shopifyClient.js is the only adapter, and its function
// surface/return shapes were only a de facto contract (comments and convention), never
// an enforced or reusable one. This file makes that contract explicit so a future
// adapter (e.g. amazonClient.js, etsyClient.js, ebayClient.js, wooCommerceClient.js -
// none added here) has something concrete to satisfy, and so shopifyClient.js's
// existing surface can be checked against it today, structurally.
//
// SCOPE: this validates CAPABILITY PRESENCE (does the adapter module export each
// required function?) - it cannot validate a capability's real RETURN shape without
// invoking it against a real platform, which is out of scope for a static, read-only
// contract. Each capability's `normalized_shape` field documents the expected return
// shape for a human/future adapter author to implement against; it is descriptive,
// not (yet) mechanically enforced field-by-field.
//
// PLATFORM-INDEPENDENT VOCABULARY: `normalized_shape` field names are generic
// e-commerce terms, not Shopify's - e.g. `slug` (Shopify calls this `handle`),
// `category` (Shopify calls this `productType`), `brand` (Shopify calls this
// `vendor`). integrations/adapters/shopifyClient.js is NOT renamed to match this
// vocabulary here (that would be a redesign, out of scope) - it already returns an
// equivalent normalized shape under its own Shopify-flavored field names; aligning its
// literal field names to this contract's vocabulary is a later, separate, explicitly-
// scoped step, not required for it to satisfy the CAPABILITY portion of this contract
// (see validateAdapterShape() below, and this file's own CLI demo, which checks
// shopifyClient.js against exactly that).
//
// getOrders' normalized_shape is agent/core/orderModel.js's ORDER_FIELDS directly (the
// one schema this review also formalized) - every other capability's normalized_shape
// is described inline here, since no dedicated model file for shop-info, product-
// catalog, customer, inventory, or collection *adapter output* exists yet (distinct
// from agent/core/productModel.js, which is a research/opportunity record, not a raw
// catalog pull - see that file's own header).

const { ORDER_FIELDS } = require('../../agent/core/orderModel');

const REQUIRED_ADAPTER_CAPABILITIES = [
  {
    id: 'isConfigured',
    title: 'Configuration check',
    description:
      'Reports whether this adapter has valid credentials configured for a given business, WITHOUT making a network call - lets a caller fail fast with a clear message instead of attempting a request that can only fail.',
    normalized_shape: 'boolean',
  },
  {
    id: 'getShopInfo',
    title: 'Shop/store identity',
    description:
      'Confirms the platform connection works and reports basic store identity. Every platform has an equivalent concept (a shop/seller account with a name, primary domain/store URL, and contact email).',
    normalized_shape: '{ name: string, domain: string, email: string }',
  },
  {
    id: 'getProducts',
    title: 'Product catalog retrieval',
    description:
      'Retrieves the catalog\'s products, normalized into a generic product-listing shape - read-only, no mutation.',
    normalized_shape:
      'array of { id: string, title: string, slug: string, status: string, category: string, ' +
      'brand: string, tags: array, variants: [{ id, title, sku, price, inventory_quantity, available }], ' +
      'collections: [{ id, title }], metadata: [{ namespace, key, value }] }',
  },
  {
    id: 'getOrders',
    title: 'Order retrieval',
    description:
      'Retrieves orders, normalized into agent/core/orderModel.js\'s shape - the one dedicated order schema this project defines, reused here rather than redeclared.',
    normalized_shape: `array of agent/core/orderModel.js records: { ${ORDER_FIELDS.map((field) => field.id).join(', ')} }`,
  },
  {
    id: 'getCustomers',
    title: 'Customer retrieval (non-PII)',
    description:
      'Retrieves account-level customer aggregate data only - deliberately never a name, email, phone, or address (same privacy-conscious "customers where permitted" convention integrations/adapters/shopifyClient.js already established).',
    normalized_shape:
      'array of { id: string, orders_count: number|string, amount_spent: string, currency: string, ' +
      'state: string, tags: array, created_at: string }',
  },
  {
    id: 'getInventoryLevels',
    title: 'Inventory level retrieval',
    description: 'Retrieves per-location stock levels - read-only, no mutation.',
    normalized_shape:
      'array of { id: string, sku: string, tracked: boolean, ' +
      'levels: [{ location_id, location_name, available }] }',
  },
  {
    id: 'getCollections',
    title: 'Collection/category catalog retrieval',
    description:
      'Retrieves the store-wide collection/category catalog, independent of any one product - read-only, no mutation.',
    normalized_shape:
      'array of { id: string, title: string, slug: string, description: string, ' +
      'image: { url } | null, products_count: number }',
  },
];

// Cross-cutting rules every adapter must follow, regardless of platform - the same
// behavior integrations/adapters/shopifyClient.js's own header already documents,
// made explicit here as a reusable contract rather than restated per-adapter.
const ADAPTER_CONTRACT_RULES = [
  {
    id: 'read_only_only',
    description:
      'No write/mutation capability is part of this contract - every required capability is a read. A future write/execute capability is a separate, explicitly-scoped contract addition, not assumed here.',
  },
  {
    id: 'never_fabricate_a_result',
    description:
      'A missing config, a network failure, or a non-success/error response from the platform must throw a clear error - never return fabricated, guessed, or partial-but-unlabeled data.',
  },
  {
    id: 'credentials_isolated_per_business',
    description:
      'Credentials are resolved per business (see configuration/businessRegistry.js), never hardcoded and never mixed between businesses in one running process.',
  },
  {
    id: 'no_sdk_required',
    description:
      'An adapter is not required to add a platform SDK dependency - a plain HTTP/GraphQL client (e.g. Node\'s built-in fetch) satisfies this contract, same precedent as integrations/adapters/shopifyClient.js.',
  },
];

// ---------------------------------------------------------------------------------
// The PUBLISHING contract - additive, and deliberately separate from the read contract
// above.
// ---------------------------------------------------------------------------------
//
// ADAPTER_CONTRACT_RULES's 'read_only_only' rule states that a write/mutation capability
// is "a separate, explicitly-scoped contract addition, not assumed here". This is that
// addition, and it is kept apart rather than folded in for two reasons: the read
// contract stays exactly true of every adapter that only reads (nothing about
// integrations/adapters/shopifyClient.js changes, and it is still validated against the
// read contract unchanged), and an adapter must OPT IN to being publish-capable rather
// than inheriting the claim.
//
// A publishing adapter is checked with validatePublishingAdapterShape(), never with
// validateAdapterShape() - the two answer different questions.
//
// THERE IS MORE THAN ONE KIND OF PUBLISH, AND THIS CONTRACT ONLY DESCRIBED ONE.
// The capability list below was written around a MARKETPLACE LISTING publish
// (integrations/adapters/etsyClient.js's publishListing, whose transport is a declared,
// honest gap). But the one publishing integration in this project that actually reaches
// a real store today publishes STORE CONTENT, not a listing:
// integrations/adapters/shopifyClient.js's createBlogArticle(), behind its own
// fail-closed hasWriteContentScope() preflight, called from
// integrations/shopifyBlogPublishing.js past a passing publish authorization.
//
// Checked against the list below, that working adapter reports as non-conforming
// ("missing canPublish, missing publishListing") while the adapter with no transport
// reports as conforming - the contract had the two exactly backwards, because a blog
// article is not a marketplace listing and never will be. See PUBLISHING_ADAPTER_KINDS
// below, which fixes that by naming the kind being checked. NOTHING about either
// adapter changed: both kinds below describe capabilities that already exist and are
// already exported today. No endpoint, field, credential or publishing behavior is
// invented for either platform.
const PUBLISHING_ADAPTER_CAPABILITIES = [
  {
    id: 'isConfigured',
    description: 'Whether every credential this platform requires is present, per business. Never reports a value, only presence.',
    normalized_shape: 'boolean',
  },
  {
    id: 'canPublish',
    description:
      'Whether this adapter could actually perform a publish right now. Deliberately distinct from isConfigured(): credentials being present does not mean the integration is complete, and conflating the two is how an unfinished adapter ships looking finished.',
    normalized_shape: 'boolean',
  },
  {
    id: 'publishListing',
    description:
      "Publish one formatted marketplace listing (an agent/core/marketplaceListingFormatModel.js record) to the seller's account on this platform. Must return the platform's own result/reference, or throw - never a fabricated id, never a silent no-op, never a partial success reported as a success.",
    normalized_shape: "the platform's own result object, relayed unchanged",
  },
];

// Capabilities a STORE CONTENT publishing adapter must expose. Every entry is a
// function integrations/adapters/shopifyClient.js already exports and
// integrations/shopifyBlogPublishing.js already calls - this describes an implemented
// boundary, it does not ask for anything new.
//
// As with the read contract above, a capability's `id` IS the required export name, and
// those names were set by the adapter that implemented the capability first (the read
// contract took getShopInfo/getProducts from Shopify the same way). hasWriteContentScope
// is therefore the literal export required here; the generic capability it stands for is
// "the adapter verifies its own granted write permission before any mutation leaves the
// process, and fails closed" - the store-content counterpart to canPublish() in the
// marketplace-listing kind above.
const CONTENT_PUBLISHING_ADAPTER_CAPABILITIES = [
  {
    id: 'isConfigured',
    description:
      'Whether every credential this platform requires is present, per business. Never reports a value, only presence. Same capability as the marketplace-listing kind - a publish of any kind needs credentials first.',
    normalized_shape: 'boolean',
  },
  {
    id: 'hasWriteContentScope',
    description:
      "Whether the connected app has actually been granted the platform's content-write permission. Checked by the adapter itself, immediately before any mutation, and failing closed - so an app missing the grant reaches zero mutations rather than discovering it from a rejected write. Distinct from isConfigured() for the same reason canPublish() is: a present credential is not a granted permission.",
    normalized_shape: 'Promise<boolean>',
  },
  {
    id: 'createBlogArticle',
    description:
      "Publish one content article to the store's own blog, from an already-approved generated-content record. Must return the platform's own result/reference, or throw - never a fabricated article id, never a silent no-op, never a partial success reported as a success.",
    normalized_shape: "the platform's own result object, relayed unchanged",
  },
];

// The publish kinds this contract describes. Each one is backed by a real adapter in
// this repository - a kind is never declared for a platform or a publishing style that
// does not already exist here, which is what keeps this a contract over real
// integrations rather than a wishlist.
const PUBLISHING_ADAPTER_KINDS = [
  {
    id: 'marketplace_listing',
    title: 'Marketplace listing publishing',
    description:
      'Publishes one formatted marketplace listing (an agent/core/marketplaceListingFormatModel.js record) to the seller\'s account on an external marketplace.',
    capabilities: PUBLISHING_ADAPTER_CAPABILITIES,
    implemented_by: 'integrations/adapters/etsyClient.js',
  },
  {
    id: 'store_content',
    title: 'Store content publishing',
    description:
      "Publishes one approved content article to the business's own store, on a platform the business already owns - not a third-party marketplace listing.",
    capabilities: CONTENT_PUBLISHING_ADAPTER_CAPABILITIES,
    implemented_by: 'integrations/adapters/shopifyClient.js',
  },
];

// The kind assumed when a caller names none - the marketplace-listing kind this contract
// originally described on its own, so every existing call site keeps its exact previous
// behavior.
const DEFAULT_PUBLISHING_KIND = 'marketplace_listing';

const PUBLISHING_CONTRACT_RULES = [
  {
    id: 'authorization_before_mutation',
    description:
      'A publishing adapter is never called except past a passing server-side publish authorization (approvals/publishAuthorization.js), re-checked immediately before the mutation. The adapter itself does not enforce this - the workflow in front of it does, and there is exactly one call site per platform.',
  },
  {
    id: 'never_fabricate_a_publish_result',
    description:
      'A missing credential, an incomplete integration, a network failure, or a platform error must throw a clear error naming what is missing - never a fabricated listing id, and never a success-shaped result for a mutation that did not happen.',
  },
  {
    id: 'credentials_never_surfaced',
    description:
      'Errors, audit detail and return values may name which credential KEYS are missing, never a credential value - so a publish failure can be logged and audited safely.',
  },
];

// Structural check for a PUBLISHING adapter of one kind. Same limits as
// validateAdapterShape(): it verifies capability presence, not real return shape, which
// cannot be checked without a live platform.
//
// `kind` names which publish this adapter claims to perform (see
// PUBLISHING_ADAPTER_KINDS). Omitting it checks the marketplace-listing kind, which is
// what this function checked before kinds existed - so every existing caller is
// unchanged. An adapter is only ever checked against a kind it actually claims: asking
// a store-content adapter for publishListing() is a question about the wrong contract,
// not a defect in the adapter. An unknown kind is an error, never a silent pass.
function validatePublishingAdapterShape(adapterModule, { kind = DEFAULT_PUBLISHING_KIND } = {}) {
  const errors = [];

  const publishingKind = getPublishingKindById(kind);
  if (!publishingKind) {
    return {
      valid: false,
      errors: [`unknown publishing kind: ${kind} (must be one of: ${PUBLISHING_ADAPTER_KINDS.map((entry) => entry.id).join(', ')})`],
    };
  }

  if (typeof adapterModule !== 'object' || adapterModule === null) {
    return { valid: false, errors: ['adapter module must be an object'] };
  }

  for (const capability of publishingKind.capabilities) {
    if (typeof adapterModule[capability.id] !== 'function') {
      errors.push(`missing required publishing capability: ${capability.id} (must be a function)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function getPublishingKindById(id) {
  return PUBLISHING_ADAPTER_KINDS.find((entry) => entry.id === id);
}

// Looks a publishing capability up within one kind (the marketplace-listing kind when
// none is named, preserving this helper's previous behavior). Deliberately not a search
// across every kind at once: isConfigured is required by both, and returning whichever
// happened to be declared first would hand back the wrong kind's description.
function getPublishingCapabilityById(id, { kind = DEFAULT_PUBLISHING_KIND } = {}) {
  const publishingKind = getPublishingKindById(kind);
  if (!publishingKind) return undefined;
  return publishingKind.capabilities.find((entry) => entry.id === id);
}

function getCapabilityById(id) {
  return REQUIRED_ADAPTER_CAPABILITIES.find((entry) => entry.id === id);
}

function getRuleById(id) {
  return ADAPTER_CONTRACT_RULES.find((entry) => entry.id === id);
}

// Structural check only (see this file's own header): does the given adapter module
// expose every required capability as a callable function? Cannot verify a
// capability's real return shape without invoking it against a live platform - that is
// out of scope for a static, read-only contract. Does not guess or fill in anything
// missing - only reports, same convention as every other validate*Shape() in this
// project.
function validateAdapterShape(adapterModule) {
  const errors = [];

  if (typeof adapterModule !== 'object' || adapterModule === null) {
    return { valid: false, errors: ['adapter module must be an object'] };
  }

  for (const capability of REQUIRED_ADAPTER_CAPABILITIES) {
    if (typeof adapterModule[capability.id] !== 'function') {
      errors.push(`missing required capability: ${capability.id} (must be a function)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  REQUIRED_ADAPTER_CAPABILITIES,
  ADAPTER_CONTRACT_RULES,
  PUBLISHING_ADAPTER_CAPABILITIES,
  CONTENT_PUBLISHING_ADAPTER_CAPABILITIES,
  PUBLISHING_ADAPTER_KINDS,
  DEFAULT_PUBLISHING_KIND,
  PUBLISHING_CONTRACT_RULES,
  validatePublishingAdapterShape,
  getPublishingKindById,
  getPublishingCapabilityById,
  getCapabilityById,
  getRuleById,
  validateAdapterShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - platform adapter contract (specification only):\n');

  console.log('Required capabilities:');
  REQUIRED_ADAPTER_CAPABILITIES.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.id}] ${entry.title}`);
    console.log(`   ${entry.description}`);
    console.log(`   normalized_shape: ${entry.normalized_shape}`);
  });

  console.log('\nContract rules:');
  ADAPTER_CONTRACT_RULES.forEach((rule, index) => {
    console.log(`${index + 1}. [${rule.id}]`);
    console.log(`   ${rule.description}`);
  });

  console.log('\nChecking integrations/adapters/shopifyClient.js against this contract (structural check only, no network call):');
  const shopifyClient = require('./shopifyClient');
  const result = validateAdapterShape(shopifyClient);
  if (result.valid) {
    console.log('  PASS: shopifyClient.js exposes every required capability.');
  } else {
    console.log('  FAIL:');
    result.errors.forEach((error) => console.log(`    - ${error}`));
  }

  console.log('\nPublishing kinds, each checked against the adapter that implements it:');
  const adaptersByKind = {
    marketplace_listing: { path: 'integrations/adapters/etsyClient.js', module: require('./etsyClient') },
    store_content: { path: 'integrations/adapters/shopifyClient.js', module: shopifyClient },
  };
  for (const publishingKind of PUBLISHING_ADAPTER_KINDS) {
    const adapter = adaptersByKind[publishingKind.id];
    const outcome = validatePublishingAdapterShape(adapter.module, { kind: publishingKind.id });
    console.log(`  [${publishingKind.id}] ${adapter.path}`);
    console.log(`    required: ${publishingKind.capabilities.map((entry) => entry.id).join(', ')}`);
    if (outcome.valid) {
      console.log('    PASS: every required publishing capability is exposed.');
    } else {
      console.log('    FAIL:');
      outcome.errors.forEach((error) => console.log(`      - ${error}`));
    }
  }

  console.log('\nA passing structural check is not a claim that a platform can be published to -');
  console.log('integrations/adapters/etsyClient.js exposes publishListing() and still has no transport,');
  console.log('and says so itself at runtime rather than fabricating a result.');
}
