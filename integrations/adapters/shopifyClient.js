'use strict';

// The ONE agent's connection to the owner's Shopify store (Admin GraphQL API). This is
// a CONNECTION LAYER: it can reach the store, confirm the connection works
// (getShopInfo), and read product, collection, order, customer, and inventory data
// (getProducts, getCollections, getOrders, getCustomers, getInventoryLevels).
// Read-only only - no write/mutation of any kind exists here, and it is not wired into
// agent/core/agentContract.js's stages yet - that orchestration is later, explicitly
// scoped work. No response is ever invented here: a missing config, a network failure,
// or a non-success/GraphQL-error response all throw a clear error instead of returning
// fabricated data (same convention as every research/analysis module already in this
// project, and as agent/core/claudeClient.js).
//
// Required Admin API scopes, read-only: read_products, read_orders, read_customers,
// read_inventory. A store whose access token lacks one of these will get a GraphQL
// access-denied error from that one function - the caller (tools/analyticsDataTool.js)
// is responsible for degrading gracefully per source rather than this layer silently
// swallowing it (this layer never swallows an error; it always throws one).
//
// getCustomers() deliberately requests no personally-identifiable fields (no name,
// email, phone, or address) - only account-level aggregate stats (order count, amount
// spent, state, tags, creation date). This is what "customers where permitted" means
// here: a privacy-conscious, minimal-scope default, not just an API-permission check.
//
// No SDK dependency is added for this: Node's built-in fetch (stable since Node 18)
// is enough for the GraphQL calls this layer needs.

const fs = require('fs');
const path = require('path');
const { RetryableError, retryAsync, withTimeout, parseRetryAfterMs } = require('../../agent/core/networkRetry');
const businessRegistry = require('../../configuration/businessRegistry');

// Default Admin API version, overridable via SHOPIFY_API_VERSION in .env - no code
// change needed to move to a newer quarterly release. Current stable version as of
// this writing (confirmed at https://shopify.dev/docs/api/usage/versioning).
const DEFAULT_API_VERSION = '2026-07';

let envLoadAttempted = false;

// Loads .env (git-ignored - see .env.example) into process.env exactly once, using
// Node's built-in process.loadEnvFile - no dotenv dependency needed. Safe to call
// before .env exists: real credentials are never guessed or defaulted, just left
// unset until the owner adds them.
function loadEnvOnce() {
  if (envLoadAttempted) return;
  envLoadAttempted = true;
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error(`Warning: failed to load .env (${envPath}): ${err.message}`);
  }
}

// Resolves { domain, accessToken, apiVersion } for one call. businessId falsy (the
// default) reproduces today's exact single-business behavior: the root .env loaded
// once into global process.env. businessId set delegates to
// configuration/businessRegistry.js's per-business .env instead - never touches
// process.env, so two businesses' credentials can safely coexist in one process (see
// that module's header for why process.loadEnvFile is unsafe for this).
function resolveCredentials(businessId) {
  if (!businessId) {
    loadEnvOnce();
    return {
      domain: process.env.SHOPIFY_STORE_DOMAIN,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      apiVersion: process.env.SHOPIFY_API_VERSION,
    };
  }
  const credentials = businessRegistry.loadBusinessCredentials(businessId);
  return {
    domain: credentials.SHOPIFY_STORE_DOMAIN,
    accessToken: credentials.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    apiVersion: credentials.SHOPIFY_API_VERSION,
  };
}

// True once a non-empty domain and access token are both present for businessId (or,
// when omitted, for the root .env/process.env - today's default single business).
// Lets a caller check readiness and fail fast with a clear message instead of
// attempting a network call that can only fail.
function isConfigured({ businessId = null } = {}) {
  const { domain, accessToken } = resolveCredentials(businessId);
  return Boolean(domain && domain.trim() && accessToken && accessToken.trim());
}

// Builds the versioned Admin GraphQL endpoint URL for the configured store.
function buildGraphqlUrl(domain, apiVersion) {
  return `https://${domain}/admin/api/${apiVersion}/graphql.json`;
}

// Runs a getter's reshape step (the .edges.map(...) chain that turns a raw GraphQL
// node into this layer's normalized shape) and turns any thrown error into a clear,
// named one instead of letting a raw TypeError (e.g. "Cannot read properties of
// undefined (reading 'edges')" when Shopify omits a nested field like `variants` on
// one node) surface unlabeled. Each getter already checks its OWN top-level field
// exists (raw.data.products, etc.) before calling this - this only guards the nested
// shape one level deeper, which that check can't see. Never invents a fallback value;
// it only makes an existing failure legible.
function reshapeOrThrow(fnName, reshapeFn) {
  try {
    return reshapeFn();
  } catch (err) {
    throw new Error(`Shopify Admin API response for ${fnName} had an unexpected shape: ${err.message}`);
  }
}

