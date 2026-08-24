# marketing/

Campaign ideas, copy, and marketing strategy the agent produces for the store.

The shape of one marketing analysis record (marketing channel, target segment,
product, campaign, objective, message, offer, timing, evidence, expected outcome,
verification status) is defined in
[`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js).
No external marketing action (sending, scheduling, publishing) is ever executed here.

## Marketing Agent

[`agent/core/marketingAgent.js`](../agent/core/marketingAgent.js) is the Marketing
Agent (CLAUDE.md section 2, specialist #5) — deterministic and evidence-only, the same
philosophy and structure as
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js),
[`agent/core/seoAgent.js`](../agent/core/seoAgent.js), and
[`agent/core/listingAgent.js`](../agent/core/listingAgent.js): no AI API call, no
external fetch, no live marketing-platform API. Callers supply already-structured
evidence; the agent validates it, composes it into existing schemas, and grades it
honestly — never synthesizing or guessing a message, an offer, or an assessment. It
supports 8 capabilities, returning one common structured result shape,
[`agent/core/marketingAgentResultModel.js`](../agent/core/marketingAgentResultModel.js):
capability, topic, market, findings, evidence, source, confidence, limitations,
recommendations, verification status, research date, and the underlying specialized
record(s) it was composed from.

Capability → schema mapping (**zero new schema surface** — every capability reuses an
existing model as-is):

- **Marketing strategy**, **offers**, **promotions**, **campaign planning**, and
  **email strategy** all compose one
  [`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js)
  record — the same schema, differing only in which fields the capability's topic/
  label emphasizes, the same way SEO's product/collection/content SEO share one
  composition helper over 3 record builders. **Email strategy** pins
  `marketing_channel` to `'email'` — always, not just a default — mirroring how SEO's
  collection/content SEO pin `subject_type`.
- **Audience segmentation** reuses
  [`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js)
  records directly — not rebuilt here at all. It delegates straight to
  [`agent/core/researchAgent.js`](../agent/core/researchAgent.js)'s own
  `retrieveResearchData('customer_segment', ...)` and
  `analyzeResearchData('customer_segment')` (both already fully validated/tested
  there), extending the cross-agent reuse pattern SEO/Listing already established for
  `retrieveResearchData('generic', ...)`.
- **Retention** and **conversion opportunities** both compose
  [`agent/core/growthOpportunityModel.js`](../agent/core/growthOpportunityModel.js)
  records (already scoped for exactly this: upselling, cross-selling, retention,
  repeat purchases, customer re-engagement). Retention pins `opportunity_type` to
  `'retention'` over one record; conversion opportunities accepts an array of entries
  across any of the other opportunity types (mirroring `keyword_research`'s
  multi-entry shape) — retention is a convenience/pinned single-type variant, not
  mutually exclusive with conversion opportunities.

`marketingAnalysisModel.js` and `growthOpportunityModel.js` both already carry their
own `evidence` array field (unlike `listingOptimizationModel.js`'s fields) — so,
exactly like `researchAgent.js`'s own `buildMarketRecord`, evidence is assigned
directly from caller-supplied input inside each record builder, with no separate
evidence-composition step layered on top (that extra step exists in `seoAgent.js`/
`listingAgent.js` specifically because their schemas lack an evidence field of their
own).

The `marketing_analysis` tool id (`tools/toolRegistry.js`) is wired to this agent —
[`tools/marketingAnalysisTool.js`](../tools/marketingAnalysisTool.js) wraps all 8
capabilities, dispatching on a `marketingCapability` parameter. It returns
`{ status, result, error }` with `status` one of `success`, `empty`, `partial`, or
`failed` — never fabricating a result when structured input is missing or incomplete.
The Marketing specialist is fully wired into the Chief/Orchestrator
(`agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`), so a routed
objective can reach it end-to-end via `runOrchestratorContract()`.
