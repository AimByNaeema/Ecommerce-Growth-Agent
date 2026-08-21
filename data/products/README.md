# data/products/

This business's product catalog (e.g. a product export pulled from a connected store).
Kept separate from [`data/business/`](../business/README.md) so the agent can retrieve a
relevant slice of the catalog (a product, a category) without loading the entire
catalog — and without loading other business data it doesn't need for the task at hand.
Git-ignored, same as `data/business/`.

Note: `products/` (top-level) holds reusable *logic* for catalog analysis, not catalog
data — see `products/README.md`.

Real entries here are meant to conform to the shape defined in
[`agent/core/productModel.js`](../../agent/core/productModel.js) - product identity,
category, product model, description, positioning, target customer, market, pricing,
availability, source, and research status. Schema only - no product-hunting/scraping
logic exists yet.
