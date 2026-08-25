'use strict';

// Structured cross-agent context passing: when a multi-step plan (see
// agent/core/orchestratorExecutionContract.js's planRouting/buildPlanStep) routes
// through more than one specialist, this module derives the minimal, structured
// subset of an earlier step's REAL output that the next step's specific capability
// actually declares it needs (per agent/core/specialistCapabilityRegistry.js's
// input_contract) - never the whole raw output, never a field the next capability
// doesn't ask for, never a guessed/invented value.
//
// Supports exactly the flows named in this project's current scope:
//   Research -> Product, Product -> Listing, SEO -> Listing, Product -> Marketing,
//   Marketing -> Social & Advertising, All -> Analytics, Analytics -> Optimization.
//
// THREE MECHANISMS, one principle (only real, declared-relevant data ever crosses a
// specialist boundary; nothing is fabricated to fill a gap):
//
// 1. SPECIALIST_PAIR_EXTRACTORS - the 5 concrete (from specialist, to specialist)
//    pairs above. Each extractor reads one upstream capability's real output and
//    reshapes only the fields the specific downstream capability is known to accept
//    (verified field-by-field against the real *Agent.js param names each accepts -
//    see the comment above each extractor) - a documented rename where the upstream
//    record's own field name differs (e.g. onPageOptimizationModel.js's
//    subject_title -> listingAgent.js's seoRecommendations.product_title), never a
//    blind pass-through of an entire record.
//
// 2. "All -> Analytics": any completed step's output that carries a real
//    agent/core/growthOpportunityModel.js-shaped specialized_record (Marketing's
//    retention/conversion_opportunities, Analytics's own growth_opportunities) feeds
//    Analytics's growth_opportunities capability - the one Analytics capability with a
//    matching generic shape (see deriveAllToAnalyticsContext).
//
// 3. "Analytics -> Optimization": every growthOpportunityModel.js-shaped record
//    gathered anywhere in the plan becomes a DRAFT candidate for the standalone
//    agent/core/growthOpportunityEngine.js (see gatherGrowthOpportunityDrafts).
//    expectedImpactCategory, expectedImpactMagnitude, and actionClassification are
//    subjective business judgments growthOpportunityEngine.js's own header says can
//    never be honestly defaulted or guessed - no field anywhere upstream supplies
//    them, so each draft names them explicitly in missing_for_ranking rather than
//    inventing a value, and this module never calls rankGrowthOpportunities() itself.
// exports.
//
// EVERY extractor here is a pure function: real input in, a plain context object out,
// no I/O, no tool call, no mutation of its input. Two safety nets apply universally,
// enforced centrally rather than trusted per-extractor:
//   - filterToDeclaredFields(): only keys the target capability's own input_contract
//     (required or optional) actually lists ever survive - "only pass information
//     required by the next specialist", mechanically enforced, not just by
//     convention.
//   - mergeContext(): never overwrites a scalar field already set (by an earlier
//     contribution, or by the caller's own explicit researchParams, which always wins
//     - see deriveCrossAgentContext); array fields are concatenated and deduplicated -
//     "avoid duplicate context".

const { getSpecialistCapabilityById, getCapabilityTask } = require('./specialistCapabilityRegistry');

