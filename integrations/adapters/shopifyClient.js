'use strict';

// The ONE agent's connection to the owner's Shopify store (Admin GraphQL API). This is
// a CONNECTION LAYER: it can reach the store, confirm the connection works
// (getShopInfo), and read product, collection, order, customer, and inventory data
// (getProducts, getCollections, getOrders, getCustomers, getInventoryLevels).
// No response is ever invented here: a missing config, a network failure,
// or a non-success/GraphQL-error response all throw a clear error instead of returning
// fabricated data (same convention as every research/analysis module already in this
// project, and as agent/core/claudeClient.js).
//
// EXACTLY ONE MUTATION EXISTS HERE: createBlogArticle(), the real Admin API
// `articleCreate` mutation behind the publishing chain in
// integrations/shopifyBlogPublishing.js. Everything else in this file is still a read,
// unchanged. There is no second Shopify client anywhere in this project: the mutation
// reuses THIS module's credential resolution, token cache, retry/timeout layer, and
// error handling rather than opening a parallel transport. Nothing here decides whether
// a publish is allowed - approvals/publishAuthorization.js does, and
// integrations/shopifyBlogPublishing.js is the single call site that consults it
// immediately before calling createBlogArticle().
//
// Required Admin API scopes, read-only: read_products, read_orders, read_customers,
// read_inventory. A store whose access token lacks one of these will get a GraphQL
// access-denied error from that one function - the caller (tools/analyticsDataTool.js)
// is responsible for degrading gracefully per source rather than this layer silently
// swallowing it (this layer never swallows an error; it always throws one).
//
// createBlogArticle() additionally requires the WRITE scope 'write_content'
// (REQUIRED_PUBLISH_SCOPE). It is checked as a PREFLIGHT against the app's genuinely
// granted scopes (getGrantedAccessScopes(), a real read query - never an assumption)
// before any mutation is sent, so a store whose app lacks the scope makes ZERO mutation
// attempts rather than sending one and being refused. That is a fail-closed guard in
// front of the mutation, not a substitute for the authorization boundary in front of
// this whole layer.
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

// Apps created via Shopify's newer Dev Dashboard don't hand out a static, copyable
// Admin API access token the way a classic custom app does - they authenticate via
// the OAuth Client Credentials grant instead (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET
// exchanged for a short-lived token). Confirmed against Shopify's own docs
// (https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens): POST
// https://{shop}.myshopify.com/admin/oauth/access_token, form-urlencoded body
// {grant_type: 'client_credentials', client_id, client_secret}, response
// {access_token, scope, expires_in} with expires_in always 86399 (24h) - refresh
// before expiry, per that same doc's own guidance.
//
// PRECEDENCE (explicit, not silent - see resolveCredentials()/usesClientCredentials()
// below): when SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are both present, this mode
// is used. Otherwise SHOPIFY_ADMIN_API_ACCESS_TOKEN is used exactly as before - the
// static-token path is untouched, kept as a fallback for a classic custom-app-style
// store, per CLAUDE.md rule 11 (never break existing, tested behavior) and rule 14
// (this system must be able to point at a different store without code changes,
// including a store on the older auth model).
//
// Cached in memory only, per resolved credential set (keyed by businessId, or
// '__default__' for the root .env/process.env) - never written to disk, matching
// CLAUDE.md rule 6 (no secret/credential material persisted beyond what .env's own
// git-ignore already covers).
const CLIENT_CREDENTIALS_TOKEN_CACHE = new Map(); // cacheKey -> { accessToken, expiresAt }
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60000;

// The Admin API scope createBlogArticle() genuinely needs, per Shopify's own scope
// naming. Declared once, named in the preflight error, and exported so a caller (and a
// test) can check it without restating the string.
const REQUIRED_PUBLISH_SCOPE = 'write_content';

// The Admin API scopes updateProductVendor() and addProductsToCollection() genuinely
// need (Shopify groups product-field mutations and collection-membership mutations
// under the same 'write_products' scope), and adjustInventoryQuantities() needs
// separately. Same preflight discipline as REQUIRED_PUBLISH_SCOPE: checked against
// genuinely granted scopes before any mutation is built, never assumed from .env.
const REQUIRED_PRODUCT_WRITE_SCOPE = 'write_products';
const REQUIRED_INVENTORY_WRITE_SCOPE = 'write_inventory';

// Which scopes the configured app was ACTUALLY granted, cached per resolved credential
// set exactly like the token above (same cacheKey derivation, same "never written to
// disk" rule). Scope grants change only when the app is re-installed/re-deployed, so one
// read per process is enough - this keeps the publish preflight from costing a network
// round-trip on every article.
const ACCESS_SCOPES_CACHE = new Map(); // cacheKey -> string[]

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

