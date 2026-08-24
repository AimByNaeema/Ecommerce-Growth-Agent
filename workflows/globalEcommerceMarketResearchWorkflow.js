'use strict';

// The global ecommerce market research workflow: compares markets side-by-side across
// 9 dimensions - countries, markets, categories, products, trends, competition,
// pricing, demand signals, and risks. Markets are the comparison axis (one row per
// country/market, matching agent/core/researchAgent.js's runGlobalMarketResearch
// market-entry shape); the other 7 items are evidence-backed facets compared across
// those rows.
//
// Real, executable logic - unlike every other file in workflows/ (keywordResearchWorkflow.js,
// productOpportunityAnalysisWorkflow.js, contentMarketingWorkflow.js,
// analyticsInsightWorkflow.js), which are conceptual stage-lists only. This module
// breaks that mold the same way agent/core/researchAgent.js broke the schema-only mold
// for agent/core/ - it actually composes caller-supplied evidence into a structured,
// testable comparison result. See workflows/README.md.
//
// Deterministic only - no AI call, no external fetch, no invented statistic anywhere.
// Every facet is either a direct pass-through of caller-supplied content, a structural
// evidence-presence signal (has_evidence: boolean, or status: 'empty'|'partial'|'success'
// - the exact derivation already used by tools/competitorResearchTool.js and
// tools/customerResearchTool.js), or a plain array length. Never a computed number,
// percentage, score, or ranking - "do not create unsupported market statistics" is
// enforced by never having a field that could hold one.
//
// Reuses agent/core/researchAgent.js's retrieveResearchData() for the 'market' and
// 'competitor' kinds (no new record-building logic for those two), and
// agent/core/productModel.js's createEmptyProductRecord/validateProductRecordShape via
// one small local builder (productModel.js isn't one of retrieveResearchData's
// existing kinds).

const {
  createEmptyGlobalMarketComparison,
  validateGlobalMarketComparisonShape,
} = require('../agent/core/globalMarketComparisonModel');
const { retrieveResearchData } = require('../agent/core/researchAgent');
const { createEmptyProductRecord, validateProductRecordShape } = require('../agent/core/productModel');

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

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Product record retrieval - reuses agent/core/productModel.js as-is. Not one of
// agent/core/researchAgent.js's retrieveResearchData() kinds, so this small builder is
// new composition (not new schema).
// ---------------------------------------------------------------------------------

