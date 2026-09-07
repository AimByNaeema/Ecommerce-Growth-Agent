'use strict';

// Tests for the offer_recommendation tool - the wiring that makes
// agent/core/offerRecommendationEngine.js reachable through the Chief/orchestrator.
//
// WHAT THIS CHANGE WAS. generateOfferRecommendations() was already built and fully
// tested (offerRecommendationEngine.test.js still owns every engine-logic assertion),
// but nothing in production could reach it: it was called from no tool, no capability,
// and no workflow - only from its own test. agent/core/specialistCapabilityRegistry.js
// listed it as a deliberately excluded standalone engine. It turned out to be a
// genuinely reusable Marketing specialist capability (one product in, one structured
// recommendation record out, no workflow sequencing of its own), so it is now wired as
// the Marketing `offer_recommendation` capability.
//
// These tests cover only the connecting wiring: the dispatch, the registry/permission
// entries, and real reachability through the normal Chief routing path. No offer logic
// is re-tested here, and none was rewritten.
//
// WHY A SEPARATE TOOL ID rather than a marketing_analysis mode: the engine composes its
// own agent/core/offerRecommendationModel.js record, not the shared Marketing envelope
// that tools/marketingAnalysisTool.js's deriveStatus() reads - asserted below rather
// than assumed.
//
// Every value below is an invented placeholder. No network call is made anywhere.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runOfferRecommendationTool } = require('../../tools/offerRecommendationTool');
const { validateOfferRecommendationShape } = require('../../agent/core/offerRecommendationModel');
const { getCapabilityTask, getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { MODEL_CALL_TOOL_IDS, EXTERNAL_API_TOOL_IDS, RESEARCH_TOOL_IDS } = require('../../agent/core/usageLimits');
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
// Placeholder fixtures - caller-supplied input only, the only thing this engine will
// ever compose from.
// --------------------------------------------------------------------------------

const PRODUCT_REFERENCE = '(placeholder) insulated jacket';

// Every one of the 7 dimensions supplied and evidenced -> coverage_score.status
// 'success'.
const FULLY_COVERED = {
  productReference: PRODUCT_REFERENCE,
  pricing: { currency: 'USD', cost: 35, price: 100 },
  discountConstraints: { minMarginPercent: 40, maxDiscountPercent: 25 },
  relatedProducts: [
    { productReference: '(placeholder) wool hat', relationship: 'bundle_candidate', evidence: ['(placeholder)'] },
    { productReference: '(placeholder) premium jacket', relationship: 'higher_tier', evidence: ['(placeholder)'] },
    { productReference: '(placeholder) wool gloves', relationship: 'accessory', evidence: ['(placeholder)'] },
  ],
  incentiveOptions: [{ incentive: '(placeholder) free shipping', evidence: ['(placeholder)'] }],
  valuePropositions: [{ statement: '(placeholder) waterproof shell', evidence: ['(placeholder)'] }],
  objections: [{ objection: '(placeholder) too expensive?', response: '(placeholder) premium tier', evidence: ['(placeholder)'] }],
};

// Only the computable discount dimension supplied -> some but not all dimensions
// covered -> 'partial'.
const PARTIALLY_COVERED = {
  productReference: PRODUCT_REFERENCE,
  pricing: { currency: 'USD', cost: 35, price: 100 },
  discountConstraints: { minMarginPercent: 40 },
};

// A valid product reference and nothing else -> no dimension has anything to work with
// -> 'empty'. Honest, not a failure.
const NOTHING_SUPPLIED = { productReference: PRODUCT_REFERENCE };

// --------------------------------------------------------------------------------
// 1. Dispatch - the tool relays the engine's own result and its own status.
// --------------------------------------------------------------------------------

test('the tool returns the engine\'s real, schema-valid record', () => {
  const outcome = runOfferRecommendationTool(FULLY_COVERED);
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.ok(validateOfferRecommendationShape(outcome.result).valid);
  assert.strictEqual(outcome.result.product_reference, PRODUCT_REFERENCE);
});

test('status is read straight off the engine\'s own coverage_score.status, never recomputed', () => {
  for (const params of [FULLY_COVERED, PARTIALLY_COVERED, NOTHING_SUPPLIED]) {
    const outcome = runOfferRecommendationTool(params);
    assert.strictEqual(outcome.status, outcome.result.coverage_score.status);
  }
});

test('all three honest outcomes are reachable: success, partial, empty', () => {
  assert.strictEqual(runOfferRecommendationTool(FULLY_COVERED).status, 'success');
  assert.strictEqual(runOfferRecommendationTool(PARTIALLY_COVERED).status, 'partial');
  assert.strictEqual(runOfferRecommendationTool(NOTHING_SUPPLIED).status, 'empty');
});

// --------------------------------------------------------------------------------
// 2. Honesty - it never throws, never invents, and says why it failed.
// --------------------------------------------------------------------------------

test('no structured input is reported as failed, not guessed from an objective', () => {
  for (const bad of [undefined, null, 'a free-text objective', 42]) {
    const outcome = runOfferRecommendationTool(bad);
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.result, null);
    assert.ok(outcome.error.includes('No structured research input was supplied'));
  }
});

