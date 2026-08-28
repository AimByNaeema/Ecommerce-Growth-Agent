'use strict';

// The business_configuration_retrieval tool (tools/toolRegistry.js): the first real,
// callable tool for the ONE agent. Read-only - it only retrieves the connected
// Shopify store's shop identity, never writes or changes anything. Thin wrapper
// around integrations/adapters/shopifyClient.js's getShopInfo() - no new HTTP or
// config-loading logic is added here, just reuse. Not wired into any
// register/execute/dispatch mechanism yet since none exists (see
// tools/toolRegistry.js) - this is a standalone, directly callable function until
// that dispatcher is built in later, explicitly-scoped work.

const shopifyClient = require('../integrations/adapters/shopifyClient');

// Retrieves the business's configuration by reading the connected Shopify store's
// shop identity (name, domain, email) via shopifyClient.getShopInfo(). Read-only:
// makes no writes, changes nothing. Returns exactly what getShopInfo() returns and
// throws exactly what it throws (not configured / network failure / API error) -
// never fabricates a result.
async function retrieveBusinessConfiguration({ businessId = null } = {}) {
  return shopifyClient.getShopInfo({ businessId });
}

module.exports = { retrieveBusinessConfiguration };

if (require.main === module) {
  shopifyClient.loadEnvOnce();
  if (!shopifyClient.isConfigured()) {
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
