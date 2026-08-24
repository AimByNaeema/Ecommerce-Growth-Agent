# social-advertising/

Social media content ideas and paid advertising strategy the agent produces for the
store, across 5 social platforms (Instagram, Facebook, TikTok, Pinterest, YouTube) and
3 advertising platforms (Meta Ads, Google Ads, TikTok Ads).

The shape of one social media content record (platform, content reference, content
type, objective, target audience, caption, hashtags, posting schedule, evidence,
expected outcome, verification status) is defined in
[`agent/core/socialContentModel.js`](../agent/core/socialContentModel.js). The shape of
one paid ad campaign record (platform, campaign reference, objective, audience, budget,
ad creative, bidding strategy, CTA, KPI, measurement plan, evidence, verification
status) is defined in [`agent/core/adCampaignModel.js`](../agent/core/adCampaignModel.js).
The shape of one cross-platform social media strategy record (strategy reference,
objective, audience, content pillars, platform selection, posting strategy, content
themes, campaign themes, KPIs, evidence, verification status) is defined in
[`agent/core/socialMediaStrategyModel.js`](../agent/core/socialMediaStrategyModel.js).
The shape of one platform-aware content generation record (platform, content
reference, objective, target audience, hooks, captions, CTAs, content ideas,
short-form video concepts, carousel concepts, creative briefs, platform adaptation
notes, evidence, verification status) is defined in
[`agent/core/platformContentModel.js`](../agent/core/platformContentModel.js).
The shape of one social content calendar entry (entry reference, date, platform,
content type, topic, hook, CTA, campaign, product, KPI, evidence, verification status)
is defined in
[`agent/core/contentCalendarModel.js`](../agent/core/contentCalendarModel.js).
No external social or advertising action (posting, scheduling, boosting, launching a
campaign, spending budget, publishing content) is ever executed here.

## Social & Advertising Agent

