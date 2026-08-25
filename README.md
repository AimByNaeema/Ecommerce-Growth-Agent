# Smart E-Commerce Growth AI Agent

## Purpose

A single AI agent that helps grow an e-commerce business — analytics, SEO, marketing,
product, and customer/market intelligence, all in one place.

This project is a **foundation for a reusable e-commerce AI agent**. The first
deployment will be **tested on the owner's own business**. The architecture must later
**support other businesses without rewriting the core agent**.

## One-agent architecture

There is exactly ONE agent — one identity, one system prompt (`prompts/`), one core
(`agent/core/`). Every capability (SEO, marketing, analytics, products, research, etc.)
is a module the agent uses, not a separate agent, persona, or system prompt. New
capabilities extend the existing agent; they never fork it.

## Future capabilities

Planned modules, none implemented yet:
- **Analytics** — store performance and growth metrics
- **SEO** — search visibility analysis and recommendations
- **Marketing** — campaign ideas, copy, and strategy
- **Products** — catalog and listing analysis
- **Customer/market intelligence** — customer behavior and market research
- **Research** — competitor and trend research
- **Workflows** — multi-step processes combining the above

## Project structure

| Folder | Purpose |
| --- | --- |
| `agent/core/` | The agent's identity, objectives, and orchestration logic |
| `prompts/` | The agent's system prompt and task prompt fragments |
| `tools/` | Tool/function definitions the agent can call |
| `workflows/` | Multi-step processes composed from tools and modules |
| `configuration/` | Per-business/per-store settings |
| `data/` | Local datasets used or produced by the agent |
| `memory/state/` | Persisted agent/session state across runs |
| `research/` | Market, competitor, and trend research |
| `seo/` | SEO analysis and recommendations |
| `marketing/` | Campaign ideas, copy, and marketing strategy |
| `products/` | Product catalog analysis and listing recommendations |
| `listing/` | Listing content generation and marketplace formatting |
| `customer-market-intelligence/` | Customer behavior and market intelligence |
| `social-advertising/` | Social media content ideas and paid advertising strategy |
| `analytics/` | Store performance and growth metrics |
| `integrations/adapters/` | Per-platform adapters (starting with Shopify) |
| `approvals/` | Human-in-the-loop approval requests and records |
| `verification/testing/` | Tests and verification of agent behavior |
| `documentation/` | Deeper design notes and how-tos |

## Configuration concept

Business-specific details — store credentials, branding, business rules, thresholds —
live under `configuration/`, not hardcoded into the agent's logic. Pointing the agent at
a different business is meant to be a configuration change, not a code change.

## Memory/state concept

`memory/state/` holds what the agent persists across runs and sessions — working
context and progress — scoped per business, so one business's history never leaks into
another's.

## Security concept

Secrets are never hardcoded or committed (`.env` is git-ignored). Actions that are
risky or hard to reverse go through `approvals/` for human sign-off before they happen.
Any connected store's API is accessed with least-privilege credentials.

## Incremental development approach

The agent is built one scoped prompt at a time. Each step is verified before the next
begins, and a git checkpoint is created once a step is confirmed working. See
[CLAUDE.md](CLAUDE.md) for the full build rules.

## Current project status

