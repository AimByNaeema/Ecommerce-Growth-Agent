# integrations/adapters/

Per-platform adapters that translate between the agent's internal interfaces and each
external system's API (starting with Shopify).

[`shopifyClient.js`](shopifyClient.js) is the ONE agent's connection to the owner's
Shopify store (Admin GraphQL API) — a connection layer only: it can reach the store and
confirm the connection works (`getShopInfo`), and report whether
`SHOPIFY_STORE_DOMAIN`/`SHOPIFY_ADMIN_API_ACCESS_TOKEN` are configured (`isConfigured`).
It does not read/write products, orders, inventory, or anything else, and is not wired
into `agent/core/agentContract.js`'s stages yet — that orchestration is later,
explicitly-scoped work. No SDK dependency was added (Node's built-in `fetch` is enough);
`.env` (git-ignored) is loaded automatically via Node's built-in `process.loadEnvFile`. A
missing config, a network failure, or a non-success/GraphQL-error response all throw a
clear error — no result is ever invented. Run `node integrations/adapters/shopifyClient.js`
(or `npm run integrations:shopify-client`) to check configuration and, if real credentials
are set, confirm the connection against the real store.