[`agent/core/socialAdvertisingAgent.js`](../agent/core/socialAdvertisingAgent.js) is the
Social & Advertising Agent (CLAUDE.md section 2, specialist #6) — deterministic and
evidence-only, the same philosophy and structure as
[`agent/core/marketingAgent.js`](../agent/core/marketingAgent.js),
[`agent/core/seoAgent.js`](../agent/core/seoAgent.js), and
[`agent/core/listingAgent.js`](../agent/core/listingAgent.js): no AI API call, no
external fetch, no live social-media or paid-advertising platform API. Callers supply
already-structured evidence; the agent validates it, composes it into existing schemas,
and grades it honestly — never synthesizing or guessing a caption, a targeting claim,
or a performance figure. It supports 11 capabilities, returning one common structured
result shape,
[`agent/core/socialAdvertisingAgentResultModel.js`](../agent/core/socialAdvertisingAgentResultModel.js):
capability, topic, market, findings, evidence, source, confidence, limitations,
recommendations, verification status, research date, and the underlying specialized
record(s) it was composed from.

Capability → schema mapping (**zero new schema surface beyond the 5 dedicated
records below** — every capability reuses one of them as-is):

- **Instagram**, **Facebook**, **TikTok**, **Pinterest**, and **YouTube** all compose
  one [`agent/core/socialContentModel.js`](../agent/core/socialContentModel.js) record
  — the same schema, differing only in which `platform` value is pinned, the same
  "one schema, a field distinguishes" approach
  [`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js)
  uses across Marketing's marketing_strategy/offers/promotions/email_strategy
  capabilities. Each of the 5 pins `platform` — always, not just a default — mirroring
  how Marketing's `email_strategy` pins `marketing_channel`.
- **Meta Ads**, **Google Ads**, and **TikTok Ads** all compose one
  [`agent/core/adCampaignModel.js`](../agent/core/adCampaignModel.js) record instead —
  a paid campaign needs fields organic content doesn't (`budget`, `bidding_strategy`),
  so it gets its own dedicated schema rather than widening
  `socialContentModel.js`, the same dedicated-schema-when-the-field-set-genuinely-differs
  precedent [`agent/core/campaignPlanModel.js`](../agent/core/campaignPlanModel.js)
  already established relative to `marketingAnalysisModel.js`. No campaign is ever
  launched automatically — `adCampaignModel.js` has no execute/launch/spend function of
  any kind; acting on a plan is a separate, human-approved action via
  [`approvals/`](../approvals/README.md).
- **Social media strategy** composes its own dedicated
  [`agent/core/socialMediaStrategyModel.js`](../agent/core/socialMediaStrategyModel.js)
  record — strategy reference, objective, audience, content pillars, platform
  selection, posting strategy, content themes, campaign themes, and KPIs — instead of
  either of the two records above. A cross-platform strategy needs fields neither
  organic content nor a single ad campaign needs, so it gets its own dedicated schema,
  the same dedicated-schema precedent `campaignPlanModel.js` established for Marketing's
  `campaign_planning` capability relative to `marketingAnalysisModel.js`. Its
  `platform_selection` field reuses the same `SOCIAL_PLATFORMS`/`AD_PLATFORMS` enums the
  two other schemas already define — no new platform list, and no platform beyond the 8
  already in scope. No strategy is ever executed automatically — acting on it is a
  separate, human-approved action via [`approvals/`](../approvals/README.md).
- **Content generation** composes its own dedicated
  [`agent/core/platformContentModel.js`](../agent/core/platformContentModel.js) record
  — hooks, captions, CTAs, content ideas, short-form video concepts, carousel
  concepts, and creative briefs, all tagged to one selected `platform` plus a
  `platform_adaptation_notes` field explaining how/why the content fits it. 7 distinct
  creative-element dimensions that `socialContentModel.js`'s single `caption` field was
  never meant to carry, so it gets its own dedicated schema too. `platform` reuses
  `socialContentModel.js`'s existing `SOCIAL_PLATFORMS` enum — this capability serves
  any of the 5 in-scope social platforms via one caller-supplied field, the same
  caller-supplied-platform approach `social_media_strategy` uses for its own
  `platform_selection`. This module never synthesizes or rewrites a hook, caption, or
  concept to "fit" a platform on its own — every creative element is caller-supplied;
  the platform tag and adaptation notes only make the intended fit explicit and
  auditable. No content is ever published automatically — acting on it is a separate,
  human-approved action via [`approvals/`](../approvals/README.md).
- **Content calendar** composes its own dedicated
  [`agent/core/contentCalendarModel.js`](../agent/core/contentCalendarModel.js) record
  — a plan-level entry (date, platform, content type, topic, hook, CTA, campaign,
  product, KPI) distinct from every record above: it plans one dated slot rather than
  carrying a single piece's full creative detail or a cross-platform strategy. **The
  Marketing Agent can provide this entry's campaign context**: when the caller supplies
  a `campaignContext` object, `analyzeContentCalendar()` validates and builds it into a
  real [`agent/core/campaignPlanModel.js`](../agent/core/campaignPlanModel.js) record by
  calling [`agent/core/marketingAgent.js`](../agent/core/marketingAgent.js)'s own
  `retrieveMarketingData('campaign_plan', ...)` directly — reused, never reimplemented,
  the same cross-agent reuse precedent `marketingAgent.js`'s own
  `analyzeAudienceSegmentation` established (delegating to
  [`agent/core/researchAgent.js`](../agent/core/researchAgent.js)). The entry's own
  `campaign` field defaults to that record's `campaign_reference` when the caller didn't
  set one explicitly, and the campaign plan record travels alongside the calendar entry
  in `specialized_records` — the provided context stays visible and auditable, never
  silently absorbed. No entry is ever posted or scheduled automatically — acting on it
  is a separate, human-approved action via [`approvals/`](../approvals/README.md).

`socialContentModel.js`, `adCampaignModel.js`, `socialMediaStrategyModel.js`,
`platformContentModel.js`, and `contentCalendarModel.js` all carry their own `evidence`
array field (like Marketing's schemas, unlike SEO's/Listing's) — so evidence is
assigned directly from caller-supplied input inside each record builder, with no
separate evidence-composition step layered on top.

The `platform`/`platform_selection` fields are narrow, validated enums (`instagram |
facebook | tiktok | pinterest | youtube` for social content, content generation, and
the content calendar; `meta_ads | google_ads | tiktok_ads` for ad campaigns; the union
of both 8 for strategy's platform selection) — no platform beyond these 8 is a valid
capability today, matching the explicit scope of this build (no unnecessary platform
integrations added).

Five tool ids (`tools/toolRegistry.js`) are wired to this agent, mirroring the task's
own social/advertising split and SEO's precedent of multiple tool ids sharing 1
category — [`tools/socialContentTool.js`](../tools/socialContentTool.js) wraps the 5
social capabilities, dispatching on a `socialPlatform` parameter;
[`tools/paidAdvertisingTool.js`](../tools/paidAdvertisingTool.js) wraps the 3
advertising capabilities, dispatching on an `adPlatform` parameter;
[`tools/socialMediaStrategyTool.js`](../tools/socialMediaStrategyTool.js),
[`tools/platformContentTool.js`](../tools/platformContentTool.js), and
[`tools/contentCalendarTool.js`](../tools/contentCalendarTool.js) each wrap a single
capability (no platform-dispatch key needed — `platform` is a required field on the
record itself for the latter two, and `contentCalendarTool.js` passes an optional
`campaignContext` straight through). All five return `{ status, result, error }` with
`status` one of `success`, `empty`, `partial`, or `failed` — never fabricating a result
when structured input is missing or incomplete. The Social & Advertising specialist is
fully wired into the Chief/Orchestrator
(`agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`), so a routed
objective can reach it end-to-end via `runOrchestratorContract()`.

No integrations adapter exists for any social or advertising platform (no
Instagram/Facebook/TikTok/Pinterest/YouTube/Meta/Google/TikTok Ads client) — matching
every other specialist's no-external-fetch philosophy and this build's explicit scope.
