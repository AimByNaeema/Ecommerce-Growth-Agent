# data/

Local data used or produced by the agent, split by lifetime and ownership so
business data, disposable data, and reusable logic never mix:

- [`business/`](business/README.md) — this business's own data (git-ignored)
- [`tasks/`](tasks/README.md) — disposable per-task working data (git-ignored)

Two related but distinct areas live elsewhere: `research/` holds gathered market
intelligence (not this business's operational data), and `memory/state/` holds
durable cross-run progress (not disposable). No database or storage engine chosen
yet.
