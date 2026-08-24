'use strict';

// The product_data_retrieval tool (tools/toolRegistry.js). Read-only - it only
// retrieves the connected Shopify store's product data (products, variants incl.
// SKU/price/inventory, product status, collections, metafields), never writes or
// changes anything. Thin wrapper around integrations/adapters/shopifyClient.js's
// getProducts() - no new HTTP or config-loading logic is added here, just reuse
// (same convention as tools/businessConfigurationRetrieval.js).
//
// This is also the "connection" between the Shopify data source and
// agent/core/productAgent.js: mapShopifyProductToCandidate() reshapes one normalized
// Shopify product into the plain camelCase entry shape
// productAgent.discoverProducts() already expects. That mapping lives here (in
// tools/), not in agent/core/, because agent/core/ never depends on integrations/ or
// tools/ anywhere in this codebase - agent/core/productAgent.js stays
// Shopify-agnostic and only ever accepts caller-supplied entries.

const shopifyClient = require('../integrations/adapters/shopifyClient');

// Retrieves product data by calling shopifyClient.getProducts(). Read-only: makes no
// writes, changes nothing. Returns exactly what getProducts() returns and throws
// exactly what it throws (not configured / network failure / API error) - never
// fabricates a result.
async function retrieveProductData(params = {}) {
  return shopifyClient.getProducts(params);
}

// Shopify's product status enum -> agent/core/productModel.js's availability enum.
// Anything not explicitly recognized stays 'unknown' rather than guessing.
const STATUS_TO_AVAILABILITY = {
  ACTIVE: 'available',
  ARCHIVED: 'discontinued',
  DRAFT: 'planned',
};

// Converts one normalized Shopify product (from retrieveProductData/getProducts)
// into the camelCase entry shape agent/core/productAgent.js's discoverProducts()
// already expects. Pure reshaping only - no field is invented, only renamed/nested.
function mapShopifyProductToCandidate(shopifyProduct) {
  const firstVariant = Array.isArray(shopifyProduct.variants) ? shopifyProduct.variants[0] : undefined;
  return {
    productIdentity: shopifyProduct.title || '',
    category: shopifyProduct.productType || '',
    pricing: {
      currency: '',
      cost: '',
      price: firstVariant ? firstVariant.price : '',
    },
    availability: STATUS_TO_AVAILABILITY[shopifyProduct.status] || 'unknown',
    source: [`Shopify product ${shopifyProduct.id} (${shopifyProduct.handle})`],
    researchStatus: 'researched',
  };
}

module.exports = { retrieveProductData, mapShopifyProductToCandidate };

if (require.main === module) {
  shopifyClient.loadEnvOnce();
  if (!shopifyClient.isConfigured()) {
    console.log('product_data_retrieval tool loaded, but store credentials are not set.');
    console.log('Copy .env.example to .env and fill in:');
    console.log('  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...');
    process.exit(0);
  }
  retrieveProductData({ limit: 5 })
    .then((products) => {
      console.log(`Retrieved ${products.length} product(s) (read-only, first 5).`);
      console.log(JSON.stringify(products, null, 2));
      if (products.length > 0) {
        console.log('\nMapped to a productAgent.discoverProducts() candidate:');
        console.log(JSON.stringify(mapShopifyProductToCandidate(products[0]), null, 2));
      }
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
