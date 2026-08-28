'use strict';

// The Product Agent (CLAUDE.md section 2, specialist #2: "Product catalog analysis
// and opportunity research"). Supports 8 capabilities: product discovery, product
// validation, demand analysis, competition analysis, market fit, product risk,
// profitability inputs, and opportunity scoring.
//
// Deterministic only - no AI API call, no external fetch. Callers supply
// already-structured evidence; this module's job is to validate it, compose it into
// the existing product/opportunity schemas (agent/core/productModel.js,
// agent/core/opportunityAnalysisModel.js - reused as-is, never duplicated), and grade
// it honestly - never to synthesize or guess a finding, an assessment, or a score.
//
// Confidence: caller-asserted only, defaulting to 'unassessed', same convention as
// every other module in this project (agent/core/researchAgent.js,
// agent/core/opportunityAnalysisModel.js). A confidence asserted without evidence is
// downgraded back to 'unassessed' (same honesty guard as researchAgent.js's
// verified/unverified downgrade).
//
// Opportunity scoring is a structural coverage count - how many of the 4 assessed
// dimensions (demand, competition, market fit, product risk) ended up evidence-backed
// - never a judgment about whether the opportunity is actually good. Same honesty
// convention as agent/core/competitorIntelligenceAgent.js's data_availability.
//
// Profitability inputs are inputs only: caller-supplied pricing and cost evidence,
// passed through as-is. No margin or profitability figure is ever computed here.
//
// Market fit and product risk are this module's names for
// agent/core/opportunityAnalysisModel.js's existing market_relevance and risks
// dimensions - see analyzeProductOpportunity, which builds a real, validated
// opportunityAnalysisModel.js record (leaving its other 4 dimensions - customer_fit,
// differentiation, commercial_potential, evidence_quality - untouched, since this
// prompt doesn't ask for them).
//
// buildDimension (exported) is reused directly by
// workflows/productOpportunityAnalysisWorkflow.js to build commercial_potential (its
// "Economics" pipeline stage) from market-intelligence-derived evidence - same
// {assessment, evidence, confidence} shape and honesty guard, no duplicated logic.
// commercial_potential is deliberately NOT one of analyzeProductOpportunity's own 4
// assessed dimensions (DIMENSION_RESULT_IDS, from productAgentResultModel.js, is
// unchanged) - only DIMENSION_LABELS/DIMENSION_PARAM_KEYS gained an entry for it, so
// analyzeProductOpportunity's existing behavior is unaffected.
//
// Product discovery here reuses agent/core/productModel.js exactly the way
// agent/core/researchAgent.js reuses its own specialized schemas: build + validate,
// never invent a candidate that wasn't supplied. Not wired to
// integrations/adapters/shopifyClient.js directly - agent/core/ never depends on
// integrations/ or tools/ in this codebase. A caller (e.g.
// tools/productDataRetrievalTool.js) bridges real Shopify data into the plain entry
// shape discoverProducts() already expects.

const { createEmptyProductRecord, validateProductRecordShape } = require('./productModel');
const { createEmptyOpportunityAnalysis, validateOpportunityAnalysisShape } = require('./opportunityAnalysisModel');
const {
  DIMENSION_RESULT_IDS,
  createEmptyProductAgentResult,
  validateProductAgentResultShape,
} = require('./productAgentResultModel');
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

// ---------------------------------------------------------------------------------
// Product discovery - builds and validates agent/core/productModel.js records from
// raw caller-supplied candidates. This IS "data retrieval" in this
// deterministic-only architecture: caller-supplied structured input is the only data
// source that exists today (see module header). Never invents a candidate that
// wasn't supplied.
// ---------------------------------------------------------------------------------

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

function discoverProducts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('discoverProducts requires a non-empty `entries` array.');
  }
  return entries.map((entry) => buildProductRecord(entry, 'discoverProducts'));
}

// ---------------------------------------------------------------------------------
// Product validation - structural completeness audit, never a quality judgment.
// Reuses validateProductRecordShape as-is for structural correctness, then adds a
// purely mechanical completeness check (which fields are non-empty).
// ---------------------------------------------------------------------------------

function assessCompleteness(record) {
  return {
    category: Boolean(record.category),
    description: Boolean(record.description),
    positioning: Boolean(record.positioning),
    target_customer: Boolean(record.target_customer),
    pricing: Boolean(record.pricing && record.pricing.price),
    source: Array.isArray(record.source) && record.source.length > 0,
  };
}

function validateProduct(productRecord) {
  const shapeValidation = validateProductRecordShape(productRecord);
  const completeness = shapeValidation.valid ? assessCompleteness(productRecord) : {};
  const isResearchReady =
    shapeValidation.valid &&
    Array.isArray(productRecord.source) &&
    productRecord.source.length > 0 &&
    productRecord.research_status !== 'not_researched';

  return {
    shape_valid: shapeValidation.valid,
    shape_errors: shapeValidation.errors,
    completeness,
    is_research_ready: isResearchReady,
  };
}

