# products/

Product catalog analysis, listing recommendations, and related work the agent produces.

[`productResearchArchitecture.js`](productResearchArchitecture.js) defines the
conceptual pipeline of a future product research capability (discover opportunities,
collect evidence, compare opportunities, identify demand signals, identify
competition, identify market fit, record confidence). It composes with
[`agent/core/productModel.js`](../agent/core/productModel.js) (the candidate/product
shape) and [`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js)
(the evidence/finding shape). Pipeline only - no external research API is called, no
source is configured today, and no result is fabricated.

[`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)
defines the shape of one product/listing optimization record (product title,
description, keywords, search intent, structure, metadata, internal optimization
opportunities, conversion considerations). Every field is a suggestion only - nothing
here reads or writes real listing content, and applying a suggestion to a real store
listing requires a separate, human-approved action via
[`approvals/`](../approvals/README.md). No field claims or predicts an SEO performance
improvement - only qualitative, evidence-checkable opportunities are captured.

[`agent/core/growthOpportunityModel.js`](../agent/core/growthOpportunityModel.js)
defines the shape of one growth opportunity record, covering upselling,
cross-selling, retention, repeat purchases, and customer re-engagement. Every
product/offer reference must point at real, already-configured data - never
invented - and `recommendation` is a suggestion only: no customer-facing action is
ever executed here.

## Product Agent

