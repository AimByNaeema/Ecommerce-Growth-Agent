'use strict';

// The market_product_opportunity_analysis tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to
// workflows/productOpportunityAnalysisWorkflow.js's analyzeProductOpportunityFromMarket()
// - Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity,
// composing one global market intelligence row (from the
// global_market_opportunity_analysis tool) with one product candidate into a real,
// validated agent/core/opportunityAnalysisModel.js record. Thin wrapper - no new
// composition logic is added here, only structured input handling and an honest
// outcome status, same convention as tools/globalMarketOpportunityTool.js.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured research input (marketRow,
// productIdentity) must arrive via executionRequest.research_params (an optional
// passthrough). When it's missing, this tool reports that honestly instead of
// guessing parameters from the objective text.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or
//                      analyzeProductOpportunityFromMarket() threw (e.g. a missing
//                      market row, or the product wasn't found in it)
//   status 'empty'   - valid input, but none of the 4 in-scope dimensions are
//                      evidence-backed
//   status 'partial' - some, but not all, of the 4 in-scope dimensions are
//                      evidence-backed
//   status 'success' - every one of the 4 in-scope dimensions is evidence-backed
//
// "Evidence-backed" reuses the exact same definition
// agent/core/productAgent.js's buildOpportunityScoring() already uses for its own 4
// dimensions: confidence !== 'unassessed' AND evidence.length > 0 - i.e. real evidence
// exists AND the caller explicitly asserted a confidence level, never a status derived
// from evidence volume alone. This is deliberately conservative: an estimate without an
// explicit, caller-asserted confidence is never reported as 'success' - see the
// module header of workflows/productOpportunityAnalysisWorkflow.js for why
// `assessment`/`confidence` are never synthesized by this pipeline.

const { analyzeProductOpportunityFromMarket } = require('../workflows/productOpportunityAnalysisWorkflow');

const IN_SCOPE_DIMENSION_IDS = ['demand', 'competition', 'market_relevance', 'commercial_potential'];

function isDimensionEvidenceBacked(dimension) {
  return Boolean(dimension) && dimension.confidence !== 'unassessed' && Array.isArray(dimension.evidence) && dimension.evidence.length > 0;
}

function deriveStatus(result) {
  const analysis = result.opportunity_analysis;
  const backedCount = IN_SCOPE_DIMENSION_IDS.filter((id) => isDimensionEvidenceBacked(analysis[id])).length;
  if (backedCount === IN_SCOPE_DIMENSION_IDS.length) return 'success';
  if (backedCount === 0) return 'empty';
  return 'partial';
}

function runMarketProductOpportunityTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - market_product_opportunity_analysis requires structured parameters (marketRow, productIdentity) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeProductOpportunityFromMarket(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runMarketProductOpportunityTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - market_product_opportunity_analysis tool:\n');

  const { compareGlobalMarkets } = require('../workflows/globalEcommerceMarketResearchWorkflow');

  const sparseRowComparison = compareGlobalMarkets({
    markets: [
      {
        country: 'US',
        market: 'North America',
        category: 'outdoor apparel',
        products: [{ productIdentity: '(Example product, no other evidence supplied)' }],
      },
    ],
  });

  const evidencedRowComparison = compareGlobalMarkets({
    markets: [
      {
        country: 'DE',
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['(placeholder demand signal)'],
        trends: ['(placeholder trend)'],
        evidence: ['(placeholder market evidence reference)'],
        competitors: [
          {
            competitor: '(Example Co.)',
            positioning: '(placeholder positioning)',
            pricingEvidence: ['(placeholder pricing evidence reference)'],
            source: ['(placeholder competitor source reference)'],
          },
        ],
        products: [
          {
            productIdentity: '(Example product)',
            pricing: { currency: 'EUR', cost: '40', price: '90' },
            source: ['(placeholder product source reference)'],
          },
        ],
      },
    ],
  });

  const cases = {
    'no researchParams': undefined,
    'missing marketRow (failed)': { productIdentity: '(Example product)' },
    'product not found in row (failed)': {
      marketRow: evidencedRowComparison.comparison[0],
      productIdentity: '(Nonexistent product)',
    },
    'no evidence supplied (empty)': {
      marketRow: sparseRowComparison.comparison[0],
      productIdentity: '(Example product, no other evidence supplied)',
    },
    'evidence supplied, but no explicit confidence asserted for any dimension (empty)': {
      marketRow: evidencedRowComparison.comparison[0],
      productIdentity: '(Example product)',
    },
    'evidence + explicit confidence for only some in-scope dimensions (partial)': {
      marketRow: evidencedRowComparison.comparison[0],
      productIdentity: '(Example product)',
      demandAssessment: '(placeholder assessment)',
      demandConfidence: 'medium',
    },
    'evidence + explicit confidence for every in-scope dimension (success)': {
      marketRow: evidencedRowComparison.comparison[0],
      productIdentity: '(Example product)',
      demandAssessment: '(placeholder assessment)',
      demandConfidence: 'medium',
      competitionAssessment: '(placeholder assessment)',
      competitionConfidence: 'low',
      marketFitAssessment: '(placeholder assessment)',
      marketFitConfidence: 'medium',
      commercialPotentialAssessment: '(placeholder assessment)',
      commercialPotentialConfidence: 'low',
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runMarketProductOpportunityTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