// Shared request/error-handling core for every Admin GraphQL call this layer makes -
// not configured / network failure / non-success status / GraphQL errors all throw the
// same clear errors every function here already relied on, now defined once instead of
// once per function (see getShopInfo/getProducts/getOrders/getCustomers/
// getInventoryLevels below, each of which only supplies its own query and reshapes its
// own response). Never returns fabricated data - only the raw parsed response and the
// resolved API version, for the caller to pull its own fields from.
//
// CONTROLLED RETRIES (agent/core/networkRetry.js): only a thrown fetch() failure
// (network unreachable) or an HTTP 429/5xx response is retried, bounded and with
// backoff - never silently forever (agent/core/toolSelectionRules.js's
// handle_tool_failures rule). A 4xx response or a GraphQL-level error (raw.errors on
// an otherwise-ok HTTP status) is a query/permission/config problem that will
// deterministically fail again, so it is thrown as a plain (non-retryable) Error
// instead - retrying it would only waste calls. The "not configured" check happens
// before retryAsync() is ever entered, so it never triggers a retry either.
async function runAdminGraphqlQuery(query, fnName, businessId = null) {
  if (!isConfigured({ businessId })) {
    const message = businessId
      ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
        `configuration/businesses/${businessId}/.env with real values before calling ${fnName}().`
      : 'SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_API_ACCESS_TOKEN are not set. Copy ' +
        '.env.example to .env and add real values for the owner\'s Shopify store before ' +
        `calling ${fnName}().`;
    throw new Error(message);
  }

  const resolved = resolveCredentials(businessId);
  const domain = resolved.domain.trim();
  const accessToken = resolved.accessToken.trim();
  const apiVersion = (resolved.apiVersion && resolved.apiVersion.trim()) || DEFAULT_API_VERSION;
  const url = buildGraphqlUrl(domain, apiVersion);

  return retryAsync(async () => {
    let response;
    try {
      response = await withTimeout((signal) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query }),
          signal,
        })
      );
    } catch (err) {
      throw new RetryableError(`Could not reach the Shopify Admin API: ${err.message}`);
    }

    const raw = await response.json().catch(() => null);

    if (!response.ok) {
      const apiMessage = raw && raw.errors ? JSON.stringify(raw.errors) : response.statusText;
      const message = `Shopify Admin API request failed (${response.status}): ${apiMessage}`;
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(message, { retryAfterMs: parseRetryAfterMs(response) });
      }
      throw new Error(message);
    }

    if (raw && Array.isArray(raw.errors) && raw.errors.length > 0) {
      throw new Error(`Shopify Admin API returned GraphQL errors: ${JSON.stringify(raw.errors)}`);
    }

    return { raw, apiVersion };
  });
}

// Runs a minimal GraphQL query against the store's Admin API and returns the shop's
// name, domain, and email - proof that the connection and credentials work.
//
// Returns: { name, domain, email, apiVersion, raw }
// Throws: if the store isn't configured, the request fails, or the API responds with
// a non-success status or GraphQL errors. Never returns fabricated shop info.
async function getShopInfo({ businessId = null } = {}) {
  const query = `{
    shop {
      name
      myshopifyDomain
      email
    }
  }`;

  const { raw, apiVersion } = await runAdminGraphqlQuery(query, 'getShopInfo', businessId);

  if (!raw || !raw.data || !raw.data.shop) {
    throw new Error('Shopify Admin API response did not include shop data.');
  }

  const shop = raw.data.shop;
  return {
    name: shop.name,
    domain: shop.myshopifyDomain,
    email: shop.email,
    apiVersion,
    raw,
  };
}

