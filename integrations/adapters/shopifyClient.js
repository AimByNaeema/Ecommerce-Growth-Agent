'use strict';

// The ONE agent's connection to the owner's Shopify store (Admin GraphQL API). This is
// a CONNECTION LAYER: it can reach the store, confirm the connection works
// (getShopInfo), and read product data (getProducts - products, variants incl.
// SKU/price/inventory, product status, collections, and metafields). Read-only only -
// no write/mutation of any kind exists here, and it is not wired into
// agent/core/agentContract.js's stages yet - that orchestration is later, explicitly
// scoped work. No response is ever invented here: a missing config, a network
// failure, or a non-success/GraphQL-error response all throw a clear error instead of
// returning fabricated data (same convention as every research/analysis module
// already in this project, and as agent/core/claudeClient.js).
//
// No SDK dependency is added for this: Node's built-in fetch (stable since Node 18)
// is enough for the GraphQL calls this layer needs.

const fs = require('fs');
const path = require('path');

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

// True once a non-empty SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_ACCESS_TOKEN are
// both present in the environment. Lets a caller check readiness and fail fast with a
// clear message instead of attempting a network call that can only fail.
function isConfigured() {
  loadEnvOnce();
  return Boolean(
    process.env.SHOPIFY_STORE_DOMAIN &&
    process.env.SHOPIFY_STORE_DOMAIN.trim() &&
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN &&
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN.trim()
  );
}

// Builds the versioned Admin GraphQL endpoint URL for the configured store.
function buildGraphqlUrl(domain, apiVersion) {
  return `https://${domain}/admin/api/${apiVersion}/graphql.json`;
}

// Runs a minimal GraphQL query against the store's Admin API and returns the shop's
// name, domain, and email - proof that the connection and credentials work.
//
// Returns: { name, domain, email, apiVersion, raw }
// Throws: if the store isn't configured, the request fails, or the API responds with
// a non-success status or GraphQL errors. Never returns fabricated shop info.
async function getShopInfo() {
  loadEnvOnce();

  if (!isConfigured()) {
    throw new Error(
      'SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_API_ACCESS_TOKEN are not set. Copy ' +
      '.env.example to .env and add real values for the owner\'s Shopify store before ' +
      'calling getShopInfo().'
    );
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN.trim();
  const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN.trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION && process.env.SHOPIFY_API_VERSION.trim()) || DEFAULT_API_VERSION;
  const url = buildGraphqlUrl(domain, apiVersion);

  const query = `{
    shop {
      name
      myshopifyDomain
      email
    }
  }`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    throw new Error(`Could not reach the Shopify Admin API: ${err.message}`);
  }

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage = raw && raw.errors ? JSON.stringify(raw.errors) : response.statusText;
    throw new Error(`Shopify Admin API request failed (${response.status}): ${apiMessage}`);
  }

  if (raw && Array.isArray(raw.errors) && raw.errors.length > 0) {
    throw new Error(`Shopify Admin API returned GraphQL errors: ${JSON.stringify(raw.errors)}`);
  }

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
async function getProducts({ limit = 50 } = {}) {
  loadEnvOnce();

  if (!isConfigured()) {
    throw new Error(
      'SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_API_ACCESS_TOKEN are not set. Copy ' +
      '.env.example to .env and add real values for the owner\'s Shopify store before ' +
      'calling getProducts().'
    );
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN.trim();
  const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN.trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION && process.env.SHOPIFY_API_VERSION.trim()) || DEFAULT_API_VERSION;
  const url = buildGraphqlUrl(domain, apiVersion);

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

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    throw new Error(`Could not reach the Shopify Admin API: ${err.message}`);
  }

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage = raw && raw.errors ? JSON.stringify(raw.errors) : response.statusText;
    throw new Error(`Shopify Admin API request failed (${response.status}): ${apiMessage}`);
  }

  if (raw && Array.isArray(raw.errors) && raw.errors.length > 0) {
    throw new Error(`Shopify Admin API returned GraphQL errors: ${JSON.stringify(raw.errors)}`);
  }

  if (!raw || !raw.data || !raw.data.products) {
    throw new Error('Shopify Admin API response did not include product data.');
  }

  return raw.data.products.edges.map(({ node }) => ({
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
  }));
}

module.exports = {
  getShopInfo,
  getProducts,
  isConfigured,
  loadEnvOnce,
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
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