test('an engine rejection becomes a failed status carrying the engine\'s own message - never a throw', () => {
  const missingReference = runOfferRecommendationTool({ pricing: { currency: 'USD', cost: 35, price: 100 } });
  assert.strictEqual(missingReference.status, 'failed');
  assert.ok(missingReference.error.includes('productReference'));

  const badRelationship = runOfferRecommendationTool({
    productReference: PRODUCT_REFERENCE,
    relatedProducts: [{ productReference: '(placeholder) hat', relationship: 'not_a_real_relationship' }],
  });
  assert.strictEqual(badRelationship.status, 'failed');
  assert.ok(badRelationship.error.includes('relationship'));
});

test('an empty result still names, per dimension, what was missing - nothing is silently skipped', () => {
  const outcome = runOfferRecommendationTool(NOTHING_SUPPLIED);
  assert.strictEqual(outcome.result.missing_information.length, 7);
  for (const entry of outcome.result.missing_information) {
    assert.ok(entry.reason && entry.reason.trim() !== '', `${entry.dimension} has no reason`);
  }
});

// --------------------------------------------------------------------------------
// 3. Anti-duplication - the tool wraps the engine, it does not restate it.
// --------------------------------------------------------------------------------

test('the tool file contains no offer logic of its own - it only calls the engine', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'offerRecommendationTool.js'), 'utf8');
  // Code only: the header comment names the engine's entry point too, and a comment is
  // not a call site.
  const body = source
    .split('if (require.main === module)')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  // The one real computation (margin/discount depth) must live in the engine only.
  assert.ok(!/minMarginPercent\s*\)?\s*[-*/]/.test(body), 'the tool must not compute a discount itself');
  assert.ok(!body.includes('CLAIM_TRIGGER_PHRASES'), 'claim scanning must stay in the engine');
  assert.ok(!body.includes('OFFER_RECOMMENDATION_TYPES'), 'the tool must not restate the dimension list');
  assert.strictEqual((body.match(/generateOfferRecommendations\(/g) || []).length, 1, 'exactly one engine call site');
});

test('the existing `offers` capability is untouched and still runs on marketing_analysis - no second route', () => {
  assert.deepStrictEqual(getCapabilityTask('marketing', 'offers').tool_ids, ['marketing_analysis']);
  assert.deepStrictEqual(getCapabilityTask('marketing', 'promotions').tool_ids, ['marketing_analysis']);
  // The two are genuinely different work, which is why both exist: `offers` relays one
  // caller-supplied offer into a marketingAnalysisModel.js record; this composes a
  // 7-dimension offerRecommendationModel.js audit.
  assert.strictEqual(getCapabilityTask('marketing', 'offers').output_contract.model, 'agent/core/marketingAgentResultModel.js');
  assert.strictEqual(
    getCapabilityTask('marketing', 'offer_recommendation').output_contract.model,
    'agent/core/offerRecommendationModel.js'
  );
});

// --------------------------------------------------------------------------------
// 4. Registry, permissions and usage entries.
// --------------------------------------------------------------------------------

test('offer_recommendation is a real, implemented Marketing tool the capability points at', () => {
  const tool = getToolById('offer_recommendation');
  assert.strictEqual(tool.status, 'implemented');
  assert.strictEqual(tool.category, 'marketing');
  // 'write' matches SPECIALIST_ROLE_PERMISSIONS.marketing, exactly like marketing_analysis;
  // a 'read' tool in this category would be denied to its own specialist.
  assert.strictEqual(tool.operation, 'write');
  assert.deepStrictEqual(getCapabilityTask('marketing', 'offer_recommendation').tool_ids, ['offer_recommendation']);
  assert.ok(getSpecialistCapabilityById('marketing').required_tools.includes('offer_recommendation'));
});

