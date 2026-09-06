'use strict';

// Tests for the conversion_optimization capability - the wiring that makes
// agent/core/conversionOptimizationChecker.js reachable through the Chief/orchestrator.
//
// WHAT THIS CHANGE WAS. The CRO checker was already built and fully tested (see
// conversionOptimizationChecker.test.js, which still owns every check-logic assertion),
// but nothing in production required it: no capability, no tool, no route. These tests
// cover only the connecting wiring - the capability, its dispatch through the EXISTING
// 'analytics' tool id, and real reachability through the normal Chief routing path.
// No check logic is re-tested here, and none was rewritten.
//
// NO NEW ENGINE AND NO NEW TOOL ID: the capability rides the existing 'analytics' tool,
// so tools/toolRegistry.js, agent/core/toolPermissions.js, agent/core/usageLimits.js and
// TOOL_EXECUTORS needed no change - asserted below rather than assumed.
//
// Every value below is an invented placeholder. No network call is made anywhere.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ANALYTICS_CAPABILITIES } = require('../../agent/core/analyticsAgentResultModel');
const { analyzeConversionOptimization, runAnalyticsAgent } = require('../../agent/core/analyticsAgent');
const { runAnalyticsTool } = require('../../tools/analyticsTool');
const { validateConversionOptimizationCheckShape, CONVERSION_OPTIMIZATION_DIMENSIONS } = require('../../agent/core/conversionOptimizationCheckModel');
const { getCapabilityTask, getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
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

const SUBJECT = '(placeholder) storefront checkout';
const EVIDENCE = {
  subjectReference: SUBJECT,
  checkoutFriction: { stepsToCheckout: 5, guestCheckoutAvailable: false },
  trustSignals: { hasReturnPolicy: true, reviewsCount: 0 },
};

(async () => {
  // --- The capability exists and is distinct ---------------------------------------

  test('conversion_optimization is a real analytics capability, distinct from the conversion snapshot', () => {
    assert.ok(ANALYTICS_CAPABILITIES.includes('conversion_optimization'));
    assert.ok(ANALYTICS_CAPABILITIES.includes('conversion'), 'the existing metrics snapshot must be untouched');
    assert.strictEqual(typeof analyzeConversionOptimization, 'function');
  });

  test('NO CHECK LOGIC WAS REIMPLEMENTED - the agent delegates to the existing engine', () => {
    const agentSource = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'analyticsAgent.js'), 'utf8');
    assert.ok(
      agentSource.includes("require('./conversionOptimizationChecker')"),
      'the agent must call the existing checker'
    );
    const code = agentSource.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(code.includes('checkConversionOptimization('), 'the engine must actually be invoked');
    // The 8-dimension check logic must live ONLY in the engine, never copied here.
    for (const marker of ['DIMENSION_CHECKS', 'SEVERITY_RANK', 'buildDimensionGapReason']) {
      assert.ok(!code.includes(marker), `check logic '${marker}' must not be duplicated into the agent`);
    }
  });

  // --- The agent capability -----------------------------------------------------

  test('the capability returns a valid analytics result wrapping a valid CRO record', () => {
    const result = analyzeConversionOptimization(EVIDENCE);
    assert.strictEqual(result.capability, 'conversion_optimization');
    assert.strictEqual(result.specialized_records.length, 1, 'one CRO record per audit');
    const validation = validateConversionOptimizationCheckShape(result.specialized_records[0]);
    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
  });

  test('runAnalyticsAgent dispatches the new capability', () => {
    const result = runAnalyticsAgent({ capability: 'conversion_optimization', ...EVIDENCE });
    assert.strictEqual(result.capability, 'conversion_optimization');
  });

  test('a dimension with no evidence is reported honestly, never assumed to pass', () => {
    const result = analyzeConversionOptimization(EVIDENCE);
    const record = result.specialized_records[0];
    // Only 2 of the 8 dimensions had evidence supplied.
    assert.strictEqual(record.quality_score.dimensions_total, CONVERSION_OPTIMIZATION_DIMENSIONS.length);
    assert.ok(record.quality_score.dimensions_empty > 0);
    assert.ok(record.dimension_gaps.length > 0, 'unaudited dimensions must be named as gaps');
    for (const dimension of ['product_pages', 'landing_pages']) {
      assert.strictEqual(record.dimension_status[dimension], 'empty');
    }
    assert.ok(
      result.limitations.some((l) => l.includes('had no evidence supplied')),
      'partial coverage must be stated in the limitations'
    );
  });

  test('the CRO audit never claims to fetch a live page or predict a conversion rate', () => {
    const result = analyzeConversionOptimization(EVIDENCE);
    assert.ok(result.limitations.some((l) => l.includes('never fetches a live page')));
    assert.ok(result.limitations.some((l) => l.includes('never predicts an actual conversion rate')));
  });

  // --- Dispatch through the EXISTING analytics tool ------------------------------

  test('the existing analytics tool dispatches conversion_optimization', () => {
    const outcome = runAnalyticsTool({ analyticsCapability: 'conversion_optimization', ...EVIDENCE });
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.error, null);
    assert.strictEqual(outcome.result.capability, 'conversion_optimization');
  });

  test('an audit with NO evidence at all is reported as empty, never as a passing audit', () => {
    const outcome = runAnalyticsTool({ analyticsCapability: 'conversion_optimization', subjectReference: SUBJECT });
    assert.strictEqual(outcome.status, 'empty');
    const record = outcome.result.specialized_records[0];
    assert.strictEqual(record.quality_score.dimensions_success, 0);
    assert.strictEqual(record.quality_score.status, 'empty');
  });

  test('the tool still rejects an unknown capability, and every prior capability still works', () => {
    assert.strictEqual(runAnalyticsTool({ analyticsCapability: 'not_a_real_capability' }).status, 'failed');
    const sales = runAnalyticsTool({ reportingPeriod: '(placeholder)', summary: '(placeholder)' });
    assert.strictEqual(sales.result.capability, 'sales', 'the default capability must be unchanged');
  });

  // --- Registry / permissions: minimum wiring, nothing new -----------------------

  test('the capability is registered as an Analytics & Optimization task on the existing tool', () => {
    const task = getCapabilityTask('analytics_optimization', 'conversion_optimization');
    assert.ok(task, 'the task must exist');
    assert.deepStrictEqual(task.tool_ids, ['analytics'], 'it must reuse the existing analytics tool id');
    assert.deepStrictEqual(task.input_contract.required, [], 'no field is required - unsupplied dimensions are reported, not failed');
    for (const dimensionParam of ['productPages', 'trustSignals', 'checkoutFriction', 'pricingPresentation']) {
      assert.ok(task.input_contract.optional.includes(dimensionParam), `${dimensionParam} must be an accepted input`);
    }
    assert.ok(getSpecialistCapabilityById('analytics_optimization').required_tools.includes('analytics'));
  });

  test('NO NEW TOOL ID WAS CREATED - the capability rides the existing analytics tool', () => {
    assert.strictEqual(getToolById('conversion_optimization'), undefined, 'conversion_optimization is a capability, not a tool');
    const analyticsTool = getToolById('analytics');
    assert.strictEqual(analyticsTool.category, 'analytics');
    assert.strictEqual(analyticsTool.operation, 'read');
    assert.strictEqual(analyticsTool.status, 'implemented');
  });

  test('permissions are unchanged and already sufficient - analytics stays analysis_only', () => {
    assert.strictEqual(TOOL_CLASSIFICATIONS.analytics, 'analysis_only');
    const access = checkToolAccess({ specialistId: 'analytics_optimization', toolId: 'analytics' });
    assert.strictEqual(access.decision, 'allowed', access.reason);
    // A specialist that does not own analytics still cannot reach it.
    assert.notStrictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'analytics' }).decision, 'allowed');
  });

  // --- Real reachability through the normal Chief routing path -------------------

  await testAsync('REACHABLE THROUGH CHIEF: the orchestrator routes to it and executes it for real', async () => {
    const response = await runOrchestratorContract('Run a conversion optimization audit of our store', {
      researchParams: EVIDENCE,
    });
    assert.strictEqual(response.routing.status, 'planned', response.routing.reason || '');
    const step = (response.routing.plan || [])[0];
    assert.ok(step, 'a plan step must exist');
    assert.strictEqual(step.selected_specialist.id, 'analytics_optimization');
    assert.strictEqual(step.inputs.capability_id, 'conversion_optimization');
    assert.strictEqual(step.inputs.tool_id, 'analytics');
    assert.strictEqual(step.outputs.status, 'success');
    assert.strictEqual(step.outputs.result.capability, 'conversion_optimization');
    // It produced a real audit, not an empty shell.
    assert.ok(step.outputs.result.findings.length > 0);
    assert.strictEqual(step.outputs.result.specialized_records.length, 1);
  });

  await testAsync('the capability spends no tokens and makes no model call', async () => {
    const response = await runOrchestratorContract('Run a conversion optimization audit of our store', {
      researchParams: EVIDENCE,
    });
    assert.strictEqual(response.tokens_used, 0, 'a deterministic audit must cost no tokens');
    assert.strictEqual(response.usage_summary.by_category.model_call.count, 0);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('conversionOptimizationCapability.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
