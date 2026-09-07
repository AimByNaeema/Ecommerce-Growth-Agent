'use strict';

// The offer_recommendation tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/offerRecommendationEngine.js's generateOfferRecommendations(), the one
// implemented Marketing engine that had no route into normal Chief dispatch. Thin
// wrapper - no offer, bundle, discount, incentive, value-proposition or objection logic
// is added or restated here, only structured input handling, one engine call, and an
// honest outcome status, matching tools/productResearchTool.js's convention exactly.
//
// WHY A SEPARATE TOOL RATHER THAN A marketingAnalysisTool.js MODE. The engine composes
// its OWN result schema (agent/core/offerRecommendationModel.js: dimension_status,
// coverage_score, unsupported_claims_flagged), not the shared Marketing envelope
// (agent/core/marketingAgentResultModel.js) every marketing_analysis capability returns.
// tools/marketingAnalysisTool.js's deriveStatus() reads that envelope's `limitations`
// array and its flat `specialized_records` list; an offer recommendation result has
// neither, so routing it through that tool would have meant either a second status
// derivation inside a tool documented as having exactly one, or reshaping the engine's
// output to imitate an envelope it never produces. Both are worse than one more thin
// wrapper. This is the same precedent tools/marketQuestionDiscoveryTool.js and
// tools/seoContentGenerationTool.js already set on the SEO side: a capability whose
// output is not its specialist agent's envelope gets its own tool id.
//
// NOT A DUPLICATE OF THE EXISTING `offers` CAPABILITY. agent/core/marketingAgent.js's
// analyzeOffers() composes one agent/core/marketingAnalysisModel.js record relaying a
// caller-supplied offer/channel/message. This engine does something different in kind: a
// 7-dimension structural audit (bundle, discount, upsell, cross_sell, incentive,
// value_proposition, objection_handling) over caller-supplied product data, with one
// real arithmetic computation - the discount depth that keeps margin at or above a
// caller-supplied floor. Different input contract, different output schema, no shared
// logic. Both stay; neither is reimplemented here.
//
// researchParams are passed straight through to the engine (productReference, market,
// pricing, discountConstraints, relatedProducts, incentiveOptions, valuePropositions,
// objections, researchDate). The orchestrator only threads a free-text objective through
// by default, so when nothing structured arrives this tool reports that honestly rather
// than guessing a product, a price, or a margin constraint from the objective text.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or the engine rejected the input
//                       (missing productReference, a structurally invalid entry)
//   status 'empty'   - valid input, but no dimension had anything real to work with
//   status 'partial' - valid input, some but not all 7 dimensions are fully covered
//   status 'success' - valid input, all 7 dimensions are fully covered

const { generateOfferRecommendations } = require('../agent/core/offerRecommendationEngine');

// The engine already computes its own honest tri-state in coverage_score.status
// ('empty' | 'partial' | 'success' - see agent/core/offerRecommendationEngine.js's
// combined entry point). Reused as-is rather than recomputed here, the same way
// tools/productResearchTool.js's STATUS_READERS reuse each Product engine's own status.
function readStatus(result) {
  return result.coverage_score.status;
}

function runOfferRecommendationTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - offer_recommendation requires structured parameters (a productReference, plus any pricing/discountConstraints/relatedProducts/incentiveOptions/valuePropositions/objections) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = generateOfferRecommendations(researchParams);
    return { status: readStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runOfferRecommendationTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - offer_recommendation tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing productReference (failed)': { market: 'US' },
    'nothing supplied for any dimension (empty)': { productReference: '(Example insulated jacket)' },
    'some dimensions covered (partial)': {
      productReference: '(Example insulated jacket)',
      pricing: { currency: 'USD', cost: 35, price: 100 },
      discountConstraints: { minMarginPercent: 40, maxDiscountPercent: 25 },
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runOfferRecommendationTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (outcome.result) console.log(`  coverage: ${outcome.result.coverage_score.percentage}%`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This tool never applies, publishes, or purchases an offer - acting on a recommendation is a separate, human-approved action via approvals/.');
}