// Resolves { domain, accessToken, apiVersion, clientId, clientSecret } for one call.
// businessId falsy (the default) reproduces today's exact single-business behavior:
// the root .env loaded once into global process.env. businessId set delegates to
// configuration/businessRegistry.js's per-business .env instead - never touches
// process.env, so two businesses' credentials can safely coexist in one process (see
// that module's header for why process.loadEnvFile is unsafe for this).
//
// clientId/clientSecret are additive (see the Client Credentials block above) - a
// business/root .env that only has SHOPIFY_ADMIN_API_ACCESS_TOKEN gets them back as
// undefined, exactly like before this field existed.
function resolveCredentials(businessId) {
  if (!businessId) {
    loadEnvOnce();
    return {
      domain: process.env.SHOPIFY_STORE_DOMAIN,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      clientId: process.env.SHOPIFY_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
      blogId: process.env.SHOPIFY_BLOG_ID,
      articleAuthor: process.env.SHOPIFY_ARTICLE_AUTHOR,
    };
  }
  const credentials = businessRegistry.loadBusinessCredentials(businessId);
  return {
    domain: credentials.SHOPIFY_STORE_DOMAIN,
    accessToken: credentials.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    apiVersion: credentials.SHOPIFY_API_VERSION,
    clientId: credentials.SHOPIFY_CLIENT_ID,
    clientSecret: credentials.SHOPIFY_CLIENT_SECRET,
    blogId: credentials.SHOPIFY_BLOG_ID,
    articleAuthor: credentials.SHOPIFY_ARTICLE_AUTHOR,
  };
}

// The approved blog this store publishes articles to, and the byline articles carry -
// configuration, never a hardcoded id or name (CLAUDE.md rule 14). Both resolve through
// the SAME two-mode credential architecture as every other key above, so pointing the
// system at a different store/business needs no code change. Absent means absent: these
// return null rather than a guessed default, and integrations/shopifyBlogPublishing.js
// refuses (with zero mutation) rather than inventing either one.
function getConfiguredBlogId({ businessId = null } = {}) {
  const { blogId } = resolveCredentials(businessId);
  return blogId && blogId.trim() ? blogId.trim() : null;
}

function getConfiguredArticleAuthor({ businessId = null } = {}) {
  const { articleAuthor } = resolveCredentials(businessId);
  return articleAuthor && articleAuthor.trim() ? articleAuthor.trim() : null;
}

// True when both a client id and client secret are present and non-blank - the signal
// to use the OAuth Client Credentials grant instead of the static access token. Takes
// the already-resolved credentials object (not businessId) so callers that already
// called resolveCredentials() once don't do it twice.
function usesClientCredentials({ clientId, clientSecret } = {}) {
  return Boolean(clientId && clientId.trim() && clientSecret && clientSecret.trim());
}

// True once a store is reachable under EITHER supported auth model for businessId (or,
// when omitted, for the root .env/process.env - today's default single business): a
// non-empty domain plus either (a) a non-empty static access token, or (b) a non-empty
// client id and secret. Lets a caller check readiness and fail fast with a clear
// message instead of attempting a network call that can only fail.
function isConfigured({ businessId = null } = {}) {
  const resolved = resolveCredentials(businessId);
  const hasDomain = Boolean(resolved.domain && resolved.domain.trim());
  if (!hasDomain) return false;
  const hasStaticToken = Boolean(resolved.accessToken && resolved.accessToken.trim());
  return hasStaticToken || usesClientCredentials(resolved);
}

// Builds the versioned Admin GraphQL endpoint URL for the configured store.
function buildGraphqlUrl(domain, apiVersion) {
  return `https://${domain}/admin/api/${apiVersion}/graphql.json`;
}

// Builds the OAuth Client Credentials token endpoint URL for the configured store, per
// https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens.
function buildTokenUrl(domain) {
  return `https://${domain}/admin/oauth/access_token`;
}