// ---------------------------------------------------------------------------------
// Dimension assessment (demand / competition / market fit / product risk) - shared
// logic for all 4, since they share the exact same {assessment, evidence, confidence}
// sub-shape as agent/core/opportunityAnalysisModel.js's dimensions.
// ---------------------------------------------------------------------------------

const DIMENSION_LABELS = {
  demand: 'Demand',
  competition: 'Competition',
  market_fit: 'Market fit',
  product_risk: 'Product risk',
  // Not one of analyzeProductOpportunity's own 4 assessed dimensions (see
  // DIMENSION_RESULT_IDS above) - added so buildDimension can be reused, unmodified,
  // by workflows/productOpportunityAnalysisWorkflow.js to build
  // agent/core/opportunityAnalysisModel.js's existing commercial_potential dimension
  // (the "Economics" stage - inputs only, never a computed margin).
  commercial_potential: 'Commercial potential',
};

const DIMENSION_PARAM_KEYS = {
  demand: { assessment: 'demandAssessment', evidence: 'demandEvidence', confidence: 'demandConfidence' },
  competition: { assessment: 'competitionAssessment', evidence: 'competitionEvidence', confidence: 'competitionConfidence' },
  market_fit: { assessment: 'marketFitAssessment', evidence: 'marketFitEvidence', confidence: 'marketFitConfidence' },
  product_risk: { assessment: 'productRiskAssessment', evidence: 'productRiskEvidence', confidence: 'productRiskConfidence' },
  commercial_potential: {
    assessment: 'commercialPotentialAssessment',
    evidence: 'commercialPotentialEvidence',
    confidence: 'commercialPotentialConfidence',
  },
};

function buildDimension(params, resultId, fnName) {
  const keys = DIMENSION_PARAM_KEYS[resultId];
  const label = DIMENSION_LABELS[resultId];
  const evidenceEntries = normalizeArray(params[keys.evidence]);
  const evidenceRecords = retrieveResearchData('generic', evidenceEntries, fnName);

  const evidence = [];
  for (const record of evidenceRecords) {
    if (record.finding) evidence.push(record.finding);
    evidence.push(...record.source);
  }

  const assessment = params[keys.assessment] || '';
  const assertedConfidence = params[keys.confidence] || 'unassessed';
  let confidence = assertedConfidence;
  let limitation = null;

  if (evidence.length === 0) {
    if (assertedConfidence !== 'unassessed') {
      confidence = 'unassessed';
      limitation = `${label} confidence was downgraded to unassessed because no evidence was supplied.`;
    } else {
      limitation = `${label} has no evidence-backed assessment.`;
    }
  }

  return { dimension: { assessment, evidence, confidence }, limitation };
}

// ---------------------------------------------------------------------------------
// Profitability inputs - collects real pricing/cost inputs only. Deliberately never
// computes a margin or profitability figure - this capability is inputs, not
// analysis.
// ---------------------------------------------------------------------------------

function buildProfitabilityInputs(params, productRecord, fnName) {
  const costEntries = normalizeArray(params.costComponents);
  const costRecords = retrieveResearchData('generic', costEntries, fnName);

  return {
    pricing: { ...productRecord.pricing },
    cost_components: costRecords.map((record) => ({
      topic: record.topic,
      finding: record.finding,
      source: record.source,
    })),
    evidence: costRecords.filter((record) => record.finding).map((record) => record.finding),
    source: costRecords.flatMap((record) => record.source),
  };
}

// ---------------------------------------------------------------------------------
// Opportunity scoring - a structural coverage count across the 4 dimensions above.
// Never a judgment about whether the opportunity is good, only a mechanical count of
// how many dimensions ended up evidence-backed. Same 'empty'/'partial'/'success'
// tri-state already used across this codebase (e.g.
// agent/core/competitorIntelligenceAgent.js's data_availability).
// ---------------------------------------------------------------------------------

function buildOpportunityScoring(dimensionResults) {
  const backedIds = DIMENSION_RESULT_IDS.filter(
    (id) => dimensionResults[id].confidence !== 'unassessed' && dimensionResults[id].evidence.length > 0
  );
  const total = DIMENSION_RESULT_IDS.length;
  const backed = backedIds.length;

  let status = 'empty';
  if (backed === total) status = 'success';
  else if (backed > 0) status = 'partial';

  return {
    dimensions_total: total,
    dimensions_evidence_backed: backed,
    dimensions_evidence_backed_ids: backedIds,
    status,
  };
}

