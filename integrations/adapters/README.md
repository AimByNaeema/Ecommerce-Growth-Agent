# integrations/adapters/

Per-platform adapters that translate between the agent's internal interfaces and each
external system's API (starting with Shopify).

[`shopifyClient.js`](shopifyClient.js) is the ONE agent's connection to the owner's
Shopify store (Admin GraphQL API) — a connection layer: it can reach the store and
confirm the connection works (`getShopInfo`), report whether
`SHOPIFY_STORE_DOMAIN`/`SHOPIFY_ADMIN_API_ACCESS_TOKEN` are configured (`isConfigured`),
and read product data (`getProducts` — products, variants including SKU/price/inventory,
product status, collections, and metafields, in one GraphQL round-trip), order data
(`getOrders`), non-PII customer data (`getCustomers`), inventory data
(`getInventoryLevels`), and a store-wide collection catalog (`getCollections` — title,
handle, description, image, product count, independent of any one product — unlike the
collections already nested per-product inside `getProducts`). Read-only only — no
write/mutation of any kind exists here, and it is not wired into
`agent/core/agentContract.js`'s stages yet — that orchestration is later,
explicitly-scoped work. No SDK dependency was added (Node's built-in `fetch` is
enough); `.env` (git-ignored) is loaded automatically via Node's built-in
`process.loadEnvFile`. A missing config, a network failure, or a
non-success/GraphQL-error response all throw a clear error — no result is ever
invented. Run `node integrations/adapters/shopifyClient.js` (or
`npm run integrations:shopify-client`) to check configuration and, if real credentials
are set, confirm the connection and print up to 5 real products, orders, customers,
inventory items, and collections against the real store.

[`tools/productDataRetrievalTool.js`](../../tools/productDataRetrievalTool.js) is the
thin tool wrapper around `getProducts()` — see [`tools/README.md`](../../tools/README.md)
and [`products/README.md`](../../products/README.md#product-agent) for how it connects
this read-only Shopify data to the Product Agent.
[`tools/collectionDataRetrievalTool.js`](../../tools/collectionDataRetrievalTool.js) is
the equivalent thin wrapper around `getCollections()` — same pass-through convention,
no downstream mapping yet.
