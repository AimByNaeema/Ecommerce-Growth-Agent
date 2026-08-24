# seo/

SEO-related analysis, recommendations, and assets the agent generates for the store.

The shape of one SEO keyword research record (keyword, search intent, market,
language, relevance, competition, opportunity, source, research date, confidence) is
defined in [`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js).
No keyword lookup or live keyword API is called or configured today — every record
below is composed from caller-supplied, structured evidence only.

## SEO Agent

[`agent/core/seoAgent.js`](../agent/core/seoAgent.js) is the SEO Agent (CLAUDE.md
section 2, specialist #3) — deterministic and evidence-only, the same philosophy and
structure as [`agent/core/researchAgent.js`](../agent/core/researchAgent.js) and
[`agent/core/productAgent.js`](../agent/core/productAgent.js): no AI API call, no
external fetch, no live keyword-research API. Callers supply already-structured
evidence; the agent validates it, composes it into existing schemas, and grades it
honestly — never synthesizing or guessing a keyword, a finding, or an assessment. It
supports 7 capabilities, returning one common structured result shape,
[`agent/core/seoAgentResultModel.js`](../agent/core/seoAgentResultModel.js): capability,
topic, market, findings, evidence, source, confidence, limitations, recommendations,
verification status, research date, and the underlying specialized record(s) it was
composed from.

Capability → schema mapping (maximizing reuse over new schema surface):

- **Keyword research** and **SEO opportunity analysis** compose one
  [`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js) record per
  keyword, reused as-is. SEO opportunity analysis summarizes each keyword's existing
  `opportunity`/`competition` fields as a structural evidence-coverage count
  (`empty`/`partial`/`success`) — never a score or verdict about whether an opportunity
  is good. That 8-dimension scoring pattern is deliberately Product's territory (see
  [`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js)),
  untouched here.
- **Search intent analysis** groups already-built keyword records by their existing
  `search_intent` field — not a new schema, mirroring
  [`workflows/keywordResearchWorkflow.js`](../workflows/keywordResearchWorkflow.js)'s
  `group_keywords_by_intent` stage.
- **Product SEO** composes one
  [`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)
  record — structured recommendations for **title**, **meta description**,
  **headings**, **description**, **keyword usage**, **internal links**, and
  **supporting content**. Every field is a suggestion built only from what the caller
  supplies: no factual product claim (price, material, dimensions, etc.) is ever
  generated or altered, and nothing is automatically published (see
  [`approvals/`](../approvals/README.md)) — both stated in code as a standing
  `limitations` entry on every product/collection/content SEO result, not just in
  comments.
- **Collection SEO** and **content SEO** compose one
  [`agent/core/onPageOptimizationModel.js`](../agent/core/onPageOptimizationModel.js)
  record (`subject_type: 'collection' | 'content'`) — the one new schema this agent
  needed, since nothing else in the project modeled a collection or content-page
  optimization suggestion. It deliberately mirrors `listingOptimizationModel.js`'s
  original, narrower field set (title, description, keywords, search intent,
  structure, metadata, optimization opportunities, conversion considerations) rather
  than product SEO's later-added headings/keyword usage/internal links/supporting
  content — "ecommerce product SEO optimization" was product-scoped, so collection/
  content SEO were left as they were rather than widened to match.
- **On-page SEO** is not a fourth record type — it dispatches to product/collection/
  content SEO by `subjectType` and returns that same result, tagged
  `capability: 'on_page_seo'`. Composition, not duplication.

Every product/collection/content SEO suggestion stays a proposal: nothing here reads or
writes real listing/collection/content data, and applying a suggestion to a real store
still requires a separate, human-approved action (see [`approvals/`](../approvals/README.md)).

Internally, `seoAgent.js` follows the same retrieval/analysis/recommendation separation
as `researchAgent.js`, and reuses it directly rather than reimplementing: `retrieveSeoData`
delegates generic-kind entries to `researchAgent.js`'s `retrieveResearchData`, product/
collection/content SEO's optional supporting evidence composes via the same function
(the pattern `agent/core/productAgent.js` already established), and recommendations pass
through `researchAgent.js`'s `deriveRecommendations` unchanged.

Both `keyword_research` and `seo_analysis` tool ids (`tools/toolRegistry.js`) are wired
to this agent — [`tools/keywordResearchTool.js`](../tools/keywordResearchTool.js) wraps
keyword research and search intent analysis; [`tools/seoAnalysisTool.js`](../tools/seoAnalysisTool.js)
wraps product/collection/content/on-page SEO and SEO opportunity analysis, dispatching
on a `seoCapability` parameter. Both return `{ status, result, error }` with `status`
one of `success`, `empty`, `partial`, or `failed` — never fabricating a result when
structured input is missing or incomplete. The SEO specialist is fully wired into the
Chief/Orchestrator (`agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`),
so a routed objective can reach it end-to-end via `runOrchestratorContract()`.

## SEO Quality Checker

[`agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js) evaluates an
already-composed product SEO suggestion (a
[`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)
record, e.g. the output of `analyzeProductSeo()`) across 9 dimensions — keyword
targeting, search intent, title, metadata, content quality, product accuracy, missing
information, over-optimization, and internal linking opportunities — returning a
mechanical checklist-coverage score plus actionable recommendations, defined in
[`agent/core/seoQualityCheckModel.js`](../agent/core/seoQualityCheckModel.js).

Every finding is a concrete, verifiable fact about the actual supplied text (a
character count, a substring match, an occurrence count, a field being empty) — never
a subjective opinion about writing quality, tone, persuasiveness, or an actual
ranking/performance prediction. Where a dimension has nothing to check (e.g. no target
keywords or factual attributes were supplied), that is reported honestly as `'empty'`
with a finding explaining why, not silently skipped or guessed; once real content
exists, a failed check downgrades the dimension to `'partial'`, never back to
`'empty'` — that status is reserved strictly for "nothing here to check."

`quality_score` is a mechanical checklist-coverage percentage (how many of the 9
dimensions' structural checks passed) — deliberately distinct from
[`agent/core/productOpportunityScoreModel.js`](../agent/core/productOpportunityScoreModel.js)'s
own `coverage_score`, which measures evidence *availability*, not check *pass/fail*.

Standalone deliverable, not yet wired into `tools/toolRegistry.js` or the
Chief/Orchestrator — the same deliberate scope choice
[`agent/core/productOpportunityScoringEngine.js`](../agent/core/productOpportunityScoringEngine.js)
already made (directly callable, evaluating existing structured output, not part of
the 7-capability dispatcher).
