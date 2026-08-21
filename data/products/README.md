# data/products/

This business's product catalog (e.g. a product export pulled from a connected store).
Kept separate from [`data/business/`](../business/README.md) so the agent can retrieve a
relevant slice of the catalog (a product, a category) without loading the entire
catalog — and without loading other business data it doesn't need for the task at hand.
Git-ignored, same as `data/business/`.

Note: `products/` (top-level) holds reusable *logic* for catalog analysis, not catalog
data — see `products/README.md`.
