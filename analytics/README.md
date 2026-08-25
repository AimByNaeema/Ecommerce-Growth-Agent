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

## Conversion Optimization Checker

[`../agent/core/conversionOptimizationChecker.js`](../agent/core/conversionOptimizationChecker.js)
is a CRO (conversion-rate optimization) audit, evaluating 8 dimensions of a store's
real, caller-supplied evidence — product pages, landing pages, offers, CTA, trust
signals, checkout friction, mobile experience, pricing presentation — via
[`../agent/core/conversionOptimizationCheckModel.js`](../agent/core/conversionOptimizationCheckModel.js).
It mirrors [`../agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js)'s
and [`../agent/core/listingQualityChecker.js`](../agent/core/listingQualityChecker.js)'s
structure and honesty rules exactly: every finding is a concrete, mechanical fact about
the actual supplied evidence (a count, a boolean presence check, a numeric threshold
comparison) — never a subjective opinion about design quality or an actual
conversion-rate prediction. A dimension with no evidence supplied is honestly `'empty'`,
not skipped or guessed; `offers` is additionally `'empty'` (not a failure) whenever no
active offer exists, since a store isn't required to always run a promotion.

This is a distinct concern from this folder's own `conversion` snapshot category above
(numeric conversion-rate metrics) and from
[`../agent/core/marketingAgent.js`](../agent/core/marketingAgent.js)'s
`conversion_opportunities` capability (upsell/cross-sell/retention growth records) —
three different things that happen to share the word "conversion". It also never
fetches a live page, screenshot, or theme file — there is no tool in this project that
can (see [`../integrations/adapters/shopifyClient.js`](../integrations/adapters/shopifyClient.js)'s
own scope: read-only product/order/customer/inventory data only) — every dimension's
evidence is supplied by the caller as plain structured facts.

`prioritized_recommendations` tags every flagged issue with a fixed, documented
severity tier (`critical`/`high`/`medium`/`low`) drawn from widely-documented
e-commerce CRO conventions (e.g. a missing guest-checkout option is `critical`; a
missing compare-at price is `low`) — the same labeled-heuristic honesty
`seoQualityChecker.js`'s length guidelines already use, never a per-instance invented
business-impact estimate. `quality_score` is a mechanical checklist-coverage
percentage across the 8 dimensions, never a conversion-rate prediction.

Standalone deliverable, not wired into `tools/toolRegistry.js` or the
Chief/Orchestrator — the same deliberate scope choice
[`../agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js) and
[`../agent/core/listingQualityChecker.js`](../agent/core/listingQualityChecker.js)
already made (directly callable, evaluating caller-supplied structured evidence, not
part of the 10-capability dispatcher above). It has no write/execute/publish code path
anywhere: applying any recommendation to a real page is a separate, human-approved
action (see [`../approvals/README.md`](../approvals/README.md)) — nothing here ever
modifies a production page.

## Sales Growth Planner

[`../agent/core/salesGrowthPlanner.js`](../agent/core/salesGrowthPlanner.js) is the
first module in this project that combines real, caller-supplied structured evidence
from **multiple specialist domains** — product, customer, analytics, SEO, marketing,
social, advertising — into one cross-domain report via
[`../agent/core/salesGrowthPlanModel.js`](../agent/core/salesGrowthPlanModel.js):
`current_state`, `bottlenecks`, `opportunities`, `recommended_actions`, `kpis`,
`experiment_ideas`, and `approval_requirements`.

Like every other engine in this folder, it never calls another specialist, fetches a
live page, or makes an AI/API call itself — whoever calls it (a workflow, the
Chief/Orchestrator, or a human) is responsible for gathering each domain's evidence
first. `current_state` reuses `analyticsModel.js`'s exact per-category
actual/calculated/estimated-metrics shape, keyed by domain instead of by analytics
category. `opportunities` is composed by calling
[`../agent/core/growthOpportunityEngine.js`](../agent/core/growthOpportunityEngine.js)'s
`rankGrowthOpportunities()` directly — its ICE-style ranking (impact × confidence) and
approval-classification tagging are reused, never reimplemented.

