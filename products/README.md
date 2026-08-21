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

[`agent/core/listingOptimizationModel.js`](../agent/core/listingOptimizationModel.js)
defines the shape of one product/listing optimization record (product title,
description, keywords, search intent, structure, metadata, internal optimization
opportunities, conversion considerations). Every field is a suggestion only - nothing
here reads or writes real listing content, and applying a suggestion to a real store
listing requires a separate, human-approved action via
[`approvals/`](../approvals/README.md). No field claims or predicts an SEO performance
improvement - only qualitative, evidence-checkable opportunities are captured.
