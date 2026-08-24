'use strict';

// The Product Opportunity scoring engine. Evaluates 8 dimensions of one product
// opportunity - demand, competition, market fit, pricing, margin inputs, trend, risk,
// differentiation - and reports honestly how much real, evidenced input exists for
// each. Never invents a missing value: where required information is absent, the
// engine names exactly what's missing (missing_inputs) instead of guessing.
//
// Standalone deliverable, distinct from agent/core/productAgent.js's own
// opportunity_scoring field (a narrower, 4-dimension coverage count) - that field is
// untouched by this module.
//
// Reuses, never duplicates: agent/core/productModel.js (product record - pricing and
// margin_inputs read productRecord.pricing.cost/price directly, nothing new invented)
// and agent/core/opportunityAnalysisModel.js (demand, competition, market_relevance,
// risks, differentiation dimensions - market_fit and risk are this engine's names for
// the latter two, same mapping agent/core/productAgent.js already established). trend
// has no dedicated schema, so it reuses the generic agent/core/researchRecordModel.js
// shape via agent/core/researchAgent.js's exported retrieveResearchData('generic', ...)
// - the same primitive researchAgent.js's own runTrendResearch and productAgent.js's
// profitability_inputs.cost_components already use for evidence with no dedicated
// schema.
//
// coverage_score is a mechanical evidence-coverage measurement (how many of the 8
// dimensions have real, evidenced input) - never a judgment about whether the
// opportunity is good. All 8 dimensions are weighted equally; no unjustified
// weighting scheme is invented.
//
// Builds its own agent/core/productModel.js and agent/core/opportunityAnalysisModel.js
// records directly from raw params rather than calling agent/core/productAgent.js:
// that module's analyzeProductOpportunity() only fills 4 of
// opportunityAnalysisModel.js's 8 dimensions and does not touch differentiation, which
// this engine needs. Its own small per-dimension status-deriving helper is not shared
// with productAgent.js or agent/core/competitorIntelligenceAgent.js - matching this
// codebase's convention that each capability module owns its own small derivation
// helper (there is no shared-utils module anywhere in this project).

const { createEmptyProductRecord, validateProductRecordShape } = require('./productModel');
const { createEmptyOpportunityAnalysis, validateOpportunityAnalysisShape } = require('./opportunityAnalysisModel');
const {
  PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS,
  createEmptyProductOpportunityScore,
  validateProductOpportunityScoreShape,
} = require('./productOpportunityScoreModel');
const { retrieveResearchData } = require('./researchAgent');

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

