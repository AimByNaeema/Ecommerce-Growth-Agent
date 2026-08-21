# configuration/

Per-business, per-store settings that let the same agent be repointed at a different
e-commerce business without code changes.

[`business.example.yaml`](business.example.yaml) is the structure template. Copy it to
`business.yaml` (git-ignored, not committed) and fill in the real business's values.
12 of its 13 fields are required (validated by
[`tools/configValidator.js`](../tools/configValidator.js)); `integrations` is optional
— a business is valid with zero integrations connected.
