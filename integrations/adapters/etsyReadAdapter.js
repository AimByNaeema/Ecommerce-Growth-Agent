'use strict';

// The Etsy READ ADAPTER: a thin conformance shim that lets the one Etsy read client speak
// integrations/adapters/platformAdapterContract.js's platform-independent vocabulary, so
// integrations/adapters/adapterRegistry.js can resolve 'etsy' the same way it resolves
// 'shopify' and a tool needs no per-platform branch.
//
// ===================================================================================
// A SHIM, NOT A CLIENT. IT ADDS NO TRANSPORT AND NO ENDPOINT.
// ===================================================================================
// Every value returned here comes from integrations/adapters/etsyReadClient.js, which is
// NOT modified by this file and stays the single owner of Etsy HTTP, OAuth, caching, rate
// limiting and its own verified endpoint mapping. This file contains no URL, no fetch, no
// credential resolution and no retry logic - it renames and reshapes what that client
// already returned, nothing more. Two consequences worth stating:
//   - It cannot widen Etsy access. The token still carries only shops_r and listings_r
//     (integrations/etsyOAuth.js refuses anything else), and every call still goes through
//     runEtsyRead()'s assertReadOnlyMethod() GET-only guard.
//   - There is NO write or publish capability here of any kind. The read contract is
//     read-only by rule (ADAPTER_CONTRACT_RULES's 'read_only_only'), Etsy publishing still
//     has no verified request mapping (see integrations/adapters/etsyClient.js's own
//     header), and this file does not require that module at all.
//
// ===================================================================================
// WHAT ETSY CAN AND CANNOT ANSWER - DECLARED, NEVER FAKED.
// ===================================================================================
// Under shops_r + listings_r, Etsy can serve the shop record and the shop's listings. It
// has no orders, no customers, no per-location inventory and no collection concept
// reachable from those scopes. Those four capabilities are therefore DECLARED unsupported
// (UNSUPPORTED_READ_CAPABILITIES below) and REFUSE the call with an identifiable
// unsupported-capability error.
//
// They deliberately do NOT return []. An empty array would be indistinguishable from a shop
// that genuinely has zero orders, and would then become a real 0 in an analytics total - the
// exact silent fabrication ADAPTER_CONTRACT_RULES's 'unsupported_is_declared_never_faked'
// forbids. Refusing loudly is the only honest option, so a caller degrades on purpose
// rather than by accident.
//
// ===================================================================================
// MAPPING DISCIPLINE: A FIELD ETSY DOES NOT HAVE IS null, NEVER INVENTED.
// ===================================================================================
// The contract's vocabulary was set by Shopify, so several contract fields have no Etsy
// counterpart. Each such field is returned as null and listed in
// UNAVAILABLE_FIELDS_BY_CAPABILITY below, so "Etsy does not report this" is inspectable
// data rather than something a reader has to infer from a blank value. Nothing is derived
// from a guess: no slug is manufactured from a URL, no category name is invented from a
// numeric taxonomy id, and no availability boolean is inferred.
//
// Etsy-specific values with no contract home are relayed under the contract's own
// `metadata` escape hatch, namespaced 'etsy', so nothing real is silently dropped either.
//
// Every record keeps the `channel: 'etsy'` stamp etsyReadClient.js already applied
// (agent/core/channelModel.js), so an Etsy listing can never be mistaken downstream for a
// Shopify product. This file never re-stamps or strips it.

const etsyReadClient = require('./etsyReadClient');
const { createUnsupportedCapabilityError } = require('./platformAdapterContract');

const PLATFORM = 'etsy';

// The four read capabilities Etsy cannot serve under this project's granted scopes. Read by
// platformAdapterContract.js's validateAdapterShape(), which reports them as `unsupported`
// rather than treating this adapter as broken.
const UNSUPPORTED_READ_CAPABILITIES = ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections'];

