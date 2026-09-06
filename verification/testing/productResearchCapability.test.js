'use strict';

// Tests for the product_research tool - the wiring that makes the four remaining Product
// capabilities reachable through the Chief/orchestrator.
//
// WHAT THIS CHANGE WAS. agent/core/productAgent.js's validateProduct() and
// analyzeProductOpportunity(), agent/core/productOpportunityScoringEngine.js's
// scoreProductOpportunity(), and agent/core/productRecommendationEngine.js's
// buildProductRecommendation() were all already built and fully tested (see
// productAgent.test.js, productOpportunityScoringEngine.test.js and
// productRecommendationEngine.test.js, which still own every engine-logic assertion), but
// nothing in production could reach them: their capabilities carried tool_ids: [], so
// agent/core/orchestratorExecutionContract.js's buildPlanStep() - which selects a
// capability by filtering supported_tasks on task.tool_ids.includes(toolMatch.id) - could
// never select one. These tests cover only the connecting wiring: the dispatch, the
// registry/permission entries, and real reachability through the normal Chief routing
// path. No product logic is re-tested here, and none was rewritten.
//
// NO NEW TOOL ID: product_research is the id tools/toolRegistry.js had already reserved
// for exactly this, flipped from 'not_implemented' to 'implemented' rather than replaced,
// so no second Product route exists - asserted below rather than assumed.
//
// Every value below is an invented placeholder. No network call is made anywhere.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  runProductResearchTool,
  CAPABILITY_HANDLERS,
  CAPABILITIES_OWNED_BY_OTHER_TOOLS,
} = require('../../tools/productResearchTool');
const { scoreProductOpportunity } = require('../../agent/core/productOpportunityScoringEngine');
const { validateProductAgentResultShape } = require('../../agent/core/productAgentResultModel');
const { validateProductOpportunityScoreShape } = require('../../agent/core/productOpportunityScoreModel');
const { validateProductRecommendationShape } = require('../../agent/core/productRecommendationModel');
const { getCapabilityTask, getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { MODEL_CALL_TOOL_IDS, EXTERNAL_API_TOOL_IDS } = require('../../agent/core/usageLimits');
const { getToolById } = require('../../tools/toolRegistry');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

// --------------------------------------------------------------------------------
// Placeholder fixtures - caller-supplied evidence only, exactly what these engines
// require and the only thing they will ever compose from.
// --------------------------------------------------------------------------------

const PRODUCT_IDENTITY = '(placeholder) insulated jacket';

function evidence(topic) {
  return [{ topic, finding: '(placeholder) caller-supplied observation', source: ['(placeholder source)'] }];
}

// A structurally valid, fully complete productModel.js record.
const COMPLETE_RECORD = {
  product_identity: PRODUCT_IDENTITY,
  category: '(placeholder) outdoor apparel',
  product_model: '',
  description: '(placeholder) description',
  positioning: '(placeholder) positioning',
  target_customer: '(placeholder) target customer',
  market: [],
  pricing: { currency: 'EUR', cost: '35.00', price: '90.00' },
  availability: 'unknown',
  source: ['(placeholder store export reference)'],
  research_status: 'researched',
};

// The same record with every optional descriptive field blank - structurally valid,
// but nothing complete except its source.
const BARE_RECORD = {
  ...COMPLETE_RECORD,
  category: '',
  description: '',
  positioning: '',
  target_customer: '',
  pricing: { currency: '', cost: '', price: '' },
  source: [],
};

// All 4 assessed dimensions evidence-backed -> analyzeProductOpportunity reports
// opportunity_scoring.status 'success'.
const FULL_ANALYSIS_PARAMS = {
  productIdentity: PRODUCT_IDENTITY,
  demandAssessment: '(placeholder) assessment',
  demandEvidence: evidence('Demand'),
  demandConfidence: 'medium',
  competitionAssessment: '(placeholder) assessment',
  competitionEvidence: evidence('Competition'),
  competitionConfidence: 'medium',
  marketFitAssessment: '(placeholder) assessment',
  marketFitEvidence: evidence('Market fit'),
  marketFitConfidence: 'medium',
  productRiskAssessment: '(placeholder) assessment',
  productRiskEvidence: evidence('Product risk'),
  productRiskConfidence: 'medium',
};

// One of 8 dimensions backed -> scoreProductOpportunity reports coverage_score.status
// 'partial'.
const PARTIAL_SCORING_PARAMS = {
  productIdentity: PRODUCT_IDENTITY,
  demandAssessment: '(placeholder) assessment',
  demandEvidence: evidence('Demand'),
  demandConfidence: 'medium',
};

const SCORED = scoreProductOpportunity(PARTIAL_SCORING_PARAMS);

// --------------------------------------------------------------------------------
// 1. Dispatch: each capability reaches its own engine and returns its own model.
// --------------------------------------------------------------------------------

test('the tool owns exactly the four capabilities that had no wrapper', () => {
  assert.deepStrictEqual(Object.keys(CAPABILITY_HANDLERS), [
    'product_validation',
    'product_opportunity_analysis',
    'product_opportunity_scoring',
    'product_recommendation',
  ]);
});

test('product_validation dispatches to validateProduct and returns its ad hoc shape', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_validation',
    productRecord: COMPLETE_RECORD,
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.shape_valid, true);
  assert.strictEqual(outcome.result.is_research_ready, true);
  assert.deepStrictEqual(Object.keys(outcome.result), [
    'shape_valid',
    'shape_errors',
    'completeness',
    'is_research_ready',
  ]);
});

