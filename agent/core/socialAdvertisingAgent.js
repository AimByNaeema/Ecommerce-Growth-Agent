'use strict';

// The Social & Advertising Agent (CLAUDE.md section 2, specialist #6: "Social media
// and paid advertising"). Supports 13 capabilities: instagram, facebook, tiktok,
// pinterest, youtube (social), meta_ads, google_ads, tiktok_ads (advertising),
// social_media_strategy (cross-platform strategy generation), content_generation
// (platform-aware ecommerce content generation), content_calendar (structured
// social content calendar entries, optionally informed by Marketing Agent campaign
// context), advertising_strategy (pre-launch advertising strategy planning:
// campaign objective, audience, offer, creative angle, ad copy, CTA, budget
// recommendation, KPI, testing plan), and advertising_performance (advertising
// performance analysis: impressions, CTR, CPC, CPM, conversions, CPA, ROAS - actual
// metrics kept separate from calculated metrics and from recommendations).
//
// Deterministic only - no AI API call, no external fetch, no live social/ads platform
// API (none is configured or called anywhere in this project). Callers supply
// already-structured evidence; this module's job is to validate it, compose it into
// the existing schemas (agent/core/socialContentModel.js, agent/core/adCampaignModel.js
// - both reused as-is), and grade it honestly - never to synthesize or guess a caption,
// a targeting claim, or a performance figure. Same philosophy and structure as
// agent/core/researchAgent.js, agent/core/seoAgent.js, agent/core/listingAgent.js, and
// agent/core/marketingAgent.js: retrieval (build + validate records), analysis
// (flatten findings/evidence/source, derive honest limitations), and recommendation
// (relay only what the caller supplied) stay distinct, composed by one thin
// composeResult().
//
// Capability -> schema mapping:
//   - instagram, facebook, tiktok, pinterest, and youtube all compose one
//     agent/core/socialContentModel.js record (platform, content_reference,
//     content_type, objective, target_audience, caption, hashtags, posting_schedule,
//     evidence, expected_outcome, verification_status) - the same schema, differing
//     only in which platform value is pinned, exactly the way Marketing's
//     marketing_strategy/offers/promotions/email_strategy share one
//     marketingAnalysisModel.js record. Each of the 5 pins `platform` to its own value
//     (always, not just a default) - the same pinning pattern
//     agent/core/marketingAgent.js's analyzeEmailStrategy uses for
//     marketing_channel: 'email'.
//   - meta_ads, google_ads, and tiktok_ads all compose one
//     agent/core/adCampaignModel.js record (platform, campaign_reference, objective,
//     audience, budget, ad_creative, bidding_strategy, cta, kpi, measurement_plan,
//     evidence, verification_status) instead - a paid campaign needs fields organic
//     content doesn't (budget, bidding_strategy), so it gets its own dedicated schema
//     rather than widening socialContentModel.js, the same
//     dedicated-schema-when-the-field-set-genuinely-differs precedent
//     agent/core/campaignPlanModel.js already established relative to
//     agent/core/marketingAnalysisModel.js. No campaign is ever launched
//     automatically - agent/core/adCampaignModel.js has no execute/launch/spend
//     function of any kind; acting on a plan is a separate, human-approved action via
//     approvals/.
//   - social_media_strategy composes its own dedicated
//     agent/core/socialMediaStrategyModel.js record (strategy_reference, objective,
//     audience, content_pillars, platform_selection, posting_strategy, content_themes,
//     campaign_themes, kpis) - a cross-platform strategy needs fields none of the other
//     8 capabilities need, so it gets its own schema rather than widening either
//     existing one, the same dedicated-schema precedent campaign_planning established
//     for agent/core/marketingAgent.js relative to marketingAnalysisModel.js.
//     `platform_selection` reuses the same platform enums socialContentModel.js/
//     adCampaignModel.js already define - no new platform list, no platform beyond the
//     8 already in scope.
//   - content_generation composes its own dedicated
//     agent/core/platformContentModel.js record (platform, content_reference,
//     objective, target_audience, hooks, captions, ctas, content_ideas,
//     short_form_video_concepts, carousel_concepts, creative_briefs,
//     platform_adaptation_notes) - 7 distinct creative-element dimensions that
//     socialContentModel.js's single `caption` field was never meant to carry, so it
//     gets its own dedicated schema rather than widening that one, the same
//     dedicated-schema precedent social_media_strategy established above. `platform`
//     reuses socialContentModel.js's existing SOCIAL_PLATFORMS enum - content here is
//     always generated for, and adapted to, exactly one of the 5 in-scope social
//     platforms, never invented or rewritten by this module itself.
//   - content_calendar composes its own dedicated agent/core/contentCalendarModel.js
//     record (entry_reference, date, platform, content_type, topic, hook, cta,
//     campaign, product, kpi) - a plan-level scheduling record with fields
//     (date, campaign, product) none of the other 4 dedicated schemas carry, so it
//     gets its own schema too. When the caller supplies `campaignContext`, it is
//     validated and built into a real agent/core/campaignPlanModel.js record via
//     agent/core/marketingAgent.js's own retrieveMarketingData('campaign_plan', ...) -
//     reused directly, not reimplemented, the same cross-agent reuse precedent
//     agent/core/marketingAgent.js's own analyzeAudienceSegmentation established
//     (delegating to agent/core/researchAgent.js). This is how the Marketing Agent
//     "provides campaign context" here: the entry's own `campaign` field defaults to
//     that record's campaign_reference when the caller didn't explicitly set one, and
//     the campaign plan record is included alongside the calendar entry in
//     specialized_records so the provided context stays visible and auditable, not
//     hidden.
//   - advertising_strategy composes its own dedicated
//     agent/core/advertisingStrategyModel.js record (strategy_reference,
//     campaign_objective, audience, offer, creative_angle, ad_copy, cta,
//     budget_recommendation, kpi, testing_plan) - a pre-launch strategic plan for one
//     advertising campaign, needing fields neither agent/core/adCampaignModel.js
//     (platform-pinned, execution-ready: bidding_strategy, measurement_plan) nor
//     agent/core/socialMediaStrategyModel.js (cross-platform organic+paid: content
//     pillars, posting cadence) carries, so it gets its own schema too, the same
//     dedicated-schema precedent every other capability here established.
//     `budget_recommendation` is always a caller-supplied description, never a
//     fabricated or committed number - no budget is ever spent and no campaign is ever
//     launched automatically; acting on a strategy is a separate, human-approved
//     action via approvals/.
//   - advertising_performance composes its own dedicated
//     agent/core/advertisingPerformanceModel.js record (performance_reference,
//     campaign_reference, actual_metrics, calculated_metrics) - analyzing a
//     campaign's *actual, already-measured* results is a distinct concern from
//     planning one (advertising_strategy) or executing one (meta_ads/google_ads/
//     tiktok_ads), so it gets its own schema too. `actual_metrics` is whatever the
//     caller directly supplies as already-known values; `calculated_metrics` is
//     derived from it via agent/core/advertisingPerformanceCalculator.js's standard
//     ad-metric formulas (CTR, CPC, CPM, CPA, ROAS) - reused, not reimplemented here -
//     and only ever populated when the required inputs are present, never fabricated.
//     Recommendations are never mixed into either metrics object - they stay only in
//     this envelope's own `recommendations` field below, the same structural
//     separation every other capability here already uses.
//
// socialContentModel.js, adCampaignModel.js, socialMediaStrategyModel.js,
// platformContentModel.js, contentCalendarModel.js, advertisingStrategyModel.js, and
// advertisingPerformanceModel.js all already carry their own `evidence` array field -
// so, exactly like agent/core/marketingAgent.js's own record builders, evidence is
// assigned directly from caller-supplied input inside each record builder, with no
// separate evidence-composition step layered on top.
//
// Confidence: caller-asserted only, defaulting to 'unassessed' - same convention as
// every other module in this project. A 'verified' claim asserted without evidence is
// downgraded back to 'unverified' (same honesty guard as every other agent's).

