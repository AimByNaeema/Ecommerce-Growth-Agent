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
exist; data is organized into business/task/research/state boundaries (see
[`data/README.md`](data/README.md)); and the ONE agent's core contract — its conceptual
lifecycle stages — is defined in [`agent/core/agentContract.js`](agent/core/agentContract.js).
No tool calling, AI API connection, or autonomous behavior has been implemented yet, and
no database or hosting platform has been chosen.
