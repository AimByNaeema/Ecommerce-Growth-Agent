# configuration/

Per-business, per-store settings that let the same agent be repointed at a different
e-commerce business without code changes.

[`business.example.yaml`](business.example.yaml) is the structure template. Copy it to
`business.yaml` (git-ignored, not committed) and fill in the real business's values.
12 of its 13 fields are required (validated by
[`tools/configValidator.js`](../tools/configValidator.js)); `integrations` is optional
— a business is valid with zero integrations connected.

[`business.sample.yaml`](business.sample.yaml) is a different, complementary file: a
filled-in, illustrative reference showing what a *completed* configuration looks like,
using entirely fictional placeholder values for a business with a different platform,
business model, and markets than the owner's own. It is not meant to be copied — it
exists to demonstrate that the same, unmodified agent core and validator work for any
business's configuration without code changes. It is committed (unlike `business.yaml`)
and validated in the test suite.
