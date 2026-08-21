# workflows/

Multi-step processes the agent runs (e.g. a growth-audit sequence), composed from tools
and capability modules elsewhere in the repo.

[`productOpportunityAnalysisWorkflow.js`](productOpportunityAnalysisWorkflow.js) defines
the process that turns evidence gathered by
[`products/productResearchArchitecture.js`](../products/productResearchArchitecture.js)
into a structured
[`agent/core/opportunityAnalysisModel.js`](../agent/core/opportunityAnalysisModel.js)
record. Pipeline only — no automated recommendation, score, or verdict is produced.

[`keywordResearchWorkflow.js`](keywordResearchWorkflow.js) defines the process that
turns a product/category
([`agent/core/productModel.js`](../agent/core/productModel.js)) and customer intent
signals
([`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js))
into a concise, structured set of
[`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js) keyword records.
Pipeline only — no search volume or competition metric is ever invented, and any field
with no real evidence is marked unavailable rather than guessed.

[`contentMarketingWorkflow.js`](contentMarketingWorkflow.js) defines the process that
connects a product to a content recommendation: PRODUCT → CUSTOMER → PROBLEM/NEED →
SEARCH/INTEREST → CONTENT OPPORTUNITY → CONTENT RECOMMENDATION → VERIFICATION. It
composes [`agent/core/productModel.js`](../agent/core/productModel.js),
[`agent/core/customerSegmentResearchModel.js`](../agent/core/customerSegmentResearchModel.js),
[`agent/core/seoResearchModel.js`](../agent/core/seoResearchModel.js), and
[`agent/core/marketingAnalysisModel.js`](../agent/core/marketingAnalysisModel.js).
Pipeline only — nothing is ever published automatically, and no business fact is
invented anywhere.
