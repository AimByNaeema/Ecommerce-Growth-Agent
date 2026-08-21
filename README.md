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
and the shape of one customer segment research record is defined in
[`agent/core/customerSegmentResearchModel.js`](agent/core/customerSegmentResearchModel.js)
(no customer research is invented, and confidence defaults to `unassessed` so an
assumption is never claimed as a fact). No tool calling, AI API connection, autonomous
behavior, real retrieval/research/product-hunting logic, external research API calls,
automated recommendations/scoring, or state persistence has been implemented yet, and
no database or hosting platform has been chosen.
