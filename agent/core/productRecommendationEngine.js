'use strict';

// The final layer of the Product pipeline: composes an already-computed, already-
// validated agent/core/productOpportunityScoreModel.js record (from
// agent/core/productOpportunityScoringEngine.js's scoreProductOpportunity()) into one
// structured recommendation - opportunity, reasoning, evidence, risks, missing
// information, confidence, recommended next step.
//
// This module makes no external calls of any kind (no fetch, no tool, no
// integrations/ or tools/ dependency) - it never purchases, publishes, or imports a
// product. Its exported surface is exactly one function
// (buildProductRecommendation), verified by a test, so no hidden action-executing
// export can slip in unnoticed. Per approvals/approvalArchitecture.js's taxonomy, a
// recommendation like this is 'recommendation'-class at most if ever wired into the
// tool registry - never 'externally_executable' - since producing a suggestion needs
// no approval, only acting on one does.
//
// Every field is either reused as-is from the input score record or mechanically
// derived from it - nothing here is a fabricated business judgment:
// - opportunity: composed from the score record's own product_record fields.
// - reasoning: composed only from real, caller-supplied assessment text plus each
//   dimension's already-computed structural status - never new interpretive text.
// - evidence / missing_information: direct copies of the score record's own
//   source / missing_inputs fields.
// - risks: the real risks dimension object, taken as-is, never re-assessed.
// - confidence: a deterministic mapping from the score record's coverage_score
//   percentage onto agent/core/researchRecordModel.js's existing CONFIDENCE_LEVELS
//   enum - never a business judgment about whether the opportunity is good.
// - recommended_next_step: caller-suppliable; when omitted, a deterministic,
//   structural default (close the named evidence gaps, or route to a human for a
//   go/no-go decision) - never a specific fabricated business action.

const { PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS, validateProductOpportunityScoreShape } = require('./productOpportunityScoreModel');
const { createEmptyProductRecommendation, validateProductRecommendationShape } = require('./productRecommendationModel');

const DIMENSION_LABELS = {
  demand: 'Demand',
  competition: 'Competition',
  market_fit: 'Market fit',
  pricing: 'Pricing',
  margin_inputs: 'Margin inputs',
  trend: 'Trend',
  risk: 'Risk',
  differentiation: 'Differentiation',
};

// The 5 dimensions backed by a real agent/core/opportunityAnalysisModel.js
// {assessment, evidence, confidence} object - risk is composed separately into its
// own top-level `risks` field, but is still included here for the reasoning summary.
const ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD = {
  demand: 'demand',
  competition: 'competition',
  market_fit: 'market_relevance',
  risk: 'risks',
  differentiation: 'differentiation',
};

function buildReasoningLine(dimensionId, status, opportunityAnalysis, productRecord, trendRecords) {
  const label = DIMENSION_LABELS[dimensionId];

  if (dimensionId in ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD) {
    const dimension = opportunityAnalysis[ASSESSED_DIMENSION_TO_OPPORTUNITY_FIELD[dimensionId]];
    const assessmentText = dimension.assessment || '(no assessment text supplied)';
    return `${label}: ${assessmentText} (status: ${status}).`;
  }
  if (dimensionId === 'trend') {
    return `${label}: ${trendRecords.length} signal(s) supplied (status: ${status}).`;
  }
  if (dimensionId === 'pricing') {
    const { currency, price } = productRecord.pricing;
    return `${label}: price is ${price}${currency ? ` ${currency}` : ''} (status: ${status}).`;
  }
  // margin_inputs
  const { currency, cost, price } = productRecord.pricing;
  return `${label}: cost=${cost || '(not supplied)'}, price=${price || '(not supplied)'}${currency ? ` ${currency}` : ''} (status: ${status}).`;
}

function buildReasoning(scoreResult) {
  const { opportunity_analysis: opportunityAnalysis, product_record: productRecord, trend_records: trendRecords } =
    scoreResult.specialized_records;
  const lines = [];
  for (const dimensionId of PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS) {
    const status = scoreResult.dimension_status[dimensionId];
    if (status === 'empty') continue;
    lines.push(buildReasoningLine(dimensionId, status, opportunityAnalysis, productRecord, trendRecords));
  }
  return lines;
}