test('product_opportunity_analysis dispatches to analyzeProductOpportunity and returns a valid productAgentResultModel record', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_opportunity_analysis',
    ...FULL_ANALYSIS_PARAMS,
  });
  assert.strictEqual(outcome.status, 'success');
  assert.ok(validateProductAgentResultShape(outcome.result).valid);
  assert.strictEqual(outcome.result.opportunity_scoring.status, 'success');
});

test('product_opportunity_scoring dispatches to scoreProductOpportunity and returns a valid productOpportunityScoreModel record', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_opportunity_scoring',
    ...PARTIAL_SCORING_PARAMS,
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.ok(validateProductOpportunityScoreShape(outcome.result).valid);
  assert.strictEqual(outcome.result.coverage_score.dimensions_total, 8);
});

test('product_recommendation dispatches to buildProductRecommendation and returns a valid productRecommendationModel record', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_recommendation',
    scoreResult: SCORED,
  });
  assert.strictEqual(outcome.status, 'partial');
  assert.ok(validateProductRecommendationShape(outcome.result).valid);
  assert.ok(outcome.result.recommended_next_step.length > 0);
});

test('recommendedNextStep is passed through to the engine, not overridden', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_recommendation',
    scoreResult: SCORED,
    recommendedNextStep: '(placeholder) caller-chosen next step',
  });
  assert.strictEqual(outcome.result.recommended_next_step, '(placeholder) caller-chosen next step');
});

// --------------------------------------------------------------------------------
// 2. No duplicate route, and no duplicated logic.
// --------------------------------------------------------------------------------

test('an already-wired capability is refused with the name of the tool that owns it', () => {
  const discovery = runProductResearchTool({ productCapability: 'product_discovery' });
  assert.strictEqual(discovery.status, 'failed');
  assert.ok(discovery.error.includes('product_data_retrieval'));

  const market = runProductResearchTool({ productCapability: 'market_product_opportunity_analysis' });
  assert.strictEqual(market.status, 'failed');
  assert.ok(market.error.includes('market_product_opportunity_analysis'));

  assert.deepStrictEqual(Object.keys(CAPABILITIES_OWNED_BY_OTHER_TOOLS), [
    'product_discovery',
    'market_product_opportunity_analysis',
  ]);
});

