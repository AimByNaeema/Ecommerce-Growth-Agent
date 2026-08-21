# products/

Product catalog analysis, listing recommendations, and related work the agent produces.

[`productResearchArchitecture.js`](productResearchArchitecture.js) defines the
conceptual pipeline of a future product research capability (discover opportunities,
collect evidence, compare opportunities, identify demand signals, identify
competition, identify market fit, record confidence). It composes with
[`agent/core/productModel.js`](../agent/core/productModel.js) (the candidate/product
shape) and [`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js)
(the evidence/finding shape). Pipeline only - no external research API is called, no
source is configured today, and no result is fabricated.
