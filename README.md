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
sales, traffic, conversion, product performance, customer behavior, marketing
performance, SEO performance, retention, growth opportunities) is defined in
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
chosen.
