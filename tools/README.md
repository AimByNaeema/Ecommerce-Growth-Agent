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

[`globalMarketOpportunityTool.js`](globalMarketOpportunityTool.js) is the same thin
wrapper pattern around
[`workflows/globalEcommerceMarketResearchWorkflow.js`](../workflows/globalEcommerceMarketResearchWorkflow.js)'s
`compareGlobalMarkets()` — structured global ecommerce market opportunity analysis
across 9 evidence-backed dimensions (country, category, demand, competition, pricing,
trends, customer_need, risk, opportunity) per market row. `status` is derived per row
across all 9 facets rather than per flat record (`success` only when every row has
evidence in every facet), the same three-tier honesty convention as
`marketResearchTool.js`/`competitorResearchTool.js`, adapted to a multi-facet-per-row
result.

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

[`collectionDataRetrievalTool.js`](collectionDataRetrievalTool.js) is the same
thin, read-only wrapper pattern around `getCollections()` — a store-wide collection
catalog (title, handle, description, image, product count) independent of any one
product. No downstream agent mapping exists for it yet.

[`marketProductOpportunityTool.js`](marketProductOpportunityTool.js) is the same thin
wrapper pattern around
[`workflows/productOpportunityAnalysisWorkflow.js`](../workflows/productOpportunityAnalysisWorkflow.js)'s
`analyzeProductOpportunityFromMarket()` — connects one global market intelligence row
(from `global_market_opportunity_analysis`) to one product candidate: Market →
Category → Trend → Product → Competition → Economics → Opportunity, producing a real
`agent/core/opportunityAnalysisModel.js` record. `status` is graded on the same
"evidence-backed" definition `agent/core/productAgent.js`'s `opportunity_scoring`
already uses (`confidence !== 'unassessed' && evidence.length > 0`) across the 4
in-scope dimensions (`demand`, `competition`, `market_relevance`,
`commercial_potential`) — deliberately conservative, since confidence is never
inferred from evidence alone.

Every `toolRegistry.js` entry now also carries an `operation` field —
`'read' | 'write' | 'execute'` — describing what kind of action the tool performs,
independent of its `category` (which domain owns it) and independent of
`approvals/approvalArchitecture.js`'s classification (whether a human must sign off).
This is the axis [`agent/core/toolPermissions.js`](../agent/core/toolPermissions.js)'s
`SPECIALIST_ROLE_PERMISSIONS` gates on: each specialist's role covers only the
operation types its domain actually needs (e.g. Research is read-only; Listing is
write-only), so a tool it would otherwise reach by category ownership is still denied
if the tool's operation falls outside that role. No tool is `execute` today.