[`agent/core/productAgent.js`](../agent/core/productAgent.js) is the Product Agent
(CLAUDE.md section 2, specialist #2) - the first real, executable logic for this
domain (`productResearchArchitecture.js` and
[`workflows/productOpportunityAnalysisWorkflow.js`](../workflows/productOpportunityAnalysisWorkflow.js)
remain conceptual stage-lists only). It supports 8 capabilities: product discovery,
product validation, demand analysis, competition analysis, market fit, product risk,
profitability inputs, and opportunity scoring. Deterministic only - no AI call, no
external fetch; callers supply already-structured evidence.

Of the 8 capabilities, 4 (demand, competition, market fit, product risk) reuse
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js)
directly: `analyzeProductOpportunity()` builds a real, validated instance of that
model, where "market fit" and "product risk" are this module's names for its existing
`market_relevance` and `risks` dimensions (its other 4 dimensions -
`customer_fit`/`differentiation`/`commercial_potential`/`evidence_quality` - are left
untouched, since this pass doesn't assess them). Each dimension's `confidence` is
caller-asserted only, defaulting to `unassessed`, and is downgraded back to
`unassessed` with a `limitations` entry if asserted without any evidence - the same
honesty guard [`agent/core/researchAgent.js`](../agent/core/researchAgent.js) uses for
verification status.

The other 4 capabilities have no existing schema and are kept intentionally small:
**product discovery** and **product validation** build/validate
[`agent/core/productModel.js`](../agent/core/productModel.js) records as-is (never
inventing a candidate that wasn't supplied); **profitability inputs** collects real
pricing/cost evidence only - it never computes a margin or profitability figure, by
design; **opportunity scoring** is a structural coverage count (how many of the 4
assessed dimensions ended up evidence-backed), never a judgment about whether the
opportunity is good - the same honesty convention as
[`agent/core/competitorIntelligenceAgent.js`](../agent/core/competitorIntelligenceAgent.js)'s
`data_availability`. The combined result shape is
[`agent/core/productAgentResultModel.js`](../agent/core/productAgentResultModel.js).

`agent/core/productAgent.js` never depends on `integrations/` or `tools/` directly
(no `agent/core/` file does, in this codebase). It connects to real Shopify product
data instead through [`tools/productDataRetrievalTool.js`](../tools/productDataRetrievalTool.js),
which fetches read-only data via
[`integrations/adapters/shopifyClient.js`](../integrations/adapters/shopifyClient.js)'s
`getProducts()` and reshapes it into the plain entry shape `discoverProducts()`
already expects - see that file and [`tools/README.md`](../tools/README.md).

## Product Opportunity scoring engine

[`agent/core/productOpportunityScoringEngine.js`](../agent/core/productOpportunityScoringEngine.js)
is a standalone deliverable, distinct from `productAgent.js`'s own narrower
`opportunity_scoring` field (a 4-dimension coverage count left untouched by this
module). It evaluates 8 dimensions of one product opportunity - demand, competition,
market fit, pricing, margin inputs, trend, risk, differentiation - and reports how
much real, evidenced input exists for each, without ever inventing a missing value.

5 dimensions map directly onto
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js)'s
existing dimensions (`market fit` -> `market_relevance`, `risk` -> `risks`; `demand`,
`competition`, `differentiation` match by name) - the engine builds a real, validated
instance of that model. `pricing` and `margin inputs` read
[`agent/core/productModel.js`](../agent/core/productModel.js)'s existing
`pricing.price`/`pricing.cost` fields directly (margin inputs needs both before a
margin could ever be computed - no margin figure is ever computed here, same
"inputs only" precedent as `productAgent.js`'s `profitability_inputs`). `trend` has no
dedicated schema, so it reuses the generic
[`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js) shape via
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js)'s
`retrieveResearchData('generic', ...)`.

The result shape is
[`agent/core/productOpportunityScoreModel.js`](../agent/core/productOpportunityScoreModel.js):
`dimension_status` (one `empty`/`partial`/`success` per dimension, mirroring
[`agent/core/competitorIntelligenceModel.js`](../agent/core/competitorIntelligenceModel.js)'s
`data_availability` convention), `missing_inputs` (one `{dimension, reason}` entry per
dimension not at `success` - "identify the missing input", literally), and
`coverage_score` (a mechanical evidence-coverage count/percentage across the 8
dimensions, all weighted equally). None of these are a business-quality verdict about
whether the opportunity is good - only a structural, non-fabricated audit of how much
real input exists.

## Product recommendation layer

[`agent/core/productRecommendationEngine.js`](../agent/core/productRecommendationEngine.js)
is the final layer of the Product pipeline: discovery/validation
(`productAgent.js`) -> 8-dimension evidence scoring
(`productOpportunityScoringEngine.js`) -> this recommendation layer. Its only
substantive input is an already-computed, already-validated
[`agent/core/productOpportunityScoreModel.js`](../agent/core/productOpportunityScoreModel.js)
record - zero evidence-building logic is duplicated here.

The result shape,
[`agent/core/productRecommendationModel.js`](../agent/core/productRecommendationModel.js),
carries the 7 required parts of a recommendation: `opportunity` (composed from the
underlying product record), `reasoning` (composed only from real, caller-supplied
assessment text plus each dimension's already-computed structural status - never a
fabricated insight), `evidence` and `missing_information` (direct copies of the score
record's own `source`/`missing_inputs`), `risks` (the real `risks` dimension object,
taken as-is), `confidence` (mechanically mapped from the score record's
`coverage_score` percentage onto
[`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js)'s existing
`CONFIDENCE_LEVELS` enum - never a business judgment), and `recommended_next_step`
(caller-suppliable; when omitted, a deterministic default names the exact missing
dimensions to gather evidence for, or - once all 8 are evidence-backed - states that
the opportunity should be routed to a human for a go/no-go decision).

This module makes no external calls of any kind - no `integrations/`/`tools/`
dependency, nothing I/O-capable - and it never purchases, publishes, or imports a
product. Its exported surface is exactly one function
(`buildProductRecommendation`), verified by a test. If it is ever wired into
[`tools/toolRegistry.js`](../tools/toolRegistry.js), the natural classification per
[`approvals/approvalArchitecture.js`](../approvals/README.md) is `recommendation` -
producing the suggestion needs no approval, only acting on it does - never
`externally_executable`. That wiring is not implemented here.
