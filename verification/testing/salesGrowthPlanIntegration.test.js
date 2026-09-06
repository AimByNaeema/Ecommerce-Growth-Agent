'use strict';

// Tests for the salesGrowthPlanner integration - the wiring that makes
// agent/core/salesGrowthPlanner.js reachable.
//
// ARCHITECTURAL PLACEMENT UNDER TEST. The planner spans 7 domains owned by 5 different
// specialists. CLAUDE.md section 2 makes the Chief/Orchestrator "the only place
// cross-specialist coordination happens", so it is wired at the WORKFLOW layer
// (agent/core/growthWorkflowOrchestrator.js, over the stages that really ran) and
// deliberately NOT as an Analytics capability - which would have made specialist #7 read
// Product/SEO/Marketing/Social output and break the boundary. Tests below assert BOTH
// halves of that: that it is reachable from the workflow, and that no Analytics
// capability/tool was added.
//
// The planner's own logic is not re-tested here - salesGrowthPlanner.test.js still owns
// every synthesis assertion. These tests cover only the connecting wiring.
//
// Every value below is an invented placeholder. The synthetic-step tests make no network
// call at all; the one real end-to-end test runs the actual workflow.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  gatherSalesGrowthPlanEvidence,
  PLAN_DOMAINS_WITH_NO_WORKFLOW_SOURCE,
} = require('../../agent/core/crossAgentContext');
const { runGrowthWorkflow } = require('../../agent/core/growthWorkflowOrchestrator');
const { validateSalesGrowthPlanShape, SALES_GROWTH_PLAN_DOMAINS } = require('../../agent/core/salesGrowthPlanModel');
const { ANALYTICS_CAPABILITIES } = require('../../agent/core/analyticsAgentResultModel');
const { getToolById } = require('../../tools/toolRegistry');
const { getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');

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

// Synthetic completed steps in the exact shape buildPlanStep() produces.
function syntheticSteps() {
  return [
    // A step that never produced a result - must be skipped, not crashed on.
    null,
    { selected_specialist: { id: 'research' }, inputs: { capability_id: 'global_market_opportunity_analysis' }, outputs: { status: 'failed', result: null } },
    { selected_specialist: { id: 'product' }, inputs: { capability_id: 'market_product_opportunity_analysis' }, outputs: { status: 'success', result: { topic: '(placeholder) product opportunity', verification_status: 'unverified' } } },
    // Listing is NOT one of the planner's 7 domains - must be ignored entirely.
    { selected_specialist: { id: 'listing' }, inputs: { capability_id: 'listing_content' }, outputs: { status: 'success', result: { topic: '(placeholder) listing copy' } } },
    { selected_specialist: { id: 'seo' }, inputs: { capability_id: 'product_seo' }, outputs: { status: 'success', result: { topic: '(placeholder) seo analysis', verification_status: 'verified' } } },
    { selected_specialist: { id: 'marketing' }, inputs: { capability_id: 'retention' }, outputs: { status: 'success', result: { topic: '(placeholder) retention' } } },
    { selected_specialist: { id: 'social_advertising' }, inputs: { capability_id: 'content_calendar' }, outputs: { status: 'success', result: { topic: '(placeholder) calendar' } } },
    {
      selected_specialist: { id: 'analytics_optimization' },
      inputs: { capability_id: 'sales' },
      outputs: {
        status: 'success',
        result: {
          topic: '(placeholder) sales',
          verification_status: 'verified',
          specialized_records: [
            {
              sales: {
                summary: '(placeholder) revenue summary',
                actual_metrics: [{ label: 'orders_count', value: 340 }],
                calculated_metrics: [],
                estimated_metrics: [],
                verification_status: 'verified',
              },
            },
          ],
        },
      },
    },
    // A LATER analytics stage with no metrics must not clobber the richer one above.
    { selected_specialist: { id: 'analytics_optimization' }, inputs: { capability_id: 'growth_opportunities' }, outputs: { status: 'success', result: { topic: '(placeholder) opportunities' } } },
  ];
}

(async () => {
  // --- Placement: workflow layer, NOT an Analytics capability ----------------------

  test('PLACEMENT: no Analytics capability or tool id was added for the plan', () => {
    assert.strictEqual(ANALYTICS_CAPABILITIES.length, 11, 'the analytics capability list must be unchanged');
    assert.ok(!ANALYTICS_CAPABILITIES.includes('sales_growth_plan'));
    assert.ok(!ANALYTICS_CAPABILITIES.includes('sales_growth_planning'));
    assert.strictEqual(getToolById('sales_growth_plan'), undefined);
    const analytics = getSpecialistCapabilityById('analytics_optimization');
    assert.ok(
      !analytics.supported_tasks.some((task) => task.id.includes('sales_growth')),
      'the planner must NOT be an Analytics specialist task - it spans 5 specialists'
    );
  });

  test('PLACEMENT: the planner is reached from the workflow layer only', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'growthWorkflowOrchestrator.js'), 'utf8');
    assert.ok(workflow.includes("require('./salesGrowthPlanner')"), 'the workflow orchestrator must be the caller');
    // No specialist agent may reach it.
    for (const specialistFile of ['analyticsAgent.js', 'marketingAgent.js', 'seoAgent.js', 'productAgent.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', specialistFile), 'utf8');
      assert.ok(!source.includes('salesGrowthPlanner'), `${specialistFile} must not reach across specialist boundaries`);
    }
  });

  test('the gatherer never calls the planner itself - the two stay separate', () => {
    // Scan the CODE only - a comment may legitimately name the function to explain the
    // separation it is documenting (same convention as etsyPublishing.test.js).
    const code = fs
      .readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'crossAgentContext.js'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!code.includes('generateSalesGrowthPlan'), 'crossAgentContext only gathers evidence, it never synthesizes');
    assert.ok(!code.includes("require('./salesGrowthPlanner')"));
  });

  // --- The extractor: relay only, never synthesis ---------------------------------

  test('the extractor is pure - it does not mutate the steps it reads', () => {
    const steps = syntheticSteps();
    const before = JSON.stringify(steps);
    gatherSalesGrowthPlanEvidence(steps);
    assert.strictEqual(JSON.stringify(steps), before);
  });

  test('the extractor tolerates null/failed steps instead of crashing', () => {
    assert.deepStrictEqual(gatherSalesGrowthPlanEvidence([]), {});
    assert.deepStrictEqual(gatherSalesGrowthPlanEvidence(undefined), {});
    assert.deepStrictEqual(gatherSalesGrowthPlanEvidence([null, { outputs: null }]), {});
    // A failed step produced no real result, so it contributes nothing.
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    assert.ok(!('research' in evidence));
  });

  test('each mapped domain relays only fields the real result actually carries', () => {
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    assert.strictEqual(evidence.seo.summary, '(placeholder) seo analysis');
    assert.strictEqual(evidence.seo.verificationStatus, 'verified');
    // A specialist envelope carries no metrics - they stay empty, never padded.
    assert.deepStrictEqual(evidence.seo.actualMetrics, []);
    // An unstated verification_status defaults to unverified, never upgraded.
    assert.strictEqual(evidence.marketing.verificationStatus, 'unverified');
    assert.strictEqual(evidence.social.summary, '(placeholder) calendar');
    assert.strictEqual(evidence.product.summary, '(placeholder) product opportunity');
  });

  test('real analytics metrics are relayed from the snapshot category', () => {
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    assert.strictEqual(evidence.analytics.summary, '(placeholder) revenue summary');
    assert.deepStrictEqual(evidence.analytics.actualMetrics, [{ label: 'orders_count', value: 340 }]);
    assert.strictEqual(evidence.analytics.verificationStatus, 'verified');
  });

  test('a later same-specialist stage never clobbers richer measured evidence', () => {
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    // growth_opportunities ran after sales and has no metrics - sales must survive.
    assert.strictEqual(evidence.analytics.actualMetrics.length, 1);
  });

  test('a specialist outside the plan domains contributes nothing', () => {
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    assert.ok(!('listing' in evidence), 'listing is not one of the plan domains');
    for (const domain of Object.keys(evidence)) {
      assert.ok(SALES_GROWTH_PLAN_DOMAINS.includes(domain), `${domain} is not a real plan domain`);
    }
  });

  test('domains with no workflow source are declared and left empty, never faked', () => {
    assert.deepStrictEqual(PLAN_DOMAINS_WITH_NO_WORKFLOW_SOURCE, ['customer', 'advertising']);
    const evidence = gatherSalesGrowthPlanEvidence(syntheticSteps());
    for (const domain of PLAN_DOMAINS_WITH_NO_WORKFLOW_SOURCE) {
      assert.ok(!(domain in evidence), `${domain} has no honest workflow source and must not be invented`);
      assert.ok(SALES_GROWTH_PLAN_DOMAINS.includes(domain), 'it is still a real plan domain the planner reports as a gap');
    }
  });

  // --- Real reachability through the workflow path --------------------------------

  await testAsync('REACHABLE: a completed workflow run carries a schema-valid sales_growth_plan', async () => {
    const response = await runGrowthWorkflow(null, {
      research: { markets: ['(placeholder) United States'] },
      product: { productIdentity: '(placeholder) insulated jacket' },
    });
    assert.strictEqual(response.status, 'completed', 'this run must complete for the plan to be attached');
    assert.ok(response.sales_growth_plan, 'the plan must be attached to a completed run');
    const validation = validateSalesGrowthPlanShape(response.sales_growth_plan);
    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
    // Every domain is accounted for, one way or the other.
    assert.strictEqual(response.sales_growth_plan.domain_coverage.domains_total, SALES_GROWTH_PLAN_DOMAINS.length);
    for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
      assert.ok(response.sales_growth_plan.domain_status[domain], `${domain} must carry a status`);
    }
  });

  await testAsync('the synthesis is deterministic - no model call, no tokens', async () => {
    const response = await runGrowthWorkflow(null, {
      research: { markets: ['(placeholder) United States'] },
      product: { productIdentity: '(placeholder) insulated jacket' },
    });
    assert.strictEqual(response.usage_summary.by_category.model_call.count, 0);
  });

  await testAsync('caller-supplied domain evidence overrides the derived value', async () => {
    const response = await runGrowthWorkflow(null, {
      research: { markets: ['(placeholder) United States'] },
      product: { productIdentity: '(placeholder) insulated jacket' },
      salesGrowthPlan: {
        subjectReference: '(placeholder) my store',
        customer: {
          summary: '(placeholder) caller-supplied customer state',
          actualMetrics: [{ label: 'repeat_rate', value: '18%' }],
          verificationStatus: 'verified',
        },
      },
    });
    const plan = response.sales_growth_plan;
    assert.strictEqual(plan.subject_reference, '(placeholder) my store');
    // customer has no workflow source, so the caller's own evidence is what fills it.
    assert.strictEqual(plan.current_state.customer.summary, '(placeholder) caller-supplied customer state');
    assert.strictEqual(plan.domain_status.customer, 'success');
    assert.ok(!plan.domain_gaps.some((gap) => gap.domain === 'customer'));
  });

  await testAsync('an INCOMPLETE run carries NO plan - a plan must never describe a run that did not finish', async () => {
    // buildStoppedResponse/the paused response deliberately omit sales_growth_plan.
    const workflow = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'growthWorkflowOrchestrator.js'), 'utf8');
    const stopped = workflow.slice(workflow.indexOf('function buildStoppedResponse'));
    const stoppedBody = stopped.slice(0, stopped.indexOf('\n}'));
    assert.ok(!stoppedBody.includes('sales_growth_plan'), 'a stopped run must carry no plan');
    // And it is attached in exactly one place.
    const code = workflow.replace(/^\s*\/\/.*$/gm, '');
    assert.strictEqual((code.match(/sales_growth_plan:/g) || []).length, 1);
    assert.strictEqual((code.match(/generateSalesGrowthPlan\(/g) || []).length, 1);
  });

  test('the ranking engine is still reused, not duplicated', () => {
    const planner = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'salesGrowthPlanner.js'), 'utf8');
    assert.ok(planner.includes("require('./growthOpportunityEngine')"), 'ranking must still come from the existing engine');
    const workflow = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'growthWorkflowOrchestrator.js'), 'utf8');
    assert.ok(!workflow.includes('rankGrowthOpportunities'), 'the workflow must not reimplement ranking');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('salesGrowthPlanIntegration.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
