# data/

Local data used or produced by the agent, split by lifetime and ownership so
business data, product data, disposable data, and reusable logic never mix:

- [`business/`](business/README.md) — this business's operational data, excluding its
  product catalog (git-ignored)
- [`products/`](products/README.md) — this business's product catalog (git-ignored)
- [`tasks/`](tasks/README.md) — disposable per-task working data (git-ignored)

Two related but distinct areas live elsewhere: `research/` holds gathered market
intelligence (not this business's operational data, git-ignored), and
`memory/state/` holds durable cross-run progress (not disposable, git-ignored). See
[`agent/core/contextBoundaries.js`](../agent/core/contextBoundaries.js) for how these
areas map to what the agent selectively retrieves per task. No database or storage
engine chosen yet.
