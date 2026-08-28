'use strict';

// The collection_data_retrieval tool (tools/toolRegistry.js). Read-only - it only
// retrieves the connected Shopify store's collection catalog (title, handle,
// description, image, product count), never writes or changes anything. Thin wrapper
// around integrations/adapters/shopifyClient.js's getCollections() - no new HTTP or
// config-loading logic is added here, just reuse (same convention as
// tools/businessConfigurationRetrieval.js and tools/productDataRetrievalTool.js). This
// is a store-wide collection list, independent of any one product - see
// tools/productDataRetrievalTool.js for the collections[] already nested per product.

const shopifyClient = require('../integrations/adapters/shopifyClient');

// Retrieves collection data by calling shopifyClient.getCollections(). Read-only: makes
// no writes, changes nothing. Returns exactly what getCollections() returns and throws
// exactly what it throws (not configured / network failure / API error) - never
// fabricates a result.
async function retrieveCollectionData(params = {}) {
  return shopifyClient.getCollections(params);
}

module.exports = { retrieveCollectionData };

if (require.main === module) {
  shopifyClient.loadEnvOnce();
  if (!shopifyClient.isConfigured()) {
    console.log('collection_data_retrieval tool loaded, but store credentials are not set.');
    console.log('Copy .env.example to .env and fill in:');
    console.log('  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...');
    process.exit(0);
  }
  retrieveCollectionData({ limit: 5 })
    .then((collections) => {
      console.log(`Retrieved ${collections.length} collection(s) (read-only, first 5).`);
      console.log(JSON.stringify(collections, null, 2));
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