// Exchanges client_id/client_secret for a short-lived Admin API access token,
// caching it in memory (keyed by cacheKey - businessId, or '__default__') so repeated
// calls within the same process don't re-request a token on every GraphQL call.
// Refreshes TOKEN_EXPIRY_SAFETY_MARGIN_MS (60s) before the token's actual expiry, per
// Shopify's own documented guidance, rather than waiting for it to fail.
//
// Reuses this module's existing retry/timeout infrastructure
// (agent/core/networkRetry.js) rather than writing new retry logic: a thrown fetch
// failure or a 429/5xx response is retried (bounded, with backoff); any other non-ok
// status, or a response missing access_token, is a config/permission problem that
// throws a plain (non-retryable) Error instead. Never returns a fabricated token.
async function getClientCredentialsToken(domain, clientId, clientSecret, cacheKey) {
  const cached = CLIENT_CREDENTIALS_TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const url = buildTokenUrl(domain);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const accessToken = await retryAsync(async () => {
    let response;
    try {
      response = await withTimeout((signal) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal,
        })
      );
    } catch (err) {
      throw new RetryableError(`Could not reach the Shopify OAuth token endpoint: ${err.message}`);
    }

    const raw = await response.json().catch(() => null);

    if (!response.ok) {
      const apiMessage = raw && (raw.error_description || raw.error) ? (raw.error_description || raw.error) : response.statusText;
      const message = `Shopify OAuth token request failed (${response.status}): ${apiMessage}`;
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(message, { retryAfterMs: parseRetryAfterMs(response) });
      }
      throw new Error(message);
    }

    if (!raw || !raw.access_token) {
      throw new Error('Shopify OAuth token response did not include an access_token.');
    }

    const expiresInMs = (typeof raw.expires_in === 'number' ? raw.expires_in : 86399) * 1000;
    CLIENT_CREDENTIALS_TOKEN_CACHE.set(cacheKey, {
      accessToken: raw.access_token,
      expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_SAFETY_MARGIN_MS,
    });

    return raw.access_token;
  });

  return accessToken;
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
//
// `variables` is optional and additive: omitted (the default) the request body is exactly
// `{ query }`, byte-for-byte what every existing read already sent. Supplied, it is sent
// as GraphQL variables - which is how createBlogArticle() passes article content, so no
// title or body is ever interpolated into a query string.
async function runAdminGraphqlQuery(query, fnName, businessId = null, variables = null) {
  if (!isConfigured({ businessId })) {
    const message = businessId
      ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
        `configuration/businesses/${businessId}/.env with either SHOPIFY_ADMIN_API_ACCESS_TOKEN ` +
        `or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET (plus SHOPIFY_STORE_DOMAIN) before calling ${fnName}().`
      : 'SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor ' +
        'SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET is set. Copy .env.example to .env and add real ' +
        `values for the owner's Shopify store before calling ${fnName}().`;
    throw new Error(message);
  }

  const resolved = resolveCredentials(businessId);
  const domain = resolved.domain.trim();
  const apiVersion = (resolved.apiVersion && resolved.apiVersion.trim()) || DEFAULT_API_VERSION;
  const url = buildGraphqlUrl(domain, apiVersion);

  // Resolve the access token to send: the OAuth Client Credentials flow when
  // client id/secret are configured (cached/refreshed per resolved credential set),
  // otherwise the static long-lived token exactly as before - see the precedence note
  // above CLIENT_CREDENTIALS_TOKEN_CACHE. Cache key prefers businessId (today's
  // multi-business scoping); when there's no businessId (the root .env/process.env
  // case), the client id itself is used instead of a single '__default__' bucket, so
  // that swapping which client id is configured in process.env can never reuse a
  // stale token cached under a different client id.
  const cacheKey = businessId || (resolved.clientId && resolved.clientId.trim()) || '__default__';
  const accessToken = usesClientCredentials(resolved)
    ? await getClientCredentialsToken(domain, resolved.clientId.trim(), resolved.clientSecret.trim(), cacheKey)
    : resolved.accessToken.trim();

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
          body: JSON.stringify(variables ? { query, variables } : { query }),
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
// financial/fulfillment status, total price, whether Shopify itself flags the order as
// a TEST order, and line items) - read-only, most-recent first. This is the raw data
// source agent/core/analyticsMetricsCalculator.js's calculateSalesMetrics()/
// estimateProjectedMonthlyRevenue() compute sales figures from - this layer itself
// performs no arithmetic. `test` and `lineItems[].inventoryItemId` are additive fields
// (added for integrations/shopifyInventoryCorrection.js's test-order reconciliation) -
// no existing field was removed or renamed, so this remains a strict superset of the
// previous shape.
//
// Returns: an array of normalized order objects: { id, name, createdAt,
// financialStatus, fulfillmentStatus, totalPrice, currency, test, lineItems: [{title,
// quantity, sku, inventoryItemId}] }
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
        test
        lineItems(first: 20) { edges { node {
          title
          quantity
          sku
          variant { id inventoryItem { id } }
        } } }
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
      test: Boolean(node.test),
      lineItems: node.lineItems.edges.map(({ node: lineItem }) => ({
        title: lineItem.title,
        quantity: lineItem.quantity,
        sku: lineItem.sku,
        inventoryItemId: lineItem.variant && lineItem.variant.inventoryItem ? lineItem.variant.inventoryItem.id : null,
      })),
    }))
  );
}