const {
  createEmptySocialContentRecord,
  validateSocialContentShape,
} = require('./socialContentModel');
const {
  createEmptyAdCampaignRecord,
  validateAdCampaignShape,
} = require('./adCampaignModel');
const {
  createEmptySocialMediaStrategyRecord,
  validateSocialMediaStrategyShape,
} = require('./socialMediaStrategyModel');
const {
  createEmptyPlatformContentRecord,
  validatePlatformContentShape,
} = require('./platformContentModel');
const {
  createEmptyContentCalendarRecord,
  validateContentCalendarShape,
} = require('./contentCalendarModel');
const {
  createEmptyAdvertisingStrategyRecord,
  validateAdvertisingStrategyShape,
} = require('./advertisingStrategyModel');
const {
  CALCULABLE_METRICS,
  createEmptyAdvertisingPerformanceRecord,
  validateAdvertisingPerformanceShape,
} = require('./advertisingPerformanceModel');
const { calculateAdvertisingPerformanceMetrics } = require('./advertisingPerformanceCalculator');
const {
  SOCIAL_ADVERTISING_CAPABILITIES,
  createEmptySocialAdvertisingAgentResult,
  validateSocialAdvertisingAgentResultShape,
} = require('./socialAdvertisingAgentResultModel');
const { deriveRecommendations } = require('./researchAgent');
// Reused directly for content_calendar's optional Marketing Agent campaign context -
// see analyzeContentCalendar() below. One-directional dependency only
// (socialAdvertisingAgent.js -> marketingAgent.js); marketingAgent.js does not import
// this module, so there is no cycle.
const { retrieveMarketingData: retrieveMarketingAgentData } = require('./marketingAgent');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
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
// module header) - no live social/ads platform API is configured. Never invents an
// entry that wasn't supplied.
// ---------------------------------------------------------------------------------

