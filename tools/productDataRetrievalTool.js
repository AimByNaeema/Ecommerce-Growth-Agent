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

// RESOLVED, NOT IMPORTED - see tools/businessConfigurationRetrieval.js's own note for the
// rationale. Identical behavior against Shopify; the platform is now a named constant and
// the adapter is contract-checked before use.
const { getReadAdapter } = require('../integrations/adapters/adapterRegistry');
const { discoverProducts } = require('../agent/core/productAgent');
const { computeUnitEconomics } = require('../agent/core/productEconomics');

// Matches tools/toolRegistry.js's `platforms: ['shopify']` binding for
// product_data_retrieval. Deliberately still Shopify: getProducts() IS a capability
// integrations/adapters/etsyReadAdapter.js supports, but mapShopifyProductToCandidate()
// below reads Shopify-shaped fields (productType, handle, status's ACTIVE/DRAFT/ARCHIVED
// vocabulary) that an Etsy listing does not have. Pointing this tool at another platform
// therefore needs that mapping generalized first - a separate, explicitly-scoped change, not
// a constant edit. Naming the platform here is what makes that dependency visible instead of
// hiding it in an import.
const PLATFORM = 'shopify';

// Retrieves product data by calling the resolved adapter's getProducts(). Read-only: makes
// no writes, changes nothing. Returns exactly what getProducts() returns and throws exactly
// what it throws (not configured / network failure / API error) - never fabricates a result.
async function retrieveProductData(params = {}) {
  return getReadAdapter(PLATFORM).getProducts(params);
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

// The product_discovery capability's live-data path (see
// agent/core/specialistCapabilityRegistry.js's PRODUCT_TASKS - product_discovery
// declares product_data_retrieval as its live_data_tool_id): pulls real Shopify
// products, maps each into productAgent.discoverProducts()'s entry shape via
// mapShopifyProductToCandidate(), then runs them through discoverProducts() unmodified
// so the result is a real, validated agent/core/productModel.js record per product -
// never a raw, unvalidated Shopify passthrough. Follows the same honest
// {status, result, error}-envelope, never-throws convention as every other
// TOOL_EXECUTORS entry (see tools/analyticsDataTool.js) rather than the throw-through
// convention retrieveProductData() above uses, since this is the function
// agent/core/orchestratorExecutionContract.js's TOOL_EXECUTORS dispatches to.
// LISTING SOURCES FOR THE SEO SPECIALIST. agent/core/productModel.js has no field for a
// product's handle or its SEO title/description, so the Chief's SEO quality check had
// nothing real to audit and stopped with "needs ... listingRecord". The same single read
// already returns those fields, so they are relayed alongside the product records - never a
// second Shopify call - as one plain entry per product (see agent/core/crossAgentContext.js's
// Product -> SEO flow, which turns each into a listing record).
//
// NOTHING FILLED IN. A field the read did not return at all (undefined - e.g. an adapter that
// does not read it) is listed in unavailable_fields rather than blanked silently. A field the
// store genuinely has no value for (null/'' - e.g. no custom SEO title) is relayed as '',
// which is what the store actually holds.
const LISTING_SOURCE_READERS = {
  title: (product) => product.title,
  handle: (product) => product.handle,
  description: (product) => product.description,
  seo_title: (product) => (product.seo ? product.seo.title : undefined),
  seo_description: (product) => (product.seo ? product.seo.description : undefined),
};

// The store's own listing-quality fields the same read already returns - product type,
// vendor, tags and published status - relayed as read for the SEO/listing audit. Same rule:
// a field the read did not return is named in unavailable_fields, never filled in.
const STORE_FIELD_READERS = {
  product_type: (product) => product.productType,
  vendor: (product) => product.vendor,
  tags: (product) => product.tags,
  status: (product) => product.status,
};

function buildStoreFields(shopifyProduct) {
  const storeFields = { unavailable_fields: [] };
  for (const [field, read] of Object.entries(STORE_FIELD_READERS)) {
    const value = read(shopifyProduct);
    if (value === undefined) {
      storeFields.unavailable_fields.push(field);
      continue;
    }
    if (field === 'tags') storeFields.tags = Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : [];
    else storeFields[field] = typeof value === 'string' ? value : '';
  }
  return storeFields;
}

function buildListingSource(shopifyProduct) {
  const source = {
    product_reference: shopifyProduct.title || '',
    shopify_product_id: shopifyProduct.id || '',
    unavailable_fields: [],
  };
  for (const [field, read] of Object.entries(LISTING_SOURCE_READERS)) {
    const value = read(shopifyProduct);
    if (value === undefined) source.unavailable_fields.push(field);
    source[field] = typeof value === 'string' ? value : '';
  }
  source.store_fields = buildStoreFields(shopifyProduct);
  return source;
}

// UNIT ECONOMICS (only when the request asks about profit, margin or cost - params.unitEconomics). The recorded
// unit cost is read by a SEPARATE query (getProductUnitCosts: it needs read_inventory, and a store without that
// scope must still read its products), then agent/core/productEconomics.js computes per variant. A failed or
// unsupported cost read leaves cost UNKNOWN with the reason - the product read itself still succeeds. Selling
// fees, shipping and duties are not in the store data this tool reads, so they stay UNKNOWN unless the caller
// supplies them (params.economicsInputs). The price and the unit cost always come from the store, never from
// the caller.
const ECONOMICS_INPUT_KEYS = {
  fees: 'selling fees',
  feesConfirmedNone: null,
  inboundShipping: 'inbound shipping cost',
  inboundShippingConfirmedNone: null,
  outboundShipping: 'outbound shipping cost',
  outboundShippingConfirmedNone: null,
  duties: null,
  exchangeRates: null,
};

async function buildProductEconomics(products, params) {
  const adapter = getReadAdapter(PLATFORM);
  const supplied = params.economicsInputs && typeof params.economicsInputs === 'object' ? params.economicsInputs : {};
  const inputs = {};
  for (const key of Object.keys(ECONOMICS_INPUT_KEYS)) {
    if (supplied[key] !== undefined) inputs[key] = supplied[key];
  }

  let costs = null;
  let costReadError = null;
  if (typeof adapter.getProductUnitCosts !== 'function') {
    costReadError = `The ${PLATFORM} adapter cannot read recorded unit costs.`;
  } else {
    try {
      costs = await adapter.getProductUnitCosts({
        productIds: products.map((product) => product.id).filter(Boolean),
        businessId: params.businessId || null,
      });
    } catch (err) {
      costReadError = `Recorded unit costs could not be read: ${err.message}`;
    }
  }
  const costByVariant = new Map(costs ? costs.variants.map((entry) => [entry.variantId, entry.unitCost]) : []);
  const shopCurrency = costs ? costs.shopCurrency : null;

  const summary = { variants_total: 0, unit_cost_known: 0, unit_cost_unknown: 0, gross_profit_known: 0, contribution_known: 0 };
  const entries = products.map((product) => ({
    product_reference: product.title || '',
    shopify_product_id: product.id || '',
    variants: (Array.isArray(product.variants) ? product.variants : []).map((variant) => {
      const economics = computeUnitEconomics({
        ...inputs,
        price: { amount: variant.price, currency: shopCurrency },
        unitCost: costByVariant.get(variant.id) || null,
      });
      summary.variants_total += 1;
      if (economics.unit_cost.status === 'KNOWN') summary.unit_cost_known += 1;
      else summary.unit_cost_unknown += 1;
      if (economics.gross_profit.status === 'KNOWN') summary.gross_profit_known += 1;
      if (economics.contribution.status === 'KNOWN') summary.contribution_known += 1;
      return { variant_id: variant.id || '', variant_title: variant.title || '', sku: variant.sku || '', economics };
    }),
  }));

  return {
    currency: shopCurrency,
    cost_source: costs ? 'Shopify inventory item unit cost, as recorded in the store' : null,
    cost_read_error: costReadError,
    summary,
    not_supplied: Object.entries(ECONOMICS_INPUT_KEYS)
      .filter(([key, label]) => label && inputs[key] === undefined)
      .map(([, label]) => label),
    rule: 'A missing cost, fee, shipping cost or currency is UNKNOWN - never zero, never assumed. Different currencies are combined only with a supplied exchange rate.',
    products: entries,
  };
}

async function runProductDataRetrievalTool(researchParams) {
  const params = researchParams && typeof researchParams === 'object' ? researchParams : {};
  try {
    const products = await retrieveProductData(params);
    if (!Array.isArray(products) || products.length === 0) {
      return { status: 'empty', result: null, error: null };
    }
    const candidates = products.map(mapShopifyProductToCandidate);
    const result = discoverProducts(candidates);
    const outcome = { status: 'success', result, error: null, listing_sources: products.map(buildListingSource) };
    if (params.unitEconomics === true) outcome.product_economics = await buildProductEconomics(products, params);
    return outcome;
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { retrieveProductData, mapShopifyProductToCandidate, runProductDataRetrievalTool };

if (require.main === module) {
  // See tools/businessConfigurationRetrieval.js: isConfigured() loads the root .env itself,
  // so the explicit loadEnvOnce() call this demo used to make was redundant.
  if (!getReadAdapter(PLATFORM).isConfigured()) {
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
