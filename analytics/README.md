# analytics/

Store performance analysis: sales, orders, products, inventory, customers, and
performance metrics the agent computes or summarizes — either from caller-supplied
evidence, or from a live, read-only connection to the owner's Shopify store.

[`../agent/core/analyticsModel.js`](../agent/core/analyticsModel.js) defines the shape
of one analytics snapshot, covering sales, traffic, conversion, product performance,
inventory, customer behavior, marketing performance, advertising performance, SEO
performance, retention, and growth opportunities. Each category distinguishes 4 kinds
of statement, per
[`../workflows/analyticsInsightWorkflow.js`](../workflows/analyticsInsightWorkflow.js)'s
own taxonomy, never blurred together:

- **`actual_metrics`** — an observed fact: a value read directly off a real source (a
  live Shopify pull, or caller-supplied), with no arithmetic applied.
- **`calculated_metrics`** — a value mechanically derived from `actual_metrics` by a
  defined formula (e.g. total revenue = sum of order totals) — objective, but derived,
  and only as complete as the actual data it was computed from.
- **`estimated_metrics`** — a value that additionally requires an assumption or
  extrapolation beyond the literal calculated data (e.g. a monthly revenue projection
  scaled from a partial period, or days-of-inventory-remaining assuming a steady sales
  rate) — always labeled as approximate, and the assumption is always caller-supplied,
  never invented internally. Every estimate carries its own `assumption` string.
- **recommended** — deliberately *not* a 4th sub-field here; recommendations stay only
  in [`../agent/core/analyticsAgentResultModel.js`](../agent/core/analyticsAgentResultModel.js)'s
  own `recommendations` field, the same separation
  [`../agent/core/advertisingPerformanceModel.js`](../agent/core/advertisingPerformanceModel.js)'s
  header already established for actual/calculated vs. recommendations.

## Analytics & Optimization Agent

[`../agent/core/analyticsAgent.js`](../agent/core/analyticsAgent.js) is the Analytics &
Optimization Agent (CLAUDE.md section 2, specialist #7) — deterministic and
evidence-only, the same philosophy and structure as every other specialist in this
project: no AI API call, no synthesis. It supports 10 capabilities — sales, products,
customers, conversion, traffic, marketing, advertising, inventory, growth
opportunities, and insights — returning one common structured result shape,
[`../agent/core/analyticsAgentResultModel.js`](../agent/core/analyticsAgentResultModel.js).

## The analytics insight engine

The `insights` capability is the analytics insight engine. For each **significant**
insight it returns exactly 8 fields — **metric, current state, comparison, possible
cause, opportunity, recommendation, confidence, evidence** — via
[`../agent/core/insightModel.js`](../agent/core/insightModel.js).

Given an array of raw metric-comparison entries (`metric`, `currentValue`,
`comparisonValue`, `comparisonLabel`, `unit`),
[`../agent/core/insightEngine.js`](../agent/core/insightEngine.js) mechanically computes
each one's percent change and decides whether it clears a significance threshold (a
defined, adjustable rule — 10% by default, overridable via `thresholdPercent` — never a
judgment call). Only metrics that clear the bar are composed into insight records and
returned; the rest are named in `limitations` as excluded, not silently dropped.

`possible_cause`, `opportunity`, and `recommendation` are always caller-supplied
hypotheses — this engine never invents an explanation for *why* a metric changed.

**"Do not state correlation as causation without evidence"** is enforced structurally,
not just by convention: a `possible_cause` stated with an empty `evidence` array can
never carry `'high'` confidence — `analyzeInsights()` caps it at `'medium'` and adds an
explicit limitation naming the downgrade. This is a presence-only guard (it checks
*whether* evidence was supplied, not whether that evidence actually substantiates the
causal claim — a deterministic, non-AI system has no way to judge that), the same
honest limit every other confidence/verification guard in this project already accepts.

This module itself stays Shopify-agnostic (`agent/core/` never depends on
`integrations/` or `tools/` — see
[`../tools/productDataRetrievalTool.js`](../tools/productDataRetrievalTool.js)'s header
for this project's standing rule): the 8 snapshot-based capabilities each compose one
`analyticsModel.js` category, and `growth_opportunities` composes
[`../agent/core/growthOpportunityModel.js`](../agent/core/growthOpportunityModel.js)
records directly (an OPPORTUNITY-stage hypothesis, not a DATA-stage observed fact).

## Connecting to real data (read-only, first connection)

Two tools call the *same* `analyticsAgent.js` capability functions, just with data from
a different source:

- [`../tools/analyticsTool.js`](../tools/analyticsTool.js) — the `analytics` tool id.
  Composes a result from **caller-supplied evidence** (`actualMetrics`,
  `calculatedMetrics`, `estimatedMetrics`, `summary`, etc.) — no live connection.
- [`../tools/analyticsDataTool.js`](../tools/analyticsDataTool.js) — the
  `analytics_data_retrieval` tool id. Connects to the owner's **live Shopify store**,
  read-only, via [`../integrations/adapters/shopifyClient.js`](../integrations/adapters/shopifyClient.js)'s
  `getOrders()`, `getProducts()`, `getCustomers()`, and `getInventoryLevels()`, computes
  `calculated_metrics`/`estimated_metrics` from the pulled data via
  [`../agent/core/analyticsMetricsCalculator.js`](../agent/core/analyticsMetricsCalculator.js)
  (a pure, Shopify-agnostic calculator mirroring
  [`../agent/core/advertisingPerformanceCalculator.js`](../agent/core/advertisingPerformanceCalculator.js)'s
  precedent), and composes the result the same way. Supports `sales`, `products`,
  `customers`, and `inventory` — `conversion`, `traffic`, `marketing`, `advertising`,
  and `growth_opportunities` aren't backed by any read-only Admin API data Shopify
  exposes today, so they stay caller-supplied-evidence only (via `analyticsTool.js`).

  No writes of any kind — every Shopify call is a read-only GraphQL query. A `limit`
  parameter (default 50) caps each pull; the result always names the actual record
  count retrieved so a capped read is never mistaken for a complete one.

  **Customers ("where permitted")**: `getCustomers()` deliberately requests no
  personally-identifiable fields (no name, email, phone, or address) — only
  account-level aggregate stats (order count, amount spent, state, tags, creation
  date). If the connected access token lacks the `read_customers` scope, that source
  degrades gracefully to a `partial` status with the real error named in
  `limitations`, rather than failing the whole call.

Both tools are wired into the Chief/Orchestrator
(`../agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`), classified
`analysis_only` in `../agent/core/toolPermissions.js` (read-only, no side effects), so a
routed objective can reach either end-to-end via `runOrchestratorContract()`.
