# listing/

Listing content the agent generates for the store - the Listing specialist's home
folder (CLAUDE.md section 2, specialist #4: "Product listing content and
optimization").

## Listing Agent

[`agent/core/listingAgent.js`](../agent/core/listingAgent.js) is the Listing Agent -
deterministic and evidence-only, the same philosophy and structure as
[`agent/core/researchAgent.js`](../agent/core/researchAgent.js),
[`agent/core/productAgent.js`](../agent/core/productAgent.js), and
[`agent/core/seoAgent.js`](../agent/core/seoAgent.js): no AI API call, no external
fetch, no live product-content API. Callers supply already-structured evidence; the
agent validates it, composes it into two new schemas, and grades it honestly - never
synthesizing or guessing a title, a benefit, a feature, an attribute, a variant, or a
formatted field.

It supports 2 capabilities, returning one common structured result shape,
[`agent/core/listingAgentResultModel.js`](../agent/core/listingAgentResultModel.js)
(mirroring [`agent/core/seoAgentResultModel.js`](../agent/core/seoAgentResultModel.js)
field-for-field): capability, topic, market, findings, evidence, source, confidence,
limitations, recommendations, verification status, research date, and the underlying
specialized record(s) it was composed from.

- **Listing content** composes one
  [`agent/core/listingContentModel.js`](../agent/core/listingContentModel.js) record -
  a product's title, description, benefits, features, selling points, FAQs,
  attributes, variants, and a CTA, all in one record. This is a **dedicated schema**,
  not a further widening of
  [`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)
  (SEO's file). That file's `product_title`/`description` fields exist specifically
  for SEO's `product_seo` capability (keyword-driven suggestions); this file's fields
  exist for Listing's own concern (copywriting/content authoring, not search-
  visibility optimization). Both specialists may propose a title/description for the
  same real-world listing, cross-referenced by the same `product_reference`
  convention - that is not duplication, it is two specialists assessing the same
  artifact from different angles, the same pattern
  [`agent/core/productAgent.js`](../agent/core/productAgent.js) already uses for its
  demand/competition/market_fit/product_risk dimensions.

  **Structured ecommerce listing generation**: `generateListingContent()` optionally
  accepts 5 structured composition sources instead of (or alongside) flat fields -
  `productInfo` (an [`agent/core/productModel.js`](../agent/core/productModel.js)-
  shaped record), `targetMarket` (string), `customerSegment` (an
  [`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js)-
  shaped record), `seoRecommendations` (an
  [`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)-
  shaped record, e.g. SEO's `product_seo` output), and `brandInfo` (the same
  `{name, tagline, tone}` shape `configuration/business.yaml`'s own `brand:` block
  already uses). Title, description, and CTA are resolved through a fixed, honest
  precedence order (`resolveListingSources()`): an explicit field always wins; title/
  description fall back to `seoRecommendations`, description further falls back to
  `productInfo.description`, and CTA falls back to `brandInfo.tagline`. Every step only
  ever *relays* text some other specialist or the caller already produced - nothing is
  independently written. `customerSegment` is never used to derive title/description/
  CTA text; its needs/motivations are surfaced as findings only, since a segment's
  needs are evidence, not listing copy. Any of the 5 sources that's missing, and any
  output field that still ends up empty after applying precedence, is named explicitly
  in the result's `limitations` - this schema's existing "honest gaps" convention,
  reused rather than adding a parallel "missing information" field.
- **Marketplace format** composes one
  [`agent/core/marketplaceListingFormatModel.js`](../agent/core/marketplaceListingFormatModel.js)
  record - a deterministic, constraint-driven reformatting of an already-built listing
  content record for one marketplace channel (truncation/mapping only, never new
  content). `marketplace` is a free-form string, not a hardcoded enum, so a new
  marketplace never requires a code change (CLAUDE.md rule 14). With no constraints
  supplied, content is carried through unchanged, noted honestly as a limitation
  rather than silently reformatted.

"Do not invent product specifications": every field in both schemas is either a
copy/structure suggestion built only from what the caller explicitly supplies, or a
direct structural echo of caller-supplied facts (features, attributes, variants). There
is no AI/API call anywhere in this module and no code path that could synthesize a
feature, attribute, or variant that wasn't supplied. Every standing result carries a
limitation stating this, plus that applying a suggestion to a real listing or
publishing a formatted listing to a real marketplace channel requires a separate,
human-approved action (see [`approvals/`](../approvals/README.md)) - nothing here is
automatically published.

Internally, `listingAgent.js` follows the same retrieval/analysis/recommendation
separation as `researchAgent.js`, and reuses it directly rather than reimplementing:
`retrieveListingData` delegates generic-kind entries to `researchAgent.js`'s
`retrieveResearchData` for optional supporting evidence, and recommendations pass
through `researchAgent.js`'s `deriveRecommendations` unchanged.

## Listing Quality Checker

[`agent/core/listingQualityChecker.js`](../agent/core/listingQualityChecker.js)
evaluates an already-composed listing content record (an
[`agent/core/listingContentModel.js`](../agent/core/listingContentModel.js) record,
e.g. the output of `generateListingContent()`) across 8 dimensions - completeness,
clarity, accuracy, conversion quality, SEO compatibility, customer objections, missing
information, unsupported claims - returning a mechanical checklist-coverage score plus
actionable recommendations, defined in
[`agent/core/listingQualityCheckModel.js`](../agent/core/listingQualityCheckModel.js).
It mirrors [`agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js)'s
structure and honesty rules exactly (see that section above for the full "empty vs.
partial vs. success" semantics and the `deriveNonEmptyCheckStatus` rule).

Every finding is a concrete, verifiable fact about the actual supplied text (a
character count, a substring match, an occurrence count, a field being empty) - never a
subjective opinion about writing quality, tone, persuasiveness, or an actual
conversion/ranking/sales prediction. `completeness` checks only the essential go-live
fields (title, description, benefits, features, CTA); `missing_information` is a
separate, more exhaustive audit across every field including optional ones (selling
points, FAQs, attributes, variants) - the two are deliberately distinct, not aliases of
each other. `accuracy` and `unsupported_claims` both rely on caller-supplied
`factualAttributes` (the same flat-string-array pattern `seoQualityChecker.js` already
uses) - `accuracy` checks that each known fact is mentioned somewhere in the listing
text, while `unsupported_claims` flags absolute/superlative phrases (e.g. "best",
"guaranteed", "#1") found in the text that are *not* backed by any supplied factual
attribute; neither ever judges truthfulness, since this module has no independent
source of truth. `seo_compatibility` and `customer_objections` are both optional,
evidence-driven coverage checks (target keywords and known customer objections,
respectively) - both honestly `'empty'`, not a failure, when nothing was supplied to
check against.

`quality_score` is a mechanical checklist-coverage percentage (how many of the 8
dimensions' structural checks passed) - distinct from
[`agent/core/productOpportunityScoreModel.js`](../agent/core/productOpportunityScoreModel.js)'s
own `coverage_score`, which measures evidence *availability*, not check *pass/fail*.

Standalone deliverable, not yet wired into `tools/toolRegistry.js` or the
Chief/Orchestrator - the same deliberate scope choice
[`agent/core/seoQualityChecker.js`](../agent/core/seoQualityChecker.js) and
[`agent/core/productOpportunityScoringEngine.js`](../agent/core/productOpportunityScoringEngine.js)
already made (directly callable, evaluating existing structured output, not part of
the 7-capability dispatcher).

The `listing_content_generation` tool id (`tools/toolRegistry.js`) is wired to this
agent - [`tools/listingContentTool.js`](../tools/listingContentTool.js) wraps both
capabilities, dispatching on a `listingCapability` parameter. It returns
`{ status, result, error }` with `status` one of `success`, `empty`, `partial`, or
`failed` - never fabricating a result when structured input is missing or incomplete.
The Listing specialist is fully wired into the Chief/Orchestrator
(`agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`), so a routed
objective can reach it end-to-end via `runOrchestratorContract()`.
