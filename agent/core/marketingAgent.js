'use strict';

// The Marketing Agent (CLAUDE.md section 2, specialist #5: "Campaign ideas, copy, and
// marketing strategy"). Supports 8 capabilities: marketing strategy, audience
// segmentation, offers, promotions, retention, campaign planning, email strategy, and
// conversion opportunities.
//
// Deterministic only - no AI API call, no external fetch, no live marketing-platform
// API (none is configured or called anywhere in this project). Callers supply
// already-structured evidence; this module's job is to validate it, compose it into
// the existing marketing schemas (agent/core/marketingAnalysisModel.js,
// agent/core/growthOpportunityModel.js, agent/core/customerSegmentResearchModel.js -
// all reused as-is, zero new schema surface), and grade it honestly - never to
// synthesize or guess a message, an offer, or an assessment. Same philosophy and
// structure as agent/core/researchAgent.js, agent/core/seoAgent.js, and
// agent/core/listingAgent.js: retrieval (build + validate records), analysis (flatten
// findings/evidence/source, derive honest limitations), and recommendation (relay only
// what the caller supplied) stay distinct, composed by one thin composeResult().
//
// Capability -> schema mapping:
//   - marketing strategy, offers, promotions, and email strategy all compose one
//     agent/core/marketingAnalysisModel.js record (marketing_channel, target_segment,
//     product, campaign, objective, message, offer, timing, evidence,
//     expected_outcome, verification_status) - the same schema, differing only in
//     which fields the capability's topic/label emphasizes, exactly the way SEO's
//     product/collection/content SEO share one composeSuggestionResult over 3 record
//     builders. email_strategy pins marketing_channel to 'email' (always, not just a
//     default) - the same pinning pattern SEO's collection_seo/content_seo use for
//     subject_type.
//   - campaign planning composes its own dedicated agent/core/campaignPlanModel.js
//     record (objective, audience, offer, message, channel, creative_direction, cta,
//     kpi, measurement_plan) instead - a full campaign plan needs fields none of the 4
//     capabilities above need, so it gets its own schema rather than further widening
//     the shared one, the same dedicated-schema-when-the-field-set-genuinely-differs
//     precedent agent/core/listingContentModel.js already established relative to
//     agent/core/listingOptimizationModel.js. No campaign is ever launched
//     automatically - agent/core/campaignPlanModel.js has no execute/send/launch
//     function of any kind; acting on a plan is a separate, human-approved action via
//     approvals/.
//   - audience segmentation reuses agent/core/customerSegmentResearchModel.js records
//     directly - not rebuilt here at all. It delegates straight to
//     agent/core/researchAgent.js's retrieveResearchData('customer_segment', ...) and
//     analyzeResearchData('customer_segment') (both already fully validated/tested
//     there), the same cross-agent reuse pattern SEO/Listing already established for
//     retrieveResearchData('generic', ...).
//   - retention and conversion opportunities both compose
//     agent/core/growthOpportunityModel.js records (already scoped for exactly this:
//     upselling, cross-selling, retention, repeat purchases, customer re-engagement).
//     retention pins opportunity_type to 'retention' over one record (mirrors
//     email_strategy's channel pin); conversion_opportunities accepts an array of
//     entries across any of the other opportunity types (mirrors keyword_research's
//     multi-entry shape) - retention is a convenience/pinned single-type variant, not
//     mutually exclusive with conversion_opportunities.
//
// marketingAnalysisModel.js and growthOpportunityModel.js both already carry their own
// `evidence` array field (unlike listingOptimizationModel.js's fields) - so, exactly
// like agent/core/researchAgent.js's buildMarketRecord, evidence is assigned directly
// from caller-supplied input inside each record builder, with no separate
// buildSupportingEvidence step layered on top (that extra step exists in
// agent/core/seoAgent.js/listingAgent.js specifically because their schemas lack an
// evidence field of their own).
//
// Confidence: caller-asserted only, defaulting to 'unassessed' - same convention as
// every other module in this project. A 'verified' claim asserted without evidence is
// downgraded back to 'unverified' (same honesty guard as researchAgent.js's).

const {
  createEmptyMarketingAnalysisRecord,
  validateMarketingAnalysisShape,
} = require('./marketingAnalysisModel');
const {
  createEmptyGrowthOpportunityRecord,
  validateGrowthOpportunityShape,
} = require('./growthOpportunityModel');
const {
  createEmptyCampaignPlanRecord,
  validateCampaignPlanShape,
} = require('./campaignPlanModel');
const {
  MARKETING_CAPABILITIES,
  createEmptyMarketingAgentResult,
  validateMarketingAgentResultShape,
} = require('./marketingAgentResultModel');
const { retrieveResearchData, analyzeResearchData, deriveRecommendations } = require('./researchAgent');
const { rankGrowthOpportunities } = require('./growthOpportunityEngine');

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
// Retrieval - builds and validates specialized records from raw caller-supplied
// entries. This IS "data retrieval" in this deterministic-only architecture (see
// module header) - no live marketing-platform API is configured. Never invents an
// entry that wasn't supplied.
// ---------------------------------------------------------------------------------