// Why each one is unsupported - the REAL reason, named per capability, so a future reader
// knows whether it is a scope limit that could be lifted or a concept Etsy does not have.
const UNSUPPORTED_REASONS = {
  getOrders:
    "Etsy's receipts/orders endpoints need a transactions scope this project deliberately does not request (integrations/etsyOAuth.js permits only shops_r and listings_r, and refuses any other scope), so no order data is reachable.",
  getCustomers:
    'Etsy exposes no account-level customer aggregate comparable to a storefront customer record, and this project requests no buyer-data scope, so there is no customer data to read.',
  getInventoryLevels:
    "Etsy has no per-location stock concept: a listing carries a single quantity, which is already reported as the listing's own variant inventory_quantity by getProducts() below.",
  getCollections:
    'Etsy has no store-wide collection/category catalog comparable to a Shopify collection. A listing carries a numeric taxonomy_id, which is relayed in each product\'s metadata rather than reshaped into a collection this shop does not have.',
};

// Contract fields Etsy genuinely does not report, per capability. Returned as null and
// declared here, so an absent value is never mistaken for an empty one.
const UNAVAILABLE_FIELDS_BY_CAPABILITY = {
  getShopInfo: [
    // Etsy's shop record carries no contact email, and no email scope is requested.
    'email',
  ],
  getProducts: [
    // Etsy has no handle/slug. Its listings carry a full url, relayed in metadata instead -
    // deriving a slug from that url would be a guess about Etsy's url structure.
    'slug',
    // Etsy reports a numeric taxonomy_id, not a category NAME. Relayed in metadata.
    'category',
    // Etsy's listing record has no vendor/brand field.
    'brand',
    // Etsy has no collection concept (see getCollections above).
    'collections',
    // A listing's variant carries no SKU, and `available` is not inferred from `state` -
    // the real state is reported as the product's own `status` instead.
    'variants[].sku',
    'variants[].available',
  ],
};

function refuse(capability) {
  throw createUnsupportedCapabilityError({
    platform: PLATFORM,
    capability,
    reason: UNSUPPORTED_REASONS[capability],
  });
}

// Relays an Etsy-specific value under the contract's `metadata` shape. Only called for
// values that are genuinely present - an absent value contributes no metadata entry at all,
// rather than an entry whose value is null.
function metadataEntry(key, value) {
  if (value === undefined || value === null || value === '') return null;
  return { namespace: PLATFORM, key, value };
}

// ---------------------------------------------------------------------------------
// isConfigured - the contract's configuration check, mapped to the Etsy READ path.
// ---------------------------------------------------------------------------------
//
// Maps to etsyReadClient.canRead(), not to a broader "is Etsy connected" notion, because
// the read path is the only Etsy path this adapter exposes. Zero network calls, same as
// every other adapter's isConfigured().
function isConfigured({ businessId = null } = {}) {
  return etsyReadClient.canRead({ businessId });
}

// ---------------------------------------------------------------------------------
// getShopInfo <- etsyReadClient.getEtsyShop()
// ---------------------------------------------------------------------------------
//
// Contract shape: { name, domain, email }. Etsy supplies the first two; `email` is null and
// declared in UNAVAILABLE_FIELDS_BY_CAPABILITY above.
//   name   <- shop_name
//   domain <- url  (the shop's own storefront URL - Etsy's equivalent of a store domain)
// Throws exactly what getEtsyShop() throws (missing credentials, rate limit, Etsy error) -
// this shim adds no error handling of its own and never substitutes a fabricated shop.
async function getShopInfo({ businessId = null } = {}) {
  const shop = await etsyReadClient.getEtsyShop({ businessId });
  return {
    name: shop.shop_name || null,
    domain: shop.url || null,
    email: null,
    channel: shop.channel,
    // The full normalized Etsy record, unchanged - so nothing this shim did not map is lost.
    native: shop,
  };
}