// Runs one GraphQL query covering products, variants (incl. SKU/price/inventory),
// collections, and metafields (product metadata) - read-only, no mutation, no write
// field anywhere in this query. One round-trip is enough for every item this layer
// currently exposes.
//
// Returns: an array of normalized product objects: { id, title, handle, status,
// productType, vendor, tags, variants: [{id, title, sku, price, inventoryQuantity,
// availableForSale}], collections: [{id, title}], metafields: [{namespace, key, value}] }
// Throws: same conditions as getShopInfo() (not configured / network failure /
// non-success status / GraphQL errors / missing data). Never returns fabricated
// product data.
async function getProducts({ limit = 50, businessId = null } = {}) {
  const query = `{
    products(first: ${Number(limit)}) {
      edges { node {
        id
        title
        handle
        status
        productType
        vendor
        tags
        variants(first: 50) { edges { node {
          id
          title
          sku
          price
          inventoryQuantity
          availableForSale
        } } }
        collections(first: 10) { edges { node { id title } } }
        metafields(first: 10) { edges { node { namespace key value } } }
      } }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getProducts', businessId);

  if (!raw || !raw.data || !raw.data.products) {
    throw new Error('Shopify Admin API response did not include product data.');
  }

  return reshapeOrThrow('getProducts', () =>
    raw.data.products.edges.map(({ node }) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      productType: node.productType,
      vendor: node.vendor,
      tags: node.tags,
      variants: node.variants.edges.map(({ node: variant }) => ({
        id: variant.id,
        title: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        availableForSale: variant.availableForSale,
      })),
      collections: node.collections.edges.map(({ node: collection }) => ({
        id: collection.id,
        title: collection.title,
      })),
      metafields: node.metafields.edges.map(({ node: metafield }) => ({
        namespace: metafield.namespace,
        key: metafield.key,
        value: metafield.value,
      })),
    }))
  );
}

// Runs one GraphQL query covering orders (id, name/order number, created date,
// financial/fulfillment status, total price, and line items) - read-only, most-recent
// first. This is the raw data source agent/core/analyticsMetricsCalculator.js's
// calculateSalesMetrics()/estimateProjectedMonthlyRevenue() compute sales figures
// from - this layer itself performs no arithmetic.
//
// Returns: an array of normalized order objects: { id, name, createdAt,
// financialStatus, fulfillmentStatus, totalPrice, currency, lineItems: [{title,
// quantity, sku}] }
// Throws: same conditions as getShopInfo(). Never returns fabricated order data.
async function getOrders({ limit = 50, businessId = null } = {}) {
  const query = `{
    orders(first: ${Number(limit)}, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 20) { edges { node { title quantity sku } } }
      } }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getOrders', businessId);

  if (!raw || !raw.data || !raw.data.orders) {
    throw new Error('Shopify Admin API response did not include order data.');
  }

  return reshapeOrThrow('getOrders', () =>
    raw.data.orders.edges.map(({ node }) => ({
      id: node.id,
      name: node.name,
      createdAt: node.createdAt,
      financialStatus: node.displayFinancialStatus,
      fulfillmentStatus: node.displayFulfillmentStatus,
      totalPrice: node.currentTotalPriceSet.shopMoney.amount,
      currency: node.currentTotalPriceSet.shopMoney.currencyCode,
      lineItems: node.lineItems.edges.map(({ node: lineItem }) => ({
        title: lineItem.title,
        quantity: lineItem.quantity,
        sku: lineItem.sku,
      })),
    }))
  );
}

