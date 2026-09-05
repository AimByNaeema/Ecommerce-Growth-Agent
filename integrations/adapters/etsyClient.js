'use strict';

// The Etsy adapter - the smallest surface the publishing workflow needs, following the
// existing integrations/adapters/ pattern rather than starting a second integration
// framework. It reuses this project's credential resolution (root .env or per-business
// via configuration/businessRegistry.js) and its shared retry/timeout layer
// (agent/core/networkRetry.js) exactly as integrations/adapters/shopifyClient.js does.
// No SDK dependency is added, matching that precedent.
//
// ===================================================================================
// THIS ADAPTER CANNOT PUBLISH TO ETSY YET, AND SAYS SO RATHER THAN PRETENDING.
// ===================================================================================
// Two external capabilities this project does not have are required before
// publishListing() can do anything real, and neither can be invented here:
//
//   1. CREDENTIALS. Etsy's Open API v3 requires a registered application keystring plus
//      an OAuth 2.0 (PKCE) access token carrying the listing write scope, and the
//      seller's own numeric shop id. None of these exists in this project - see
//      ETSY_REQUIRED_CREDENTIALS below and the documented, empty ETSY_* block in
//      .env.example. isConfigured() reports honestly on them.
//
//   2. A VERIFIED FIELD/ENDPOINT MAPPING. Creating a real Etsy listing requires values
//      that only exist inside a particular seller's account (a taxonomy id, a shipping
//      profile id) plus required attributes about the product's origin. Writing that
//      request from memory is exactly the fabrication CLAUDE.md rule 8 forbids, and it
//      would be presented as "Etsy's supported API" while being unverifiable. So this
//      file contains NO endpoint URL and NO Etsy field names - the mapping is a
//      deliberate, declared gap, not a silent one.
//
// publishListing() therefore ALWAYS throws a specific, actionable error naming whichever
// gap applies. It never returns a fabricated listing id, never partially succeeds, and
// never silently no-ops - the same "never fabricate a result" rule
// integrations/adapters/platformAdapterContract.js already states and
// integrations/adapters/shopifyClient.js already follows.
//
// WHY THIS FILE EXISTS AT ALL, GIVEN THAT. The security boundary in front of publishing
// is real, complete and testable today: integrations/etsyPublishing.js re-checks
// server-side authorization immediately before calling this adapter, and every
// "unauthorized -> zero mutation" guarantee is enforced and covered against this exact
// function. When the two gaps above are closed, the transport lands HERE and nothing in
// front of it changes.

const { RetryableError, retryAsync, withTimeout } = require('../../agent/core/networkRetry');
const businessRegistry = require('../../configuration/businessRegistry');
const shopifyClient = require('./shopifyClient');

// Reuses shopifyClient.js's own loadEnvOnce() rather than duplicating the fs/path/
// process.loadEnvFile logic a third time (CLAUDE.md rules 3-4). Its effect is identical:
// populate process.env from the root .env once per process.
const loadEnvOnce = shopifyClient.loadEnvOnce;

// What a real Etsy publish would need, declared so the gap is inspectable rather than
// discovered at runtime. These names are this project's own configuration keys - they
// are not Etsy API field names, and nothing here asserts Etsy's request shape.
const ETSY_REQUIRED_CREDENTIALS = [
  {
    key: 'ETSY_API_KEYSTRING',
    description: "The registered Etsy application's keystring, from an Etsy developer app.",
  },
  {
    key: 'ETSY_OAUTH_ACCESS_TOKEN',
    description: 'An OAuth 2.0 access token for the seller, carrying the listing write scope.',
  },
  {
    key: 'ETSY_SHOP_ID',
    description: "The seller's own numeric Etsy shop id, which every listing call is scoped to.",
  },
];

// The remaining gap once credentials exist. Kept as data so a future, explicitly-scoped
// step can retire it deliberately instead of someone assuming it was already handled.
const ETSY_PUBLISHING_STATUS = 'awaiting_verified_api_mapping';

const ETSY_UNVERIFIED_MAPPING_REASON =
  'Publishing to Etsy also needs a verified request mapping (including seller-specific ids such as a taxonomy id and a shipping profile id) that this project has not established. No endpoint or field shape is guessed here.';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Same two-mode resolution shopifyClient.js uses: the root .env for today's single