function buildProductRecord(entry, fnName) {
  requireNonEmptyString(entry.productIdentity, 'productIdentity', fnName);
  const record = createEmptyProductRecord(entry.productIdentity);
  record.category = entry.category || '';
  record.product_model = entry.productModel || '';
  record.description = entry.description || '';
  record.positioning = entry.positioning || '';
  record.target_customer = entry.targetCustomer || '';
  record.market = normalizeArray(entry.market);
  if (entry.pricing) {
    record.pricing = {
      currency: entry.pricing.currency || '',
      cost: entry.pricing.cost || '',
      price: entry.pricing.price || '',
    };
  }
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
// Assessed dimensions: demand, competition, market_fit, risk, differentiation map
// directly onto agent/core/opportunityAnalysisModel.js's dimensions (market_fit ->
// market_relevance, risk -> risks). trend has no dedicated dimension shape and is
// built separately below (see buildTrendRecords).
// ---------------------------------------------------------------------------------

const ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD = {
  demand: 'demand',
  competition: 'competition',
  market_fit: 'market_relevance',
  risk: 'risks',
  differentiation: 'differentiation',
};

const DIMENSION_LABELS = {
  demand: 'Demand',
  competition: 'Competition',
  market_fit: 'Market fit',
  risk: 'Risk',
  differentiation: 'Differentiation',
  trend: 'Trend',
  pricing: 'Pricing',
  margin_inputs: 'Margin inputs',
};

const DIMENSION_PARAM_KEYS = {
  demand: { assessment: 'demandAssessment', evidence: 'demandEvidence', confidence: 'demandConfidence' },
  competition: { assessment: 'competitionAssessment', evidence: 'competitionEvidence', confidence: 'competitionConfidence' },
  market_fit: { assessment: 'marketFitAssessment', evidence: 'marketFitEvidence', confidence: 'marketFitConfidence' },
  risk: { assessment: 'riskAssessment', evidence: 'riskEvidence', confidence: 'riskConfidence' },
  differentiation: { assessment: 'differentiationAssessment', evidence: 'differentiationEvidence', confidence: 'differentiationConfidence' },
};

// Builds one {assessment, evidence, confidence} dimension from raw params - never
// invents an assessment or evidence item that wasn't supplied. A confidence asserted
// without evidence is downgraded back to 'unassessed' (same honesty guard already
// established in agent/core/researchAgent.js and agent/core/productAgent.js).
function buildAssessedDimension(params, dimensionId, fnName) {
  const keys = DIMENSION_PARAM_KEYS[dimensionId];
  const evidenceEntries = normalizeArray(params[keys.evidence]);
  const evidenceRecords = retrieveResearchData('generic', evidenceEntries, fnName);

  const evidence = [];
  for (const record of evidenceRecords) {
    if (record.finding) evidence.push(record.finding);
    evidence.push(...record.source);
  }

  const assessment = params[keys.assessment] || '';
  const assertedConfidence = params[keys.confidence] || 'unassessed';
  const confidence = evidence.length === 0 ? 'unassessed' : assertedConfidence;

  return { assessment, evidence, confidence };
}

// Same tri-state derivation agent/core/competitorIntelligenceAgent.js's
// deriveScalarAreaStatus uses: no evidence -> 'empty'; evidence present and
// confidence asserted -> 'success'; evidence present but confidence stayed
// 'unassessed' -> 'partial'.
function deriveAssessedDimensionStatus(dimension) {
  if (dimension.evidence.length === 0) return 'empty';
  return dimension.confidence !== 'unassessed' ? 'success' : 'partial';
}

// Same list-area derivation agent/core/competitorIntelligenceAgent.js's
// deriveListAreaStatus uses: no records -> 'empty'; every record evidenced ->
// 'success'; otherwise -> 'partial'.
function buildTrendRecords(params, fnName) {
  const entries = normalizeArray(params.trendEvidence);
  return retrieveResearchData('generic', entries, fnName);
}

function deriveTrendStatus(trendRecords) {
  if (trendRecords.length === 0) return 'empty';
  const evidencedCount = trendRecords.filter((record) => record.source.length > 0).length;
  if (evidencedCount === 0) return 'empty';
  return evidencedCount === trendRecords.length ? 'success' : 'partial';
}

function trendEvidence(trendRecords) {
  const evidence = [];
  for (const record of trendRecords) {
    if (record.finding) evidence.push(record.finding);
    evidence.push(...record.source);
  }
  return evidence;
}

// ---------------------------------------------------------------------------------
// pricing / margin_inputs: raw facts read directly from productModel.js's existing
// pricing field - never assessed/evidenced the way the other dimensions are, since
// they are supplied data, not a judgment requiring evidence. margin_inputs never
// computes an actual margin - it only reports whether both inputs needed to compute
// one later exist (same "inputs only" precedent as productAgent.js's
// profitability_inputs).
// ---------------------------------------------------------------------------------

function derivePricingStatus(productRecord) {
  return productRecord.pricing.price ? 'success' : 'empty';
}

function deriveMarginInputsStatus(productRecord) {
  const hasCost = Boolean(productRecord.pricing.cost);
  const hasPrice = Boolean(productRecord.pricing.price);
  if (hasCost && hasPrice) return 'success';
  if (hasCost || hasPrice) return 'partial';
  return 'empty';
}

function buildMissingInputReason(dimensionId, status, productRecord) {
  const label = DIMENSION_LABELS[dimensionId];
  if (dimensionId === 'pricing') {
    return 'No price is set on the product record (pricing.price).';
  }
  if (dimensionId === 'margin_inputs') {
    const missingParts = [];
    if (!productRecord.pricing.cost) missingParts.push('cost (pricing.cost)');
    if (!productRecord.pricing.price) missingParts.push('price (pricing.price)');
    return `Margin cannot be computed - missing: ${missingParts.join(', ')}.`;
  }
  if (status === 'empty') {
    return `${label} has no assessment or evidence supplied.`;
  }
  return `${label} has no evidence-backed assessment.`;
}

// ---------------------------------------------------------------------------------
// Combined entry point.
// ---------------------------------------------------------------------------------

function scoreProductOpportunity(params = {}) {
  const fnName = 'scoreProductOpportunity';
  const productRecord = buildProductRecord(params, fnName);

  const opportunityAnalysis = createEmptyOpportunityAnalysis(productRecord.product_identity);
  const assessedDimensions = {};
  for (const [dimensionId, opportunityField] of Object.entries(ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD)) {
    const dimension = buildAssessedDimension(params, dimensionId, fnName);
    assessedDimensions[dimensionId] = dimension;
    opportunityAnalysis[opportunityField] = dimension;
  }
  const opportunityValidation = validateOpportunityAnalysisShape(opportunityAnalysis);
  if (!opportunityValidation.valid) {
    throw new Error(
      `${fnName} produced an invalid opportunity analysis record: ${opportunityValidation.errors.join('; ')}`
    );
  }

  const trendRecords = buildTrendRecords(params, fnName);

  const dimensionStatus = {};
  const dimensionEvidence = {};
  for (const dimensionId of Object.keys(ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD)) {
    dimensionStatus[dimensionId] = deriveAssessedDimensionStatus(assessedDimensions[dimensionId]);
    dimensionEvidence[dimensionId] = assessedDimensions[dimensionId].evidence;
  }
  dimensionStatus.trend = deriveTrendStatus(trendRecords);
  dimensionEvidence.trend = trendEvidence(trendRecords);
  dimensionStatus.pricing = derivePricingStatus(productRecord);
  dimensionEvidence.pricing = productRecord.pricing.price ? [...productRecord.source] : [];
  dimensionStatus.margin_inputs = deriveMarginInputsStatus(productRecord);
  dimensionEvidence.margin_inputs = dimensionStatus.margin_inputs !== 'empty' ? [...productRecord.source] : [];

  const missingInputs = [];
  for (const dimensionId of PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS) {
    if (dimensionStatus[dimensionId] !== 'success') {
      missingInputs.push({
        dimension: dimensionId,
        reason: buildMissingInputReason(dimensionId, dimensionStatus[dimensionId], productRecord),
      });
    }
  }

  const statuses = Object.values(dimensionStatus);
  const dimensionsTotal = PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.length;
  const dimensionsAvailable = statuses.filter((status) => status === 'success').length;
  const dimensionsPartial = statuses.filter((status) => status === 'partial').length;
  const dimensionsMissing = statuses.filter((status) => status === 'empty').length;
  let coverageStatus = 'empty';
  if (dimensionsAvailable === dimensionsTotal) coverageStatus = 'success';
  else if (dimensionsAvailable > 0) coverageStatus = 'partial';

  const result = createEmptyProductOpportunityScore(productRecord.product_identity);
  result.research_date = params.researchDate || todayIsoDate();
  result.dimension_status = dimensionStatus;
  result.missing_inputs = missingInputs;
  result.coverage_score = {
    dimensions_total: dimensionsTotal,
    dimensions_available: dimensionsAvailable,
    dimensions_partial: dimensionsPartial,
    dimensions_missing: dimensionsMissing,
    percentage: Math.round((dimensionsAvailable / dimensionsTotal) * 100),
    status: coverageStatus,
  };
  result.source = PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.flatMap((dimensionId) => dimensionEvidence[dimensionId]);
  result.specialized_records = {
    product_record: productRecord,
    opportunity_analysis: opportunityAnalysis,
    trend_records: trendRecords,
  };

  const resultValidation = validateProductOpportunityScoreShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed product opportunity score failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  scoreProductOpportunity,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Product Opportunity scoring engine (deterministic, no invented values):\n');

  const result = scoreProductOpportunity({
    productIdentity: '(Example insulated jacket)',
    category: 'outdoor apparel',
    market: 'European Union',
    // pricing: deliberately only a cost, no price - to show pricing 'empty' and
    // margin_inputs 'partial' honestly.
    pricing: { currency: 'EUR', cost: '35.00' },
    source: ['(placeholder store export reference)'],
    // demand: fully evidence-backed (success)
    demandAssessment: 'Caller-supplied placeholder assessment.',
    demandEvidence: [{ topic: 'Search interest', finding: 'Rising search interest (placeholder).', source: ['(placeholder source)'] }],
    demandConfidence: 'medium',
    // competition: assessed without evidence (confidence honestly downgraded)
    competitionAssessment: 'Caller-supplied placeholder assessment.',
    competitionConfidence: 'high',
    // trend: two entries, only one evidenced (partial)
    trendEvidence: [
      { topic: 'Recycled materials', finding: 'Growing preference (placeholder).', source: ['(placeholder trend source)'] },
      { topic: 'Plus-size range', finding: 'Underserved segment (placeholder).' },
    ],
    // market_fit, risk, differentiation: deliberately omitted, to show the honest
    // 'empty' state.
  });
  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('coverage_score is a mechanical evidence-coverage measurement only, never a judgment about opportunity quality.');
}