test('the tool delegates to the three existing engines and copies none of their logic', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', '..', 'tools', 'productResearchTool.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(source.includes("require('../agent/core/productAgent')"));
  assert.ok(source.includes("require('../agent/core/productOpportunityScoringEngine')"));
  assert.ok(source.includes("require('../agent/core/productRecommendationEngine')"));

  // None of the engines' own composition internals may appear here - this file adapts
  // parameters and reads a status, it never builds a product record or a dimension.
  for (const forbidden of [
    'createEmptyProductRecord',
    'createEmptyOpportunityAnalysis',
    'createEmptyProductOpportunityScore',
    'createEmptyProductRecommendation',
    'buildDimension',
    'retrieveResearchData',
  ]) {
    assert.ok(!source.includes(forbidden), `productResearchTool.js must not reimplement ${forbidden}`);
  }
});

// --------------------------------------------------------------------------------
// 3. Honesty: never a confident result from nothing, never a silent throw.
// --------------------------------------------------------------------------------

test('no researchParams at all is reported honestly, never guessed from the objective', () => {
  const outcome = runProductResearchTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(/No structured product input was supplied/.test(outcome.error));
});

test('an unknown productCapability is refused and names the real options', () => {
  const outcome = runProductResearchTool({ productCapability: 'not_a_real_capability' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('product_opportunity_scoring'));
});

test('no evidence anywhere reports empty - never a passing or confident result', () => {
  const analysis = runProductResearchTool({
    productCapability: 'product_opportunity_analysis',
    productIdentity: PRODUCT_IDENTITY,
  });
  assert.strictEqual(analysis.status, 'empty');
  assert.strictEqual(analysis.result.opportunity_scoring.dimensions_evidence_backed, 0);

  const scoring = runProductResearchTool({
    productCapability: 'product_opportunity_scoring',
    productIdentity: PRODUCT_IDENTITY,
  });
  assert.strictEqual(scoring.status, 'empty');
  assert.strictEqual(scoring.result.coverage_score.percentage, 0);
  assert.strictEqual(scoring.result.missing_inputs.length, 8);
});

test('a structurally valid but wholly incomplete record audits as empty, not success', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_validation',
    productRecord: BARE_RECORD,
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.shape_valid, true);
  assert.strictEqual(outcome.result.is_research_ready, false);
});

test('a malformed record is audited honestly (empty, with the shape errors named), never thrown away', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_validation',
    productRecord: { not: 'a product record' },
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.shape_valid, false);
  assert.ok(outcome.result.shape_errors.length > 0);
});

test('an engine rejection becomes a failed status carrying the engine\'s own message - never a fabricated result', () => {
  const outcome = runProductResearchTool({
    productCapability: 'product_recommendation',
    scoreResult: { not: 'a score record' },
  });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('buildProductRecommendation requires a valid'));

  const missingIdentity = runProductResearchTool({ productCapability: 'product_opportunity_scoring' });
  assert.strictEqual(missingIdentity.status, 'failed');
  assert.ok(missingIdentity.error.includes('productIdentity'));
});

test('the reported status is the engine\'s own coverage verdict, not a second calculation', () => {
  const scoring = runProductResearchTool({
    productCapability: 'product_opportunity_scoring',
    ...PARTIAL_SCORING_PARAMS,
  });
  assert.strictEqual(scoring.status, scoring.result.coverage_score.status);

  const recommendation = runProductResearchTool({
    productCapability: 'product_recommendation',
    scoreResult: SCORED,
  });
  assert.strictEqual(
    recommendation.status,
    recommendation.result.specialized_records.product_opportunity_score.coverage_score.status
  );

  const analysis = runProductResearchTool({
    productCapability: 'product_opportunity_analysis',
    ...FULL_ANALYSIS_PARAMS,
  });
  assert.strictEqual(analysis.status, analysis.result.opportunity_scoring.status);
});

// --------------------------------------------------------------------------------
// 4. Registry, permissions, and usage limits.
// --------------------------------------------------------------------------------

test('product_research is the pre-existing reserved tool id, now implemented - not a new one', () => {
  const tool = getToolById('product_research');
  assert.strictEqual(tool.status, 'implemented');
  assert.strictEqual(tool.category, 'products');
  assert.strictEqual(tool.operation, 'read');
});