// business, or configuration/businessRegistry.js's per-business credentials, which never
// touch process.env.
function resolveCredentials(businessId) {
  if (!businessId) {
    loadEnvOnce();
    return {
      keystring: process.env.ETSY_API_KEYSTRING,
      accessToken: process.env.ETSY_OAUTH_ACCESS_TOKEN,
      shopId: process.env.ETSY_SHOP_ID,
    };
  }
  const credentials = businessRegistry.loadBusinessCredentials(businessId);
  return {
    keystring: credentials.ETSY_API_KEYSTRING,
    accessToken: credentials.ETSY_OAUTH_ACCESS_TOKEN,
    shopId: credentials.ETSY_SHOP_ID,
  };
}

// Which required credentials are absent. Returns the KEY NAMES only - never a value, so
// this can be logged, audited or returned to a caller without leaking a secret.
function missingCredentials(businessId = null) {
  const resolved = resolveCredentials(businessId);
  const present = {
    ETSY_API_KEYSTRING: resolved.keystring,
    ETSY_OAUTH_ACCESS_TOKEN: resolved.accessToken,
    ETSY_SHOP_ID: resolved.shopId,
  };
  return ETSY_REQUIRED_CREDENTIALS.filter((entry) => !isNonEmptyString(present[entry.key])).map((entry) => entry.key);
}

// True once every required credential is present. Mirrors shopifyClient.isConfigured()'s
// signature so both adapters are checked the same way. Being configured is necessary but
// NOT sufficient to publish - see ETSY_PUBLISHING_STATUS above.
function isConfigured({ businessId = null } = {}) {
  return missingCredentials(businessId).length === 0;
}

// True once this adapter could actually perform a publish. Deliberately separate from
// isConfigured(): conflating "the credentials are present" with "the integration works"
// is how a fabricated implementation gets shipped unnoticed.
function canPublish({ businessId = null } = {}) {
  return isConfigured({ businessId }) && ETSY_PUBLISHING_STATUS !== 'awaiting_verified_api_mapping';
}

// Publishes one formatted marketplace listing (an
// agent/core/marketplaceListingFormatModel.js record) to the seller's Etsy shop.
//
// ALWAYS THROWS TODAY - see this file's header. The error names the specific gap so a
// caller (and a human reading an audit trail) knows exactly what is missing, and callers
// that already handle a platform failure need no special case for it.
//
// The signature is the one the real transport will use, so closing the gap is an edit
// HERE and nowhere else: the authorization boundary in front of it does not change.
async function publishListing({ listing, businessId = null } = {}) {
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
    throw new Error('publishListing requires a formatted marketplace listing record.');
  }

  const missing = missingCredentials(businessId);
  if (missing.length > 0) {
    throw new Error(
      `Etsy is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Add them to .env (see the ETSY_* block in .env.example) or to this business\'s own credentials file. No Etsy call was attempted.'
    );
  }

  throw new Error(`Etsy publishing is not available: ${ETSY_UNVERIFIED_MAPPING_REASON} No Etsy call was attempted.`);
}

module.exports = {
  ETSY_REQUIRED_CREDENTIALS,
  ETSY_PUBLISHING_STATUS,
  ETSY_UNVERIFIED_MAPPING_REASON,
  loadEnvOnce,
  resolveCredentials,
  missingCredentials,
  isConfigured,
  canPublish,
  publishListing,
  // Re-exported so the transport, when it lands, uses this project's existing retry and
  // timeout behavior rather than introducing its own (CLAUDE.md rules 3-4). Referenced
  // here so the dependency is real and visible, not merely intended.
  _sharedTransport: { RetryableError, retryAsync, withTimeout },
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy adapter:\n');
  console.log(`Publishing status: ${ETSY_PUBLISHING_STATUS}`);
  console.log(`Configured (credentials present): ${isConfigured()}`);
  console.log(`Can publish: ${canPublish()}`);

  const missing = missingCredentials();
  if (missing.length > 0) {
    console.log('\nMissing credentials (names only - no value is ever printed):');
    for (const key of missing) {
      const entry = ETSY_REQUIRED_CREDENTIALS.find((candidate) => candidate.key === key);
      console.log(`  ${key} - ${entry.description}`);
    }
  }

  console.log(`\n${ETSY_UNVERIFIED_MAPPING_REASON}`);
  console.log('\npublishListing() throws rather than fabricating a result:');
  publishListing({ listing: { marketplace: 'etsy', product_reference: '(placeholder)' } })
    .then(() => console.log('  (unreachable)'))
    .catch((err) => console.log(`  ${err.message}`));
}