Foundation stage. Runtime: Node.js. A structured configuration template
(`configuration/business.example.yaml`) and its validator (`tools/configValidator.js`)
exist; data is organized into business/product/task/research/state boundaries (see
[`data/README.md`](data/README.md)); the ONE agent's core contract — its conceptual
lifecycle stages — is defined in [`agent/core/agentContract.js`](agent/core/agentContract.js);
where each kind of context lives (so the agent can retrieve a relevant slice instead
of everything) is defined in
[`agent/core/contextBoundaries.js`](agent/core/contextBoundaries.js); the compact
shape of one task's state is defined in
[`agent/core/stateModel.js`](agent/core/stateModel.js); and the rules for what memory
should and should not contain are defined in
[`agent/core/memoryRules.js`](agent/core/memoryRules.js); the shape of one reusable
research record is defined in
[`agent/core/researchRecordModel.js`](agent/core/researchRecordModel.js); the shape
of one product record is defined in
[`agent/core/productModel.js`](agent/core/productModel.js); the conceptual pipeline
of a future product research capability is defined in
[`products/productResearchArchitecture.js`](products/productResearchArchitecture.js);
the shape of one product opportunity analysis is defined in
[`agent/core/opportunityAnalysisModel.js`](agent/core/opportunityAnalysisModel.js); and
the workflow that turns gathered evidence into a structured opportunity analysis is
defined in
[`workflows/productOpportunityAnalysisWorkflow.js`](workflows/productOpportunityAnalysisWorkflow.js);
the shape of one market research record is defined in
[`agent/core/marketResearchModel.js`](agent/core/marketResearchModel.js) (no country or
market is hardcoded — real values come only from configuration or task requirements);
the shape of one customer segment research record is defined in
[`agent/core/customerSegmentResearchModel.js`](agent/core/customerSegmentResearchModel.js)
(no customer research is invented, and confidence defaults to `unassessed` so an
assumption is never claimed as a fact); the shape of one competitor research record
is defined in
[`agent/core/competitorResearchModel.js`](agent/core/competitorResearchModel.js) (no
competitor data is invented); the shape of one SEO keyword research record is
defined in
[`agent/core/seoResearchModel.js`](agent/core/seoResearchModel.js) (no live keyword
API is called or configured today); the workflow that turns a product/category and
customer intent signals into a concise, structured set of keyword records is defined in
[`workflows/keywordResearchWorkflow.js`](workflows/keywordResearchWorkflow.js) (no
search volume or competition metric is ever invented; unavailable data is marked
unavailable, never guessed); the shape of one product/listing optimization record
is defined in
[`agent/core/listingOptimizationModel.js`](agent/core/listingOptimizationModel.js)
(every field is a suggestion — nothing overwrites real listing content, and no field
claims an SEO performance improvement without evidence); the shape of one marketing
analysis record is defined in
[`agent/core/marketingAnalysisModel.js`](agent/core/marketingAnalysisModel.js) (no
external marketing action is ever executed here); and the workflow that connects a
product to a content recommendation (PRODUCT → CUSTOMER → PROBLEM/NEED →
SEARCH/INTEREST → CONTENT OPPORTUNITY → CONTENT RECOMMENDATION → VERIFICATION) is
defined in
[`workflows/contentMarketingWorkflow.js`](workflows/contentMarketingWorkflow.js)
(nothing is ever published automatically, and no business fact is invented); and the
shape of one growth opportunity record (covering upselling, cross-selling, retention,
repeat purchases, and customer re-engagement) is defined in
[`agent/core/growthOpportunityModel.js`](agent/core/growthOpportunityModel.js) (every
product/offer reference must be real and already configured, never invented, and no
customer-facing action is ever executed here); and the registry of tools the ONE agent
may eventually call (12 tools across 9 categories) is defined in
[`tools/toolRegistry.js`](tools/toolRegistry.js) (registry foundation only — every
entry is `not_implemented`, and no register/execute/dispatch logic exists); and how
the agent should select and use those tools (use only relevant tools, avoid
unnecessary calls, reuse valid existing information, avoid duplicate research, verify
results, handle failures, never invent results, stop when enough evidence exists) is
defined in
[`agent/core/toolSelectionRules.js`](agent/core/toolSelectionRules.js) (rules only —
no automatic tool-selection optimization exists yet); and the approval architecture
classifying future actions into 4 classes (analysis-only, recommendation,
approval-required, externally executable) and the policy governing them (approval
required by default for consequential actions unless later configuration permits
otherwise; never silently perform a consequential external action) is defined in
[`approvals/approvalArchitecture.js`](approvals/approvalArchitecture.js) (no external
service is connected); and the shape of one analytics snapshot (reporting period,
sales, traffic, conversion, product performance, inventory, customer behavior,
marketing performance, advertising performance, SEO performance, retention, growth
opportunities) is defined in
[`agent/core/analyticsModel.js`](agent/core/analyticsModel.js) (no analytics provider
is assumed, and no integration exists yet — every category's metrics stay empty until
a real, configured source is connected); and the workflow that turns real analytics
data into a verified result (DATA → FINDING → INTERPRETATION → OPPORTUNITY →
RECOMMENDATION → EXPECTED IMPACT → VERIFICATION), along with the 5-type taxonomy the
agent must use to label every claim it makes (observed fact, calculated result,
interpretation, hypothesis, recommendation), is defined in
[`workflows/analyticsInsightWorkflow.js`](workflows/analyticsInsightWorkflow.js)
(hypotheses are never presented as facts — only the verification stage confirms or
refutes them). A controlled test of the agent against the owner's real business
configuration is defined in
[`verification/testing/controlledAgentTest.js`](verification/testing/controlledAgentTest.js)
(run with `npm run verify:controlled-agent-test`) — as of the last run, all 10
capability areas pass structurally, but `configuration/business.yaml` does not yet
exist, so real business data is unavailable for 9 of the 10 areas (reported plainly,
never invented). The business configuration template
([`configuration/business.example.yaml`](configuration/business.example.yaml)) now
also names `integrations` (13th field, optional — a business is valid with zero
integrations connected) alongside its 12 required fields, so a new client can
eventually configure business information, platform, product model, markets,
countries, currencies, categories, customers, brand, goals, marketing channels, and
integrations, all without changing core agent logic; credentials stay entirely in
`.env` (git-ignored, never in source). A fully filled-in, documented example —
[`configuration/business.sample.yaml`](configuration/business.sample.yaml) — uses
entirely fictional placeholder values (a different platform, business model, and
markets than the owner's own business) to demonstrate that the same, unmodified agent
core and validator work for any business's configuration without code changes; it is
committed and validated by
[`verification/testing/businessConfigSample.test.js`](verification/testing/businessConfigSample.test.js).
The agent's connection to the Claude API is now implemented — a connection layer only
([`agent/core/claudeClient.js`](agent/core/claudeClient.js)) that can send one message
to Claude and return its reply (`sendMessage`), and report whether `ANTHROPIC_API_KEY`
is configured (`isConfigured`), using Node's built-in `fetch` (no SDK dependency) and
`.env` (git-ignored; see [`.env.example`](.env.example)) for the API key. It never
invents a reply: a missing key, a network failure, or a non-success API response all
throw a clear error. It is not yet wired into `agentContract.js`'s stages, does not
call/dispatch tools, and has no autonomous looping — that orchestration is later,
explicitly-scoped work. The agent's connection to the owner's Shopify store is now
also implemented — a connection layer only
([`integrations/adapters/shopifyClient.js`](integrations/adapters/shopifyClient.js))
that can reach the store's Admin GraphQL API and confirm the connection works
(`getShopInfo`), and report whether `SHOPIFY_STORE_DOMAIN`/`SHOPIFY_ADMIN_API_ACCESS_TOKEN`
are configured (`isConfigured`), using Node's built-in `fetch` (no SDK dependency) and
`.env` for the store domain and access token. It never invents a result: a missing
config, a network failure, or a non-success/GraphQL-error response all throw a clear
error. It does not read/write products, orders, or inventory, and is not yet wired
into `agentContract.js`'s stages — that orchestration is later, explicitly-scoped
work. No tool calling, autonomous behavior, real retrieval/research/product-hunting
logic, external research API calls, automated recommendations/scoring, or state
persistence has been implemented yet, and no database or hosting platform has been
chosen. The Research, SEO, Listing, and Marketing specialists (CLAUDE.md section 2)
are now fully implemented and wired into the Chief/Orchestrator
(`agent/core/orchestratorExecutionContract.js`), and the Social & Advertising
specialist (#6) now joins them: the shape of one social media content record is
defined in
[`agent/core/socialContentModel.js`](agent/core/socialContentModel.js) (platform,
content reference, content type, objective, target audience, caption, hashtags,
posting schedule, evidence, expected outcome, verification status; `platform` is a
narrow, validated enum of only the 5 in-scope social platforms - Instagram, Facebook,
TikTok, Pinterest, YouTube); the shape of one paid ad campaign record is defined in
[`agent/core/adCampaignModel.js`](agent/core/adCampaignModel.js) (platform, campaign
reference, objective, audience, budget, ad creative, bidding strategy, CTA, KPI,
measurement plan, evidence, verification status; `platform` is a narrow, validated
enum of only the 3 in-scope advertising platforms - Meta Ads, Google Ads, TikTok Ads;
no campaign is ever launched, and no budget is ever spent, by this schema); and
[`agent/core/socialAdvertisingAgent.js`](agent/core/socialAdvertisingAgent.js) is the
deterministic, evidence-only agent (no AI API call, no external fetch, no live
social/ads platform API) supporting all 8 capabilities, composing those two schemas
and returning one common result shape,
[`agent/core/socialAdvertisingAgentResultModel.js`](agent/core/socialAdvertisingAgentResultModel.js).
Two tools connect it to the orchestrator -
[`tools/socialContentTool.js`](tools/socialContentTool.js) (the 5 social capabilities)
and [`tools/paidAdvertisingTool.js`](tools/paidAdvertisingTool.js) (the 3 advertising
capabilities) - both registered in
[`tools/toolRegistry.js`](tools/toolRegistry.js) under a new `social_advertising`
category, permitted to the `social_advertising` specialist in
[`agent/core/toolPermissions.js`](agent/core/toolPermissions.js), and wired into
`orchestratorExecutionContract.js`'s `TOOL_EXECUTORS`, so a routed objective can reach
this specialist end-to-end. No Instagram/Facebook/TikTok/Pinterest/YouTube/Meta/Google/
TikTok Ads integration adapter exists - deliberately out of scope for this build, per
every other specialist's no-external-fetch philosophy. The Social & Advertising
specialist now also generates cross-platform social media strategies: the shape of one
strategy record (strategy reference, objective, audience, content pillars, platform
selection, posting strategy, content themes, campaign themes, KPIs, evidence,
verification status) is defined in
[`agent/core/socialMediaStrategyModel.js`](agent/core/socialMediaStrategyModel.js) -
its own dedicated schema, since a cross-platform strategy needs fields neither organic
content nor a single ad campaign needs; `platform_selection` reuses the same platform
enums the other 2 schemas already define. `socialAdvertisingAgent.js`'s 9th capability,
`analyzeSocialMediaStrategy`, composes it the same deterministic, evidence-only way as
every other capability, returning only caller-supplied structured recommendations -
never an invented pillar, theme, or KPI. A third tool,
[`tools/socialMediaStrategyTool.js`](tools/socialMediaStrategyTool.js), connects it to
the orchestrator the same way the other two social/advertising tools do. The
specialist's 10th capability, platform-aware ecommerce content generation, produces
hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts, and
creative briefs, all tagged to one selected platform: the shape of one content record
is defined in
[`agent/core/platformContentModel.js`](agent/core/platformContentModel.js) - its own
dedicated schema (7 creative-element dimensions the existing social content schema was
never meant to carry), with `platform` reusing the same 5-platform enum
`socialContentModel.js` already defines. `socialAdvertisingAgent.js`'s
`analyzeContentGeneration` composes it the same deterministic, evidence-only way as
every other capability - it never synthesizes or rewrites a hook, caption, or concept
to fit a platform on its own, only requires the platform to be named so the adaptation
is explicit; a `platform_adaptation_notes` field records the caller's own explanation
of that fit. Nothing is ever published automatically. A fourth tool,
[`tools/platformContentTool.js`](tools/platformContentTool.js), connects it to the
orchestrator the same way. The specialist's 11th capability, a structured social
content calendar, is defined in
[`agent/core/contentCalendarModel.js`](agent/core/contentCalendarModel.js) (date,
platform, content type, topic, hook, CTA, campaign, product, KPI). It's the one
capability that reaches across specialists: when the caller supplies a
`campaignContext`, `socialAdvertisingAgent.js`'s `analyzeContentCalendar` builds it into
a real campaign plan record by calling `marketingAgent.js`'s own
`retrieveMarketingData('campaign_plan', ...)` directly (reused, not reimplemented), so
the Marketing Agent can supply an entry's campaign context - the resulting
`campaign_reference` fills the entry's `campaign` field when the caller didn't set one
explicitly, and the campaign plan record travels alongside the entry in the result so
that context stays visible rather than silently absorbed. Nothing is ever posted or
scheduled automatically. A fifth tool,
[`tools/contentCalendarTool.js`](tools/contentCalendarTool.js), connects it to the
orchestrator the same way. The specialist's 12th capability, pre-launch advertising
strategy planning, is defined in
[`agent/core/advertisingStrategyModel.js`](agent/core/advertisingStrategyModel.js)
(campaign objective, audience, offer, creative angle, ad copy, CTA, budget
recommendation, KPI, testing plan) - its own dedicated schema, distinct from the
platform-pinned, execution-ready ad campaign schema (`adCampaignModel.js`) and from the
cross-platform organic+paid strategy schema (`socialMediaStrategyModel.js`), since a
pre-launch strategy needs creative and testing fields neither carries and isn't pinned
to one of the 3 ad platforms. `budget_recommendation` is always a caller-supplied
description, never a fabricated or committed number - no advertising budget is ever
spent and no campaign is ever launched automatically. A sixth tool,
[`tools/advertisingStrategyTool.js`](tools/advertisingStrategyTool.js), connects it to
the orchestrator the same way. The specialist's 13th capability, advertising
performance analysis, is defined in
[`agent/core/advertisingPerformanceModel.js`](agent/core/advertisingPerformanceModel.js)
(performance reference, campaign reference, actual metrics, calculated metrics,
evidence, verification status), supporting impressions, CTR, CPC, CPM, conversions,
CPA, and ROAS. `actual_metrics` and `calculated_metrics` are kept as two separate
object fields, never merged: `actual_metrics` is whatever the caller directly supplies
as already-known; `calculated_metrics` is derived from it by
[`agent/core/advertisingPerformanceCalculator.js`](agent/core/advertisingPerformanceCalculator.js)
(reused by the agent, not reimplemented) via the standard formulas - CTR =
clicks/impressions, CPC = spend/clicks, CPM = spend/impressions×1000, CPA =
spend/conversions, ROAS = revenue/spend - and only ever populated when the required
inputs are present; a metric that can't be calculated is simply omitted, never
defaulted to 0/null/NaN, and `analyzeAdvertisingPerformance` names every such gap in an
explicit limitation instead of leaving it unexplained. Recommendations are never mixed
into either metrics object - they stay only in the common result envelope's own
`recommendations` field, the same separation every other capability here already uses.
No metric is ever fetched or estimated automatically. A seventh tool,
[`tools/advertisingPerformanceTool.js`](tools/advertisingPerformanceTool.js), connects
it to the orchestrator the same way. The Analytics & Optimization specialist (#7, the
last of the 7 approved specialists) is now also implemented:
[`agent/core/analyticsAgent.js`](agent/core/analyticsAgent.js) supports 8 capabilities
(sales, products, customers, conversion, traffic, marketing, advertising, growth
opportunities), returning one common result shape,
[`agent/core/analyticsAgentResultModel.js`](agent/core/analyticsAgentResultModel.js).
The 7 "data" capabilities each compose one
[`agent/core/analyticsModel.js`](agent/core/analyticsModel.js) snapshot record,
populating only their own category and leaving every other category at its untouched
empty/unverified default; `analyticsModel.js` gained one additive field,
`advertising_performance` (it originally shipped with 9 categories with this exact
addition already anticipated in its own header), kept distinct from
`marketing_performance` since Marketing and Social & Advertising are already separate
specialists with separate schemas. Growth opportunities composes
[`agent/core/growthOpportunityModel.js`](agent/core/growthOpportunityModel.js) records
directly instead, since it's an OPPORTUNITY-stage hypothesis
(see [`workflows/analyticsInsightWorkflow.js`](workflows/analyticsInsightWorkflow.js)),
not a DATA-stage observed fact. Zero new schema surface beyond that one field — no
metric, trend, or opportunity is ever synthesized or guessed; a metric or category with
no caller-supplied evidence is reported as such, never invented. An eighth tool,
[`tools/analyticsTool.js`](tools/analyticsTool.js), connects it to the orchestrator the
same way as every other specialist, completing all 7 approved specialists' wiring into
the Chief/Orchestrator. The Analytics & Optimization specialist is now also connected
to real, read-only ecommerce data: `analyticsModel.js`'s category sub-shape now
distinguishes `actual_metrics` (an observed fact, straight off a real source),
`calculated_metrics` (mechanically derived from actual_metrics by a defined formula),
and `estimated_metrics` (additionally requires a caller-stated assumption or
extrapolation, e.g. a monthly revenue projection) — recommendations stay only in the
common result envelope, never mixed into any of the three. A 9th category, `inventory`,
was added alongside the existing 10. Two new modules connect this to reality:
[`integrations/adapters/shopifyClient.js`](integrations/adapters/shopifyClient.js)
gained 3 read-only GraphQL functions — `getOrders()`, `getCustomers()` (deliberately
non-PII fields only — no name/email/phone/address, "customers where permitted" per
CLAUDE.md's security-first design), and `getInventoryLevels()` — alongside its existing
`getProducts()`; and
[`agent/core/analyticsMetricsCalculator.js`](agent/core/analyticsMetricsCalculator.js)
is a pure, Shopify-agnostic calculator (mirroring
[`agent/core/advertisingPerformanceCalculator.js`](agent/core/advertisingPerformanceCalculator.js)'s
precedent) computing calculated/estimated metrics from plain order/product/inventory
arrays — never fabricating a figure whose inputs are missing. A ninth tool,
[`tools/analyticsDataTool.js`](tools/analyticsDataTool.js) (the `analytics_data_retrieval`
tool id), is the actual read-only connection: it pulls live sales/products/customers/
inventory data and calls the same `analyticsAgent.js` capability functions
`tools/analyticsTool.js` already used for caller-supplied evidence. A denied/unavailable
customer-data pull degrades to an honest `partial` status instead of failing the whole
call. Both tools are wired into the orchestrator, classified `analysis_only`. The
Analytics & Optimization specialist's 10th capability, `insights`, is the analytics
insight engine: for each significant insight it returns exactly 8 fields — metric,
current state, comparison, possible cause, opportunity, recommendation, confidence,
evidence — via [`agent/core/insightModel.js`](agent/core/insightModel.js).
[`agent/core/insightEngine.js`](agent/core/insightEngine.js) is a pure calculator that
mechanically computes each metric's percent change from caller-supplied raw values and
decides whether it clears a significance threshold (10% by default, adjustable) —
never a judgment call; only significant metrics are composed into records, the rest
are named as excluded in `limitations`. `possible_cause`/`opportunity`/`recommendation`
are always caller-supplied hypotheses, never invented. Correlation is never asserted as
causation without evidence: a `possible_cause` stated with no evidence can never carry
`'high'` confidence — it's capped at `'medium'`, with an explicit limitation naming the
downgrade (a presence-only guard, the same honest limit every other verification guard
in this project already accepts). `insights` is reached through the existing
`tools/analyticsTool.js`, wired into the orchestrator the same way as every other
analytics capability. A conversion-rate-optimization (CRO) audit is now also
available: [`agent/core/conversionOptimizationChecker.js`](agent/core/conversionOptimizationChecker.js)
evaluates 8 dimensions of a store's real, caller-supplied evidence — product pages,
landing pages, offers, CTA, trust signals, checkout friction, mobile experience,
pricing presentation — via
[`agent/core/conversionOptimizationCheckModel.js`](agent/core/conversionOptimizationCheckModel.js),
mirroring `agent/core/seoQualityChecker.js`/`agent/core/listingQualityChecker.js`'s
mechanical, evidence-only checklist structure exactly. Every flagged issue is tagged
with a fixed, documented severity tier (critical/high/medium/low) and returned in a
`prioritized_recommendations` list sorted by that tier — never a fabricated
conversion-rate or business-impact estimate. Like those two checkers, it is a
standalone deliverable (not wired into `tools/toolRegistry.js` or the
Chief/Orchestrator) with no write/execute/publish code path anywhere, so no
recommendation is ever applied to a real page automatically. A Sales Growth Planner
now combines caller-supplied evidence from **multiple specialist domains** —
product, customer, analytics, SEO, marketing, social, advertising — into one
cross-domain report:
[`agent/core/salesGrowthPlanner.js`](agent/core/salesGrowthPlanner.js) via
[`agent/core/salesGrowthPlanModel.js`](agent/core/salesGrowthPlanModel.js) returns
current state, bottlenecks, opportunities, recommended actions, KPIs, experiment
ideas, and approval requirements. It is the first module in this project to
synthesize real records across that many domains at once; it composes rather than
reimplements — `opportunities` is ranked by calling
[`agent/core/growthOpportunityEngine.js`](agent/core/growthOpportunityEngine.js)'s
existing ICE-style engine directly, and every other section is caller-supplied,
structured and validated only, never invented (an unevidenced `critical`/`high`
bottleneck is honesty-graded down to `medium`, recorded in the plan's own
`limitations`). Every recommended action carries one of
`approvals/approvalArchitecture.js`'s 4 classifications, and `approval_requirements`
is a mechanical rollup of everything that needs human sign-off. Also a standalone
deliverable for this first pass, with no write/execute path of its own. A reusable
experiment (A/B-test) framework now exists too:
[`agent/core/experimentEngine.js`](agent/core/experimentEngine.js) via
[`agent/core/experimentModel.js`](agent/core/experimentModel.js) carries one experiment
schema — hypothesis, variable, control, variant, target metric, duration, success
criteria, result, decision — through its full lifecycle (design → run → decide),
reused identically across all 8 named growth surfaces: products, pricing, listing,
SEO, offers, marketing, social, advertising. `status` (draft/running/completed) is
mechanically derived from what evidence actually exists, never asserted directly;
`hypothesis`/`control`/`variant`/`result` stay caller-supplied fact, never computed or
predicted. A decision to `ship_variant` or `keep_control` asserted before a result is
actually recorded is honesty-downgraded to `inconclusive` (recorded in `limitations`,
never applied silently), and every decision is tagged with one of
`approvals/approvalArchitecture.js`'s 4 classifications via
`growthOpportunityEngine.js`'s reused `buildApprovalRequirement()` — the same pattern
`salesGrowthPlanner.js`'s recommended actions already use. Standalone deliverable, no
write/execute path of its own. A knowledge layer now sits on top of that framework:
[`agent/core/experimentLearningStore.js`](agent/core/experimentLearningStore.js) via
[`agent/core/experimentLessonModel.js`](agent/core/experimentLessonModel.js) distills a
*decided* experiment into a structured lesson — experiment reference, hypothesis,
result, evidence, outcome, lesson, and confidence. `outcome` is mechanically derived
from the decision (`ship_variant` → `success`, `keep_control` → `failure`; `iterate`/
`inconclusive`/`not_yet_decided` throw rather than guessing) — never caller-set, so a
failed experiment can never be mislabeled a success. Making validated knowledge
available to future recommendations is enforced mechanically:
`getValidatedLearnings()` and `lessonsAsRecommendationEvidence()` return only
`outcome === 'success'` lessons; `getCautionaryLessons()` keeps failed-experiment
lessons real and retrievable but permanently separate from that validated pool, so a
failed experiment is never treated as successful knowledge by anything built on top of
it. No persistence layer — a set of pure functions over a caller-held lesson array,
the same standalone-deliverable, no-write-path pattern as every other engine here.
The approval architecture is now operational, not just a classification schema:
[`approvals/approvalWorkflow.js`](approvals/approvalWorkflow.js) via
[`approvals/approvalRequestModel.js`](approvals/approvalRequestModel.js) carries one
Approval Request record through a real `pending` → `approved`/`rejected` lifecycle.
`decideApprovalRequest()` is the only function that can move a request out of
`pending`, and it requires a non-empty `decidedBy` — no path anywhere lets a
consequential action be approved silently. `agent/core/orchestratorExecutionContract.js`'s
`executeSelectedCapability()` (the Chief's single dispatch point) creates a real
tracked request whenever `agent/core/toolPermissions.js`'s `checkToolAccess()` reports
`approval_required`, surfaced on every response as `pending_approvals`; the new
`resumeApprovedExecution()` is the only path in the codebase that can execute a
previously gated action, and it only reaches the tool executor once a real, decided
`approved` record exists — re-checking availability/permission at resume time, since
approval only ever satisfies the approval gate itself. `approvals/approvalArchitecture.js`
now also exposes `requiresApproval()`, the single mechanical source of truth for which
classifications auto-proceed, reused (never re-declared) by
`agent/core/toolPermissions.js`. No hidden module state anywhere — the request array is
threaded through one run the same way `runTokenTracker` already was. No external
service is connected yet, so no `externally_executable` action can run end-to-end
today, but the classification, request lifecycle, and Chief-level wiring are all real.
