'use strict';

// The business_configuration_retrieval tool (tools/toolRegistry.js): the first real,
// callable tool for the ONE agent. Read-only - it only retrieves the connected
// Shopify store's shop identity, never writes or changes anything. Thin wrapper
// around integrations/adapters/shopifyClient.js's getShopInfo() - no new HTTP or
// config-loading logic is added here, just reuse. Not wired into any
// register/execute/dispatch mechanism yet since none exists (see
// tools/toolRegistry.js) - this is a standalone, directly callable function until
// that dispatcher is built in later, explicitly-scoped work.

// RESOLVED, NOT IMPORTED. This tool no longer names a concrete adapter module: it asks
// integrations/adapters/adapterRegistry.js for this platform's read adapter, which is
// checked against integrations/adapters/platformAdapterContract.js before it is handed
// back. The behavior against Shopify is identical - the registry returns the same
// shopifyClient module this file used to require directly - but the platform is now one
// named constant rather than an import, and an unregistered or non-conforming adapter
// fails closed at the seam instead of deep inside a call.
const { getReadAdapter } = require('../integrations/adapters/adapterRegistry');

// The platform this tool reads. Matches tools/toolRegistry.js's own `platforms: ['shopify']`
// binding for business_configuration_retrieval, which is what
// agent/core/toolPermissions.js's platform gate checks against the business's
// enabled_platforms before this tool is ever dispatched.
const PLATFORM = 'shopify';

// Retrieves the business's configuration by reading the connected store's shop identity
// (name, domain, email) via the resolved adapter's getShopInfo(). Read-only: makes no
// writes, changes nothing. Returns exactly what getShopInfo() returns and throws exactly
// what it throws (not configured / network failure / API error) - never fabricates a result.
async function retrieveBusinessConfiguration({ businessId = null } = {}) {
  return getReadAdapter(PLATFORM).getShopInfo({ businessId });
}

module.exports = { retrieveBusinessConfiguration };

if (require.main === module) {
  // isConfigured() resolves credentials, which loads the root .env itself on the
  // no-businessId path - so the explicit loadEnvOnce() this demo used to call was
  // redundant, and dropping it keeps this block to contract capabilities only.
  if (!getReadAdapter(PLATFORM).isConfigured()) {
    console.log('business_configuration_retrieval tool loaded, but store credentials are not set.');
    console.log('Copy .env.example to .env and fill in:');
    console.log('  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...');
    process.exit(0);
  }
  retrieveBusinessConfiguration()
    .then((result) => {
      console.log('Business configuration retrieved.');
      console.log(`Business (shop) name: ${result.name}`);
      console.log(`Domain: ${result.domain}`);
      console.log(`Email: ${result.email}`);
      console.log(`API version: ${result.apiVersion}`);
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
