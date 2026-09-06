'use strict';

// The product_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// the four Product capabilities that were already implemented but had no tool wrapping
// them - product_validation, product_opportunity_analysis, product_opportunity_scoring
// and product_recommendation (the Product half of the "HONEST tool_ids GAPS"
// agent/core/specialistCapabilityRegistry.js's own header declares). Thin wrapper - no
// new product logic is added here, only structured input handling, capability dispatch,
// and an honest outcome status, matching tools/analyticsTool.js's convention exactly.
//
// This is the tool id tools/toolRegistry.js already reserved for exactly this purpose;
// it is now implemented rather than replaced, so no second Product route is created.
//
// NO NEW ENGINE. Every capability below delegates to the existing engine's own exported
// entry point - agent/core/productAgent.js's validateProduct/analyzeProductOpportunity,
// agent/core/productOpportunityScoringEngine.js's scoreProductOpportunity, and
// agent/core/productRecommendationEngine.js's buildProductRecommendation. Nothing about
// how a product is validated, assessed, scored or recommended is decided in this file.
//
// DELIBERATELY SCOPED TO THE FOUR UNWIRED CAPABILITIES. Product's other two capabilities
// each already have their own tool (tools/productDataRetrievalTool.js and
// tools/marketProductOpportunityTool.js). Accepting them here too would be a second route
// to the same capability - exactly the duplicate functionality CLAUDE.md rule 4 forbids -
// so an already-wired productCapability is refused with a message naming the tool that
// owns it, rather than silently served twice.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a free-text
// objective through by default; structured product input (productRecord, productIdentity,
// pricing, per-dimension assessments/evidence, scoreResult, ...) must arrive via
// executionRequest.research_params - the same optional passthrough every other tool uses.
// When it's missing, this tool reports that honestly instead of guessing parameters from
// the objective text: no product, price, cost, assessment, score or recommendation is ever
// invented here.
//
// researchParams.productCapability selects which capability to run. The orchestrator
// supplies it automatically from the routed capability id (see that file's
// TOOL_CAPABILITY_SELECTORS, valueMap null - the capability id IS the value), so a normal
// Chief route never has to pass it by hand.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams, an unknown/already-wired productCapability, or
//                       an engine rejected the input (a required field was missing or a
//                       supplied record was invalid)
//   status 'empty'   - valid input, but no dimension ended up evidence-backed
//   status 'success' - valid input, every dimension ended up evidence-backed
//   status 'partial' - valid input, some but not all dimensions ended up evidence-backed

const { validateProduct, analyzeProductOpportunity } = require('../agent/core/productAgent');
const { scoreProductOpportunity } = require('../agent/core/productOpportunityScoringEngine');
const { buildProductRecommendation } = require('../agent/core/productRecommendationEngine');

// Already reachable elsewhere; named here so the refusal can point at the right tool
// instead of just rejecting a legitimate Product capability.
const CAPABILITIES_OWNED_BY_OTHER_TOOLS = {
  product_discovery: 'product_data_retrieval',
  market_product_opportunity_analysis: 'market_product_opportunity_analysis',
};

// The four capabilities this tool owns - the ones that had no tool wrapper. Each entry
// only adapts the orchestrator's flat researchParams bag to the engine's own signature;
// it never reshapes, defaults, or supplements what the caller supplied.
const CAPABILITY_HANDLERS = {
  // Takes one already-built productModel.js record, not a flat param bag.
  product_validation: (params) => validateProduct(params.productRecord),
  product_opportunity_analysis: (params) => analyzeProductOpportunity(params),
  product_opportunity_scoring: (params) => scoreProductOpportunity(params),
  // Takes one already-scored productOpportunityScoreModel.js record, not a flat bag.
  product_recommendation: (params) =>
    buildProductRecommendation({
      scoreResult: params.scoreResult,
      recommendedNextStep: params.recommendedNextStep,
    }),
};