// Mechanical mapping from coverage_score.percentage onto CONFIDENCE_LEVELS - never a
// business judgment, only a summary of how much of the score record is evidence-backed.
function deriveConfidence(coverageScore) {
  if (coverageScore.percentage === 100) return 'high';
  if (coverageScore.percentage >= 50) return 'medium';
  if (coverageScore.percentage > 0) return 'low';
  return 'unassessed';
}

const NEVER_EXECUTES_NOTE =
  'This recommendation does not purchase, publish, or import anything automatically.';

// Deterministic default recommended_next_step - never a specific fabricated business
// action. Names exactly the missing dimensions when any exist; otherwise routes to a
// human for a go/no-go decision.
function buildDefaultNextStep(scoreResult) {
  if (scoreResult.missing_inputs.length > 0) {
    const labels = scoreResult.missing_inputs.map((entry) => DIMENSION_LABELS[entry.dimension] || entry.dimension);
    return `Gather evidence for: ${labels.join(', ')}. ${NEVER_EXECUTES_NOTE}`;
  }
  return `All 8 dimensions are evidence-backed - route to a human for a go/no-go decision. ${NEVER_EXECUTES_NOTE}`;
}

function buildProductRecommendation({ scoreResult, recommendedNextStep } = {}) {
  const scoreValidation = validateProductOpportunityScoreShape(scoreResult);
  if (!scoreValidation.valid) {
    throw new Error(
      `buildProductRecommendation requires a valid productOpportunityScoreModel.js record: ${scoreValidation.errors.join('; ')}`
    );
  }

  const { product_record: productRecord, opportunity_analysis: opportunityAnalysis } = scoreResult.specialized_records;

  const result = createEmptyProductRecommendation(scoreResult.product_identity);
  result.opportunity = {
    product_identity: scoreResult.product_identity,
    category: productRecord.category,
    market: productRecord.market.join(', '),
    positioning: productRecord.positioning,
  };
  result.research_date = scoreResult.research_date;
  result.reasoning = buildReasoning(scoreResult);
  result.evidence = [...scoreResult.source];
  result.risks = { ...opportunityAnalysis.risks };
  result.missing_information = scoreResult.missing_inputs.map((entry) => ({ ...entry }));
  result.confidence = deriveConfidence(scoreResult.coverage_score);
  result.recommended_next_step = recommendedNextStep || buildDefaultNextStep(scoreResult);
  result.specialized_records = { product_opportunity_score: scoreResult };

  const resultValidation = validateProductRecommendationShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed product recommendation failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  buildProductRecommendation,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product recommendation engine (deterministic, no external calls):\n');

  const { scoreProductOpportunity } = require('./productOpportunityScoringEngine');

  const scoreResult = scoreProductOpportunity({
    productIdentity: '(Example insulated jacket)',
    category: 'outdoor apparel',
    market: 'European Union',
    positioning: 'Premium, sustainability-focused (caller-supplied placeholder).',
    // pricing: deliberately only a cost, no price - to show pricing/margin_inputs
    // honestly reported as missing further down the pipeline.
    pricing: { currency: 'EUR', cost: '35.00' },
    source: ['(placeholder store export reference)'],
    demandAssessment: 'Caller-supplied placeholder assessment.',
    demandEvidence: [{ topic: 'Search interest', finding: 'Rising search interest (placeholder).', source: ['(placeholder source)'] }],
    demandConfidence: 'medium',
    riskAssessment: 'Caller-supplied placeholder risk assessment.',
    riskEvidence: [{ topic: 'Supply chain', finding: 'Single supplier dependency (placeholder).', source: ['(placeholder risk source)'] }],
    riskConfidence: 'medium',
    trendEvidence: [
      { topic: 'Recycled materials', finding: 'Growing preference (placeholder).', source: ['(placeholder trend source)'] },
    ],
    // competition, market_fit, differentiation: deliberately omitted, to show the
    // honest 'empty' state flowing through into missing_information.
  });

  const recommendation = buildProductRecommendation({ scoreResult });
  console.log(JSON.stringify(recommendation, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log(`\n${NEVER_EXECUTES_NOTE}`);
}
