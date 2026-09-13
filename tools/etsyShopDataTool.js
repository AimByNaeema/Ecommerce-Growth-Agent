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

// RESOLVED, NOT IMPORTED. The data path now goes through
// integrations/adapters/adapterRegistry.js, which hands back a contract-checked adapter -
// for 'etsy' that is integrations/adapters/etsyReadAdapter.js, the thin shim over the same
// read client this tool used to require directly. Behaviour is unchanged: the shim adds no
// transport, and it is still GET-only all the way down.
const { getReadAdapter } = require('../integrations/adapters/adapterRegistry');
// STILL IMPORTED, DELIBERATELY, FOR ONE NON-CONTRACT THING. missingReadCredentials() names
// WHICH credential keys are absent, which the read contract does not cover - isConfigured()
// is a boolean and says nothing about why. That diagnostic is Etsy-specific by nature, so it
// stays with the Etsy client rather than being forced into a platform-independent contract
// it does not belong in. No data is read through this import.
const etsyReadClient = require('../integrations/adapters/etsyReadClient');

const PLATFORM = 'etsy';

// Retrieves the shop record. `native` is the shim's verbatim relay of the read client's own
// normalized shop record - the exact shape this tool has always returned, so every
// downstream reader of shop_id/shop_name/currency_code is unaffected. Throws exactly what
// the underlying read throws - never fabricates a shop.
async function retrieveEtsyShopData(params = {}) {
  const shop = await getReadAdapter(PLATFORM).getShopInfo(params);
  return shop.native;
}

async function runEtsyShopDataTool(researchParams) {
  const params = researchParams && typeof researchParams === 'object' ? researchParams : {};
  try {
    if (!getReadAdapter(PLATFORM).isConfigured({ businessId: params.businessId || null })) {
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