// Each engine already computes its own evidence-coverage tri-state, in the exact
// 'empty' | 'partial' | 'success' vocabulary every tool in this codebase reports. These
// readers hand that existing verdict back - deliberately NOT a second coverage
// calculation that could disagree with the engine's own.
//
// product_validation is the one capability with no such tri-state of its own, because
// validateProduct() returns an ad hoc shape rather than a *Model.js record. Its status is
// therefore counted mechanically from the engine's own `completeness` flags, on the same
// rule the other three already use (none backed -> empty, all -> success, else partial).
// A structurally invalid record is 'empty', not 'failed': the audit ran and answered
// honestly (shape_valid false, with the errors named) - refusing to audit a malformed
// record is exactly what this capability exists to avoid.
function deriveValidationStatus(result) {
  if (!result.shape_valid) return 'empty';
  const flags = Object.values(result.completeness);
  const complete = flags.filter(Boolean).length;
  if (complete === 0) return 'empty';
  if (complete === flags.length) return 'success';
  return 'partial';
}

const STATUS_READERS = {
  product_validation: deriveValidationStatus,
  product_opportunity_analysis: (result) => result.opportunity_scoring.status,
  product_opportunity_scoring: (result) => result.coverage_score.status,
  product_recommendation: (result) =>
    result.specialized_records.product_opportunity_score.coverage_score.status,
};

function runProductResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured product input was supplied - product_research requires structured parameters ' +
        '(e.g. productRecord, productIdentity, pricing, dimension evidence, scoreResult) that a ' +
        'free-text objective cannot provide.',
    };
  }

  const { productCapability, ...params } = researchParams;

  if (CAPABILITIES_OWNED_BY_OTHER_TOOLS[productCapability]) {
    return {
      status: 'failed',
      result: null,
      error:
        `productCapability '${productCapability}' is already served by the ` +
        `${CAPABILITIES_OWNED_BY_OTHER_TOOLS[productCapability]} tool - product_research covers only: ` +
        `${Object.keys(CAPABILITY_HANDLERS).join(', ')}.`,
    };
  }

  const handler = CAPABILITY_HANDLERS[productCapability];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown productCapability: ${productCapability}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: STATUS_READERS[productCapability](result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { CAPABILITY_HANDLERS, CAPABILITIES_OWNED_BY_OTHER_TOOLS, runProductResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product_research tool:\n');

  const scored = scoreProductOpportunity({
    productIdentity: '(placeholder) insulated jacket',
    pricing: { currency: 'EUR', cost: '35.00' },
    source: ['(placeholder store export reference)'],
    demandAssessment: '(placeholder) caller-supplied assessment',
    demandEvidence: [{ topic: 'Search interest', finding: '(placeholder) caller-supplied observation', source: ['(placeholder source)'] }],
    demandConfidence: 'medium',
  });

  const cases = {
    'no researchParams (failed)': undefined,
    'unknown productCapability (failed)': { productCapability: 'not_a_real_capability' },
    'already-wired capability (failed, names the owning tool)': { productCapability: 'product_discovery' },
    'product_validation, incomplete record (partial)': {
      productCapability: 'product_validation',
      productRecord: {
        product_identity: '(placeholder) insulated jacket',
        category: 'outdoor apparel',
        product_model: '',
        description: '',
        positioning: '',
        target_customer: '',
        market: [],
        pricing: { currency: '', cost: '', price: '' },
        availability: 'unknown',
        source: ['(placeholder store export reference)'],
        research_status: 'not_researched',
      },
    },
    'product_opportunity_analysis, no evidence (empty)': {
      productCapability: 'product_opportunity_analysis',
      productIdentity: '(placeholder) insulated jacket',
    },
    'product_opportunity_scoring, one dimension evidenced (partial)': {
      productCapability: 'product_opportunity_scoring',
      productIdentity: '(placeholder) insulated jacket',
      demandAssessment: '(placeholder) caller-supplied assessment',
      demandEvidence: [{ topic: 'Search interest', finding: '(placeholder) caller-supplied observation', source: ['(placeholder source)'] }],
      demandConfidence: 'medium',
    },
    'product_recommendation from that score (partial)': {
      productCapability: 'product_recommendation',
      scoreResult: scored,
    },
    'product_recommendation with an invalid score (failed)': {
      productCapability: 'product_recommendation',
      scoreResult: { not: 'a score record' },
    },
  };

  for (const [label, params] of Object.entries(cases)) {
    const outcome = runProductResearchTool(params);
    console.log(`--- ${label}`);
    console.log(`    status: ${outcome.status}${outcome.error ? ` | error: ${outcome.error}` : ''}`);
  }

  console.log('\nEvery value above is an invented placeholder - this tool composes only what a caller supplies.');
}
