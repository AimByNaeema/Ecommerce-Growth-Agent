# data/business/

Real, business-specific operational data (e.g. order/customer exports pulled from a
connected store) — everything about this business except its product catalog, which has
its own boundary at [`data/products/`](../products/README.md) so it can be retrieved
separately and selectively. Mirrors `configuration/business.yaml`: never committed, never
hardcoded into agent logic — files here are safe to delete or regenerate for a
different business.

Reusable agent logic (`agent/core/`, `tools/`, `workflows/`, `prompts/`) must never
read this folder directly or hardcode its contents. Business data only reaches the
agent through `configuration/` and whatever adapter/tool call fetched it at runtime.