// ---------------------------------------------------------------------------------
// getProducts <- etsyReadClient.getEtsyListings()
// ---------------------------------------------------------------------------------
//
// Contract shape per entry: { id, title, slug, status, category, brand, tags, variants,
// collections, metadata }. Mapped from one Etsy listing:
//   id      <- listing_id
//   title   <- title
//   status  <- state          (Etsy's own listing state, relayed verbatim - not normalized
//                              into Shopify's ACTIVE/DRAFT/ARCHIVED vocabulary, which would
//                              assert an equivalence this project has not established)
//   tags    <- tags
//   variants -> exactly one entry, because an Etsy listing carries exactly one price and one
//               quantity. Its price and inventory_quantity are the listing's own real
//               values; sku and available are null (see UNAVAILABLE_FIELDS_BY_CAPABILITY).
//   metadata -> Etsy-only reals with no contract home: url, description, taxonomy_id,
//               listing_type, is_digital_product, materials, num_favorers, views.
// slug/category/brand/collections are null/[] and declared - never manufactured.
//
// `limit`/`offset`/`state` are passed straight through to getEtsyListings(); this shim
// invents no paging behavior of its own.
async function getProducts({ businessId = null, limit = 25, offset = 0, state = null } = {}) {
  const listings = await etsyReadClient.getEtsyListings({ businessId, limit, offset, state });
  return listings.map((listing) => ({
    id: listing.listing_id,
    title: listing.title || null,
    slug: null,
    status: listing.state || null,
    category: null,
    brand: null,
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    variants: [
      {
        id: listing.listing_id,
        title: listing.title || null,
        sku: null,
        price: listing.price,
        inventory_quantity: listing.quantity,
        available: null,
      },
    ],
    collections: [],
    metadata: [
      metadataEntry('url', listing.url),
      metadataEntry('description', listing.description),
      metadataEntry('taxonomy_id', listing.taxonomy_id),
      metadataEntry('listing_type', listing.listing_type),
      metadataEntry('is_digital_product', listing.is_digital_product),
      metadataEntry('materials', Array.isArray(listing.materials) && listing.materials.length > 0 ? listing.materials : null),
      metadataEntry('num_favorers', listing.num_favorers),
      metadataEntry('views', listing.views),
    ].filter(Boolean),
    channel: listing.channel,
    // The full normalized Etsy listing, unchanged.
    native: listing,
  }));
}

// ---------------------------------------------------------------------------------
// The four declared-unsupported capabilities. Each refuses; none fabricates.
// ---------------------------------------------------------------------------------
//
// Declared async to match the contract's other reads, so a caller awaiting one gets a
// rejected promise rather than a synchronous throw from an unexpected place.
async function getOrders() {
  return refuse('getOrders');
}

async function getCustomers() {
  return refuse('getCustomers');
}

async function getInventoryLevels() {
  return refuse('getInventoryLevels');
}

async function getCollections() {
  return refuse('getCollections');
}

module.exports = {
  PLATFORM,
  UNSUPPORTED_READ_CAPABILITIES,
  UNSUPPORTED_REASONS,
  UNAVAILABLE_FIELDS_BY_CAPABILITY,
  isConfigured,
  getShopInfo,
  getProducts,
  getOrders,
  getCustomers,
  getInventoryLevels,
  getCollections,
};

if (require.main === module) {
  const { validateAdapterShape } = require('./platformAdapterContract');
  console.log('Smart E-Commerce Growth AI Agent - Etsy read adapter (a shim over etsyReadClient.js):\n');

  const result = validateAdapterShape(module.exports);
  console.log(`Conforms to the read contract: ${result.valid}`);
  console.log(`  supported:   ${result.supported.join(', ')}`);
  console.log(`  unsupported: ${result.unsupported.join(', ')}`);

  console.log('\nWhy each unsupported capability is unsupported:');
  for (const capability of UNSUPPORTED_READ_CAPABILITIES) {
    console.log(`  [${capability}] ${UNSUPPORTED_REASONS[capability]}`);
  }

  console.log('\nContract fields Etsy does not report (returned as null, never invented):');
  for (const [capability, fields] of Object.entries(UNAVAILABLE_FIELDS_BY_CAPABILITY)) {
    console.log(`  ${capability}: ${fields.join(', ')}`);
  }

  console.log(`\nEtsy read credentials present: ${isConfigured()}`);
  console.log('No network call was made by this CLI, and this adapter has no write path of any kind.');
}