test('all four capabilities point at product_research, and it is in Product\'s required_tools', () => {
  for (const capabilityId of Object.keys(CAPABILITY_HANDLERS)) {
    assert.deepStrictEqual(getCapabilityTask('product', capabilityId).tool_ids, ['product_research']);
  }
  assert.ok(getSpecialistCapabilityById('product').required_tools.includes('product_research'));
});

test('product_research is analysis_only, and allowed for Product but not for another specialist', () => {
  assert.strictEqual(TOOL_CLASSIFICATIONS.product_research, 'analysis_only');
  assert.strictEqual(checkToolAccess({ specialistId: 'product', toolId: 'product_research' }).decision, 'allowed');
  assert.strictEqual(checkToolAccess({ specialistId: 'marketing', toolId: 'product_research' }).decision, 'denied');
});

test('product_research counts as neither an external API call nor a model call - deliberately', () => {
  // It reaches no external system and calls no model; it only composes what the caller
  // supplied. It is still bounded by MAX_TOOL_CALLS_PER_RUN like every other tool.
  assert.ok(!EXTERNAL_API_TOOL_IDS.has('product_research'));
  assert.ok(!MODEL_CALL_TOOL_IDS.has('product_research'));
});

// --------------------------------------------------------------------------------
// 5. Real reachability through Chief - the point of the whole change.
// --------------------------------------------------------------------------------

const ROUTES = [
  ['product_validation', 'Audit the structural completeness of this product record.', { productRecord: COMPLETE_RECORD }, 'success'],
  // Deliberately a single clause with no colon, comma list, or "and": CLAUSE_SPLIT_REGEX
  // would otherwise split a phrasing like "demand, product risk, and profitability
  // inputs" into fragments that match nothing on their own, which exercises clause
  // splitting rather than the capability routing this test is about.
  ['product_opportunity_analysis', 'Run a profitability inputs assessment for this product.', FULL_ANALYSIS_PARAMS, 'success'],
  ['product_opportunity_scoring', 'Measure the evidence coverage score for this product.', PARTIAL_SCORING_PARAMS, 'partial'],
  ['product_recommendation', 'Give me a structured product recommendation naming its missing information.', { scoreResult: SCORED }, 'partial'],
];

(async () => {
  for (const [capabilityId, objective, researchParams, expectedStatus] of ROUTES) {
    await testAsync(`REACHABLE THROUGH CHIEF: ${capabilityId} is routed and executed for real`, async () => {
      // The orchestrator derives productCapability itself, from the routed capability id
      // (TOOL_CAPABILITY_SELECTORS) - the caller never passes it.
      assert.ok(!('productCapability' in researchParams), 'the test must not pre-supply productCapability');

      const response = await runOrchestratorContract(objective, { researchParams });
      assert.strictEqual(response.routing.status, 'planned', response.routing.reason || '');
      const step = (response.routing.plan || [])[0];
      assert.ok(step, 'a plan step must exist');
      assert.strictEqual(step.selected_specialist.id, 'product');
      assert.strictEqual(step.inputs.tool_id, 'product_research');
      assert.strictEqual(step.inputs.capability_id, capabilityId);
      assert.strictEqual(step.outputs.status, expectedStatus);
      assert.ok(step.outputs.result, 'the capability must have produced a real result');
      assert.deepStrictEqual(
        step.inputs.input_contract,
        getCapabilityTask('product', capabilityId).input_contract
      );
    });
  }

  await testAsync('a Chief-routed run of these capabilities is audited and spends no tokens', async () => {
    const response = await runOrchestratorContract(
      'Measure the evidence coverage score for this product.',
      { researchParams: PARTIAL_SCORING_PARAMS }
    );
    assert.ok(response.audit_trail.length > 0);
    assert.ok(response.usage_ledger.length > 0);
    assert.strictEqual(response.tokens_used, 0);
    assert.strictEqual(response.usage_summary.by_category.model_call.count, 0);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('productResearchCapability.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
