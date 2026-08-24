'use strict';

// Structured ecommerce competitor research: for one competitor, analyzes where real,
// evidenced data actually exists across 8 areas - products, positioning, pricing,
// offers, listings, SEO signals, social presence, advertising signals - and separates
// the result into observed facts, analysis, and recommendations rather than one flat
// findings list (see agent/core/researchAgent.js's existing competitor_research type
// for that flatter shape).
//
// Reuses, never modifies: agent/core/researchAgent.js's exported
// retrieveResearchData() for both the 'competitor' kind (positioning/pricing/
// seo_signals - agent/core/competitorResearchModel.js, one record) and the 'generic'
// kind (the other 5 areas - agent/core/researchRecordModel.js, one record per item).
// No new record-building logic is written for anything retrieveResearchData already
// handles.
//
// Deterministic only - no AI call, no external fetch. "Analyze where actual data is
// available" means a structural, non-fabricated availability audit: for every area,
// 'empty' (nothing supplied), 'partial' (supplied but not evidenced), or 'success'
// (supplied and evidenced) - never an invented interpretation of what the data means
// competitively. This is what fills the `analysis` section.
//
// Statement-type vocabulary (observed_fact / interpretation / recommendation) matches
// workflows/analyticsInsightWorkflow.js's STATEMENT_TYPES ids, kept as local
// constants rather than a cross-directory require - agent/core/ has never depended on
// workflows/, and introducing that direction for 3 string literals isn't worth it.
const STATEMENT_TYPE_OBSERVED_FACT = 'observed_fact';
const STATEMENT_TYPE_INTERPRETATION = 'interpretation';
const STATEMENT_TYPE_RECOMMENDATION = 'recommendation';

const {
  COMPETITOR_INTELLIGENCE_AREAS,
  createEmptyCompetitorIntelligence,
  validateCompetitorIntelligenceShape,
} = require('./competitorIntelligenceModel');
const { retrieveResearchData } = require('./researchAgent');

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Areas backed by agent/core/competitorResearchModel.js directly - one shared
// evidence pool (the record's own `source` field), not per-field evidence.
const SCALAR_AREA_ACCESSORS = {
  positioning: (record) => (record.positioning ? [record.positioning] : []),
  pricing: (record) => record.pricing_evidence,
  seo_signals: (record) => record.seo_signals,
};

// Areas backed by the generic agent/core/researchRecordModel.js shape - per-item
// evidence (each record's own `source` field).
const LIST_AREAS = ['products', 'offers', 'listings', 'social_presence', 'advertising_signals'];

const AREA_LABELS = {
  products: 'Products',
  positioning: 'Positioning',
  pricing: 'Pricing',
  offers: 'Offers',
  listings: 'Listings',
  seo_signals: 'SEO signals',
  social_presence: 'Social presence',
  advertising_signals: 'Advertising signals',
};

function deriveScalarAreaStatus(hasValue, hasEvidence) {
  if (!hasValue) return 'empty';
  return hasEvidence ? 'success' : 'partial';
}

// Same empty/partial/success derivation already used in
// tools/competitorResearchTool.js's deriveStatus and
// workflows/globalEcommerceMarketResearchWorkflow.js's deriveEntryFacetStatus -
// reused as a pattern (each capability module owns its own copy; there is no
// shared-utils module in this codebase).
function deriveListAreaStatus(entries) {
  if (entries.length === 0) return 'empty';
  const withEvidence = entries.filter((entry) => entry.evidence.length > 0).length;
  if (withEvidence === 0) return 'empty';
  if (withEvidence === entries.length) return 'success';
  return 'partial';
}

function describeAvailability(area, status) {
  const label = AREA_LABELS[area];
  if (status === 'success') return `${label}: real, evidenced data is available.`;
  if (status === 'partial') return `${label}: some data was supplied, but it is not backed by evidence.`;
  return `${label}: no real data was supplied - unavailable.`;
}