test('the capability is analysis_only, allowed to Marketing, and denied to every other specialist', () => {
  assert.strictEqual(TOOL_CLASSIFICATIONS.offer_recommendation, 'analysis_only');
  const allowed = checkToolAccess({ specialistId: 'marketing', toolId: 'offer_recommendation' });
  assert.strictEqual(allowed.decision, 'allowed');
  assert.strictEqual(allowed.approval_required, false);
  for (const specialistId of ['research', 'product', 'seo', 'listing', 'social_advertising', 'analytics_optimization']) {
    assert.strictEqual(
      checkToolAccess({ specialistId, toolId: 'offer_recommendation' }).decision,
      'denied',
      `${specialistId} must not have access`
    );
  }
});

test('it counts against no external-API, model-call or research budget - it makes none of those calls', () => {
  assert.ok(!EXTERNAL_API_TOOL_IDS.has('offer_recommendation'));
  assert.ok(!MODEL_CALL_TOOL_IDS.has('offer_recommendation'));
  assert.ok(!RESEARCH_TOOL_IDS.has('offer_recommendation'));
});

test('the input contract matches what the engine actually requires', () => {
  const contract = getCapabilityTask('marketing', 'offer_recommendation').input_contract;
  assert.deepStrictEqual(contract.required, ['productReference']);
  // Everything the engine reads is declared somewhere in the contract.
  for (const field of ['pricing', 'discountConstraints', 'relatedProducts', 'incentiveOptions', 'valuePropositions', 'objections']) {
    assert.ok(contract.optional.includes(field), `${field} is missing from the contract`);
  }
});

// --------------------------------------------------------------------------------
// 5. Real reachability through Chief - the point of the whole change.
// --------------------------------------------------------------------------------

// Each objective is a single clause with no comma list or "and" (CLAUSE_SPLIT_REGEX
// would otherwise fragment it), worded in this tool's own vocabulary rather than
// marketing_analysis's ("campaign", "strategy", "segment").
const ROUTES = [
  ['Audit the bundle upsell coverage behind our offer.', FULLY_COVERED, 'success'],
  ['Recommend a supportable discount depth for this offer.', PARTIALLY_COVERED, 'partial'],
  ['How deep can our discount go on this offer?', NOTHING_SUPPLIED, 'empty'],
];

(async () => {
  for (const [objective, researchParams, expectedStatus] of ROUTES) {
    await testAsync(`REACHABLE THROUGH CHIEF: "${objective}" is routed and executed for real`, async () => {
      const response = await runOrchestratorContract(objective, { researchParams });
      assert.strictEqual(response.routing.status, 'planned', response.routing.reason || '');
      const step = (response.routing.plan || [])[0];
      assert.ok(step, 'a plan step must exist');
      assert.strictEqual(step.selected_specialist.id, 'marketing');
      assert.strictEqual(step.inputs.tool_id, 'offer_recommendation');
      assert.strictEqual(step.inputs.capability_id, 'offer_recommendation');
      assert.strictEqual(step.outputs.status, expectedStatus);
      assert.ok(step.outputs.result, 'the capability must have produced a real result');
      assert.deepStrictEqual(
        step.inputs.input_contract,
        getCapabilityTask('marketing', 'offer_recommendation').input_contract
      );
    });
  }

  await testAsync('the existing Marketing capabilities still route to marketing_analysis, unchanged', async () => {
    const response = await runOrchestratorContract('marketing campaign strategy');
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'marketing');
    assert.strictEqual(step.inputs.tool_id, 'marketing_analysis');
    assert.strictEqual(step.inputs.capability_id, 'marketing_strategy');
  });

  await testAsync('a Chief-routed run of this capability is audited and spends no tokens', async () => {
    const response = await runOrchestratorContract('Recommend a supportable discount depth for this offer.', {
      researchParams: PARTIALLY_COVERED,
    });
    assert.ok(response.audit_trail.length > 0);
    assert.ok(response.usage_ledger.length > 0);
    assert.strictEqual(response.tokens_used, 0);
    assert.strictEqual(response.usage_summary.by_category.model_call.count, 0);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('offerRecommendationCapability.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
