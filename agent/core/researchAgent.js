'use strict';

// The Research Agent (CLAUDE.md section 2, specialist #1: "Market, competitor, and
// customer/market-intelligence research"). Supports 7 research types - market,
// global market, competitor, trend, customer/market intelligence, opportunity
// discovery, customer segmentation - and returns one common structured result shape
// (agent/core/researchAgentResultModel.js): findings, evidence, source, confidence,
// limitations, recommendations.
//
// customer_segmentation (deriveCustomerSegmentation, near the bottom of this file) is
// the one exception to "never synthesizes or guesses a finding" above - it is a
// deterministic, threshold-based CLASSIFIER (not a composer): given structured
// purchase/order/engagement business data, it mechanically derives a segment label,
// needs, an opportunity, and a recommended strategy. See its own header comment for
// the full rationale and the explicit guarantee that no personal attribute is ever
// used or inferred.
//
// Lives in agent/core/ (alongside every research schema it composes) rather than
// research/ - research/ is reserved entirely for a business's own gathered research
// data (research/*  is git-ignored except its README; see research/README.md), never
// for reusable agent code. research/README.md documents this module for discoverability.
//
// Deterministic only - no AI API call, no external fetch, no search/lookup logic (no
// research engine). Callers supply already-structured evidence; this module's job is
// to validate it, compose it into the existing per-type schemas
// (marketResearchModel.js, competitorResearchModel.js, customerSegmentResearchModel.js,
// researchRecordModel.js - reused as-is, never duplicated), and grade it honestly -
// never to synthesize or guess a finding. Where the caller supplies no evidence, the
// result says so (limitations) instead of inventing anything, and
// confidence/verification_status stay at whatever the caller explicitly asserted
// (default unassessed/unverified) - this module never upgrades or infers either.
//
// Opportunity discovery here is deliberately distinct from Product's territory:
// agent/core/opportunityAnalysisModel.js (an 8-dimension evaluation of one specific
// product candidate, fed by products/productResearchArchitecture.js) is untouched.
// runOpportunityDiscovery below produces market/customer/competitor-evidence-based
// *signals* using the generic researchRecordModel.js shape - adjacent output, no
// shared code, no overlap with Product's pipeline.

const {
  RESEARCH_TYPES,
  createEmptyResearchAgentResult,
  validateResearchAgentResultShape,
} = require('./researchAgentResultModel');
const {
  createEmptyResearchRecord,
  validateResearchRecordShape,
} = require('./researchRecordModel');
const {
  createEmptyMarketResearchRecord,
  validateMarketResearchShape,
} = require('./marketResearchModel');
const {
  createEmptyCompetitorResearchRecord,
  validateCompetitorResearchShape,
} = require('./competitorResearchModel');
const {
  createEmptyCustomerSegmentResearchRecord,
  validateCustomerSegmentResearchShape,
} = require('./customerSegmentResearchModel');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireNonEmptyArray(value, fieldName, fnName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` array.`);
  }
}

function requireObjectEntry(entry, fieldName, fnName) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${fnName} requires each \`${fieldName}\` entry to be an object.`);
  }
}