// Sums line-item quantities from orders Shopify itself flags `test: true` (an order
// placed through a test/sandbox payment gateway), grouped by the inventory item those
// line items decremented. This is the SOLE signal integrations/shopifyInventoryCorrection.js
// uses to identify how much of a negative inventory balance is attributable to dummy/test
// orders - no tag, title, or date-range heuristic is used anywhere. Pure function: no I/O,
// operates only on what getOrders() already returned.
//
// Returns: Map<inventoryItemId, quantity>. A line item with no resolvable inventory item
// (e.g. a removed variant) is skipped rather than guessed.
function sumTestOrderQuantitiesByInventoryItem(orders) {
  const totals = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.test) continue;
    for (const lineItem of Array.isArray(order.lineItems) ? order.lineItems : []) {
      if (!lineItem || !lineItem.inventoryItemId) continue;
      totals.set(lineItem.inventoryItemId, (totals.get(lineItem.inventoryItemId) || 0) + lineItem.quantity);
    }
  }
  return totals;
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

// ---------------------------------------------------------------------------------
// PUBLISHING: the one mutation in this file, and the scope preflight in front of it.
// ---------------------------------------------------------------------------------

// The Admin API scopes the configured app was ACTUALLY granted, read from the store
// itself rather than assumed from what .env happens to contain - a token is not the same
// thing as a permission, and only Shopify knows which scopes an app really holds.
//
// Returns: a sorted array of scope handles (e.g. ['read_products', 'write_content']).
// Throws: same conditions as getShopInfo(). Never returns a fabricated scope list, and
// never returns [] to mean "unknown" - an unreadable answer is an error, so the publish
// preflight can never mistake a failed check for a granted scope.
async function getGrantedAccessScopes({ businessId = null, refresh = false } = {}) {
  const resolved = resolveCredentials(businessId);
  const cacheKey = businessId || (resolved.clientId && resolved.clientId.trim()) || '__default__';
  if (!refresh && ACCESS_SCOPES_CACHE.has(cacheKey)) {
    return ACCESS_SCOPES_CACHE.get(cacheKey);
  }

  const query = `{
    currentAppInstallation {
      accessScopes { handle }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getGrantedAccessScopes', businessId);

  if (!raw || !raw.data || !raw.data.currentAppInstallation || !Array.isArray(raw.data.currentAppInstallation.accessScopes)) {
    throw new Error('Shopify Admin API response did not include the app installation access scopes.');
  }

  const handles = reshapeOrThrow('getGrantedAccessScopes', () =>
    raw.data.currentAppInstallation.accessScopes.map(({ handle }) => handle).sort()
  );
  ACCESS_SCOPES_CACHE.set(cacheKey, handles);
  return handles;
}

// True only when the store's app genuinely holds REQUIRED_PUBLISH_SCOPE. Deliberately
// async and network-backed: there is no offline way to know this, and guessing it is
// exactly the failure mode the preflight exists to prevent.
// Drops the cached scope answer, so the next check re-reads it from the store. Needed
// because a scope grant CAN change while a process is running (the app is re-installed
// with a new scope), and used by the test suite to keep one stubbed answer from leaking
// into the next test.
function clearAccessScopesCache() {
  ACCESS_SCOPES_CACHE.clear();
}

async function hasWriteContentScope({ businessId = null, refresh = false } = {}) {
  const granted = await getGrantedAccessScopes({ businessId, refresh });
  return granted.includes(REQUIRED_PUBLISH_SCOPE);
}

// Creates ONE blog article on the store, via the Admin API's real `articleCreate`
// mutation. The mutation name, its argument (`article: ArticleCreateInput!`), every input
// field used below, and the payload's `article`/`userErrors` shape are all taken from the
// store's own schema at the API version this client targets - nothing here is invented or
// remembered. Only the smallest set of fields an article actually needs is sent; image,
// metafields, tags, templateSuffix and publishDate are deliberately not.
//
//   blogId     - the approved blog's id (a `gid://shopify/Blog/...` GID). Configuration or
//                caller input - never hardcoded. Required.
//   title      - the article title. Required by ArticleCreateInput.
//   body       - the article body (HTML). Required here: an article with no body is not
//                something to publish, and an empty one is never substituted.
//   authorName - the byline. ArticleCreateInput.author is AuthorInput! - required by the
//                real schema, so it is required here rather than invented.
//   summary/handle - optional, sent only when supplied.
//   isPublished - whether the article goes live. Defaults to true, because this is only
//                ever reached past a human approval that said to publish.
//
// Returns: Shopify's own article node, relayed unchanged.
// Throws: when not configured, when REQUIRED_PUBLISH_SCOPE is missing (BEFORE sending any
// mutation), on a network/transport failure, on GraphQL errors, or when Shopify returns
// userErrors. Never a fabricated article id, never a partial success reported as success.
async function createBlogArticle({
  blogId,
  title,
  body,
  summary = null,
  handle = null,
  authorName,
  isPublished = true,
  businessId = null,
} = {}) {
  for (const [name, value] of [['blogId', blogId], ['title', title], ['body', body], ['authorName', authorName]]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`createBlogArticle requires a non-empty ${name}. No Shopify mutation was attempted.`);
    }
  }

  if (!isConfigured({ businessId })) {
    throw new Error(
      businessId
        ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
          `configuration/businesses/${businessId}/.env with either SHOPIFY_ADMIN_API_ACCESS_TOKEN ` +
          'or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET (plus SHOPIFY_STORE_DOMAIN) before calling createBlogArticle().'
        : 'SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor ' +
          'SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET is set. Copy .env.example to .env and add real ' +
          "values for the owner's Shopify store before calling createBlogArticle()."
    );
  }

  // THE PREFLIGHT. Checked against genuinely granted scopes, and it throws BEFORE the
  // mutation is built or sent - so a store whose app lacks write_content makes zero
  // mutation attempts. Sending one and letting Shopify refuse would also be safe, but it
  // would be an attempted write, and "zero mutation" is the property this project tests.
  const granted = await getGrantedAccessScopes({ businessId });
  if (!granted.includes(REQUIRED_PUBLISH_SCOPE)) {
    throw new Error(
      `Shopify publishing is not permitted: this store's app has not been granted the '${REQUIRED_PUBLISH_SCOPE}' ` +
        `Admin API scope (granted: ${granted.join(', ') || 'none'}). Add '${REQUIRED_PUBLISH_SCOPE}' to the app's ` +
        'access scopes and re-deploy/re-install it, then try again. No Shopify mutation was attempted.'
    );
  }

  const mutation = `mutation CreateBlogArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        handle
        title
        isPublished
        publishedAt
        blog { id }
      }
      userErrors { field message code }
    }
  }`;

  const article = {
    blogId: blogId.trim(),
    title: title.trim(),
    body,
    isPublished: Boolean(isPublished),
    author: { name: authorName.trim() },
  };
  if (typeof summary === 'string' && summary.trim() !== '') article.summary = summary;
  if (typeof handle === 'string' && handle.trim() !== '') article.handle = handle.trim();

  const { raw } = await runAdminGraphqlQuery(mutation, 'createBlogArticle', businessId, { article });

  const payload = raw && raw.data && raw.data.articleCreate;
  if (!payload) {
    throw new Error('Shopify Admin API response did not include an articleCreate result.');
  }

  // A userErrors entry means the article was NOT created. Surfaced as a failure with
  // Shopify's own messages - never swallowed, and never reported as a success.
  if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
    const details = payload.userErrors
      .map((entry) => `${Array.isArray(entry.field) ? entry.field.join('.') : entry.field || 'article'}: ${entry.message}`)
      .join('; ');
    throw new Error(`Shopify refused to create the blog article: ${details}`);
  }

  if (!payload.article || !payload.article.id) {
    throw new Error('Shopify reported no error but returned no article - refusing to report an unconfirmed publish as a success.');
  }

  return payload.article;
}

