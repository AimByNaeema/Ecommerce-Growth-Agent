'use strict';

// The etsy_shop_data_retrieval tool (tools/toolRegistry.js). Read-only: it retrieves the
// connected Etsy shop's own shop record and nothing else. It performs no write of any
// kind, and cannot - integrations/adapters/etsyReadClient.js issues GET requests only.
//
// A thin wrapper, the same shape as tools/productDataRetrievalTool.js: no HTTP, no
// credential loading and no retry logic is added here, only reuse. The one thing it does
// add is the channel-aware reporting the Etsy phase needs - the record it returns carries
// channel: 'etsy', so nothing downstream can mistake it for the Shopify store.
//
// NEVER THROWS. Returns the honest {status, result, error} envelope every TOOL_EXECUTORS
// entry uses, so a missing credential or an Etsy outage becomes a reported failure rather
// than an exception escaping into the orchestrator.

const etsyReadClient = require('../integrations/adapters/etsyReadClient');

// Retrieves the shop record. Returns exactly what getEtsyShop() returns and throws exactly
// what it throws - never fabricates a shop.
async function retrieveEtsyShopData(params = {}) {
  return etsyReadClient.getEtsyShop(params);
}

async function runEtsyShopDataTool(researchParams) {
  const params = researchParams && typeof researchParams === 'object' ? researchParams : {};
  try {
    if (!etsyReadClient.canRead({ businessId: params.businessId || null })) {
      const missing = etsyReadClient.missingReadCredentials(params.businessId || null);
      return {
        status: 'failed',
        result: null,
        // Key names only - no credential value is ever placed in a tool result.
        error:
          `Etsy reading is not configured: ${missing.join(', ')} not set. ` +
          'No Etsy request was attempted.',
      };
    }

    const shop = await retrieveEtsyShopData({ businessId: params.businessId || null });
    if (!shop || shop.shop_id === null) {
      return { status: 'empty', result: null, error: null };
    }
    return { status: 'success', result: shop, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { retrieveEtsyShopData, runEtsyShopDataTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - etsy_shop_data_retrieval (read-only):\n');
  runEtsyShopDataTool({}).then((outcome) => {
    console.log(`Status: ${outcome.status}`);
    if (outcome.error) console.log(`Reported: ${outcome.error}`);
    if (outcome.result) console.log(JSON.stringify(outcome.result, null, 2));
  });
}