function buildMarketingAnalysisRecord(entry, fnName) {
  requireNonEmptyString(entry.marketingChannel, 'marketingChannel', fnName);
  const record = createEmptyMarketingAnalysisRecord(entry.marketingChannel, entry.campaign || '');
  record.target_segment = entry.targetSegment || '';
  record.product = entry.product || '';
  record.objective = entry.objective || '';
  record.message = entry.message || '';
  record.offer = entry.offer || '';
  record.timing = entry.timing || '';
  record.evidence = normalizeArray(entry.evidence);
  record.expected_outcome = entry.expectedOutcome || '';
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateMarketingAnalysisShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid marketing analysis record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildGrowthOpportunityRecord(entry, fnName) {
  requireNonEmptyString(entry.productReference, 'productReference', fnName);
  const record = createEmptyGrowthOpportunityRecord(entry.opportunityType || 'unclassified', entry.productReference);
  record.related_products = normalizeArray(entry.relatedProducts);
  record.target_segment = entry.targetSegment || '';
  record.offer = entry.offer || '';
  record.recommendation = entry.recommendation || '';
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateGrowthOpportunityShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid growth opportunity record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildCampaignPlanRecord(entry, fnName) {
  requireNonEmptyString(entry.campaignReference, 'campaignReference', fnName);
  const record = createEmptyCampaignPlanRecord(entry.campaignReference);
  record.objective = entry.objective || '';
  record.audience = entry.audience || '';
  record.offer = entry.offer || '';
  record.message = entry.message || '';
  record.channel = entry.channel || '';
  record.creative_direction = entry.creativeDirection || '';
  record.cta = entry.cta || '';
  record.kpi = normalizeArray(entry.kpi);
  record.measurement_plan = normalizeArray(entry.measurementPlan);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateCampaignPlanShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid campaign plan record: ${validation.errors.join('; ')}`);
  }
  return record;
}

const RECORD_BUILDERS = {
  marketing_analysis: buildMarketingAnalysisRecord,
  growth_opportunity: buildGrowthOpportunityRecord,
  campaign_plan: buildCampaignPlanRecord,
};

// Exported for reuse, mirroring agent/core/seoAgent.js's retrieveSeoData /
// agent/core/listingAgent.js's retrieveListingData. 'customer_segment' and 'generic'
// delegate straight to agent/core/researchAgent.js's retrieveResearchData rather than
// reimplementing it - the only "external source" in this architecture is the caller's
// own structured input either way.
function retrieveMarketingData(kind, entries, fnName) {
  if (kind === 'customer_segment' || kind === 'generic') {
    return retrieveResearchData(kind, entries, fnName);
  }
  const builder = RECORD_BUILDERS[kind];
  if (!builder) {
    throw new Error(`retrieveMarketingData received an unknown record kind: ${kind}`);
  }
  return entries.map((entry) => builder(entry, fnName));
}

// ---------------------------------------------------------------------------------
// Analysis - pure analysis of already-retrieved marketing_analysis/growth_opportunity
// records: flattens findings/evidence/source and builds the honest limitations list.
// audience_segmentation does not use this - it reuses researchAgent.js's own
// analyzeResearchData('customer_segment') directly instead (see module header).
// ---------------------------------------------------------------------------------

function extractMarketingAnalysisRecord(record) {
  return {
    findings: [record.objective, record.message, record.offer, record.expected_outcome].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.campaign || record.marketing_channel || '(unspecified campaign)',
  };
}

function extractGrowthOpportunityRecord(record) {
  return {
    findings: [record.recommendation, record.offer].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.product_reference || '(unspecified product)',
  };
}

function extractCampaignPlanRecord(record) {
  return {
    findings: [
      record.objective,
      record.audience,
      record.offer,
      record.message,
      record.creative_direction,
      record.cta,
      ...record.kpi,
      ...record.measurement_plan,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.campaign_reference || '(unspecified campaign)',
  };
}

// growthOpportunityEngine.js's rankGrowthOpportunities() output records are a
// different shape than growthOpportunityModel.js's (see marketing_opportunity_ranking
// below) - a dedicated extractor, not a reuse of extractGrowthOpportunityRecord above.
function extractRankedGrowthOpportunityRecord(record) {
  return {
    findings: [record.opportunity, record.reason, record.required_action].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.opportunity || '(unspecified opportunity)',
  };
}

const RECORD_KIND_EXTRACTORS = {
  marketing_analysis: extractMarketingAnalysisRecord,
  growth_opportunity: extractGrowthOpportunityRecord,
  campaign_plan: extractCampaignPlanRecord,
  ranked_growth_opportunity: extractRankedGrowthOpportunityRecord,
};

function analyzeMarketingRecords(records, kind, limitationHeader) {
  const extractor = RECORD_KIND_EXTRACTORS[kind];
  const findings = [];
  const evidence = [];
  const source = [];
  const limitations = [limitationHeader];
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
// Composition - a thin assembler: applies the verified-without-evidence honesty guard,
// builds the common agent/core/marketingAgentResultModel.js envelope, and validates
// it. The only place every capability's result gets combined into one common shape.
// ---------------------------------------------------------------------------------

function composeResult({
  capability,
  topic,
  market,
  findings,
  evidence,
  source,
  confidence,
  limitations,
  recommendations,
  verificationStatus,
  researchDate,
  specializedRecords,
}) {
  const finalLimitations = [...limitations];
  const anyEvidenceSupplied = evidence.length > 0 || source.length > 0;

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && !anyEvidenceSupplied) {
    finalVerificationStatus = 'unverified';
    finalLimitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptyMarketingAgentResult(capability, topic);
  result.market = market || '';
  result.findings = findings;
  result.evidence = evidence;
  result.source = source;
  result.confidence = confidence || 'unassessed';
  result.limitations = finalLimitations;
  result.recommendations = deriveRecommendations(recommendations);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = specializedRecords;

  const validation = validateMarketingAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Marketing agent result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

const MARKETING_ANALYSIS_LIMITATION_HEADER =
  'No live marketing platform is configured; this result reflects only caller-supplied evidence.';
const GROWTH_OPPORTUNITY_LIMITATION_HEADER =
  'No live sales/customer data platform is configured; this result reflects only caller-supplied evidence.';
const CAMPAIGN_PLAN_LIMITATION_HEADER =
  'This plan is not launched automatically - no live marketing platform is configured, and this result reflects only caller-supplied evidence.';
const RANKED_GROWTH_OPPORTUNITY_LIMITATION_HEADER =
  'No live sales/performance data platform is configured; this ranking reflects only caller-supplied opportunity candidates and their evidence - it never ranks an opportunity nobody supplied.';

// Shared by marketing strategy, offers, promotions, campaign planning, and email
// strategy - all 5 build one agent/core/marketingAnalysisModel.js record and honest
// limitations the same way, differing only in the topic/label text and (for email
// strategy) a pinned marketing_channel.
function composeMarketingAnalysisResult(record, params, capability, topicFallback) {
  const analysis = analyzeMarketingRecords([record], 'marketing_analysis', MARKETING_ANALYSIS_LIMITATION_HEADER);
  return composeResult({
    capability,
    topic: params.topic || topicFallback,
    market: params.market || '',
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

// ---------------------------------------------------------------------------------
// One function per supported capability.
// ---------------------------------------------------------------------------------

function analyzeMarketingStrategy(params = {}) {
  const fnName = 'analyzeMarketingStrategy';
  const record = buildMarketingAnalysisRecord(params, fnName);
  return composeMarketingAnalysisResult(
    record,
    params,
    'marketing_strategy',
    `Marketing strategy: ${record.campaign || record.marketing_channel}`
  );
}

function analyzeOffers(params = {}) {
  const fnName = 'analyzeOffers';
  const record = buildMarketingAnalysisRecord(params, fnName);
  return composeMarketingAnalysisResult(
    record,
    params,
    'offers',
    `Offer: ${record.offer || record.campaign || record.marketing_channel}`
  );
}

function analyzePromotions(params = {}) {
  const fnName = 'analyzePromotions';
  const record = buildMarketingAnalysisRecord(params, fnName);
  return composeMarketingAnalysisResult(
    record,
    params,
    'promotions',
    `Promotion: ${record.campaign || record.offer || record.marketing_channel}`
  );
}

// Composes a dedicated agent/core/campaignPlanModel.js record - not
// composeMarketingAnalysisResult, since a full campaign plan is a different, richer
// schema than the shared marketing_analysis one the other 4 marketing-analysis-based
// capabilities use (see module header).
function analyzeCampaignPlanning(params = {}) {
  const fnName = 'analyzeCampaignPlanning';
  const record = buildCampaignPlanRecord(params, fnName);
  const analysis = analyzeMarketingRecords([record], 'campaign_plan', CAMPAIGN_PLAN_LIMITATION_HEADER);
  return composeResult({
    capability: 'campaign_planning',
    topic: params.topic || `Campaign plan: ${record.campaign_reference}`,
    market: params.market || '',
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

// Pins marketing_channel to 'email' - always, not just a default - the same pinning
// pattern agent/core/seoAgent.js's collection_seo/content_seo use for subject_type.
function analyzeEmailStrategy(params = {}) {
  const fnName = 'analyzeEmailStrategy';
  const record = buildMarketingAnalysisRecord({ ...params, marketingChannel: 'email' }, fnName);
  return composeMarketingAnalysisResult(
    record,
    params,
    'email_strategy',
    `Email strategy: ${record.campaign || record.target_segment || '(no campaign set)'}`
  );
}

// Reuses agent/core/customerSegmentResearchModel.js directly via
// agent/core/researchAgent.js's own retrieveResearchData/analyzeResearchData - not
// rebuilt here (see module header).
function analyzeAudienceSegmentation(params = {}) {
  const fnName = 'analyzeAudienceSegmentation';
  const { segments, topic, market = '' } = params;
  requireNonEmptyArray(segments, 'segments', fnName);

  const records = segments.map((entry) => {
    requireObjectEntry(entry, 'segments', fnName);
    return retrieveResearchData('customer_segment', [entry], fnName)[0];
  });

  const analysis = analyzeResearchData(records, 'customer_segment');
  const segmentList = records.map((record) => record.segment_definition).join(', ');
  return composeResult({
    capability: 'audience_segmentation',
    topic: topic || `Audience segmentation: ${segmentList}`,
    market,
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
    specializedRecords: records,
  });
}

// Pins opportunity_type to 'retention' - always, not just a default - the same
// pinning pattern analyzeEmailStrategy uses for marketing_channel.
function analyzeRetention(params = {}) {
  const fnName = 'analyzeRetention';
  const record = buildGrowthOpportunityRecord({ ...params, opportunityType: 'retention' }, fnName);
  const analysis = analyzeMarketingRecords([record], 'growth_opportunity', GROWTH_OPPORTUNITY_LIMITATION_HEADER);
  return composeResult({
    capability: 'retention',
    topic: params.topic || `Retention: ${record.product_reference}`,
    market: params.market || '',
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

// Accepts an array of entries across any growth-opportunity type (upselling,
// cross-selling, repeat purchases, customer re-engagement, or retention) - mirrors
// keyword_research's multi-entry shape. Not mutually exclusive with analyzeRetention
// above, which is a convenience/pinned single-type variant of the same schema.
function analyzeConversionOpportunities(params = {}) {
  const fnName = 'analyzeConversionOpportunities';
  const { opportunities, topic, market = '' } = params;
  requireNonEmptyArray(opportunities, 'opportunities', fnName);

  const records = opportunities.map((entry) => {
    requireObjectEntry(entry, 'opportunities', fnName);
    return buildGrowthOpportunityRecord(entry, fnName);
  });

  const analysis = analyzeMarketingRecords(records, 'growth_opportunity', GROWTH_OPPORTUNITY_LIMITATION_HEADER);
  const productList = records.map((record) => record.product_reference).join(', ');
  return composeResult({
    capability: 'conversion_opportunities',
    topic: topic || `Conversion opportunities: ${productList}`,
    market,
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
    specializedRecords: records,
  });
}

// Ranks caller-supplied marketing opportunity candidates via
// agent/core/growthOpportunityEngine.js's rankGrowthOpportunities() - never gathers,
// infers, or invents a candidate itself (see that module's own header). Every
// candidate's category is pinned to 'marketing' - always, not just a default - the
// same pinning pattern analyzeRetention uses for opportunityType, so this Marketing
// capability can never accidentally rank a candidate from another growth surface.
// Answers "what is my best marketing opportunity" only when real candidates (with
// real reason/evidence/impact/action-classification) are supplied - a bare free-text
// objective with no candidates is honestly insufficient input, not a guess.
function analyzeMarketingOpportunities(params = {}) {
  const fnName = 'analyzeMarketingOpportunities';
  const { candidates, topic, market = '' } = params;
  requireNonEmptyArray(candidates, 'candidates', fnName);

  const pinnedCandidates = candidates.map((entry) => {
    requireObjectEntry(entry, 'candidates', fnName);
    return { ...entry, category: 'marketing' };
  });

  const ranked = rankGrowthOpportunities(pinnedCandidates);
  const records = ranked.opportunities;

  const analysis = analyzeMarketingRecords(
    records,
    'ranked_growth_opportunity',
    RANKED_GROWTH_OPPORTUNITY_LIMITATION_HEADER
  );
  const opportunityList = records.map((record) => record.opportunity).join(', ');
  return composeResult({
    capability: 'marketing_opportunity_ranking',
    topic: topic || `Marketing opportunity ranking: ${opportunityList || '(no candidates)'}`,
    market,
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: records,
  });
}

const MARKETING_CAPABILITY_HANDLERS = {
  marketing_strategy: analyzeMarketingStrategy,
  audience_segmentation: analyzeAudienceSegmentation,
  offers: analyzeOffers,
  promotions: analyzePromotions,
  retention: analyzeRetention,
  campaign_planning: analyzeCampaignPlanning,
  email_strategy: analyzeEmailStrategy,
  conversion_opportunities: analyzeConversionOpportunities,
  marketing_opportunity_ranking: analyzeMarketingOpportunities,
};

// The single entry point: dispatches by capability to the matching function above.
// Never guesses an unrecognized capability - throws a clear error instead.
function runMarketingAgent({ capability, ...params } = {}) {
  const handler = MARKETING_CAPABILITY_HANDLERS[capability];
  if (!handler) {
    throw new Error(`Unknown Marketing capability: ${capability}. Must be one of: ${MARKETING_CAPABILITIES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  analyzeMarketingStrategy,
  analyzeAudienceSegmentation,
  analyzeOffers,
  analyzePromotions,
  analyzeRetention,
  analyzeCampaignPlanning,
  analyzeEmailStrategy,
  analyzeConversionOpportunities,
  analyzeMarketingOpportunities,
  runMarketingAgent,
  retrieveMarketingData,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Marketing Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      analyzeMarketingStrategy({
        marketingChannel: 'email',
        campaign: '(Example winter jacket launch)',
        objective: 'Drive awareness of the new insulated jacket line (caller-supplied placeholder).',
        message: 'Stay warm this winter with our new insulated jacket line (caller-supplied placeholder).',
        targetSegment: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        evidence: ['(placeholder prior-campaign result)'],
      }),
    () =>
      analyzeAudienceSegmentation({
        segments: [
          {
            segmentDefinition: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
            needs: ['Reliable warmth without a premium price tag (caller-supplied placeholder).'],
          },
        ],
      }),
    () =>
      analyzeOffers({
        marketingChannel: 'email',
        offer: '15% off insulated jackets (caller-supplied placeholder).',
        campaign: '(Example winter jacket launch)',
      }),
    () =>
      analyzePromotions({
        marketingChannel: 'social',
        campaign: '(Example flash sale)',
        offer: '15% off insulated jackets (caller-supplied placeholder).',
        timing: 'This weekend only (caller-supplied placeholder).',
      }),
    () =>
      analyzeRetention({
        productReference: '(Example insulated jacket)',
        targetSegment: 'Lapsed customers, no purchase in 6 months (caller-supplied placeholder).',
        recommendation: 'Send a "we miss you" offer to lapsed customers (caller-supplied placeholder).',
      }),
    () =>
      analyzeCampaignPlanning({
        campaignReference: '(Example winter jacket launch)',
        objective: 'Drive first-week sales (caller-supplied placeholder).',
        audience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        offer: '15% off insulated jackets (caller-supplied placeholder).',
        message: 'Stay warm this winter with our new insulated jacket line (caller-supplied placeholder).',
        channel: 'email',
        creativeDirection: 'Lifestyle photography in cold-weather outdoor settings, warm color palette (caller-supplied placeholder).',
        cta: 'Shop the winter collection (caller-supplied placeholder).',
        kpi: ['Click-through rate (caller-supplied placeholder).', 'Conversion rate (caller-supplied placeholder).'],
        measurementPlan: ['Track via UTM-tagged links reviewed weekly in GA4 (caller-supplied placeholder).'],
        evidence: ['(placeholder prior-campaign result)'],
      }),
    () =>
      analyzeEmailStrategy({
        campaign: '(Example winter jacket launch)',
        targetSegment: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        message: 'A 3-part welcome series introducing the jacket line (caller-supplied placeholder).',
      }),
    () =>
      analyzeConversionOpportunities({
        opportunities: [
          {
            opportunityType: 'cross_selling',
            productReference: '(Example insulated jacket)',
            relatedProducts: ['(Example wool hat)'],
            recommendation: 'Recommend the wool hat alongside the jacket (caller-supplied placeholder).',
          },
          { opportunityType: 'repeat_purchases', productReference: '(Example insulated jacket)' },
        ],
      }),
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.capability} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