// ---------------------------------------------------------------------------------
// PRODUCT/INVENTORY/COLLECTION CORRECTIONS: three more mutations, and the scope
// preflight in front of each, following createBlogArticle()'s exact shape above.
// ---------------------------------------------------------------------------------

// Looks up specific inventory items by id, requesting only `location { id }` (never
// `name`) - this store's app has not been granted the `read_locations` scope that
// `name` requires, and getInventoryLevels() above already requests `name` for its own
// store-wide use, so this is a separate, narrower query rather than a change to that
// tested function. Used by integrations/shopifyInventoryCorrection.js to build its
// reconciliation and to independently re-read a correction after it is made.
//
// Returns: an array of { id, sku, tracked, levels: [{locationId, available}] } - the
// same per-item shape as getInventoryLevels(), minus locationName. Items that no longer
// exist are simply absent from the result, never fabricated.
async function getInventoryItemsByIds({ inventoryItemIds, businessId = null } = {}) {
  if (!Array.isArray(inventoryItemIds) || inventoryItemIds.length === 0) {
    throw new Error('getInventoryItemsByIds requires a non-empty array of inventoryItemIds.');
  }

  const query = `query GetInventoryItemsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        sku
        tracked
        inventoryLevels(first: 5) { edges { node {
          location { id }
          quantities(names: ["available"]) { name quantity }
        } } }
      }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(query, 'getInventoryItemsByIds', businessId, { ids: inventoryItemIds });

  if (!raw || !raw.data || !Array.isArray(raw.data.nodes)) {
    throw new Error('Shopify Admin API response did not include inventory item data.');
  }

  return reshapeOrThrow('getInventoryItemsByIds', () =>
    raw.data.nodes
      .filter((node) => node && node.id)
      .map((node) => ({
        id: node.id,
        sku: node.sku,
        tracked: node.tracked,
        levels: node.inventoryLevels.edges.map(({ node: level }) => {
          const availableQuantity = level.quantities.find((quantity) => quantity.name === 'available');
          return { locationId: level.location.id, available: availableQuantity ? availableQuantity.quantity : undefined };
        }),
      }))
  );
}

// Corrects ONE product's vendor field via the real Admin API `productUpdate` mutation.
// Sends and requests back only `id`/`vendor` - no other product field (title,
// description, price, images, status, collections) is ever read or written by this
// function.
//
//   productId - the product's gid://shopify/Product/... id. Required.
//   vendor    - the new vendor value. Required, non-empty.
//   businessId - optional, selects that business's own Shopify credentials.
//
// Returns: { id, vendor } - Shopify's own values, relayed unchanged.
// Throws: when not configured, when REQUIRED_PRODUCT_WRITE_SCOPE is missing (BEFORE
// sending any mutation), on a network/transport failure, on GraphQL errors, or when
// Shopify returns userErrors. Never a fabricated vendor value.
async function updateProductVendor({ productId, vendor, businessId = null } = {}) {
  for (const [name, value] of [['productId', productId], ['vendor', vendor]]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`updateProductVendor requires a non-empty ${name}. No Shopify mutation was attempted.`);
    }
  }

  if (!isConfigured({ businessId })) {
    throw new Error(
      businessId
        ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
          `configuration/businesses/${businessId}/.env with either SHOPIFY_ADMIN_API_ACCESS_TOKEN ` +
          'or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET (plus SHOPIFY_STORE_DOMAIN) before calling updateProductVendor().'
        : 'SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor ' +
          'SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET is set. Copy .env.example to .env and add real ' +
          "values for the owner's Shopify store before calling updateProductVendor()."
    );
  }

  const granted = await getGrantedAccessScopes({ businessId });
  if (!granted.includes(REQUIRED_PRODUCT_WRITE_SCOPE)) {
    throw new Error(
      `Shopify vendor correction is not permitted: this store's app has not been granted the '${REQUIRED_PRODUCT_WRITE_SCOPE}' ` +
        `Admin API scope (granted: ${granted.join(', ') || 'none'}). Add '${REQUIRED_PRODUCT_WRITE_SCOPE}' to the app's ` +
        'access scopes and re-deploy/re-install it, then try again. No Shopify mutation was attempted.'
    );
  }

  const mutation = `mutation UpdateProductVendor($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id vendor }
      userErrors { field message }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(mutation, 'updateProductVendor', businessId, {
    input: { id: productId.trim(), vendor: vendor.trim() },
  });

  const payload = raw && raw.data && raw.data.productUpdate;
  if (!payload) {
    throw new Error('Shopify Admin API response did not include a productUpdate result.');
  }
  if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
    const details = payload.userErrors
      .map((entry) => `${Array.isArray(entry.field) ? entry.field.join('.') : entry.field || 'product'}: ${entry.message}`)
      .join('; ');
    throw new Error(`Shopify refused to update the product vendor: ${details}`);
  }
  if (!payload.product || !payload.product.id) {
    throw new Error('Shopify reported no error but returned no product - refusing to report an unconfirmed vendor update as a success.');
  }

  return payload.product;
}

// Adds one or more existing products to one existing collection via the real Admin API
// `collectionAddProducts` mutation. Never creates a collection, never removes a product
// from any collection, never touches any other field.
//
//   collectionId - the target collection's gid://shopify/Collection/... id. Required.
//   productIds   - non-empty array of gid://shopify/Product/... ids to add. Required.
//   businessId   - optional, selects that business's own Shopify credentials.
//
// Returns: { id, title } - the collection Shopify actually applied the mutation to.
// Membership itself is confirmed by the caller's own independent re-read, never assumed
// from a successful mutation response alone.
// Throws: same conditions as updateProductVendor() above (REQUIRED_PRODUCT_WRITE_SCOPE).
async function addProductsToCollection({ collectionId, productIds, businessId = null } = {}) {
  if (typeof collectionId !== 'string' || collectionId.trim() === '') {
    throw new Error('addProductsToCollection requires a non-empty collectionId. No Shopify mutation was attempted.');
  }
  if (!Array.isArray(productIds) || productIds.length === 0 || productIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error('addProductsToCollection requires a non-empty array of non-empty productIds. No Shopify mutation was attempted.');
  }

  if (!isConfigured({ businessId })) {
    throw new Error(
      businessId
        ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
          `configuration/businesses/${businessId}/.env with either SHOPIFY_ADMIN_API_ACCESS_TOKEN ` +
          'or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET (plus SHOPIFY_STORE_DOMAIN) before calling addProductsToCollection().'
        : 'SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor ' +
          'SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET is set. Copy .env.example to .env and add real ' +
          "values for the owner's Shopify store before calling addProductsToCollection()."
    );
  }

  const granted = await getGrantedAccessScopes({ businessId });
  if (!granted.includes(REQUIRED_PRODUCT_WRITE_SCOPE)) {
    throw new Error(
      `Shopify collection membership update is not permitted: this store's app has not been granted the '${REQUIRED_PRODUCT_WRITE_SCOPE}' ` +
        `Admin API scope (granted: ${granted.join(', ') || 'none'}). Add '${REQUIRED_PRODUCT_WRITE_SCOPE}' to the app's ` +
        'access scopes and re-deploy/re-install it, then try again. No Shopify mutation was attempted.'
    );
  }

  const mutation = `mutation AddProductsToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id title }
      userErrors { field message }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(mutation, 'addProductsToCollection', businessId, {
    id: collectionId.trim(),
    productIds: productIds.map((id) => id.trim()),
  });

  const payload = raw && raw.data && raw.data.collectionAddProducts;
  if (!payload) {
    throw new Error('Shopify Admin API response did not include a collectionAddProducts result.');
  }
  if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
    const details = payload.userErrors
      .map((entry) => `${Array.isArray(entry.field) ? entry.field.join('.') : entry.field || 'collection'}: ${entry.message}`)
      .join('; ');
    throw new Error(`Shopify refused to add the product(s) to the collection: ${details}`);
  }
  if (!payload.collection || !payload.collection.id) {
    throw new Error('Shopify reported no error but returned no collection - refusing to report an unconfirmed membership update as a success.');
  }

  return payload.collection;
}

// Restores inventory `available` quantity via the real Admin API
// `inventoryAdjustQuantities` mutation. Every change is a caller-supplied, already-
// computed delta - this function invents no quantity of its own; the reconciliation
// that decides each delta lives in integrations/shopifyInventoryCorrection.js.
//
//   changes - non-empty array of { inventoryItemId, locationId, delta } (delta a
//             non-zero integer; only positive restorations are used by this project's
//             own correction flow, but the mutation itself is direction-agnostic).
//             Each change MAY also carry `changeFromQuantity` - the quantity the caller
//             believes is currently live. It is InventoryChangeInput's own optional
//             optimistic-concurrency guard (confirmed by introspecting this store's real
//             2026-07 schema, not assumed): Shopify rejects the whole adjustment if the
//             live quantity is not that value, so an already-applied correction can never
//             be applied twice. Untracked items also need it as an explicit baseline.
//             It is a CURRENT QUANTITY, not a delta, so zero and negative are both valid.
//   reason  - a non-empty reason string Shopify's inventoryAdjustQuantities accepts
//             (e.g. 'correction'). Required - never defaulted, so every adjustment
//             names why it happened.
//   idempotencyKey - required, non-empty. This API version REFUSES the mutation outright
//             ("The @idempotent directive is required for this mutation but was not
//             provided", BAD_REQUEST) unless the @idempotent(key:) directive is present,
//             so it is a required argument here rather than an optional extra. Confirmed
//             by introspecting this store's real schema: @idempotent is a FIELD directive
//             taking `key: String!`, and the key may not be empty or whitespace-only.
//             The CALLER owns the value, exactly as it owns delta: a key that is stable
//             for one logical correction is what makes a repeated run safe, and a
//             randomly generated one would silently defeat that.
//   businessId - optional, selects that business's own Shopify credentials.
//
// Returns: Shopify's own inventoryAdjustmentGroup (carries quantityAfterChange per
// item), relayed unchanged.
// Throws: same conditions as updateProductVendor() above (REQUIRED_INVENTORY_WRITE_SCOPE).
async function adjustInventoryQuantities({ changes, reason, idempotencyKey, businessId = null } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('adjustInventoryQuantities requires a non-empty reason. No Shopify mutation was attempted.');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new Error(
      'adjustInventoryQuantities requires a non-empty idempotencyKey for the @idempotent directive this mutation mandates. No Shopify mutation was attempted.'
    );
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('adjustInventoryQuantities requires a non-empty changes array. No Shopify mutation was attempted.');
  }
  for (const change of changes) {
    const isPlain = typeof change === 'object' && change !== null && !Array.isArray(change);
    const idsOk =
      isPlain &&
      typeof change.inventoryItemId === 'string' &&
      change.inventoryItemId.trim() !== '' &&
      typeof change.locationId === 'string' &&
      change.locationId.trim() !== '';
    const deltaOk = isPlain && Number.isInteger(change.delta) && change.delta !== 0;
    if (!idsOk || !deltaOk) {
      throw new Error(
        'adjustInventoryQuantities requires every change to have a non-empty inventoryItemId, a non-empty locationId, and a non-zero integer delta. No Shopify mutation was attempted.'
      );
    }
    // Optional, and only validated when actually supplied. It is a current quantity
    // rather than a delta, so 0 and negative values are both legitimate - only a
    // non-integer is refused.
    if (change.changeFromQuantity !== undefined && change.changeFromQuantity !== null && !Number.isInteger(change.changeFromQuantity)) {
      throw new Error(
        'adjustInventoryQuantities requires changeFromQuantity, when supplied, to be an integer (it is a current quantity, not a delta). No Shopify mutation was attempted.'
      );
    }
  }

  if (!isConfigured({ businessId })) {
    throw new Error(
      businessId
        ? `Business '${businessId}' has no configured Shopify credentials. Create ` +
          `configuration/businesses/${businessId}/.env with either SHOPIFY_ADMIN_API_ACCESS_TOKEN ` +
          'or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET (plus SHOPIFY_STORE_DOMAIN) before calling adjustInventoryQuantities().'
        : 'SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor ' +
          'SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET is set. Copy .env.example to .env and add real ' +
          "values for the owner's Shopify store before calling adjustInventoryQuantities()."
    );
  }

  const granted = await getGrantedAccessScopes({ businessId });
  if (!granted.includes(REQUIRED_INVENTORY_WRITE_SCOPE)) {
    throw new Error(
      `Shopify inventory correction is not permitted: this store's app has not been granted the '${REQUIRED_INVENTORY_WRITE_SCOPE}' ` +
        `Admin API scope (granted: ${granted.join(', ') || 'none'}). Add '${REQUIRED_INVENTORY_WRITE_SCOPE}' to the app's ` +
        'access scopes and re-deploy/re-install it, then try again. No Shopify mutation was attempted.'
    );
  }

  // The @idempotent directive is mandatory for this mutation on this API version. The key
  // travels as a GraphQL VARIABLE rather than being interpolated into the query string -
  // the same discipline createBlogArticle() applies to article content.
  const mutation = `mutation AdjustInventoryQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        changes { name delta quantityAfterChange item { id } location { id } }
      }
      userErrors { field message code }
    }
  }`;

  const { raw } = await runAdminGraphqlQuery(mutation, 'adjustInventoryQuantities', businessId, {
    idempotencyKey: idempotencyKey.trim(),
    input: {
      reason: reason.trim(),
      name: 'available',
      // changeFromQuantity is added ONLY when the caller supplied one, so a call that
      // omits it sends exactly the request this function sent before the field was
      // supported - no existing behaviour changes.
      changes: changes.map((change) => {
        const entry = {
          inventoryItemId: change.inventoryItemId.trim(),
          locationId: change.locationId.trim(),
          delta: change.delta,
        };
        if (Number.isInteger(change.changeFromQuantity)) entry.changeFromQuantity = change.changeFromQuantity;
        return entry;
      }),
    },
  });

  const payload = raw && raw.data && raw.data.inventoryAdjustQuantities;
  if (!payload) {
    throw new Error('Shopify Admin API response did not include an inventoryAdjustQuantities result.');
  }
  if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
    const details = payload.userErrors
      .map((entry) => `${Array.isArray(entry.field) ? entry.field.join('.') : entry.field || 'inventory'}: ${entry.message}`)
      .join('; ');
    throw new Error(`Shopify refused to adjust inventory: ${details}`);
  }
  if (!payload.inventoryAdjustmentGroup) {
    throw new Error('Shopify reported no error but returned no inventoryAdjustmentGroup - refusing to report an unconfirmed inventory correction as a success.');
  }

  return payload.inventoryAdjustmentGroup;
}

