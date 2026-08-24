# research/

Market, competitor, and trend research the agent gathers or produces to inform growth
recommendations. The shape one research record must conform to (topic, market, date,
source/evidence, finding, confidence, relevance, summary, verification status) is
defined in [`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js).

The point of that structure is to avoid repeating valid research unnecessarily: a
record carries enough (topic, market, date, verification_status) to judge later whether
existing research already answers a question. No lookup/search/duplicate-detection
logic exists yet — that's a research engine, not built here.

For market-level research specifically, [`agent/core/marketResearchModel.js`](../agent/core/marketResearchModel.js)
defines a more specific shape (country, market, category, customer segment, demand
signals, competitors, trends, opportunities, risks, evidence, research date). Country
and market are never hardcoded — real values come only from
[`configuration/business.yaml`](../configuration/README.md) or explicit task
requirements.

For competitor research specifically, [`agent/core/competitorResearchModel.js`](../agent/core/competitorResearchModel.js)
defines a more specific shape (competitor, market, product/category, positioning,
pricing evidence, strengths, weaknesses, marketing signals, SEO signals, opportunities,
source, research date). No competitor data is invented — real values come only from
cited source evidence.

Real research records saved here belong to whichever business they were gathered for —
never committed, never hardcoded into agent logic (git-ignored, mirroring
`data/business/`). Reusable agent logic (`agent/core/`, `tools/`, `workflows/`,
`prompts/`) must never read this folder directly or hardcode its contents.

## Research Agent

[`agent/core/researchAgent.js`](../agent/core/researchAgent.js) is the Research Agent
(CLAUDE.md section 2, specialist #1) — the first specialist with real, callable logic
rather than a conceptual stage list. It lives in `agent/core/` alongside the schemas it
composes, not here: this folder is reserved entirely for a business's own gathered
research data (git-ignored, see above), never for reusable agent code — this section
exists purely so the Research Agent is documented next to the research shapes it
produces. It supports 7 research types (market, global market, competitor, trend,
customer/market intelligence, opportunity discovery, customer segmentation) and
returns one common structured result shape,
[`agent/core/researchAgentResultModel.js`](../agent/core/researchAgentResultModel.js):
research type, topic, market, findings, evidence, source, confidence, limitations,
recommendations, verification status, research date, and the underlying specialized
record(s) it was composed from.

Deterministic only — it never calls an external research source or Claude, and never
synthesizes or guesses a finding. Callers supply already-structured evidence (facts +
sources); the agent validates it against the existing per-type schemas and composes it
into the common result honestly: confidence and verification status are only ever what
the caller explicitly asserted (never upgraded or inferred), and a `'verified'` claim
with no supporting evidence is downgraded back to `'unverified'`. Where no evidence is
supplied, the result says so in `limitations` instead of inventing anything.

Market, global market, and competitor research reuse
[`marketResearchModel.js`](../agent/core/marketResearchModel.js) and
[`competitorResearchModel.js`](../agent/core/competitorResearchModel.js) as-is (global
market research produces one market record per market). Customer/market intelligence
reuses [`customerSegmentResearchModel.js`](../customer-market-intelligence/README.md).
Trend research and opportunity discovery both reuse the generic
[`researchRecordModel.js`](../agent/core/researchRecordModel.js) shape, one record per
trend/signal — none of these schemas are duplicated, only composed into the common
envelope.

### Structured ecommerce customer segmentation

`deriveCustomerSegmentation` (the `customer_segmentation` research type) is the one
capability in `researchAgent.js` that genuinely *derives* rather than just relays: a
deterministic, threshold-based classifier that segments a customer/cohort from
structured business data - purchase behavior, product interest, order frequency,
customer value, and engagement - into a segment definition, needs, an opportunity, and
a recommended strategy. Every threshold (e.g. what counts as a "frequent" buyer or an
"at-risk" customer) is an explicit, documented constant, never AI/ML-inferred, and
every derived label/need/opportunity/recommendation traces back to exactly which
threshold fired - the same mechanical, verifiable philosophy
[`agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js) and
[`agent/core/listingQualityChecker.js`](../agent/core/listingQualityChecker.js) already
use for dimension checks, applied here to classification instead of validation.