function buildProductRecord(entry, fnName) {
  requireObjectEntry(entry, 'products', fnName);
  if (typeof entry.productIdentity !== 'string' || entry.productIdentity.trim() === '') {
    throw new Error(`${fnName} requires each \`products\` entry to have a non-empty \`productIdentity\` string.`);
  }
  const record = createEmptyProductRecord(entry.productIdentity);
  record.category = entry.category || '';
  record.product_model = entry.productModel || '';
  record.description = entry.description || '';
  record.positioning = entry.positioning || '';
  record.target_customer = entry.targetCustomer || '';
  record.market = normalizeArray(entry.market);
  record.pricing = entry.pricing || { currency: '', cost: '', price: '' };
  record.availability = entry.availability || 'unknown';
  record.source = normalizeArray(entry.source);
  record.research_status = entry.researchStatus || 'not_researched';

  const validation = validateProductRecordShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid product record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// ---------------------------------------------------------------------------------
// Facet builders - structural evidence-presence only, never a computed statistic.
// ---------------------------------------------------------------------------------

function buildScalarFacet(value, evidence, label, rowLimitations) {
  const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
  if (!hasEvidence) {
    rowLimitations.push(`No evidence was supplied for ${label}.`);
  }
  return { value, evidence: [...evidence], has_evidence: hasEvidence };
}

// Same empty/partial/success derivation as tools/competitorResearchTool.js and
// tools/customerResearchTool.js's deriveStatus - reused as a pattern, not imported,
// since it operates on plain {evidence} entries here rather than a composed envelope's
// limitations list.
function deriveEntryFacetStatus(entries) {
  if (entries.length === 0) return 'empty';
  const withEvidence = entries.filter((entry) => entry.evidence.length > 0).length;
  if (withEvidence === 0) return 'empty';
  if (withEvidence === entries.length) return 'success';
  return 'partial';
}

function buildEntryFacet(entries, label, rowLimitations) {
  const status = deriveEntryFacetStatus(entries);
  if (status !== 'success') {
    rowLimitations.push(`${label} evidence is ${status}.`);
  }
  return { status, entries };
}

// ---------------------------------------------------------------------------------
// One comparison row per market.
// ---------------------------------------------------------------------------------

function buildComparisonRow(entry, fnName) {
  requireObjectEntry(entry, 'markets', fnName);
  const rowLimitations = [];

  const [marketRecord] = retrieveResearchData('market', [entry], fnName);
  const competitorRecords = retrieveResearchData('competitor', normalizeArray(entry.competitors), fnName);
  const productRecords = normalizeArray(entry.products).map((productEntry) =>
    buildProductRecord(productEntry, fnName)
  );

  const category = buildScalarFacet(
    marketRecord.category,
    marketRecord.evidence,
    `category in ${marketRecord.market}`,
    rowLimitations
  );
  const demandSignals = buildScalarFacet(
    marketRecord.demand_signals,
    marketRecord.evidence,
    `demand signals in ${marketRecord.market}`,
    rowLimitations
  );
  const trends = buildScalarFacet(
    marketRecord.trends,
    marketRecord.evidence,
    `trends in ${marketRecord.market}`,
    rowLimitations
  );
  const risks = buildScalarFacet(
    marketRecord.risks,
    marketRecord.evidence,
    `risks in ${marketRecord.market}`,
    rowLimitations
  );

  const competitionEntries = competitorRecords.map((record) => ({
    competitor: record.competitor,
    positioning: record.positioning,
    strengths: record.strengths,
    weaknesses: record.weaknesses,
    evidence: record.source,
  }));
  const competition = buildEntryFacet(competitionEntries, `Competition in ${marketRecord.market}`, rowLimitations);

  const pricingEntries = competitorRecords.map((record) => ({
    competitor: record.competitor,
    pricing_evidence: record.pricing_evidence,
    evidence: record.source,
  }));
  const pricing = buildEntryFacet(pricingEntries, `Pricing in ${marketRecord.market}`, rowLimitations);

  const productEntries = productRecords.map((record) => ({
    product_identity: record.product_identity,
    positioning: record.positioning,
    pricing: record.pricing,
    availability: record.availability,
    evidence: record.source,
  }));
  const products = buildEntryFacet(productEntries, `Products in ${marketRecord.market}`, rowLimitations);

  return {
    market: marketRecord.market,
    country: marketRecord.country,
    category,
    demand_signals: demandSignals,
    trends,
    risks,
    competition,
    pricing,
    products,
    limitations: rowLimitations,
    specialized_records: {
      market: marketRecord,
      competitors: competitorRecords,
      products: productRecords,
    },
  };
}

// ---------------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------------

function compareGlobalMarkets(params = {}) {
  const { markets, topic } = params;
  requireNonEmptyArray(markets, 'markets', 'compareGlobalMarkets');

  const rows = markets.map((entry) => buildComparisonRow(entry, 'compareGlobalMarkets'));
  const marketLabels = rows.map((row) => row.market);

  const result = createEmptyGlobalMarketComparison(topic || `Global market comparison: ${marketLabels.join(', ')}`);
  result.markets_compared = marketLabels;
  result.comparison = rows;
  result.limitations = [
    'No external research source is configured; this result reflects only caller-supplied evidence.',
    ...rows.flatMap((row) => row.limitations.map((limitation) => `[${row.market}] ${limitation}`)),
  ];
  result.research_date = todayIsoDate();

  const validation = validateGlobalMarketComparisonShape(result);
  if (!validation.valid) {
    throw new Error(`Composed global market comparison failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  compareGlobalMarkets,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - global ecommerce market research workflow:\n');

  const result = compareGlobalMarkets({
    markets: [
      {
        country: 'DE',
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['Rising search interest in insulated jackets (caller-supplied placeholder).'],
        trends: ['Growing preference for recycled materials (caller-supplied placeholder).'],
        risks: ['New EU textile labeling regulation (caller-supplied placeholder).'],
        evidence: ['(placeholder market evidence reference)'],
        competitors: [
          {
            competitor: '(Example EU Competitor Co.)',
            pricingEvidence: ['(placeholder pricing page reference)'],
            strengths: ['Fast shipping (caller-supplied placeholder).'],
            weaknesses: ['Limited size range (caller-supplied placeholder).'],
            source: ['(placeholder competitor source reference)'],
          },
        ],
        products: [
          {
            productIdentity: '(Example insulated jacket)',
            positioning: 'Mid-range, recycled materials (caller-supplied placeholder).',
            pricing: { currency: 'EUR', cost: '40', price: '90' },
            availability: 'available',
            source: ['(placeholder product source reference)'],
          },
        ],
      },
      {
        // Deliberately sparse - no competitors/products/evidence supplied, to
        // demonstrate the honest empty/partial reporting (never fabricated).
        country: 'US',
        market: 'North America',
        category: 'outdoor apparel',
        demandSignals: ['(placeholder demand signal, no evidence supplied)'],
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('No field in this result is a computed statistic - only pass-through content and structural evidence-presence signals.');
}