`bottlenecks`, `recommended_actions`, `kpis`, and `experiment_ideas` are always
caller-supplied hypotheses or facts, structured and validated only — the same
"never invent an explanation, action, or target value" rule
[`../agent/core/insightModel.js`](../agent/core/insightModel.js)'s `possible_cause`
field already establishes. A bottleneck asserted `critical`/`high` severity with no
supporting evidence is honesty-graded down to `medium` (recorded in the plan's own
`limitations`, never silently applied) — the same downgrade-and-record pattern
`growthOpportunityEngine.js` applies to confidence/verification_status. Every
recommended action is tagged with one of
[`../approvals/approvalArchitecture.js`](../approvals/approvalArchitecture.js)'s 4
classifications via a caller-supplied `actionClassification`, exactly like every
opportunity candidate already is; `approval_requirements` is a mechanical rollup of
every opportunity/action already tagged `requires_human_approval: true` — never an
independently-asserted judgment.

`domain_coverage` is a mechanical checklist-coverage percentage across the 7 domains,
mirroring the Conversion Optimization Checker's `quality_score` above — never a
growth-rate or revenue prediction. Standalone deliverable, not wired into
`tools/toolRegistry.js` or the Chief/Orchestrator in this first pass — the same
deliberate scope choice every other engine in this folder already made. It has no
write/execute/publish code path anywhere: acting on any recommended action is a
separate, human-approved action via [`../approvals/README.md`](../approvals/README.md).

## Experiment Framework

[`../agent/core/experimentEngine.js`](../agent/core/experimentEngine.js) is a reusable
A/B-test lifecycle framework via
[`../agent/core/experimentModel.js`](../agent/core/experimentModel.js): one schema —
`hypothesis`, `variable`, `control`, `variant`, `target_metric`, `duration`,
`success_criteria`, `result`, `decision` — reused identically across all 8 growth
surfaces named in the prompt this answers (`products`, `pricing`, `listing`, `seo`,
`offers`, `marketing`, `social`, `advertising`) via a generic `domain` enum, the same
"one schema, many domains" pattern
[`../agent/core/growthOpportunityEngineModel.js`](../agent/core/growthOpportunityEngineModel.js)'s
`OPPORTUNITY_CATEGORIES` already establishes.

Unlike this folder's other engines, an experiment has a real **lifecycle** rather than
being a single-snapshot report, so `experimentEngine.js` exposes three pure functions
instead of one compose-everything call, each returning a new record without mutating
its input: `createExperiment()` (design stage), `recordExperimentResult()` (run
stage), and `decideExperiment()` (decision stage). `status` (`draft` / `running` /
`completed`) is the one field this engine computes itself, and only mechanically — from
whether `duration.start_date` and a real `result` have actually been supplied — never
asserted by the caller directly, the same "status is derived, not asserted" discipline
`salesGrowthPlanModel.js`'s `domain_status` and this file's own dimension-status
convention already use.

`hypothesis`, `variable`, `control`, `variant`, `target_metric`, `duration`,
`success_criteria`, and `result` are always caller-supplied fact — this engine never
invents a hypothesis, computes a statistical-significance figure, or predicts an
outcome. `decision.approval_requirement` reuses
[`../agent/core/growthOpportunityEngine.js`](../agent/core/growthOpportunityEngine.js)'s
`buildApprovalRequirement()` directly (not reimplemented), so every decision is tagged
with one of [`../approvals/approvalArchitecture.js`](../approvals/approvalArchitecture.js)'s
4 classifications via a caller-supplied `actionClassification`, exactly like every
recommended action in `salesGrowthPlanner.js` already is.

**Honesty guard**: `ship_variant` and `keep_control` are the two conclusive,
production-affecting decision outcomes. Asserting either one before the experiment's
`status` is `'completed'` (i.e. before a real result has been recorded) is downgraded
to `'inconclusive'`, with the downgrade recorded in the record's own `limitations` —
the same downgrade-and-record pattern `salesGrowthPlanner.js`'s `DOWNGRADED_SEVERITIES`
already applies to bottleneck severity, never applied silently. `iterate` and
`inconclusive` never require a completed result — both are honest calls a human can
make at any stage.

Distinct from `salesGrowthPlanModel.js`'s existing `experiment_ideas` field — that
field is a one-line idea stub (`{domain, hypothesis, test_description,
expected_outcome, evidence}`) with no control/variant, no duration, no result, and no
decision; this module is the fuller run-to-decision lifecycle record, and the existing
field is left untouched.

Standalone deliverable, not wired into `tools/toolRegistry.js` or the
Chief/Orchestrator — the same deliberate scope choice every other engine in this folder
already made. It has no write/execute path of its own: `decideExperiment()`'s
`ship_variant`/`keep_control` outcome is a recommendation tagged with an approval
requirement, never applied to a real store, page, price, or ad account automatically —
acting on it is a separate, human-approved action via
[`../approvals/README.md`](../approvals/README.md).