module.exports = {
  getShopInfo,
  getProducts,
  getOrders,
  getCustomers,
  getInventoryLevels,
  getInventoryItemsByIds,
  getCollections,
  sumTestOrderQuantitiesByInventoryItem,
  isConfigured,
  loadEnvOnce,
  resolveCredentials,
  usesClientCredentials,
  buildTokenUrl,
  getClientCredentialsToken,
  DEFAULT_API_VERSION,
  // Publishing (the one mutation) and the scope preflight in front of it.
  REQUIRED_PUBLISH_SCOPE,
  getGrantedAccessScopes,
  hasWriteContentScope,
  clearAccessScopesCache,
  createBlogArticle,
  getConfiguredBlogId,
  getConfiguredArticleAuthor,
  // Product/inventory/collection corrections and the scope preflights in front of them.
  REQUIRED_PRODUCT_WRITE_SCOPE,
  REQUIRED_INVENTORY_WRITE_SCOPE,
  updateProductVendor,
  addProductsToCollection,
  adjustInventoryQuantities,
};

if (require.main === module) {
  loadEnvOnce();
  if (!isConfigured()) {
    console.log('Shopify connection layer loaded, but store credentials are not set.');
    console.log('Copy .env.example to .env and fill in SHOPIFY_STORE_DOMAIN plus EITHER:');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...   (classic custom app)');
    console.log('  or');
    console.log('  SHOPIFY_CLIENT_ID=...');
    console.log('  SHOPIFY_CLIENT_SECRET=...                  (Dev Dashboard app)');
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
