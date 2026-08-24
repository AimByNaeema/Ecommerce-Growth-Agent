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
produces. It supports 6 research types (market, global market, competitor, trend,
customer/market intelligence, opportunity discovery) and returns one common structured
result shape, [`agent/core/researchAgentResultModel.js`](../agent/core/researchAgentResultModel.js):
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