// Never guesses content - only normalizes a missing/singular value into the array
// shape every model already expects.
function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Specialized record builders - one per existing model, reused as-is (createEmpty* +
// validate* are never reimplemented here, only called).
// ---------------------------------------------------------------------------------

function buildMarketRecord(entry, fnName) {
  requireNonEmptyString(entry.market, 'market', fnName);
  const record = createEmptyMarketResearchRecord(entry.country || '', entry.market);
  record.category = entry.category || '';
  record.customer_segment = entry.customerSegment || '';
  record.demand_signals = normalizeArray(entry.demandSignals);
  record.competitors = normalizeArray(entry.competitors);
  record.trends = normalizeArray(entry.trends);
  record.opportunities = normalizeArray(entry.opportunities);
  record.risks = normalizeArray(entry.risks);
  record.evidence = normalizeArray(entry.evidence);
  record.research_date = entry.researchDate || todayIsoDate();

  const validation = validateMarketResearchShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid market research record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildCompetitorRecord(entry, fnName) {
  requireNonEmptyString(entry.competitor, 'competitor', fnName);
  const record = createEmptyCompetitorResearchRecord(entry.competitor);
  record.market = entry.market || '';
  record.product_category = entry.productCategory || '';
  record.positioning = entry.positioning || '';
  record.pricing_evidence = normalizeArray(entry.pricingEvidence);
  record.strengths = normalizeArray(entry.strengths);
  record.weaknesses = normalizeArray(entry.weaknesses);
  record.marketing_signals = normalizeArray(entry.marketingSignals);
  record.seo_signals = normalizeArray(entry.seoSignals);
  record.opportunities = normalizeArray(entry.opportunities);
  record.source = normalizeArray(entry.source);
  record.research_date = entry.researchDate || todayIsoDate();

  const validation = validateCompetitorResearchShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid competitor research record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildCustomerSegmentRecord(entry, fnName) {
  requireNonEmptyString(entry.segmentDefinition, 'segmentDefinition', fnName);
  const record = createEmptyCustomerSegmentResearchRecord(entry.segmentDefinition);
  record.needs = normalizeArray(entry.needs);
  record.problems = normalizeArray(entry.problems);
  record.buying_motivations = normalizeArray(entry.buyingMotivations);
  record.objections = normalizeArray(entry.objections);
  record.preferences = normalizeArray(entry.preferences);
  record.market = entry.market || '';
  record.evidence = normalizeArray(entry.evidence);
  record.confidence = entry.confidence || 'unassessed';

  const validation = validateCustomerSegmentResearchShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid customer segment research record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// Shared by trend research and opportunity discovery - both are a flat list of topics
// backed by the generic research record shape, differing only in what the topic
// conventionally represents (a trend vs. an evidence-based opportunity signal).
function buildGenericRecord(entry, fnName) {
  requireNonEmptyString(entry.topic, 'topic', fnName);
  const record = createEmptyResearchRecord(entry.topic);
  record.market = entry.market || '';
  record.date = entry.date || todayIsoDate();
  record.source = normalizeArray(entry.source);
  record.finding = entry.finding || '';
  record.confidence = entry.confidence || 'unassessed';
  record.relevance = entry.relevance || 'unassessed';
  record.summary = entry.summary || '';
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateResearchRecordShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid research record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// ---------------------------------------------------------------------------------
// Composition - turns one or more specialized records into the common
// agent/core/researchAgentResultModel.js envelope. This is the only place
// findings/evidence/source get flattened, and the only place limitations/
// verification_status get graded - never per-record-builder, so every research type
// is graded the same honest way.
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// Retrieval - turns raw caller-supplied entries into validated specialized records.
// This IS "data retrieval" in this deterministic-only architecture: caller-supplied
// structured evidence is the only data source that exists today (no external research
// source is configured - see module header). A future real external source would plug
// in here, without touching analysis or recommendation below.
// ---------------------------------------------------------------------------------

const RECORD_BUILDERS = {
  market: buildMarketRecord,
  competitor: buildCompetitorRecord,
  customer_segment: buildCustomerSegmentRecord,
  generic: buildGenericRecord,
};

function retrieveResearchData(kind, entries, fnName) {
  const builder = RECORD_BUILDERS[kind];
  if (!builder) {
    throw new Error(`retrieveResearchData received an unknown record kind: ${kind}`);
  }
  return entries.map((entry) => builder(entry, fnName));
}

const RECORD_KIND_EXTRACTORS = {
  market: (record) => ({
    findings: [
      ...record.demand_signals,
      ...record.competitors,
      ...record.trends,
      ...record.opportunities,
      ...record.risks,
    ],
    evidence: [...record.evidence],
    source: [],
    label: record.market || record.country || '(unspecified market)',
  }),
  competitor: (record) => ({
    findings: [...record.strengths, ...record.weaknesses, ...record.opportunities],
    evidence: [],
    source: [...record.source],
    label: record.competitor || '(unspecified competitor)',
  }),
  customer_segment: (record) => ({
    findings: [
      ...record.needs,
      ...record.problems,
      ...record.buying_motivations,
      ...record.objections,
      ...record.preferences,
    ],
    evidence: [...record.evidence],
    source: [],
    label: record.segment_definition || '(unspecified segment)',
  }),
  generic: (record) => ({
    findings: record.finding ? [record.finding] : [],
    evidence: [],
    source: [...record.source],
    label: record.topic || '(unspecified topic)',
  }),
};

// ---------------------------------------------------------------------------------
// Analysis - pure analysis of already-retrieved records: flattens findings/evidence/
// source and builds the honest limitations list. No recommendation logic lives here,
// and no retrieval (record-building) logic lives here either - only extraction and
// grading of what retrieveResearchData already produced.
// ---------------------------------------------------------------------------------

function analyzeResearchData(records, kind) {
  const extractor = RECORD_KIND_EXTRACTORS[kind];
  if (!extractor) {
    throw new Error(`analyzeResearchData received an unknown record kind: ${kind}`);
  }

  const findings = [];
  const evidence = [];
  const source = [];
  const limitations = [
    'No external research source is configured; this result reflects only caller-supplied evidence.',
  ];
  let anyEvidenceSupplied = false;

  for (const record of records) {
    const extracted = extractor(record);
    findings.push(...extracted.findings);
    evidence.push(...extracted.evidence);
    source.push(...extracted.source);
    if (extracted.evidence.length === 0 && extracted.source.length === 0) {
      limitations.push(`No evidence was supplied for ${extracted.label}.`);
    } else {
      anyEvidenceSupplied = true;
    }
  }

  return { findings, evidence, source, limitations, anyEvidenceSupplied };
}

// ---------------------------------------------------------------------------------
// Recommendation - deliberately trivial and separate from analysis. Never invents a
// recommendation from findings; only ever relays what the caller explicitly supplied.
// ---------------------------------------------------------------------------------

function deriveRecommendations(recommendations) {
  return normalizeArray(recommendations);
}

// ---------------------------------------------------------------------------------
// Composition - a thin assembler: runs analysis + recommendation over already-
// retrieved records, applies the verified-without-evidence honesty guard, builds the
// common agent/core/researchAgentResultModel.js envelope, and validates it. This is
// the only place the three stages above are combined - never per-record-builder, so
// every research type is graded the same honest way.
// ---------------------------------------------------------------------------------

function composeResult({
  researchType,
  topic,
  market,
  kind,
  specializedRecords,
  confidence,
  recommendations,
  verificationStatus,
  researchDate,
}) {
  const analysis = analyzeResearchData(specializedRecords, kind);
  const limitations = [...analysis.limitations];

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && !analysis.anyEvidenceSupplied) {
    finalVerificationStatus = 'unverified';
    limitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptyResearchAgentResult(researchType, topic);
  result.market = market || '';
  result.findings = analysis.findings;
  result.evidence = analysis.evidence;
  result.source = analysis.source;
  result.confidence = confidence || 'unassessed';
  result.limitations = limitations;
  result.recommendations = deriveRecommendations(recommendations);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = specializedRecords;

  const validation = validateResearchAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed research result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------
// One function per supported research type.
// ---------------------------------------------------------------------------------

function runMarketResearch(params = {}) {
  const record = buildMarketRecord(params, 'runMarketResearch');
  return composeResult({
    researchType: 'market_research',
    topic: params.topic || `Market research: ${record.market}`,
    market: record.market,
    kind: 'market',
    specializedRecords: [record],
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: record.research_date,
  });
}

function runGlobalMarketResearch(params = {}) {
  const { markets, category = '', customerSegment = '', researchDate, topic } = params;
  requireNonEmptyArray(markets, 'markets', 'runGlobalMarketResearch');

  const records = markets.map((entry) => {
    requireObjectEntry(entry, 'markets', 'runGlobalMarketResearch');
    return buildMarketRecord(
      {
        country: entry.country,
        market: entry.market,
        category: entry.category !== undefined ? entry.category : category,
        customerSegment: entry.customerSegment !== undefined ? entry.customerSegment : customerSegment,
        demandSignals: entry.demandSignals,
        competitors: entry.competitors,
        trends: entry.trends,
        opportunities: entry.opportunities,
        risks: entry.risks,
        evidence: entry.evidence,
        researchDate: entry.researchDate || researchDate,
      },
      'runGlobalMarketResearch'
    );
  });

  const marketList = records.map((record) => record.market).join(', ');
  return composeResult({
    researchType: 'global_market_research',
    topic: topic || `Global market research: ${marketList}`,
    market: marketList,
    kind: 'market',
    specializedRecords: records,
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: researchDate || todayIsoDate(),
  });
}

function runCompetitorResearch(params = {}) {
  const { competitors, topic } = params;
  requireNonEmptyArray(competitors, 'competitors', 'runCompetitorResearch');

  const records = competitors.map((entry) => {
    requireObjectEntry(entry, 'competitors', 'runCompetitorResearch');
    return buildCompetitorRecord(entry, 'runCompetitorResearch');
  });

  const competitorList = records.map((record) => record.competitor).join(', ');
  return composeResult({
    researchType: 'competitor_research',
    topic: topic || `Competitor research: ${competitorList}`,
    market: records[0].market || '',
    kind: 'competitor',
    specializedRecords: records,
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
  });
}

function runTrendResearch(params = {}) {
  const { trends, market = '', topic } = params;
  requireNonEmptyArray(trends, 'trends', 'runTrendResearch');

  const records = trends.map((entry) => {
    requireObjectEntry(entry, 'trends', 'runTrendResearch');
    return buildGenericRecord({ ...entry, market: entry.market || market }, 'runTrendResearch');
  });

  const topicList = records.map((record) => record.topic).join(', ');
  return composeResult({
    researchType: 'trend_research',
    topic: topic || `Trend research: ${topicList}`,
    market,
    kind: 'generic',
    specializedRecords: records,
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
  });
}

function runCustomerMarketIntelligence(params = {}) {
  const { segments, topic } = params;
  requireNonEmptyArray(segments, 'segments', 'runCustomerMarketIntelligence');

  const records = segments.map((entry) => {
    requireObjectEntry(entry, 'segments', 'runCustomerMarketIntelligence');
    return buildCustomerSegmentRecord(entry, 'runCustomerMarketIntelligence');
  });

  const segmentList = records.map((record) => record.segment_definition).join(', ');
  return composeResult({
    researchType: 'customer_market_intelligence',
    topic: topic || `Customer/market intelligence: ${segmentList}`,
    market: records[0].market || '',
    kind: 'customer_segment',
    specializedRecords: records,
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
  });
}

// ---------------------------------------------------------------------------------
// Structured ecommerce customer segmentation - the first genuinely DERIVED (not just
// relayed) output in this module: a deterministic, threshold-based classification of
// a customer/cohort into a segment, from structured behavioral business data only.
// Every threshold below is an explicit, documented constant - never AI/ML-inferred -
// and every derived label/need/opportunity/recommendation traces back to exactly
// which threshold fired, the same "mechanical, verifiable, never invented" philosophy
// agent/core/seoQualityChecker.js and agent/core/listingQualityChecker.js already use
// for their own dimension checks (applied here to classification instead of
// validation).
//
// "Do not infer sensitive personal attributes": the only inputs this classifier
// accepts are purchase behavior, product interest, order frequency, customer value,
// and engagement - all transactional/behavioral business data. There is no field
// anywhere in this classifier for age, gender, location, health, income, or any other
// personal attribute, so none can be used even by accident - a structural guarantee,
// not just a stated one, reused as a standing limitations entry on every result.
//
// Composes agent/core/customerSegmentResearchModel.js as-is for the segment/evidence/
// needs fields (segment_definition, evidence, needs) - reused directly, not
// duplicated. "Opportunity" and "recommended strategy" surface through this module's
// own composeResult path as `findings`/`recommendations` respectively - the same two
// envelope fields every other research type already has, so no new schema field is
// needed for either.
// ---------------------------------------------------------------------------------

const FREQUENT_ORDER_COUNT_THRESHOLD = 5;
const NEW_CUSTOMER_ORDER_COUNT_THRESHOLD = 1;
const HIGH_VALUE_LIFETIME_THRESHOLD = 500;
const AT_RISK_DAYS_SINCE_LAST_ORDER_THRESHOLD = 90;
const ENGAGED_SITE_VISITS_THRESHOLD = 4;
const ENGAGED_EMAIL_OPEN_RATE_THRESHOLD = 0.3;

function classifyOrderFrequency(orderFrequency) {
  if (!orderFrequency || typeof orderFrequency.orderCount !== 'number') return null;
  const { orderCount, daysSinceLastOrder } = orderFrequency;
  let tier;
  if (orderCount <= NEW_CUSTOMER_ORDER_COUNT_THRESHOLD) tier = 'new';
  else if (orderCount >= FREQUENT_ORDER_COUNT_THRESHOLD) tier = 'frequent';
  else tier = 'occasional';
  const atRisk = typeof daysSinceLastOrder === 'number' && daysSinceLastOrder >= AT_RISK_DAYS_SINCE_LAST_ORDER_THRESHOLD;
  return { tier, atRisk, orderCount, daysSinceLastOrder };
}

function classifyCustomerValue(customerValue) {
  if (!customerValue || typeof customerValue.lifetimeValue !== 'number') return null;
  const tier = customerValue.lifetimeValue >= HIGH_VALUE_LIFETIME_THRESHOLD ? 'high_value' : 'standard_value';
  return { tier, lifetimeValue: customerValue.lifetimeValue };
}

function classifyEngagement(engagement) {
  if (!engagement) return null;
  const hasSiteVisits = typeof engagement.siteVisitsLast30Days === 'number';
  const hasEmailOpenRate = typeof engagement.emailOpenRate === 'number';
  if (!hasSiteVisits && !hasEmailOpenRate) return null;
  const isEngaged =
    (hasSiteVisits && engagement.siteVisitsLast30Days >= ENGAGED_SITE_VISITS_THRESHOLD) ||
    (hasEmailOpenRate && engagement.emailOpenRate >= ENGAGED_EMAIL_OPEN_RATE_THRESHOLD);
  return { tier: isEngaged ? 'engaged' : 'low_engagement' };
}

// One entry per axis that produces an actionable need/opportunity/recommendation.
// Baseline tiers ('occasional', 'standard_value', 'engaged') are still shown in the
// segment label for completeness, but have no entry here - there is nothing
// actionable to say about a customer who is simply average on that axis.
const AXIS_INSIGHTS = {
  at_risk: {
    need: 'Reassurance and a reason to return before the relationship is lost.',
    opportunity: 'Win-back opportunity before this customer churns entirely.',
    recommendation: 'Send a time-limited win-back offer or reminder.',
  },
  new: {
    need: 'Onboarding and first-purchase confidence (reviews, guarantees, easy support).',
    opportunity: 'Early opportunity to convert a first-time buyer into a repeat customer.',
    recommendation: 'Send a post-purchase follow-up with care instructions and related product recommendations.',
  },
  frequent: {
    need: 'Recognition and reward for repeat purchasing.',
    opportunity: 'Loyalty/upsell opportunity given a track record of repeat purchases.',
    recommendation: 'Invite this customer to a loyalty or rewards program.',
  },
  high_value: {
    need: 'A premium, low-friction experience that matches their spend.',
    opportunity: 'High lifetime value - a priority segment for retention investment.',
    recommendation: 'Offer early access to new products or a dedicated support channel.',
  },
  low_engagement: {
    need: 'A reason to re-engage through a channel they actually use.',
    opportunity: 'Re-engagement opportunity via an alternate channel.',
    recommendation: 'Try a different channel (e.g. SMS or a retargeting ad) instead of repeating the same message.',
  },
};

// A small, explicit set of higher-value combined insights - not a full cross-product
// matrix (that would risk implying precision this deterministic module doesn't have).
const COMBINED_INSIGHTS = [
  {
    matches: (axes) => axes.has('at_risk') && axes.has('high_value'),
    opportunity: 'High-value customer showing churn risk - the highest-priority win-back opportunity in this segment.',
    recommendation: 'Prioritize this customer for personal outreach or a premium win-back offer, not a generic campaign.',
  },
  {
    matches: (axes) => axes.has('frequent') && axes.has('high_value'),
    opportunity: 'Strong upsell/cross-sell candidate given repeat, high-value purchase history.',
    recommendation: 'Invite this customer to a VIP tier with early access or exclusive perks, not just a standard loyalty program.',
  },
];

function deriveCustomerSegmentation(params = {}) {
  const fnName = 'deriveCustomerSegmentation';
  const {
    segmentReference,
    purchaseBehavior,
    productInterest,
    orderFrequency,
    customerValue,
    engagement,
    evidence,
    market = '',
    topic,
    confidence,
    recommendations: callerRecommendations,
    verificationStatus,
    researchDate,
  } = params;
  requireNonEmptyString(segmentReference, 'segmentReference', fnName);

  const frequency = classifyOrderFrequency(orderFrequency);
  const value = classifyCustomerValue(customerValue);
  const engagementResult = classifyEngagement(engagement);
  const interestCategories = normalizeArray(productInterest && productInterest.categoriesOfInterest);
  const topCategories = normalizeArray(purchaseBehavior && purchaseBehavior.topCategories);

  const activeAxes = new Set();
  const labelFragments = [];
  const needs = [];
  const opportunityFindings = [];
  const recommendedStrategies = [];

  if (frequency) {
    if (frequency.tier === 'new') {
      activeAxes.add('new');
      labelFragments.push(`new customer (${frequency.orderCount} order${frequency.orderCount === 1 ? '' : 's'})`);
    } else if (frequency.tier === 'frequent') {
      activeAxes.add('frequent');
      labelFragments.push(`frequent buyer (${frequency.orderCount}+ orders)`);
    } else {
      labelFragments.push('occasional buyer');
    }
    if (frequency.atRisk) {
      activeAxes.add('at_risk');
      labelFragments.push(`at risk of churn (${frequency.daysSinceLastOrder}+ days since last order)`);
    }
  }

  if (value) {
    if (value.tier === 'high_value') {
      activeAxes.add('high_value');
      labelFragments.push(`high value (lifetime spend $${value.lifetimeValue})`);
    } else {
      labelFragments.push('standard value');
    }
  }

  if (engagementResult) {
    if (engagementResult.tier === 'engaged') {
      labelFragments.push('engaged');
    } else {
      activeAxes.add('low_engagement');
      labelFragments.push('low engagement');
    }
  }

  for (const axisId of activeAxes) {
    const insight = AXIS_INSIGHTS[axisId];
    needs.push(insight.need);
    opportunityFindings.push(insight.opportunity);
    recommendedStrategies.push(insight.recommendation);
  }

  for (const combined of COMBINED_INSIGHTS) {
    if (combined.matches(activeAxes)) {
      opportunityFindings.push(combined.opportunity);
      recommendedStrategies.push(combined.recommendation);
    }
  }

  if (interestCategories.length > 0) {
    labelFragments.push(`interested in: ${interestCategories.join(', ')}`);
    needs.push(`Content and offers relevant to: ${interestCategories.join(', ')}.`);
    opportunityFindings.push(`Cross-sell opportunity in categories this customer has shown interest in: ${interestCategories.join(', ')}.`);
  }
  if (topCategories.length > 0) {
    labelFragments.push(`top purchased categories: ${topCategories.join(', ')}`);
  }

  const hasAnyBehavioralData = Boolean(
    frequency || value || engagementResult || interestCategories.length > 0 || topCategories.length > 0
  );
  const segmentDefinition = hasAnyBehavioralData
    ? labelFragments.join(', ')
    : '(insufficient behavioral data to classify)';

  const record = createEmptyCustomerSegmentResearchRecord(segmentDefinition);
  record.needs = needs;
  record.market = market;
  record.evidence = normalizeArray(evidence);
  record.confidence = confidence || 'unassessed';

  const recordValidation = validateCustomerSegmentResearchShape(record);
  if (!recordValidation.valid) {
    throw new Error(`${fnName} produced an invalid customer segment research record: ${recordValidation.errors.join('; ')}`);
  }

  const limitations = [
    'No live analytics/CRM platform is configured; this classification reflects only caller-supplied behavioral metrics.',
    'This segment is derived only from purchase, order, engagement, and product-interest behavior - no personal attribute (e.g. age, gender, location, health) is ever used or inferred.',
  ];
  if (!hasAnyBehavioralData) {
    limitations.push('No purchase behavior, order frequency, customer value, engagement, or product interest data was supplied - this segment could not be meaningfully classified.');
  }
  if (record.evidence.length === 0) {
    limitations.push(`No evidence was supplied for ${segmentReference}.`);
  }

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && record.evidence.length === 0) {
    finalVerificationStatus = 'unverified';
    limitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptyResearchAgentResult('customer_segmentation', topic || `Customer segmentation: ${segmentReference}`);
  result.market = market;
  result.findings = opportunityFindings;
  result.evidence = record.evidence;
  result.source = [];
  result.confidence = confidence || 'unassessed';
  result.limitations = limitations;
  result.recommendations = deriveRecommendations([...recommendedStrategies, ...normalizeArray(callerRecommendations)]);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = [record];

  const resultValidation = validateResearchAgentResultShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed customer segmentation result failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return result;
}

// Deliberately distinct from Product's agent/core/opportunityAnalysisModel.js - see
// module header. Each signal is a market/customer/competitor-evidence-based
// observation, not an evaluation of one specific product candidate.
function runOpportunityDiscovery(params = {}) {
  const { signals, market = '', topic } = params;
  requireNonEmptyArray(signals, 'signals', 'runOpportunityDiscovery');

  const records = signals.map((entry) => {
    requireObjectEntry(entry, 'signals', 'runOpportunityDiscovery');
    return buildGenericRecord({ ...entry, market: entry.market || market }, 'runOpportunityDiscovery');
  });

  const topicList = records.map((record) => record.topic).join(', ');
  return composeResult({
    researchType: 'opportunity_discovery',
    topic: topic || `Opportunity discovery: ${topicList}`,
    market,
    kind: 'generic',
    specializedRecords: records,
    confidence: params.confidence,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
  });
}

const RESEARCH_TYPE_HANDLERS = {
  market_research: runMarketResearch,
  global_market_research: runGlobalMarketResearch,
  competitor_research: runCompetitorResearch,
  trend_research: runTrendResearch,
  customer_market_intelligence: runCustomerMarketIntelligence,
  opportunity_discovery: runOpportunityDiscovery,
  customer_segmentation: deriveCustomerSegmentation,
};

// The single entry point: dispatches by researchType to the matching function above.
// Never guesses an unrecognized type - throws a clear error instead.
function runResearch({ researchType, ...params } = {}) {
  const handler = RESEARCH_TYPE_HANDLERS[researchType];
  if (!handler) {
    throw new Error(`Unknown research type: ${researchType}. Must be one of: ${RESEARCH_TYPES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  runMarketResearch,
  runGlobalMarketResearch,
  runCompetitorResearch,
  runTrendResearch,
  runCustomerMarketIntelligence,
  runOpportunityDiscovery,
  deriveCustomerSegmentation,
  runResearch,
  retrieveResearchData,
  analyzeResearchData,
  deriveRecommendations,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Research Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      runMarketResearch({
        country: 'DE',
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['Rising search interest in insulated jackets (caller-supplied placeholder).'],
        competitors: ['(example competitor placeholder)'],
        trends: ['Growing preference for recycled materials (caller-supplied placeholder).'],
        opportunities: ['Underserved plus-size range (caller-supplied placeholder).'],
        evidence: ['(placeholder source reference)'],
      }),
    () =>
      runCompetitorResearch({
        competitors: [
          {
            competitor: '(Example Competitor Co.)',
            market: 'European Union',
            productCategory: 'outdoor apparel',
            strengths: ['Fast shipping (caller-supplied placeholder).'],
            weaknesses: ['Limited size range (caller-supplied placeholder).'],
            source: ['(placeholder source reference)'],
          },
        ],
      }),
    () =>
      runTrendResearch({
        market: 'European Union',
        trends: [{ topic: 'Recycled-material outerwear', finding: 'Caller-supplied placeholder finding.' }],
      }),
    () =>
      runCustomerMarketIntelligence({
        segments: [
          {
            segmentDefinition: 'Budget-conscious outdoor enthusiasts (caller-supplied placeholder).',
            needs: ['Durable gear at low price points (caller-supplied placeholder).'],
          },
        ],
      }),
    () =>
      runOpportunityDiscovery({
        market: 'European Union',
        signals: [{ topic: 'Underserved plus-size outdoor apparel', finding: 'Caller-supplied placeholder finding.' }],
      }),
    () =>
      runGlobalMarketResearch({
        markets: [
          { country: 'DE', market: 'European Union', demandSignals: ['(placeholder demand signal)'] },
          { country: 'US', market: 'North America', demandSignals: ['(placeholder demand signal)'] },
        ],
      }),
    () =>
      deriveCustomerSegmentation({
        segmentReference: '(Example customer cohort: repeat hiking-gear buyers)',
        purchaseBehavior: { topCategories: ['outdoor apparel'] },
        productInterest: { categoriesOfInterest: ['winter accessories'] },
        orderFrequency: { orderCount: 6, daysSinceLastOrder: 100 },
        customerValue: { lifetimeValue: 620 },
        engagement: { emailOpenRate: 0.12 },
        evidence: ['(placeholder Shopify order history export)'],
      }),
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.research_type} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
