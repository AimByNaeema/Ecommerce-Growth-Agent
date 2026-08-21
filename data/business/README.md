# data/business/

Real, business-specific datasets (e.g. product/order/customer exports pulled from a
connected store). Mirrors `configuration/business.yaml`: never committed, never
hardcoded into agent logic — files here are safe to delete or regenerate for a
different business.

Reusable agent logic (`agent/core/`, `tools/`, `workflows/`, `prompts/`) must never
read this folder directly or hardcode its contents. Business data only reaches the
agent through `configuration/` and whatever adapter/tool call fetched it at runtime.