**No personal attribute is ever used or inferred** - this is a structural guarantee,
not just a stated one: the classifier has no input field for age, gender, location,
health, or any other personal attribute, so none can reach the output even by
accident. Only transactional/behavioral business data is accepted.

Reuses [`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js)
as-is for the segment/evidence/needs fields; "opportunity" and "recommended strategy"
surface through the same envelope every other research type already has
(`findings`/`recommendations`) - no new schema field was needed for either.

Wired into the same `customer_research` tool as `customer_market_intelligence` above,
via `researchParams.customerResearchMode` (`'segment_research'`, the default, or
`'customer_segmentation'`) - one tool id, two capabilities, the same
multi-capability-per-tool pattern `tools/seoAnalysisTool.js` already uses.

### Structured competitor intelligence

[`agent/core/competitorIntelligenceAgent.js`](../agent/core/competitorIntelligenceAgent.js)
is a deeper, evidence-audited elaboration of the `competitor_research` type above -
same competitor identity, richer per-area structure. For one competitor, it analyzes
where real data actually exists across 8 areas (products, positioning, pricing,
offers, listings, SEO signals, social presence, advertising signals) and separates the
result into `observed_facts`, `analysis`, and `recommendations` - never one flat
findings list. `analysis` is a structural, non-fabricated availability audit
(`empty`/`partial`/`success` per area, derived only from whether evidence exists), not
an invented competitive insight. The result shape is
[`agent/core/competitorIntelligenceModel.js`](../agent/core/competitorIntelligenceModel.js).
It reuses [`agent/core/competitorResearchModel.js`](../agent/core/competitorResearchModel.js)
(via `researchAgent.js`'s `retrieveResearchData('competitor', ...)`) for
positioning/pricing/SEO signals, and the generic
[`researchRecordModel.js`](../agent/core/researchRecordModel.js) shape (one record per
item) for the other 5 areas - neither schema is modified.

Opportunity discovery here is deliberately distinct from Product's territory: it
produces market/customer/competitor-evidence-based *signals*, not an evaluation of one
specific product candidate. Evaluating a specific candidate across 8 dimensions remains
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js),
fed by [`products/productResearchArchitecture.js`](../products/productResearchArchitecture.js)
— untouched by this module.

Internally, `researchAgent.js` separates three concerns as distinct, independently
testable functions rather than one monolithic composition: **retrieval**
(`retrieveResearchData` — turns caller-supplied entries into validated specialized
records; the only "external source" in this architecture is the caller's own
structured input), **analysis** (`analyzeResearchData` — flattens findings/evidence/
source and grades limitations honestly), and **recommendation**
(`deriveRecommendations` — relays only what the caller explicitly supplied, never
invents one). `composeResult` is a thin assembler over the three.

Three of the six research types are connected to the Chief/Orchestrator's tool system:
[`tools/marketResearchTool.js`](../tools/marketResearchTool.js),
[`tools/competitorResearchTool.js`](../tools/competitorResearchTool.js), and
[`tools/customerResearchTool.js`](../tools/customerResearchTool.js) wrap
`runMarketResearch`, `runCompetitorResearch`, and `runCustomerMarketIntelligence`
respectively, matching `tools/toolRegistry.js`'s existing `market_research`,
`competitor_research`, and `customer_research` tool ids (now `implemented`). Each tool
returns `{ status, result, error }` with `status` one of `success`, `empty`, `partial`,
or `failed` — never fabricating a result when structured input is missing or
incomplete. Global market research, trend research, and opportunity discovery are not
yet wired to the tool registry — they remain callable only by calling `runResearch()`
directly, since `tools/toolRegistry.js` doesn't scaffold separate tool ids for them
yet.
