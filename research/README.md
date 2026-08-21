# research/

Market, competitor, and trend research the agent gathers or produces to inform growth
recommendations. The shape one research record must conform to (topic, market, date,
source/evidence, finding, confidence, relevance, summary, verification status) is
defined in [`agent/core/researchRecordModel.js`](../agent/core/researchRecordModel.js).

The point of that structure is to avoid repeating valid research unnecessarily: a
record carries enough (topic, market, date, verification_status) to judge later whether
existing research already answers a question. No lookup/search/duplicate-detection
logic exists yet — that's a research engine, not built here.
