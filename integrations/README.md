# integrations/

Connections to external platforms and services the agent uses (e.g. the owner's Shopify
store). No SDK was needed — Node's built-in `fetch` is enough (see
[`adapters/README.md`](adapters/README.md) for the Shopify connection layer, which now
covers shop identity and read-only product/variant/inventory/collection/metadata
retrieval — no writes yet).
