# workflows/

Multi-step processes the agent runs (e.g. a growth-audit sequence), composed from tools
and capability modules elsewhere in the repo.

[`productOpportunityAnalysisWorkflow.js`](productOpportunityAnalysisWorkflow.js) defines
the process that turns evidence gathered by
[`products/productResearchArchitecture.js`](../products/productResearchArchitecture.js)
into a structured
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js)
record. Pipeline only — no automated recommendation, score, or verdict is produced.

[`keywordResearchWorkflow.js`](keywordResearchWorkflow.js) defines the process that
turns a product/category
([`agent/core/productModel.js`](../agent/core/productModel.js)) and customer intent
signals
([`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js))
into a concise, structured set of
[`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js) keyword records.
Pipeline only — no search volume or competition metric is ever invented, and any field
with no real evidence is marked unavailable rather than guessed.

[`contentMarketingWorkflow.js`](contentMarketingWorkflow.js) defines the process that
connects a product to a content recommendation: PRODUCT → CUSTOMER → PROBLEM/NEED →
SEARCH/INTEREST → CONTENT OPPORTUNITY → CONTENT RECOMMENDATION → VERIFICATION. It
composes [`agent/core/productModel.js`](../agent/core/productModel.js),
[`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js),
[`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js), and
[`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js).
Pipeline only — nothing is ever published automatically, and no business fact is
invented anywhere.

[`globalEcommerceMarketResearchWorkflow.js`](globalEcommerceMarketResearchWorkflow.js)
is real, executable logic — unlike the 4 workflows above, which are conceptual
stage-lists only. It is this project's structured global ecommerce market opportunity
analysis: countries/markets are the comparison axis (one row per country/market), and
each row carries 9 evidence-backed facets — category, demand_signals, trends, risks,
opportunities, competition, pricing, customer_need, and products — matching
country/category/demand/competition/pricing/trends/customer_need/risk/opportunity,
with `products` kept as an existing extra facet beyond that 9-item list. It reuses
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js)'s `retrieveResearchData()`
for the market/competitor/customer_segment record-building (no duplicated logic), and
[`agent/core/productModel.js`](../agent/core/productModel.js) for products. The result
shape is [`agent/core/globalMarketComparisonModel.js`](../agent/core/globalMarketComparisonModel.js).
No field is ever a computed number, percentage, score, or ranking — every facet is
either caller-supplied content passed through as-is, or a structural evidence-presence
signal (`has_evidence` / `status: empty|partial|success`), so no unsupported market
statistic can be produced. Wired to `tools/toolRegistry.js` as the
`global_market_opportunity_analysis` tool
([`tools/globalMarketOpportunityTool.js`](../tools/globalMarketOpportunityTool.js)) and
into the orchestrator's `TOOL_EXECUTORS` — reachable via the Chief like every other
research tool. This is distinct from
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js)'s own
`global_market_research`/`trend_research`/`opportunity_discovery` research types, which
remain unwired (see [`research/README.md`](../research/README.md)).

[`analyticsInsightWorkflow.js`](analyticsInsightWorkflow.js) defines the process that
turns real analytics data into a verified result: DATA → FINDING → INTERPRETATION →
OPPORTUNITY → RECOMMENDATION → EXPECTED IMPACT → VERIFICATION. It composes
[`agent/core/analyticsModel.js`](../agent/core/analyticsModel.js),
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js),
[`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js),
[`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js),
[`agent/core/growthOpportunityModel.js`](../agent/core/growthOpportunityModel.js), and
[`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js)'s
verification_status convention. It also defines the 5-type taxonomy the agent must use
to label every claim along this chain — observed fact, calculated result,
interpretation, hypothesis, recommendation. Pipeline only — hypotheses (opportunity,
expected impact) are never presented as facts; only the verification stage confirms or
refutes them.