// Every multi-capability tool this module cares about (tools/marketResearchTool.js,
// tools/competitorResearchTool.js, tools/customerResearchTool.js,
// tools/seoAnalysisTool.js, tools/listingContentTool.js, tools/marketingAnalysisTool.js,
// tools/socialContentTool.js, tools/contentCalendarTool.js, tools/analyticsTool.js)
// wraps its real specialist envelope in its own {status, result, error} shape (never
// throwing) - a step's outputs (agent/core/executionState.js's `outputs` field, set
// from the tool's return value) is therefore this wrapper, not the envelope itself.
// Every extractor/gatherer in this module reads the real specialist output through
// this one helper rather than each re-deriving it, and only when the tool itself
// reported a real result (never guesses from a failed/empty outcome).
function realOutput(step) {
  const wrapper = step && step.outputs;
  return wrapper && wrapper.result ? wrapper.result : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function dedupeArray(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------
// 1. Research -> Product
//
// Product's only capability with a generic evidence-shaped input is
// product_opportunity_analysis (demandEvidence/competitionEvidence/marketFitEvidence/
// productRiskEvidence, each an array of agent/core/researchRecordModel.js-shaped
// {topic, market, source, finding, confidence, verificationStatus} entries - see
// agent/core/productAgent.js's DIMENSION_PARAM_KEYS and buildDimension, which passes
// each entry through researchAgent.js's retrieveResearchData('generic', ...)). Only
// market_research maps to demandEvidence and competitor_research maps to
// competitionEvidence - the two capabilities whose subject matter genuinely matches
// one of Product's 4 assessed dimensions; every other research type is honestly left
// unmapped rather than force-fit.
// ---------------------------------------------------------------------------------

function extractResearchToProduct(fromCapabilityId, _toCapabilityId, fromOutput) {
  if (!fromOutput || !isNonEmptyArray(fromOutput.findings)) return {};
  if (fromCapabilityId !== 'market_research' && fromCapabilityId !== 'competitor_research') return {};

  const genericEntry = {
    topic: fromOutput.topic || fromOutput.research_type || '(research finding)',
    market: fromOutput.market || '',
    source: Array.isArray(fromOutput.source) ? [...fromOutput.source] : [],
    finding: fromOutput.findings.join('; '),
    confidence: fromOutput.confidence || 'unassessed',
    verificationStatus: fromOutput.verification_status || 'unverified',
  };

  return fromCapabilityId === 'market_research'
    ? { demandEvidence: [genericEntry] }
    : { competitionEvidence: [genericEntry] };
}

// ---------------------------------------------------------------------------------
// 2. Product -> Listing
//
// Listing's listing_content capability reads productInfo.description (fallback for
// the listing description) and market/targetMarket (see
// agent/core/listingAgent.js's resolveListingSources) - both real fields on the
// product_opportunity_analysis result's own specialized_records.product_record and
// top-level market field.
// ---------------------------------------------------------------------------------

function extractProductToListing(fromCapabilityId, _toCapabilityId, fromOutput) {
  if (fromCapabilityId !== 'product_opportunity_analysis' || !fromOutput) return {};
  const productRecord = fromOutput.specialized_records && fromOutput.specialized_records.product_record;

  const context = {};
  if (productRecord && isNonEmptyString(productRecord.description)) {
    context.productInfo = { description: productRecord.description };
  }
  if (isNonEmptyString(fromOutput.market)) {
    context.market = fromOutput.market;
  }
  return context;
}

// ---------------------------------------------------------------------------------
// 3. SEO -> Listing
//
// Listing's listing_content capability reads seoRecommendations.{product_title,
// description, keywords} (see resolveListingSources). SEO's product_seo capability
// (agent/core/seoAgent.js's analyzeProductSeo/buildProductSeoRecord) composes a real
// agent/core/listingOptimizationModel.js record whose field is already named
// product_title - a direct relay, no rename needed. on_page_seo dispatches to
// analyzeProductSeo when subjectType is 'product' (same record shape, tagged
// capability: 'on_page_seo') but to analyzeCollectionSeo/analyzeContentSeo otherwise,
// which compose a DIFFERENT record (agent/core/onPageOptimizationModel.js, subject_
// prefixed fields, no product_title) - detected structurally by the presence of
// product_title itself, never assumed from the capability id alone.
// ---------------------------------------------------------------------------------

function extractSeoToListing(fromCapabilityId, _toCapabilityId, fromOutput) {
  if (!fromOutput) return {};
  if (fromCapabilityId !== 'product_seo' && fromCapabilityId !== 'on_page_seo') return {};

  const record = Array.isArray(fromOutput.specialized_records) ? fromOutput.specialized_records[0] : null;
  if (!record || !('product_title' in record)) return {};

  const seoRecommendations = {};
  if (isNonEmptyString(record.product_title)) seoRecommendations.product_title = record.product_title;
  if (isNonEmptyString(record.description)) seoRecommendations.description = record.description;
  if (isNonEmptyArray(record.keywords)) seoRecommendations.keywords = [...record.keywords];

  return Object.keys(seoRecommendations).length > 0 ? { seoRecommendations } : {};
}

// ---------------------------------------------------------------------------------
// 4. Product -> Marketing
//
// marketing_strategy/offers/promotions/email_strategy read a plain `product` string
// (see agent/core/marketingAgent.js's buildMarketingAnalysisRecord); retention reads
// a required `productReference` string (buildGrowthOpportunityRecord). Both are real,
// direct relays of product_opportunity_analysis's own product_identity - never an
// object where a string is expected. `evidence` (both capabilities accept a plain
// array) relays Product's own source array untouched.
// ---------------------------------------------------------------------------------

const MARKETING_CHANNEL_CAPABILITIES = ['marketing_strategy', 'offers', 'promotions', 'email_strategy'];

function extractProductToMarketing(fromCapabilityId, toCapabilityId, fromOutput) {
  if (fromCapabilityId !== 'product_opportunity_analysis' || !fromOutput) return {};
  if (!isNonEmptyString(fromOutput.product_identity)) return {};

  const evidence = Array.isArray(fromOutput.source) ? [...fromOutput.source] : [];

  if (MARKETING_CHANNEL_CAPABILITIES.includes(toCapabilityId)) {
    const context = { product: fromOutput.product_identity };
    if (evidence.length > 0) context.evidence = evidence;
    return context;
  }

  if (toCapabilityId === 'retention') {
    const context = { productReference: fromOutput.product_identity };
    if (evidence.length > 0) context.evidence = evidence;
    return context;
  }

  return {};
}

// ---------------------------------------------------------------------------------
// 5. Marketing -> Social & Advertising
//
// Social & Advertising's content_calendar capability already accepts a
// campaignContext object (see agent/core/socialAdvertisingAgent.js, which relays it
// straight into agent/core/marketingAgent.js's retrieveMarketingData('campaign_plan',
// ...)) - the exact shape retrieveMarketingData's own campaign_plan builder expects
// (agent/core/marketingAgent.js's buildCampaignPlanRecord), a camelCase reshape of the
// real agent/core/campaignPlanModel.js record campaign_planning already produced.
// ---------------------------------------------------------------------------------

function extractMarketingToSocialAdvertising(fromCapabilityId, toCapabilityId, fromOutput) {
  if (fromCapabilityId !== 'campaign_planning' || toCapabilityId !== 'content_calendar' || !fromOutput) return {};

  const record = Array.isArray(fromOutput.specialized_records) ? fromOutput.specialized_records[0] : null;
  if (!record || !isNonEmptyString(record.campaign_reference)) return {};

  return {
    campaignContext: {
      campaignReference: record.campaign_reference,
      objective: record.objective || '',
      audience: record.audience || '',
      offer: record.offer || '',
      message: record.message || '',
      channel: record.channel || '',
      creativeDirection: record.creative_direction || '',
      cta: record.cta || '',
      kpi: Array.isArray(record.kpi) ? [...record.kpi] : [],
      measurementPlan: Array.isArray(record.measurement_plan) ? [...record.measurement_plan] : [],
      evidence: Array.isArray(record.evidence) ? [...record.evidence] : [],
      verificationStatus: record.verification_status || 'unverified',
    },
  };
}

const SPECIALIST_PAIR_EXTRACTORS = [
  { from: 'research', to: 'product', extract: extractResearchToProduct },
  { from: 'product', to: 'listing', extract: extractProductToListing },
  { from: 'seo', to: 'listing', extract: extractSeoToListing },
  { from: 'product', to: 'marketing', extract: extractProductToMarketing },
  { from: 'marketing', to: 'social_advertising', extract: extractMarketingToSocialAdvertising },
];

// Only keys the target capability's own input_contract (required or optional) lists
// ever survive - the mechanical enforcement of "only pass information required by the
// next specialist", independent of what an extractor above happens to compute.
function filterToDeclaredFields(context, inputContract) {
  if (!inputContract) return {};
  const allowed = new Set([...(inputContract.required || []), ...(inputContract.optional || [])]);
  const filtered = {};
  for (const [key, value] of Object.entries(context)) {
    if (allowed.has(key)) filtered[key] = value;
  }
  return filtered;
}

// Merges one extracted context object into an accumulator. Never overwrites a scalar
// field already set (first writer wins - deriveCrossAgentContext always merges the
// caller's own explicit researchParams last, so it can never be overridden). Array
// fields are concatenated and deduplicated - the same real evidence entry never
// appears twice ("avoid duplicate context").
function mergeContext(accumulator, addition) {
  for (const [key, value] of Object.entries(addition)) {
    if (!(key in accumulator)) {
      accumulator[key] = value;
    } else if (Array.isArray(accumulator[key]) && Array.isArray(value)) {
      accumulator[key] = dedupeArray([...accumulator[key], ...value]);
    }
  }
  return accumulator;
}

// The main entry point for the 5 specialist-pair flows: given every already-completed
// plan step (in plan order) and the specialist/capability about to run next, derives
// the minimal structured context to merge into that step's researchParams. Returns
// {} when the target isn't a real capability, when no declared flow applies, or when
// nothing real was extractable - never guessed, never a default.
function deriveCrossAgentContext({ completedSteps = [], toSpecialistId, toCapabilityId, existingResearchParams = null }) {
  const toTask = getCapabilityTask(toSpecialistId, toCapabilityId);
  if (!toTask) return {};

  let context = {};
  for (const step of completedSteps) {
    const fromSpecialistId =
      step.selected_specialist && step.selected_specialist.type === 'specialist' ? step.selected_specialist.id : null;
    const fromCapabilityId = step.inputs && step.inputs.capability_id;
    const fromOutput = realOutput(step);
    if (!fromSpecialistId || !fromCapabilityId || !fromOutput) continue;

    const flow = SPECIALIST_PAIR_EXTRACTORS.find((entry) => entry.from === fromSpecialistId && entry.to === toSpecialistId);
    if (!flow) continue;

    const extracted = flow.extract(fromCapabilityId, toCapabilityId, fromOutput);
    if (extracted && Object.keys(extracted).length > 0) {
      context = mergeContext(context, extracted);
    }
  }

  context = filterToDeclaredFields(context, toTask.input_contract);

  if (existingResearchParams && typeof existingResearchParams === 'object') {
    for (const key of Object.keys(existingResearchParams)) {
      delete context[key];
    }
  }

  return context;
}

// ---------------------------------------------------------------------------------
// "All -> Analytics" and "Analytics -> Optimization"
//
// Both start from the same real, tool-produced fact: which completed steps' outputs
// carry a genuine agent/core/growthOpportunityModel.js-shaped specialized_record
// (identified structurally - opportunity_type + product_reference are that model's
// two identifying fields, present on no other schema in this codebase). Marketing's
// retention/conversion_opportunities and Analytics's own growth_opportunities are the
// real producers today.
// ---------------------------------------------------------------------------------

function isGrowthOpportunityRecord(record) {
  return Boolean(record) && typeof record === 'object' && 'opportunity_type' in record && 'product_reference' in record;
}

function gatherGrowthOpportunityRecords(completedSteps) {
  const records = [];
  for (const step of completedSteps) {
    const output = realOutput(step);
    if (!output || !output.specialized_records) continue;
    const candidates = Array.isArray(output.specialized_records) ? output.specialized_records : [output.specialized_records];
    for (const record of candidates) {
      if (isGrowthOpportunityRecord(record)) records.push(record);
    }
  }
  return dedupeArray(records);
}

// "All -> Analytics": feeds every gathered record into Analytics's growth_opportunities
// capability's `opportunities` field - the one Analytics capability with a matching
// generic shape (agent/core/analyticsAgent.js's buildGrowthOpportunityRecord accepts
// exactly this camelCase entry shape).
function deriveAllToAnalyticsContext(completedSteps, toCapabilityId) {
  if (toCapabilityId !== 'growth_opportunities') return {};
  const records = gatherGrowthOpportunityRecords(completedSteps);
  if (records.length === 0) return {};

  return {
    opportunities: records.map((record) => ({
      productReference: record.product_reference,
      opportunityType: record.opportunity_type,
      relatedProducts: [...record.related_products],
      targetSegment: record.target_segment,
      offer: record.offer,
      recommendation: record.recommendation,
      evidence: [...record.evidence],
      verificationStatus: record.verification_status,
    })),
  };
}

// growthOpportunityModel.js's GROWTH_OPPORTUNITY_TYPES -> growthOpportunityEngine.js's
// OPPORTUNITY_CATEGORIES: a fixed, documented enum rename (never a guess) for the
// types that clearly correspond to one of the engine's categories. 'unclassified' has
// no honest equivalent and is deliberately left unmapped.
const OPPORTUNITY_TYPE_TO_ENGINE_CATEGORY = {
  retention: 'retention',
  upselling: 'conversion',
  cross_selling: 'conversion',
  repeat_purchases: 'conversion',
  customer_reengagement: 'conversion',
};

// Fields agent/core/growthOpportunityEngine.js's rankGrowthOpportunities() requires
// that no upstream specialist output anywhere in this pipeline supplies - each is a
// subjective business judgment (how big is the impact, which business dimension does
// it affect, what approval class does the action need) the engine's own header says
// can never be honestly defaulted. Named explicitly per draft, never guessed.
const GROWTH_OPPORTUNITY_JUDGMENT_FIELDS = ['expectedImpactCategory', 'expectedImpactMagnitude', 'actionClassification'];

// "Analytics -> Optimization": every growth-opportunity-shaped record gathered
// anywhere in the plan becomes a draft candidate for the standalone
// agent/core/growthOpportunityEngine.js - real fields relayed or renamed via the
// fixed mapping above, subjective judgment fields named as missing rather than
// invented. This function never calls rankGrowthOpportunities() itself; a caller
// (human or a future explicitly-scoped automation) supplies the missing judgment
// fields per draft first.
function gatherGrowthOpportunityDrafts(completedSteps) {
  const records = gatherGrowthOpportunityRecords(completedSteps);

  return records.map((record) => {
    const category = OPPORTUNITY_TYPE_TO_ENGINE_CATEGORY[record.opportunity_type] || null;
    const reasonParts = [];
    if (isNonEmptyString(record.target_segment)) reasonParts.push(`Segment: ${record.target_segment}`);
    if (isNonEmptyString(record.offer)) reasonParts.push(`Offer: ${record.offer}`);

    const missingForRanking = [...GROWTH_OPPORTUNITY_JUDGMENT_FIELDS];
    if (!category) missingForRanking.unshift('category');
    if (reasonParts.length === 0) missingForRanking.push('reason');
    if (!isNonEmptyString(record.recommendation)) missingForRanking.push('requiredAction');

    return {
      opportunity: `${record.product_reference}${isNonEmptyString(record.recommendation) ? `: ${record.recommendation}` : ''}`,
      category,
      reason: reasonParts.join('; '),
      evidence: [...record.evidence],
      requiredAction: record.recommendation || '',
      verificationStatus: record.verification_status,
      missing_for_ranking: missingForRanking,
    };
  });
}

module.exports = {
  deriveCrossAgentContext,
  deriveAllToAnalyticsContext,
  gatherGrowthOpportunityDrafts,
  mergeContext,
  filterToDeclaredFields,
  dedupeArray,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - cross-agent context passing (pure derivation, no I/O):\n');
  const sampleResearchStep = {
    selected_specialist: { type: 'specialist', id: 'research', title: 'Research' },
    inputs: { capability_id: 'market_research' },
    outputs: {
      topic: 'European hiking apparel market',
      market: 'European Union',
      findings: ['Rising demand for sustainable materials (caller-supplied placeholder).'],
      source: ['(placeholder market report)'],
      confidence: 'medium',
      verification_status: 'unverified',
    },
  };
  const context = deriveCrossAgentContext({
    completedSteps: [sampleResearchStep],
    toSpecialistId: 'product',
    toCapabilityId: 'product_opportunity_analysis',
  });
  console.log('Research -> Product example:');
  console.log(JSON.stringify(context, null, 2));
  console.log('\nEvery value above traces back to the real upstream step\'s own output - nothing invented.');
}
