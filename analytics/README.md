# analytics/

Store performance analysis: sales, traffic, and growth metrics the agent computes or
summarizes.

[`../agent/core/analyticsModel.js`](../agent/core/analyticsModel.js) defines the shape
of one analytics snapshot, covering sales, traffic, conversion, product performance,
customer behavior, marketing performance, SEO performance, retention, and growth
opportunities. Schema only — no analytics provider is assumed anywhere, and no
integration exists yet; every category's metrics stay empty until a real, configured
source is connected.