// Runs one GraphQL query covering customers - deliberately only account-level
// aggregate fields (order count, amount spent, state, tags, creation date), never
// name/email/phone/address (see module header: "customers where permitted" is a
// privacy-conscious minimal-scope default, not just an access-token permission check).
//
// Returns: an array of normalized customer objects: { id, ordersCount, amountSpent,
// currency, state, tags, createdAt }
// Throws: same conditions as getShopInfo() - including when the access token lacks
// the read_customers scope (a GraphQL access-denied error, surfaced as-is). Never
// returns fabricated customer data.
async function getCustomers({ limit = 50, businessId = null } = {}) {
  const query = `{
    customers(first: ${Number(limit)}) {
      edges { node {
        id
        numberOfOrders
        amountSpent { amount currencyCode }
        state
        tags
        createdAt
      } }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getCustomers', businessId);

  if (!raw || !raw.data || !raw.data.customers) {
    throw new Error('Shopify Admin API response did not include customer data.');
  }

  return reshapeOrThrow('getCustomers', () =>
    raw.data.customers.edges.map(({ node }) => ({
      id: node.id,
      ordersCount: node.numberOfOrders,
      amountSpent: node.amountSpent.amount,
      currency: node.amountSpent.currencyCode,
      state: node.state,
      tags: node.tags,
      createdAt: node.createdAt,
    }))
  );
}

// Runs one GraphQL query covering inventory items and their per-location available
// quantity - read-only, no mutation. This is the raw data source
// agent/core/analyticsMetricsCalculator.js's calculateInventoryMetrics()/
// estimateDaysOfInventoryRemaining() compute stock figures from.
//
// Returns: an array of normalized inventory item objects: { id, sku, tracked,
// levels: [{locationId, locationName, available}] }
// Throws: same conditions as getShopInfo() - including when the access token lacks
// the read_inventory scope. Never returns fabricated inventory data.
async function getInventoryLevels({ limit = 50, businessId = null } = {}) {
  const query = `{
    inventoryItems(first: ${Number(limit)}) {
      edges { node {
        id
        sku
        tracked
        inventoryLevels(first: 5) { edges { node {
          location { id name }
          quantities(names: ["available"]) { name quantity }
        } } }
      } }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getInventoryLevels', businessId);

  if (!raw || !raw.data || !raw.data.inventoryItems) {
    throw new Error('Shopify Admin API response did not include inventory data.');
  }

  return reshapeOrThrow('getInventoryLevels', () =>
    raw.data.inventoryItems.edges.map(({ node }) => ({
      id: node.id,
      sku: node.sku,
      tracked: node.tracked,
      levels: node.inventoryLevels.edges.map(({ node: level }) => {
        const availableQuantity = level.quantities.find((quantity) => quantity.name === 'available');
        return {
          locationId: level.location.id,
          locationName: level.location.name,
          available: availableQuantity ? availableQuantity.quantity : undefined,
        };
      }),
    }))
  );
}

// Runs one GraphQL query covering the store's collections (title, handle, description,
// image, and product count) - read-only, no mutation. This is a store-wide list
// independent of any one product, unlike the collections[] nested inside each
// getProducts() entry (which is scoped to one product's memberships and capped at 10).
// Covered by the same read_products scope already required for getProducts() - Shopify
// does not require a separate scope for collections.
//
// Returns: an array of normalized collection objects: { id, title, handle, description,
// image: { url } | null, productsCount }
// Throws: same conditions as getShopInfo(). Never returns fabricated collection data.
async function getCollections({ limit = 50, businessId = null } = {}) {
  const query = `{
    collections(first: ${Number(limit)}) {
      edges { node {
        id
        title
        handle
        description
        image { url }
        productsCount { count }
      } }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getCollections', businessId);

  if (!raw || !raw.data || !raw.data.collections) {
    throw new Error('Shopify Admin API response did not include collection data.');
  }

  return reshapeOrThrow('getCollections', () =>
    raw.data.collections.edges.map(({ node }) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      description: node.description,
      image: node.image ? { url: node.image.url } : null,
      productsCount: node.productsCount ? node.productsCount.count : undefined,
    }))
  );
}

module.exports = {
  getShopInfo,
  getProducts,
  getOrders,
  getCustomers,
  getInventoryLevels,
  getCollections,
  isConfigured,
  loadEnvOnce,
  resolveCredentials,
  DEFAULT_API_VERSION,
};

if (require.main === module) {
  loadEnvOnce();
  if (!isConfigured()) {
    console.log('Shopify connection layer loaded, but store credentials are not set.');
    console.log('Copy .env.example to .env and fill in:');
    console.log('  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...');
    process.exit(0);
  }
  getShopInfo()
    .then(async (result) => {
      console.log('Shopify connection succeeded.');
      console.log(`Shop: ${result.name}`);
      console.log(`Domain: ${result.domain}`);
      console.log(`Email: ${result.email}`);
      console.log(`API version: ${result.apiVersion}`);

      const products = await getProducts({ limit: 5 });
      console.log(`\nRetrieved ${products.length} product(s) (read-only, first 5).`);
      console.log(JSON.stringify(products, null, 2));

      const orders = await getOrders({ limit: 5 });
      console.log(`\nRetrieved ${orders.length} order(s) (read-only, first 5).`);
      console.log(JSON.stringify(orders, null, 2));

      const customers = await getCustomers({ limit: 5 });
      console.log(`\nRetrieved ${customers.length} customer(s) (read-only, first 5, non-PII fields only).`);
      console.log(JSON.stringify(customers, null, 2));

      const inventoryLevels = await getInventoryLevels({ limit: 5 });
      console.log(`\nRetrieved ${inventoryLevels.length} inventory item(s) (read-only, first 5).`);
      console.log(JSON.stringify(inventoryLevels, null, 2));

      const collections = await getCollections({ limit: 5 });
      console.log(`\nRetrieved ${collections.length} collection(s) (read-only, first 5).`);
      console.log(JSON.stringify(collections, null, 2));
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
