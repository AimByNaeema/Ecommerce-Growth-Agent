# tools/

Definitions for the tools/functions the agent can call to take action or fetch data.

[`configValidator.js`](configValidator.js) validates a business configuration file
against the required fields and reports what's missing. Run directly with
`node tools/configValidator.js [path]` (default `configuration/business.yaml`).

[`toolRegistry.js`](toolRegistry.js) is the registry of tools the ONE agent may
eventually call, grouped into 9 categories (configuration, products, research,
customer_market_intelligence, seo, marketing, analytics, memory, verification) and
covering 12 named tools (business configuration retrieval, product data retrieval,
product research, market research, customer research, competitor research, keyword
research, SEO analysis, marketing analysis, analytics, memory retrieval,
verification). Registry foundation only — every entry is `not_implemented`, and there
is no register/execute/dispatch logic anywhere in the file. Run
`node tools/toolRegistry.js` to print it. How the agent selects and uses these tools
is governed by
[`agent/core/toolSelectionRules.js`](../agent/core/toolSelectionRules.js).