// ---------------------------------------------------------------------------------
// Combined entry point - demand, competition, market fit, product risk,
// profitability inputs, and opportunity scoring, for one product.
// ---------------------------------------------------------------------------------

function analyzeProductOpportunity(params = {}) {
  const fnName = 'analyzeProductOpportunity';
  const productRecord = buildProductRecord(params, fnName);

  const dimensionResults = {};
  const limitations = [
    'No external research source is configured; this result reflects only caller-supplied evidence.',
  ];
  for (const resultId of DIMENSION_RESULT_IDS) {
    const built = buildDimension(params, resultId, fnName);
    dimensionResults[resultId] = built.dimension;
    if (built.limitation) limitations.push(built.limitation);
  }

  // Real reuse of agent/core/opportunityAnalysisModel.js: market_fit and
  // product_risk map onto its existing market_relevance and risks dimensions. The
  // other 4 dimensions it defines stay at their default empty/unassessed shape -
  // this prompt doesn't ask for them.
  const opportunityAnalysis = createEmptyOpportunityAnalysis(productRecord.product_identity);
  opportunityAnalysis.demand = dimensionResults.demand;
  opportunityAnalysis.competition = dimensionResults.competition;
  opportunityAnalysis.market_relevance = dimensionResults.market_fit;
  opportunityAnalysis.risks = dimensionResults.product_risk;
  const opportunityValidation = validateOpportunityAnalysisShape(opportunityAnalysis);
  if (!opportunityValidation.valid) {
    throw new Error(
      `${fnName} produced an invalid opportunity analysis record: ${opportunityValidation.errors.join('; ')}`
    );
  }

  const profitabilityInputs = buildProfitabilityInputs(params, productRecord, fnName);
  const opportunityScoring = buildOpportunityScoring(dimensionResults);
  const validation = validateProduct(productRecord);

  const result = createEmptyProductAgentResult(productRecord.product_identity);
  result.market = productRecord.market.join(', ');
  result.research_date = params.researchDate || todayIsoDate();
  result.validation = validation;
  result.demand = dimensionResults.demand;
  result.competition = dimensionResults.competition;
  result.market_fit = dimensionResults.market_fit;
  result.product_risk = dimensionResults.product_risk;
  result.profitability_inputs = profitabilityInputs;
  result.opportunity_scoring = opportunityScoring;
  result.limitations = limitations;
  result.source = [
    ...productRecord.source,
    ...dimensionResults.demand.evidence,
    ...dimensionResults.competition.evidence,
    ...dimensionResults.market_fit.evidence,
    ...dimensionResults.product_risk.evidence,
    ...profitabilityInputs.source,
  ];
  result.specialized_records = { product_record: productRecord, opportunity_analysis: opportunityAnalysis };

  const resultValidation = validateProductAgentResultShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed product agent result failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  discoverProducts,
  validateProduct,
  analyzeProductOpportunity,
  buildDimension,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Product Agent (deterministic, evidence-composition only):\n');

  console.log('--- product discovery ---');
  const candidates = discoverProducts([
    {
      productIdentity: '(Example insulated jacket)',
      category: 'outdoor apparel',
      description: 'Caller-supplied placeholder description.',
      pricing: { currency: 'EUR', cost: '', price: '89.00' },
      source: ['(placeholder store export reference)'],
    },
    { productIdentity: '(Example example hiking gloves)' },
  ]);
  console.log(JSON.stringify(candidates, null, 2));

  console.log('\n--- product validation (first candidate) ---');
  console.log(JSON.stringify(validateProduct(candidates[0]), null, 2));

  console.log('\n--- analyzeProductOpportunity (mixed evidence, to show all 3 states honestly) ---');
  const result = analyzeProductOpportunity({
    productIdentity: '(Example insulated jacket)',
    category: 'outdoor apparel',
    market: 'European Union',
    pricing: { currency: 'EUR', cost: '35.00', price: '89.00' },
    source: ['(placeholder store export reference)'],
    // demand: fully evidence-backed (success)
    demandAssessment: 'Caller-supplied placeholder assessment.',
    demandEvidence: [{ topic: 'Search interest', finding: 'Rising search interest (placeholder).', source: ['(placeholder source)'] }],
    demandConfidence: 'medium',
    // competition: assessed without evidence (deliberately downgraded)
    competitionAssessment: 'Caller-supplied placeholder assessment.',
    competitionConfidence: 'high',
    // market_fit, product_risk: deliberately omitted, to show the honest 'empty' state
    costComponents: [{ topic: 'Manufacturing cost', finding: 'Caller-supplied placeholder finding.', source: ['(placeholder cost source)'] }],
  });
  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('opportunity_scoring is a structural coverage count only, never a judgment about opportunity quality.');
}
