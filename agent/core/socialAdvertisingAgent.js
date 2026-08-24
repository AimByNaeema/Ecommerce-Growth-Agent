'use strict';

// The Social & Advertising Agent (CLAUDE.md section 2, specialist #6: "Social media
// and paid advertising"). Supports 10 capabilities: instagram, facebook, tiktok,
// pinterest, youtube (social), meta_ads, google_ads, tiktok_ads (advertising),
// social_media_strategy (cross-platform strategy generation), and content_generation
// (platform-aware ecommerce content generation).
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
//
// socialContentModel.js, adCampaignModel.js, socialMediaStrategyModel.js, and
// platformContentModel.js all already carry their own `evidence` array field - so,
// exactly like agent/core/marketingAgent.js's own record builders, evidence is
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
  SOCIAL_ADVERTISING_CAPABILITIES,
  createEmptySocialAdvertisingAgentResult,
  validateSocialAdvertisingAgentResultShape,
} = require('./socialAdvertisingAgentResultModel');
const { deriveRecommendations } = require('./researchAgent');

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

const RECORD_BUILDERS = {
  social_content: buildSocialContentRecord,
  ad_campaign: buildAdCampaignRecord,
  social_media_strategy: buildSocialMediaStrategyRecord,
  platform_content: buildPlatformContentRecord,
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

const RECORD_KIND_EXTRACTORS = {
  social_content: extractSocialContentRecord,
  ad_campaign: extractAdCampaignRecord,
  social_media_strategy: extractSocialMediaStrategyRecord,
  platform_content: extractPlatformContentRecord,
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
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.capability} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
