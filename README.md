# Smart E-Commerce Growth AI Agent

A single, reusable AI agent that helps grow an e-commerce business — analytics, SEO,
marketing, product, and customer/market intelligence, all as capabilities of ONE agent.

It is being built and tested first against the owner's own Shopify store, then designed
to be configurable and resellable to other e-commerce businesses.

## Ground rules

- **One agent.** Every capability below is a module of the same agent — never a
  separate agent, persona, or system prompt.
- **Configurable, not hardcoded.** Store credentials, branding, and business rules live
  in [configuration/](configuration/), so the same agent can be repointed at a different
  business later.
- No runtime, framework, SDK, database, or hosting platform has been chosen yet. This
  repo currently defines structure only.

See [CLAUDE.md](CLAUDE.md) for the full build-process rules this project follows.

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

Each folder contains its own short `README.md` describing its purpose in more detail.