function analyzeCompetitorIntelligence(params = {}) {
  const fnName = 'analyzeCompetitorIntelligence';
  const [competitorRecord] = retrieveResearchData(
    'competitor',
    [
      {
        competitor: params.competitor,
        market: params.market,
        productCategory: params.productCategory,
        positioning: params.positioning,
        pricingEvidence: params.pricingEvidence,
        strengths: params.strengths,
        weaknesses: params.weaknesses,
        marketingSignals: params.marketingSignals,
        seoSignals: params.seoSignals,
        opportunities: params.opportunities,
        source: params.source,
        researchDate: params.researchDate,
      },
    ],
    fnName
  );

  const areaRecords = {};
  for (const area of LIST_AREAS) {
    areaRecords[area] = retrieveResearchData('generic', normalizeArray(params[toParamKey(area)]), fnName);
  }

  const dataAvailability = {};
  const observedFacts = [];
  const analysis = [];
  const aggregateSource = [];

  for (const area of COMPETITOR_INTELLIGENCE_AREAS) {
    let findings;
    let evidence;
    let status;

    if (area in SCALAR_AREA_ACCESSORS) {
      const value = SCALAR_AREA_ACCESSORS[area](competitorRecord);
      const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
      const hasEvidence = competitorRecord.source.length > 0;
      status = deriveScalarAreaStatus(hasValue, hasEvidence);
      findings = Array.isArray(value) ? value : value ? [value] : [];
      evidence = hasEvidence ? [...competitorRecord.source] : [];
    } else {
      const records = areaRecords[area];
      const entries = records.map((record) => ({
        finding: record.finding,
        evidence: record.source,
      }));
      status = deriveListAreaStatus(entries);
      findings = records.filter((record) => record.finding).map((record) => record.finding);
      evidence = records.flatMap((record) => record.source);
    }

    dataAvailability[area] = status;
    observedFacts.push({ area, statement_type: STATEMENT_TYPE_OBSERVED_FACT, findings, evidence });
    analysis.push({ area, statement_type: STATEMENT_TYPE_INTERPRETATION, status, text: describeAvailability(area, status) });
    aggregateSource.push(...evidence);
  }

  const result = createEmptyCompetitorIntelligence(competitorRecord.competitor);
  result.market = competitorRecord.market;
  result.research_date = competitorRecord.research_date || todayIsoDate();
  result.data_availability = dataAvailability;
  result.observed_facts = observedFacts;
  result.analysis = analysis;
  result.recommendations = normalizeArray(params.recommendations).map((text) => text);
  result.limitations = [
    'No external research source is configured; this result reflects only caller-supplied evidence.',
    ...COMPETITOR_INTELLIGENCE_AREAS.filter((area) => dataAvailability[area] !== 'success').map(
      (area) => `${AREA_LABELS[area]} is ${dataAvailability[area]} for ${competitorRecord.competitor}.`
    ),
  ];
  result.source = aggregateSource;
  result.specialized_records = {
    competitor_record: competitorRecord,
    area_records: areaRecords,
  };

  const validation = validateCompetitorIntelligenceShape(result);
  if (!validation.valid) {
    throw new Error(`Composed competitor intelligence result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

// Maps a snake_case area id to the camelCase params key callers use for it (matching
// every other function in this codebase, which takes camelCase params but produces
// snake_case record fields).
function toParamKey(area) {
  return area.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

module.exports = {
  analyzeCompetitorIntelligence,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - structured competitor intelligence (deterministic, evidence-audited):\n');

  const result = analyzeCompetitorIntelligence({
    competitor: '(Example Competitor Co.)',
    market: 'European Union',
    positioning: 'Premium, sustainability-focused (caller-supplied placeholder).',
    pricingEvidence: ['(placeholder pricing page reference)'],
    seoSignals: ['Ranks for "recycled outdoor jacket" (caller-supplied placeholder).'],
    source: ['(placeholder competitor source reference)'],
    products: [
      { topic: 'Insulated jacket line', finding: 'Caller-supplied placeholder finding.', source: ['(placeholder product page)'] },
    ],
    offers: [
      { topic: 'Seasonal discount', finding: 'Caller-supplied placeholder finding - no source given.' },
    ],
    // listings, social_presence, advertising_signals deliberately omitted - to
    // demonstrate the honest 'empty' status.
    recommendations: ['(Example) Monitor this competitor\'s pricing page monthly.'],
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('No field in this result is a computed statistic - only pass-through content and structural availability signals.');
}