function buildSocialContentRecord(entry, fnName) {
  requireNonEmptyString(entry.platform, 'platform', fnName);
  requireNonEmptyString(entry.contentReference, 'contentReference', fnName);
  const record = createEmptySocialContentRecord(entry.platform, entry.contentReference);
  record.content_type = entry.contentType || '';
  record.objective = entry.objective || '';
  record.target_audience = entry.targetAudience || '';
  record.caption = entry.caption || '';
  record.hashtags = normalizeArray(entry.hashtags);
  record.posting_schedule = entry.postingSchedule || '';
  record.evidence = normalizeArray(entry.evidence);
  record.expected_outcome = entry.expectedOutcome || '';
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateSocialContentShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid social content record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildAdCampaignRecord(entry, fnName) {
  requireNonEmptyString(entry.platform, 'platform', fnName);
  requireNonEmptyString(entry.campaignReference, 'campaignReference', fnName);
  const record = createEmptyAdCampaignRecord(entry.platform, entry.campaignReference);
  record.objective = entry.objective || '';
  record.audience = entry.audience || '';
  record.budget = entry.budget || '';
  record.ad_creative = entry.adCreative || '';
  record.bidding_strategy = entry.biddingStrategy || '';
  record.cta = entry.cta || '';
  record.kpi = normalizeArray(entry.kpi);
  record.measurement_plan = normalizeArray(entry.measurementPlan);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateAdCampaignShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid ad campaign record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildSocialMediaStrategyRecord(entry, fnName) {
  requireNonEmptyString(entry.strategyReference, 'strategyReference', fnName);
  const record = createEmptySocialMediaStrategyRecord(entry.strategyReference);
  record.objective = entry.objective || '';
  record.audience = entry.audience || '';
  record.content_pillars = normalizeArray(entry.contentPillars);
  record.platform_selection = normalizeArray(entry.platformSelection);
  record.posting_strategy = entry.postingStrategy || '';
  record.content_themes = normalizeArray(entry.contentThemes);
  record.campaign_themes = normalizeArray(entry.campaignThemes);
  record.kpis = normalizeArray(entry.kpis);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateSocialMediaStrategyShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid social media strategy record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildPlatformContentRecord(entry, fnName) {
  requireNonEmptyString(entry.platform, 'platform', fnName);
  requireNonEmptyString(entry.contentReference, 'contentReference', fnName);
  const record = createEmptyPlatformContentRecord(entry.platform, entry.contentReference);
  record.objective = entry.objective || '';
  record.target_audience = entry.targetAudience || '';
  record.hooks = normalizeArray(entry.hooks);
  record.captions = normalizeArray(entry.captions);
  record.ctas = normalizeArray(entry.ctas);
  record.content_ideas = normalizeArray(entry.contentIdeas);
  record.short_form_video_concepts = normalizeArray(entry.shortFormVideoConcepts);
  record.carousel_concepts = normalizeArray(entry.carouselConcepts);
  record.creative_briefs = normalizeArray(entry.creativeBriefs);
  record.platform_adaptation_notes = entry.platformAdaptationNotes || '';
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validatePlatformContentShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid platform content record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildContentCalendarRecord(entry, fnName) {
  requireNonEmptyString(entry.entryReference, 'entryReference', fnName);
  requireNonEmptyString(entry.date, 'date', fnName);
  requireNonEmptyString(entry.platform, 'platform', fnName);
  const record = createEmptyContentCalendarRecord(entry.entryReference, entry.date, entry.platform);
  record.content_type = entry.contentType || '';
  record.topic = entry.topic || '';
  record.hook = entry.hook || '';
  record.cta = entry.cta || '';
  record.campaign = entry.campaign || '';
  record.product = entry.product || '';
  record.kpi = normalizeArray(entry.kpi);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateContentCalendarShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid content calendar record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildAdvertisingStrategyRecord(entry, fnName) {
  requireNonEmptyString(entry.strategyReference, 'strategyReference', fnName);
  const record = createEmptyAdvertisingStrategyRecord(entry.strategyReference);
  record.campaign_objective = entry.campaignObjective || '';
  record.audience = entry.audience || '';
  record.offer = entry.offer || '';
  record.creative_angle = entry.creativeAngle || '';
  record.ad_copy = normalizeArray(entry.adCopy);
  record.cta = entry.cta || '';
  record.budget_recommendation = entry.budgetRecommendation || '';
  record.kpi = normalizeArray(entry.kpi);
  record.testing_plan = normalizeArray(entry.testingPlan);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateAdvertisingStrategyShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid advertising strategy record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// Unlike every other builder here, this one also computes calculated_metrics - via
// agent/core/advertisingPerformanceCalculator.js's calculateAdvertisingPerformanceMetrics(),
// reused directly, never reimplemented - from whatever actual_metrics the caller
// supplied. actual_metrics itself is relayed untouched (shape-validated below, not
// pre-coerced), so an invalid type surfaces as a normal validation error rather than
// being silently swallowed.
function buildAdvertisingPerformanceRecord(entry, fnName) {
  requireNonEmptyString(entry.performanceReference, 'performanceReference', fnName);
  const record = createEmptyAdvertisingPerformanceRecord(entry.performanceReference, entry.campaignReference || '');
  record.actual_metrics = entry.actualMetrics === undefined ? {} : entry.actualMetrics;
  record.calculated_metrics = calculateAdvertisingPerformanceMetrics(record.actual_metrics);
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateAdvertisingPerformanceShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid advertising performance record: ${validation.errors.join('; ')}`);
  }
  return record;
}

const RECORD_BUILDERS = {
  social_content: buildSocialContentRecord,
  ad_campaign: buildAdCampaignRecord,
  social_media_strategy: buildSocialMediaStrategyRecord,
  platform_content: buildPlatformContentRecord,
  content_calendar: buildContentCalendarRecord,
  advertising_strategy: buildAdvertisingStrategyRecord,
  advertising_performance: buildAdvertisingPerformanceRecord,
};

// Exported for reuse, mirroring agent/core/marketingAgent.js's retrieveMarketingData /
// agent/core/seoAgent.js's retrieveSeoData / agent/core/listingAgent.js's
// retrieveListingData.
function retrieveSocialAdvertisingData(kind, entries, fnName) {
  const builder = RECORD_BUILDERS[kind];
  if (!builder) {
    throw new Error(`retrieveSocialAdvertisingData received an unknown record kind: ${kind}`);
  }
  return entries.map((entry) => builder(entry, fnName));
}

// ---------------------------------------------------------------------------------
// Analysis - pure analysis of already-retrieved social_content/ad_campaign records:
// flattens findings/evidence/source and builds the honest limitations list.
// ---------------------------------------------------------------------------------

function extractSocialContentRecord(record) {
  return {
    findings: [record.objective, record.caption, record.expected_outcome].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.content_reference || record.platform || '(unspecified content)',
  };
}

function extractAdCampaignRecord(record) {
  return {
    findings: [
      record.objective,
      record.audience,
      record.ad_creative,
      record.cta,
      ...record.kpi,
      ...record.measurement_plan,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.campaign_reference || record.platform || '(unspecified campaign)',
  };
}

function extractSocialMediaStrategyRecord(record) {
  return {
    findings: [
      record.objective,
      record.audience,
      record.posting_strategy,
      ...record.content_pillars,
      ...record.content_themes,
      ...record.campaign_themes,
      ...record.kpis,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.strategy_reference || '(unspecified strategy)',
  };
}

function extractPlatformContentRecord(record) {
  return {
    findings: [
      record.objective,
      record.platform_adaptation_notes,
      ...record.hooks,
      ...record.captions,
      ...record.ctas,
      ...record.content_ideas,
      ...record.short_form_video_concepts,
      ...record.carousel_concepts,
      ...record.creative_briefs,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.content_reference || record.platform || '(unspecified content)',
  };
}

function extractContentCalendarRecord(record) {
  return {
    findings: [
      record.topic,
      record.hook,
      record.cta,
      record.campaign,
      record.product,
      ...record.kpi,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.entry_reference || record.date || '(unspecified entry)',
  };
}

function extractAdvertisingStrategyRecord(record) {
  return {
    findings: [
      record.campaign_objective,
      record.audience,
      record.offer,
      record.creative_angle,
      record.cta,
      record.budget_recommendation,
      ...record.ad_copy,
      ...record.kpi,
      ...record.testing_plan,
    ].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.strategy_reference || '(unspecified strategy)',
  };
}

// Findings are labeled Actual/Calculated so the distinction survives flattening into
// the envelope's own findings array - not just held in the specialized record.
function formatMetricEntries(metrics) {
  return Object.entries(metrics).map(([key, value]) => `${key}: ${value}`);
}

function extractAdvertisingPerformanceRecord(record) {
  return {
    findings: [
      ...formatMetricEntries(record.actual_metrics).map((entry) => `Actual - ${entry}`),
      ...formatMetricEntries(record.calculated_metrics).map((entry) => `Calculated - ${entry}`),
    ],
    evidence: [...record.evidence],
    source: [],
    label: record.performance_reference || '(unspecified performance analysis)',
  };
}

const RECORD_KIND_EXTRACTORS = {
  social_content: extractSocialContentRecord,
  ad_campaign: extractAdCampaignRecord,
  social_media_strategy: extractSocialMediaStrategyRecord,
  platform_content: extractPlatformContentRecord,
  content_calendar: extractContentCalendarRecord,
  advertising_strategy: extractAdvertisingStrategyRecord,
  advertising_performance: extractAdvertisingPerformanceRecord,
};

function analyzeSocialAdvertisingRecords(records, kind, limitationHeader) {
  const extractor = RECORD_KIND_EXTRACTORS[kind];
  const findings = [];
  const evidence = [];
  const source = [];
  const limitations = [limitationHeader];

  for (const record of records) {
    const extracted = extractor(record);
    findings.push(...extracted.findings);
    evidence.push(...extracted.evidence);
    source.push(...extracted.source);
    if (extracted.evidence.length === 0 && extracted.source.length === 0) {
      limitations.push(`No evidence was supplied for ${extracted.label}.`);
    }
  }

  return { findings, evidence, source, limitations };
}

// ---------------------------------------------------------------------------------
// Composition - a thin assembler: applies the verified-without-evidence honesty guard,
// builds the common agent/core/socialAdvertisingAgentResultModel.js envelope, and
// validates it. The only place every capability's result gets combined into one common
// shape.
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

  const result = createEmptySocialAdvertisingAgentResult(capability, topic);
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

  const validation = validateSocialAdvertisingAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Social & Advertising agent result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

const SOCIAL_CONTENT_LIMITATION_HEADER =
  'No live social platform is configured; this result reflects only caller-supplied evidence.';
const AD_CAMPAIGN_LIMITATION_HEADER =
  'This campaign is not launched automatically - no live advertising platform is configured, and this result reflects only caller-supplied evidence.';
const SOCIAL_MEDIA_STRATEGY_LIMITATION_HEADER =
  'This strategy is not executed automatically - no live social/advertising platform is configured, and this result reflects only caller-supplied evidence.';
const PLATFORM_CONTENT_LIMITATION_HEADER =
  'This content is not published automatically - no live social platform is configured, and this result reflects only caller-supplied evidence.';
const CONTENT_CALENDAR_LIMITATION_HEADER =
  'This entry is not posted or scheduled automatically - no live social platform is configured, and this result reflects only caller-supplied evidence.';
const ADVERTISING_STRATEGY_LIMITATION_HEADER =
  'No advertising budget is spent and no campaign is launched automatically - no live advertising platform is configured, and this result reflects only caller-supplied evidence.';
const ADVERTISING_PERFORMANCE_LIMITATION_HEADER =
  'No metric is fetched or estimated automatically - no live advertising platform is configured, and this result reflects only caller-supplied actual metrics and metrics calculated from them.';

// Shared by instagram, facebook, tiktok, pinterest, and youtube - all 5 build one
// agent/core/socialContentModel.js record and honest limitations the same way,
// differing only in the pinned platform and the topic/label text.
function composeSocialContentResult(record, params, capability, topicFallback) {
  const analysis = analyzeSocialAdvertisingRecords([record], 'social_content', SOCIAL_CONTENT_LIMITATION_HEADER);
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

// Shared by meta_ads, google_ads, and tiktok_ads - all 3 build one
// agent/core/adCampaignModel.js record and honest limitations the same way, differing
// only in the pinned platform and the topic/label text.
function composeAdCampaignResult(record, params, capability, topicFallback) {
  const analysis = analyzeSocialAdvertisingRecords([record], 'ad_campaign', AD_CAMPAIGN_LIMITATION_HEADER);
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

function analyzeInstagram(params = {}) {
  const fnName = 'analyzeInstagram';
  const record = buildSocialContentRecord({ ...params, platform: 'instagram' }, fnName);
  return composeSocialContentResult(record, params, 'instagram', `Instagram: ${record.content_reference}`);
}

function analyzeFacebook(params = {}) {
  const fnName = 'analyzeFacebook';
  const record = buildSocialContentRecord({ ...params, platform: 'facebook' }, fnName);
  return composeSocialContentResult(record, params, 'facebook', `Facebook: ${record.content_reference}`);
}

function analyzeTiktok(params = {}) {
  const fnName = 'analyzeTiktok';
  const record = buildSocialContentRecord({ ...params, platform: 'tiktok' }, fnName);
  return composeSocialContentResult(record, params, 'tiktok', `TikTok: ${record.content_reference}`);
}

function analyzePinterest(params = {}) {
  const fnName = 'analyzePinterest';
  const record = buildSocialContentRecord({ ...params, platform: 'pinterest' }, fnName);
  return composeSocialContentResult(record, params, 'pinterest', `Pinterest: ${record.content_reference}`);
}

function analyzeYoutube(params = {}) {
  const fnName = 'analyzeYoutube';
  const record = buildSocialContentRecord({ ...params, platform: 'youtube' }, fnName);
  return composeSocialContentResult(record, params, 'youtube', `YouTube: ${record.content_reference}`);
}

function analyzeMetaAds(params = {}) {
  const fnName = 'analyzeMetaAds';
  const record = buildAdCampaignRecord({ ...params, platform: 'meta_ads' }, fnName);
  return composeAdCampaignResult(record, params, 'meta_ads', `Meta Ads: ${record.campaign_reference}`);
}

function analyzeGoogleAds(params = {}) {
  const fnName = 'analyzeGoogleAds';
  const record = buildAdCampaignRecord({ ...params, platform: 'google_ads' }, fnName);
  return composeAdCampaignResult(record, params, 'google_ads', `Google Ads: ${record.campaign_reference}`);
}

function analyzeTiktokAds(params = {}) {
  const fnName = 'analyzeTiktokAds';
  const record = buildAdCampaignRecord({ ...params, platform: 'tiktok_ads' }, fnName);
  return composeAdCampaignResult(record, params, 'tiktok_ads', `TikTok Ads: ${record.campaign_reference}`);
}

// Composes a dedicated agent/core/socialMediaStrategyModel.js record - not
// composeSocialContentResult/composeAdCampaignResult, since a cross-platform strategy
// is a different, richer schema than either (see module header), the same
// direct-composeResult approach agent/core/marketingAgent.js's analyzeCampaignPlanning
// uses for its own dedicated campaignPlanModel.js record.
function analyzeSocialMediaStrategy(params = {}) {
  const fnName = 'analyzeSocialMediaStrategy';
  const record = buildSocialMediaStrategyRecord(params, fnName);
  const analysis = analyzeSocialAdvertisingRecords(
    [record],
    'social_media_strategy',
    SOCIAL_MEDIA_STRATEGY_LIMITATION_HEADER
  );
  return composeResult({
    capability: 'social_media_strategy',
    topic: params.topic || `Social media strategy: ${record.strategy_reference}`,
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

// Composes a dedicated agent/core/platformContentModel.js record - not
// composeSocialContentResult, since ecommerce content generation needs 7 distinct
// creative-element dimensions socialContentModel.js's single `caption` field was never
// meant to carry (see module header). `platform` is caller-supplied (not pinned to one
// value), since this single capability serves any of the 5 in-scope social platforms -
// the same caller-supplied-platform approach analyzeSocialMediaStrategy uses for its
// own platform_selection field.
function analyzeContentGeneration(params = {}) {
  const fnName = 'analyzeContentGeneration';
  const record = buildPlatformContentRecord(params, fnName);
  const analysis = analyzeSocialAdvertisingRecords(
    [record],
    'platform_content',
    PLATFORM_CONTENT_LIMITATION_HEADER
  );
  return composeResult({
    capability: 'content_generation',
    topic: params.topic || `Content generation: ${record.content_reference}`,
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

// Composes a dedicated agent/core/contentCalendarModel.js record - not any of the
// other 4 composers, since a calendar entry is its own plan-level schema (see module
// header). Unlike every other capability here, this one may also delegate part of its
// retrieval to agent/core/marketingAgent.js: when params.campaignContext is supplied,
// it's validated and built into a real agent/core/campaignPlanModel.js record via
// that module's own retrieveMarketingData('campaign_plan', ...) - never reimplemented
// here. The entry's `campaign` field defaults to that record's campaign_reference when
// the caller didn't explicitly set one, and the campaign plan record travels alongside
// the calendar entry in specialized_records - the Marketing Agent's contribution stays
// visible in the output, not silently absorbed.
function analyzeContentCalendar(params = {}) {
  const fnName = 'analyzeContentCalendar';
  const { campaignContext, ...entryParams } = params;

  let campaignPlanRecord = null;
  if (campaignContext !== undefined) {
    if (typeof campaignContext !== 'object' || campaignContext === null || Array.isArray(campaignContext)) {
      throw new Error(`${fnName} requires \`campaignContext\` to be an object when supplied.`);
    }
    campaignPlanRecord = retrieveMarketingAgentData('campaign_plan', [campaignContext], fnName)[0];
  }

  const entryInput = { ...entryParams };
  if (!entryInput.campaign && campaignPlanRecord) {
    entryInput.campaign = campaignPlanRecord.campaign_reference;
  }

  const record = buildContentCalendarRecord(entryInput, fnName);
  const specializedRecords = [record];

  const analysis = analyzeSocialAdvertisingRecords([record], 'content_calendar', CONTENT_CALENDAR_LIMITATION_HEADER);
  const findings = [...analysis.findings];
  const evidence = [...analysis.evidence];
  const limitations = [...analysis.limitations];

  if (campaignPlanRecord) {
    specializedRecords.push(campaignPlanRecord);
    findings.push(...[campaignPlanRecord.objective, campaignPlanRecord.audience].filter(Boolean));
    evidence.push(...campaignPlanRecord.evidence);
    if (campaignPlanRecord.evidence.length === 0) {
      limitations.push(
        `No evidence was supplied for the Marketing Agent's campaign context (${campaignPlanRecord.campaign_reference}).`
      );
    }
  }

  return composeResult({
    capability: 'content_calendar',
    topic: params.topic || `Content calendar: ${record.entry_reference}`,
    market: params.market || '',
    findings,
    evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords,
  });
}

// Composes a dedicated agent/core/advertisingStrategyModel.js record - not
// composeAdCampaignResult, since a pre-launch advertising strategy is a different,
// platform-agnostic schema (see module header), the same direct-composeResult
// approach analyzeSocialMediaStrategy and analyzeContentGeneration use for their own
// dedicated records.
function analyzeAdvertisingStrategy(params = {}) {
  const fnName = 'analyzeAdvertisingStrategy';
  const record = buildAdvertisingStrategyRecord(params, fnName);
  const analysis = analyzeSocialAdvertisingRecords(
    [record],
    'advertising_strategy',
    ADVERTISING_STRATEGY_LIMITATION_HEADER
  );
  return composeResult({
    capability: 'advertising_strategy',
    topic: params.topic || `Advertising strategy: ${record.strategy_reference}`,
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

// Composes a dedicated agent/core/advertisingPerformanceModel.js record - not any of
// the other composers, since analyzing a campaign's actual, already-measured results
// is a different concern from planning or executing one (see module header). Adds an
// explicit, honest limitation naming any calculable metric that could NOT be derived
// from the supplied actual_metrics (insufficient inputs) - the concrete form
// "do not fabricate unavailable metrics" takes here: every gap is named, not silently
// omitted.
function analyzeAdvertisingPerformance(params = {}) {
  const fnName = 'analyzeAdvertisingPerformance';
  const record = buildAdvertisingPerformanceRecord(params, fnName);
  const analysis = analyzeSocialAdvertisingRecords(
    [record],
    'advertising_performance',
    ADVERTISING_PERFORMANCE_LIMITATION_HEADER
  );
  const limitations = [...analysis.limitations];

  const uncalculatedMetrics = CALCULABLE_METRICS.filter(
    (metric) => !(metric in record.actual_metrics) && !(metric in record.calculated_metrics)
  );
  if (uncalculatedMetrics.length > 0) {
    limitations.push(
      `The following metric(s) could not be calculated from the supplied actual metrics (insufficient inputs): ${uncalculatedMetrics.join(', ')}.`
    );
  }

  return composeResult({
    capability: 'advertising_performance',
    topic: params.topic || `Advertising performance: ${record.performance_reference}`,
    market: params.market || '',
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

const SOCIAL_ADVERTISING_CAPABILITY_HANDLERS = {
  instagram: analyzeInstagram,
  facebook: analyzeFacebook,
  tiktok: analyzeTiktok,
  pinterest: analyzePinterest,
  youtube: analyzeYoutube,
  meta_ads: analyzeMetaAds,
  google_ads: analyzeGoogleAds,
  tiktok_ads: analyzeTiktokAds,
  social_media_strategy: analyzeSocialMediaStrategy,
  content_generation: analyzeContentGeneration,
  content_calendar: analyzeContentCalendar,
  advertising_strategy: analyzeAdvertisingStrategy,
  advertising_performance: analyzeAdvertisingPerformance,
};

// The single entry point: dispatches by capability to the matching function above.
// Never guesses an unrecognized capability - throws a clear error instead.
function runSocialAdvertisingAgent({ capability, ...params } = {}) {
  const handler = SOCIAL_ADVERTISING_CAPABILITY_HANDLERS[capability];
  if (!handler) {
    throw new Error(`Unknown Social & Advertising capability: ${capability}. Must be one of: ${SOCIAL_ADVERTISING_CAPABILITIES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  analyzeInstagram,
  analyzeFacebook,
  analyzeTiktok,
  analyzePinterest,
  analyzeYoutube,
  analyzeMetaAds,
  analyzeGoogleAds,
  analyzeTiktokAds,
  analyzeSocialMediaStrategy,
  analyzeContentGeneration,
  analyzeContentCalendar,
  analyzeAdvertisingStrategy,
  analyzeAdvertisingPerformance,
  runSocialAdvertisingAgent,
  retrieveSocialAdvertisingData,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Social & Advertising Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      analyzeInstagram({
        contentReference: '(Example winter jacket launch post)',
        contentType: 'reel',
        objective: 'Drive awareness of the new insulated jacket line (caller-supplied placeholder).',
        caption: 'Stay warm this winter with our new insulated jacket line (caller-supplied placeholder).',
        targetAudience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        hashtags: ['#wintergear', '#hikinglife'],
        evidence: ['(placeholder prior-post performance)'],
      }),
    () =>
      analyzeFacebook({
        contentReference: '(Example flash sale post)',
        contentType: 'post',
        caption: '15% off insulated jackets this weekend only (caller-supplied placeholder).',
      }),
    () =>
      analyzeTiktok({
        contentReference: '(Example jacket unboxing video)',
        contentType: 'video',
        caption: 'Unboxing our warmest jacket yet (caller-supplied placeholder).',
      }),
    () =>
      analyzePinterest({
        contentReference: '(Example winter lookbook pin)',
        contentType: 'pin',
        caption: 'Winter hiking outfit inspiration (caller-supplied placeholder).',
      }),
    () =>
      analyzeYoutube({
        contentReference: '(Example gear review video)',
        contentType: 'video',
        caption: 'Insulated jacket review: warm, light, and budget-friendly (caller-supplied placeholder).',
      }),
    () =>
      analyzeMetaAds({
        campaignReference: '(Example winter jacket launch campaign)',
        objective: 'Drive first-week sales (caller-supplied placeholder).',
        audience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        budget: '$500/month (caller-supplied placeholder).',
        adCreative: 'Lifestyle photography in cold-weather outdoor settings (caller-supplied placeholder).',
        biddingStrategy: 'Cost-per-click, capped bid (caller-supplied placeholder).',
        cta: 'Shop the winter collection (caller-supplied placeholder).',
        kpi: ['Click-through rate (caller-supplied placeholder).'],
        measurementPlan: ['Track via Meta Ads Manager reviewed weekly (caller-supplied placeholder).'],
        evidence: ['(placeholder prior-campaign result)'],
      }),
    () =>
      analyzeGoogleAds({
        campaignReference: '(Example search campaign)',
        objective: 'Capture high-intent search traffic (caller-supplied placeholder).',
        audience: 'Shoppers searching "insulated jacket" (caller-supplied placeholder).',
        budget: '$300/month (caller-supplied placeholder).',
      }),
    () =>
      analyzeTiktokAds({
        campaignReference: '(Example spark ads campaign)',
        objective: 'Boost top-performing organic video (caller-supplied placeholder).',
        audience: 'Outdoor lifestyle audience, ages 18-34 (caller-supplied placeholder).',
        budget: '$200/month (caller-supplied placeholder).',
      }),
    () =>
      analyzeSocialMediaStrategy({
        strategyReference: '(Example Q4 winter strategy)',
        objective: 'Grow winter jacket line awareness and sales (caller-supplied placeholder).',
        audience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        contentPillars: ['Product education', 'Customer stories', 'Behind-the-scenes'],
        platformSelection: ['instagram', 'tiktok', 'meta_ads'],
        postingStrategy: '4x/week organic, always-on ads with weekly budget review (caller-supplied placeholder).',
        contentThemes: ['Cold-weather adventure', 'Value for money'],
        campaignThemes: ['Winter launch', 'Holiday gifting'],
        kpis: ['Engagement rate (caller-supplied placeholder).', 'Return on ad spend (caller-supplied placeholder).'],
        evidence: ['(placeholder prior-quarter performance)'],
      }),
    () =>
      analyzeContentGeneration({
        contentReference: '(Example jacket launch content set)',
        platform: 'tiktok',
        objective: 'Drive awareness of the new insulated jacket line (caller-supplied placeholder).',
        targetAudience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        hooks: ['You\'re about to see the warmest $80 jacket on the internet (caller-supplied placeholder).'],
        captions: ['Stay warm this winter without breaking the bank (caller-supplied placeholder).'],
        ctas: ['Shop the winter collection - link in bio (caller-supplied placeholder).'],
        contentIdeas: ['Cold-weather stress test vs. a $300 competitor jacket (caller-supplied placeholder).'],
        shortFormVideoConcepts: ['15-second cold-room challenge wearing only the jacket (caller-supplied placeholder).'],
        carouselConcepts: ['5-slide "what\'s inside the jacket" cutaway breakdown (caller-supplied placeholder).'],
        creativeBriefs: ['Fast-paced, natural light, UGC-style handheld footage, no studio setup (caller-supplied placeholder).'],
        platformAdaptationNotes: 'Vertical 9:16, hook within first 2 seconds, on-screen captions for sound-off viewing (caller-supplied placeholder).',
        evidence: ['(placeholder prior-video performance)'],
      }),
    () =>
      analyzeContentCalendar({
        entryReference: '(Example Nov 14 tiktok post)',
        date: '2026-11-14',
        platform: 'tiktok',
        contentType: 'video',
        topic: 'Cold-weather stress test (caller-supplied placeholder).',
        hook: 'You\'re about to see the warmest $80 jacket on the internet (caller-supplied placeholder).',
        cta: 'Shop the winter collection - link in bio (caller-supplied placeholder).',
        product: '(Example insulated jacket)',
        kpi: ['Engagement rate (caller-supplied placeholder).'],
        evidence: ['(placeholder prior-post performance)'],
        // The Marketing Agent supplies campaign context here - analyzeContentCalendar
        // reuses agent/core/marketingAgent.js's own retrieveMarketingData('campaign_plan')
        // to validate/build it, and the resulting campaign_reference fills `campaign`
        // below since it wasn't set explicitly (caller-supplied placeholder values).
        campaignContext: {
          campaignReference: '(Example winter jacket launch campaign)',
          objective: 'Drive first-week sales (caller-supplied placeholder).',
          audience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
          evidence: ['(placeholder prior-campaign result)'],
        },
      }),
    () =>
      analyzeAdvertisingStrategy({
        strategyReference: '(Example winter jacket launch strategy)',
        campaignObjective: 'Drive first-week sales of the new insulated jacket line (caller-supplied placeholder).',
        audience: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
        offer: '15% off for the first week (caller-supplied placeholder).',
        creativeAngle: 'Warmth without the premium price tag (caller-supplied placeholder).',
        adCopy: ['The warmest $80 jacket on the internet (caller-supplied placeholder).'],
        cta: 'Shop the winter collection (caller-supplied placeholder).',
        budgetRecommendation: '$500/month, reviewed weekly (caller-supplied placeholder).',
        kpi: ['Return on ad spend (caller-supplied placeholder).'],
        testingPlan: ['A/B test 2 creative angles against the same audience for 1 week (caller-supplied placeholder).'],
        evidence: ['(placeholder prior-campaign result)'],
      }),
    () =>
      analyzeAdvertisingPerformance({
        performanceReference: '(Example winter jacket launch - week 1 performance)',
        campaignReference: '(Example winter jacket launch campaign)',
        // impressions/clicks/spend/conversions/revenue are actual, caller-supplied
        // values (caller-supplied placeholder figures); CTR/CPC/CPM/CPA/ROAS below are
        // NOT supplied here, so calculateAdvertisingPerformanceMetrics() derives them
        // - never fabricated, only ever computed from what was actually supplied.
        actualMetrics: {
          impressions: 10000,
          clicks: 250,
          spend: 500,
          conversions: 20,
          revenue: 1000,
        },
        evidence: ['(placeholder Meta Ads Manager export)'],
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
