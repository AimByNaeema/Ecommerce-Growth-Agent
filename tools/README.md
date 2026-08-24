# tools/

Definitions for the tools/functions the agent can call to take action or fetch data.

[`configValidator.js`](configValidator.js) validates a business configuration file
against the required fields and reports what's missing. Run directly with
`node tools/configValidator.js [path]` (default `configuration/business.yaml`).

[`toolRegistry.js`](toolRegistry.js) is the registry of tools the ONE agent may
eventually call, grouped into 10 categories (configuration, products, research,
customer_market_intelligence, seo, marketing, analytics, ai_reasoning, memory,
verification) and covering 13 named tools (business configuration retrieval, product
data retrieval, product research, market research, customer research, competitor
research, keyword research, SEO analysis, marketing analysis, analytics, AI reasoning
completion, memory retrieval, verification). Registry foundation plus 6 real,
callable tools — `business_configuration_retrieval`, `product_data_retrieval`,
`market_research`, `customer_research`, `competitor_research`, and
`ai_reasoning_completion` are `implemented`; the other 7 remain `not_implemented`.
There is still no generic register/execute/dispatch function in this file — real
dispatch lives in
[`agent/core/orchestratorExecutionContract.js`](../agent/core/orchestratorExecutionContract.js),
gated by [`agent/core/toolPermissions.js`](../agent/core/toolPermissions.js). Run
`node tools/toolRegistry.js` to print it. How the agent selects and uses these tools
is governed by
[`agent/core/toolSelectionRules.js`](../agent/core/toolSelectionRules.js).

[`businessConfigurationRetrieval.js`](businessConfigurationRetrieval.js) and
[`aiReasoningCompletion.js`](aiReasoningCompletion.js) are thin wrappers around
`integrations/adapters/shopifyClient.js` and `agent/core/claudeClient.js` respectively.
[`marketResearchTool.js`](marketResearchTool.js),
[`competitorResearchTool.js`](competitorResearchTool.js), and
[`customerResearchTool.js`](customerResearchTool.js) are thin wrappers around
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js) — see
[`research/README.md`](../research/README.md) for what they compose and how they
report `success`/`empty`/`partial`/`failed` outcomes without ever fabricating a
result when structured research input is missing or incomplete.

[`productDataRetrievalTool.js`](productDataRetrievalTool.js) is a thin, read-only
wrapper around `integrations/adapters/shopifyClient.js`'s `getProducts()` — same
pass-through convention as `businessConfigurationRetrieval.js` (returns/throws exactly
what the adapter does, no new HTTP or config logic). No product writes exist here or
anywhere yet. It also exports `mapShopifyProductToCandidate()`, a pure reshaping
function that converts one normalized Shopify product into the entry shape
[`agent/core/productAgent.js`](../agent/core/productAgent.js)'s `discoverProducts()`
already expects — this is the actual connection between real Shopify data and the
Product Agent; see [`products/README.md`](../products/README.md#product-agent) for
why that mapping lives here rather than in `agent/core/` (which never depends on
`tools/` or `integrations/` in this codebase).
