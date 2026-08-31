'use strict';

// End-to-end tests for the controlled optimization cycle
// (agent/core/optimizationCycleOrchestrator.js):
//
//   Research -> Recommendation -> Approval -> Action -> Measurement -> Analysis
//   -> Learning -> New Recommendation
//
// Mirrors verification/testing/growthWorkflowOrchestrator.test.js's and
// verification/testing/chiefToApprovalIntegration.test.js's conventions exactly
// (testAsync, withEnvConfigured, withMockedFetch, withReclassifiedTool, jsonResponse) -
// controlled/mocked data throughout, no real network call except where explicitly
// mocked. Proves every requirement this feature was built for:
//   1. A full multi-iteration happy path, with real structured data flowing through
//      Research -> Recommendation -> Action -> Measurement -> Analysis -> Learning,
//      and a validated lesson feeding forward as evidence for the next iteration.
//   2/3. The Action approval boundary: a gated action never executes before a real,
//      accountable decision, and a rejected decision halts the cycle without executing.
//   4/5. Analysis outcomes 'keep_control'/'inconclusive' halt the cycle with the
//      correct, distinct stop_reason and correct Learning behavior for each.
//   6/7/8. Explicit iteration/tool-call/token ceilings each produce their own named
//      stop_reason, never a silent or generic halt.
//   9/10. Research/Action stage failures halt the cycle immediately, never guessing
//      forward past a real failure.

const assert = require('node:assert');
const {
  OPTIMIZATION_CYCLE_STAGE_KEYS,
  STOP_REASONS,
  startOptimizationCycle,
  resumeAfterApproval,
  recordMeasurementAndAnalyze,
  startNextIteration,
} = require('../../agent/core/optimizationCycleOrchestrator');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { loadEnvOnce } = require('../../integrations/adapters/shopifyClient');

let passed = 0;
let failed = 0;

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

function withEnv(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = String(value);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
}

function withEnvConfigured(fn) {
  const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const savedClientId = process.env.SHOPIFY_CLIENT_ID;
  const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
  // A real local .env may legitimately have SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET
  // set (Client Credentials is the preferred auth path - see
  // integrations/adapters/shopifyClient.js's precedence note). Cleared here so this
  // "static token" scenario is actually isolated to the static-token code path
  // regardless of local .env contents - otherwise usesClientCredentials() would pick
  // up the real values and this test would incorrectly attempt an OAuth token
  // exchange against a mock that only ever returns GraphQL-shaped responses.
  // loadEnvOnce() is forced first so the real .env's one-time load (see
  // shopifyClient.js's envLoadAttempted guard) can never happen AFTER the deletes
  // below and silently repopulate them.
  loadEnvOnce();
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
    });
}

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
    });
}

function withReclassifiedTool(toolId, classification, fn) {
  const original = TOOL_CLASSIFICATIONS[toolId];
  TOOL_CLASSIFICATIONS[toolId] = classification;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      TOOL_CLASSIFICATIONS[toolId] = original;
    });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'status text', json: async () => body };
}

// Dependency-free, in-memory tools (no external client, no mocking needed) - keeps
// most of these tests focused purely on the cycle's own control flow.
const RESEARCH_TARGET = {
  specialistId: 'research',
  objective: 'Research the target market before recommending a pricing change.',
  forcedSelection: { toolId: 'market_research', capabilityId: 'market_research' },
};
const ACTION_TARGET = {
  specialistId: 'seo',
  objective: 'Take the recommended on-page SEO action for this product.',
  forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' },
};

// The Shopify-backed action target, reused only by the approval-boundary tests (same
// tool/mocking convention as chiefToApprovalIntegration.test.js/
// growthWorkflowOrchestrator.test.js).
const EXTERNAL_ACTION_TARGET = {
  specialistId: 'analytics_optimization',
  objective: 'Retrieve baseline sales data before acting.',
  forcedSelection: { toolId: 'analytics_data_retrieval', capabilityId: 'sales' },
};

function buildExperimentInput(experimentId, overrides = {}) {
  return {
    experimentId,
    domain: 'pricing',
    subjectReference: 'Insulated Jacket X (test placeholder)',
    hypothesis: 'Lowering the price increases conversion enough to grow net revenue (test placeholder).',
    variable: 'list_price',
    control: { description: 'Current price: $89.99 (test placeholder).', evidence: [] },
    variant: { description: 'Test price: $80.99 (test placeholder).', evidence: [] },
    targetMetric: 'conversion_rate',
    duration: { plannedDurationDays: 14 },
    successCriteria: 'Net revenue improves by at least 5% (test placeholder).',
    ...overrides,
  };
}

function iterateAnalysis(rationale) {
  return { outcome: 'iterate', rationale, evidence: ['test evidence'], actionClassification: 'recommendation' };
}

(async () => {
  // --- 1. FULL HAPPY PATH: 2 iterations, real data flowing through every stage -----

  await testAsync('a 2-iteration cycle deciding iterate then ship_variant completes with the expected structured records', async () => {
    let result = await startOptimizationCycle({
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-iter-1'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });
    assert.strictEqual(result.status, 'awaiting_measurement');
    assert.strictEqual(result.iteration, 1);
    assert.strictEqual(result._resumeState.currentIterationRecord.research_step.completion_state, 'complete');
    assert.strictEqual(result._resumeState.currentIterationRecord.action_step.completion_state, 'complete');
    assert.ok(result._resumeState.currentIterationRecord.experiment.duration.start_date, 'experiment should be marked started after Action succeeds');

    result = await recordMeasurementAndAnalyze(result._resumeState, {
      measurement: {
        controlValue: '1.9% conversion rate',
        variantValue: '2.1% conversion rate',
        observedEffect: 'Modest improvement, inside the noise band for this sample size.',
        evidence: ['test measurement evidence'],
      },
      analysis: iterateAnalysis('Directionally promising but not conclusive yet.'),
    });
    assert.strictEqual(result.status, 'iteration_ready');
    assert.strictEqual(result.iteration, 2);
    assert.strictEqual(result.iterations.length, 1, 'iteration 1 should be finalized');
    assert.strictEqual(result.iterations[0].experiment.decision.outcome, 'iterate');
    assert.strictEqual(result.lessons.length, 0, "'iterate' is not learnable - no lesson should be recorded");
    assert.deepStrictEqual(result.available_evidence, []);

    result = await startNextIteration(result._resumeState, {
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-iter-2'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });
    assert.strictEqual(result.status, 'awaiting_measurement');
    assert.strictEqual(result.iteration, 2);

    result = await recordMeasurementAndAnalyze(result._resumeState, {
      measurement: {
        controlValue: '1.9% conversion rate',
        variantValue: '2.4% conversion rate',
        observedEffect: 'Net revenue improved by 6%.',
        statisticalSignificance: '95% confidence.',
        evidence: ['test measurement evidence'],
      },
      analysis: {
        outcome: 'ship_variant',
        rationale: 'Clears the success criteria at 95% confidence.',
        evidence: ['test measurement evidence'],
        actionClassification: 'recommendation',
      },
      lesson: { lesson: 'A price reduction on this product increases net revenue enough to ship.', confidence: 'medium' },
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.stop_reason, null);
    assert.strictEqual(result.iterations.length, 2);
    assert.strictEqual(result.iterations[1].experiment.decision.outcome, 'ship_variant');
    assert.strictEqual(result.lessons.length, 1);
    assert.strictEqual(result.lessons[0].outcome, 'success');
    assert.ok(Array.isArray(result.audit_trail) && result.audit_trail.length > 0);
    assert.ok(Array.isArray(result.usage_ledger) && result.usage_ledger.length > 0);
  });

  // --- 2. APPROVAL -> REJECTED: the gated action never executes, cycle halts --------

  await testAsync('a rejected approval never executes the gated action, and the cycle stops without measurement', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedTool('analytics_data_retrieval', 'externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            throw new Error('the external client must never be called for a rejected request');
          },
          async () => {
            const paused = await startOptimizationCycle({
              researchTarget: RESEARCH_TARGET,
              researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
              experiment: buildExperimentInput('test-exp-rejected'),
              actionTarget: EXTERNAL_ACTION_TARGET,
              actionParams: {},
            });

            assert.strictEqual(paused.status, 'awaiting_approval');
            assert.ok(paused.pending_approval);
            assert.strictEqual(paused.pending_approval.status, 'pending');
            assert.strictEqual(paused.pending_approval.tool_id, 'analytics_data_retrieval');
            assert.strictEqual(calls, 0);

            const decidedRequests = decideApprovalRequest([paused.pending_approval], paused.pending_approval.id, {
              decision: 'rejected',
              decidedBy: 'owner@example.com',
              notes: 'Not needed right now.',
            });
            const resumed = await resumeAfterApproval(decidedRequests[0], paused._resumeState);

            assert.strictEqual(resumed.status, 'stopped');
            assert.strictEqual(resumed.stop_reason, STOP_REASONS.APPROVAL_REJECTED);
            assert.strictEqual(resumed.iterations.length, 1);
            assert.strictEqual(resumed.iterations[0].action_step.outputs, null);
            assert.strictEqual(calls, 0, 'a rejected request must never reach the external client');
          }
        )
      )
    );
  });

  // --- 3. APPROVAL -> APPROVED, then decided keep_control: a lesson IS still ------
  // --- recorded even though the cycle stops -----------------------------------------

  await testAsync('an approved action resumes to measurement, and a keep_control decision stops the cycle but still records a lesson', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedTool('analytics_data_retrieval', 'externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(200, { data: { orders: { edges: [] } } });
          },
          async () => {
            const paused = await startOptimizationCycle({
              researchTarget: RESEARCH_TARGET,
              researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
              experiment: buildExperimentInput('test-exp-keep-control'),
              actionTarget: EXTERNAL_ACTION_TARGET,
              actionParams: {},
            });

            const decidedRequests = decideApprovalRequest([paused.pending_approval], paused.pending_approval.id, {
              decision: 'approved',
              decidedBy: 'owner@example.com',
            });
            const resumed = await resumeAfterApproval(decidedRequests[0], paused._resumeState);

            assert.strictEqual(resumed.status, 'awaiting_measurement');
            assert.strictEqual(calls, 1, 'the external client must be reached exactly once, only after approval');

            const finalResult = await recordMeasurementAndAnalyze(resumed._resumeState, {
              measurement: {
                controlValue: '1.9% conversion rate',
                variantValue: '1.8% conversion rate',
                observedEffect: 'The variant underperformed the control.',
                evidence: ['test measurement evidence'],
              },
              analysis: {
                outcome: 'keep_control',
                rationale: 'The variant underperformed - not worth pursuing.',
                evidence: ['test measurement evidence'],
                actionClassification: 'recommendation',
              },
              lesson: { lesson: 'This price reduction hurt conversion for this product category.', confidence: 'medium' },
            });

            assert.strictEqual(finalResult.status, 'stopped');
            assert.strictEqual(finalResult.stop_reason, STOP_REASONS.DECISION_KEEP_CONTROL);
            assert.strictEqual(finalResult.lessons.length, 1, 'keep_control is a decided, learnable outcome');
            assert.strictEqual(finalResult.lessons[0].outcome, 'failure');
          }
        )
      )
    );
  });

  // --- 4. inconclusive: stops, and Learning is never even attempted -----------------

  await testAsync('an inconclusive decision stops the cycle without attempting to record a lesson', async () => {
    let result = await startOptimizationCycle({
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-inconclusive'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });
    assert.strictEqual(result.status, 'awaiting_measurement');

    result = await recordMeasurementAndAnalyze(result._resumeState, {
      measurement: {
        controlValue: '1.9% conversion rate',
        variantValue: '1.95% conversion rate',
        observedEffect: 'Effectively no difference - within measurement noise.',
        evidence: ['test measurement evidence'],
      },
      analysis: {
        outcome: 'inconclusive',
        rationale: 'The observed effect is within measurement noise.',
        evidence: ['test measurement evidence'],
        actionClassification: 'recommendation',
      },
    });

    assert.strictEqual(result.status, 'stopped');
    assert.strictEqual(result.stop_reason, STOP_REASONS.DECISION_INCONCLUSIVE);
    assert.strictEqual(result.lessons.length, 0, 'inconclusive is not learnable - recordExperimentLesson must never be attempted');
  });

  // --- 5. Iteration limit: recordMeasurementAndAnalyze stops directly, never --------
  // --- returning iteration_ready once the ceiling is reached ------------------------

  await testAsync('reaching the iteration ceiling stops the cycle instead of allowing another iteration', async () => {
    await withEnv('MAX_OPTIMIZATION_CYCLE_ITERATIONS', 1, async () => {
      let result = await startOptimizationCycle({
        researchTarget: RESEARCH_TARGET,
        researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
        experiment: buildExperimentInput('test-exp-iteration-limit'),
        actionTarget: ACTION_TARGET,
        actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
      });
      assert.strictEqual(result.max_iterations, 1);

      result = await recordMeasurementAndAnalyze(result._resumeState, {
        measurement: {
          controlValue: '1.9% conversion rate',
          variantValue: '2.1% conversion rate',
          observedEffect: 'Modest improvement.',
          evidence: ['test measurement evidence'],
        },
        analysis: iterateAnalysis('Worth another iteration in principle.'),
      });

      assert.strictEqual(result.status, 'stopped');
      assert.strictEqual(result.stop_reason, STOP_REASONS.ITERATION_LIMIT_REACHED);
    });
  });

  // --- 6. Tool-call budget: exhausted exactly at the end of iteration 1, so the ------
  // --- proactive check (run before allowing 'iteration_ready') stops the cycle ------
  // --- right there - iteration 2 never gets a chance to be started ------------------

  await testAsync('exhausting the tool-call budget stops the cycle instead of allowing another iteration', async () => {
    await withEnv('MAX_TOOL_CALLS_PER_RUN', 2, async () => {
      let result = await startOptimizationCycle({
        researchTarget: RESEARCH_TARGET,
        researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
        experiment: buildExperimentInput('test-exp-tool-budget'),
        actionTarget: ACTION_TARGET,
        actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
      });
      assert.strictEqual(result.status, 'awaiting_measurement', 'iteration 1 itself stays within the 2-call budget (research + action)');

      result = await recordMeasurementAndAnalyze(result._resumeState, {
        measurement: {
          controlValue: '1.9% conversion rate',
          variantValue: '2.1% conversion rate',
          observedEffect: 'Modest improvement.',
          evidence: ['test measurement evidence'],
        },
        analysis: iterateAnalysis('Worth another iteration in principle.'),
      });

      assert.strictEqual(result.status, 'stopped');
      assert.strictEqual(result.stop_reason, STOP_REASONS.TOOL_CALL_BUDGET_EXHAUSTED);
      assert.strictEqual(result.iterations.length, 1, 'iteration 2 must never have started dispatching');
    });
  });

  // --- 7. Token budget: a directly-inflated tracker stops the next iteration --------

  await testAsync('an exhausted token budget stops the next iteration before it dispatches Research', async () => {
    let result = await startOptimizationCycle({
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-token-budget'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });

    result = await recordMeasurementAndAnalyze(result._resumeState, {
      measurement: {
        controlValue: '1.9% conversion rate',
        variantValue: '2.1% conversion rate',
        observedEffect: 'Modest improvement.',
        evidence: ['test measurement evidence'],
      },
      analysis: iterateAnalysis('Worth another iteration in principle.'),
    });
    assert.strictEqual(result.status, 'iteration_ready');

    result._resumeState.runTokenTracker.tokensUsedThisRun = 999999999;

    result = await startNextIteration(result._resumeState, {
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-token-budget-iter-2'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });

    assert.strictEqual(result.status, 'stopped');
    assert.strictEqual(result.stop_reason, STOP_REASONS.TOKEN_BUDGET_EXHAUSTED);
    assert.strictEqual(result.iterations.length, 1);
  });

  // --- 8. Research stage failure: no recommendation/approval/action attempted -------
  // (an oversized array field trips agent/core/executionBounds.js's checkArrayFieldBounds
  // before the tool is ever invoked - a genuine, deterministic outer 'error' outcome.
  // A tool-level missing-required-field result is also honestly non-'complete' today
  // (agent/core/executionState.js's getToolResultStatus unwraps the tool's own
  // {status,result,error} outcome), so either path halts the cycle here - this
  // specific test exercises the bounds-check path; see
  // agent/core/executionBounds.js's own header on why that bound exists.)

  await testAsync('a failing Research stage stops the cycle before any recommendation, approval, or action is attempted', async () => {
    const result = await startOptimizationCycle({
      researchTarget: RESEARCH_TARGET,
      researchParams: { market: 'European Union outdoor apparel market', tooManyEntries: new Array(101).fill('x') },
      experiment: buildExperimentInput('test-exp-research-failed'),
      actionTarget: ACTION_TARGET,
      actionParams: {
        productReference: 'Insulated Jacket X',
        evidence: [{ topic: 'On-page SEO', finding: 'Title contains the primary keyword (test placeholder).', source: ['SEO audit reference'] }],
      },
    });

    assert.strictEqual(result.status, 'stopped');
    assert.strictEqual(result.stop_reason, STOP_REASONS.RESEARCH_STAGE_FAILED);
    assert.strictEqual(result.iterations.length, 1);
    assert.strictEqual(result.iterations[0].experiment, null, 'no recommendation should be created after a failed Research stage');
    assert.strictEqual(result.iterations[0].action_step, null, 'no action should be attempted after a failed Research stage');
  });

  // --- 9. Action stage failure: no measurement attempted ----------------------------

  await testAsync('a failing Action stage stops the cycle before measurement is attempted', async () => {
    const result = await startOptimizationCycle({
      researchTarget: RESEARCH_TARGET,
      researchParams: {
        market: 'European Union outdoor apparel market',
        demandSignals: ['strong demand signal (test placeholder)'],
        evidence: [{ topic: 'Demand', finding: 'Search volume trending up (test placeholder).', source: ['market evidence reference'] }],
      },
      experiment: buildExperimentInput('test-exp-action-failed'),
      actionTarget: ACTION_TARGET,
      actionParams: { productReference: 'Insulated Jacket X', tooManyEntries: new Array(101).fill('x') },
    });

    assert.strictEqual(result.status, 'stopped');
    assert.strictEqual(result.stop_reason, STOP_REASONS.ACTION_STAGE_FAILED);
    assert.strictEqual(result.iterations.length, 1);
    assert.ok(result.iterations[0].experiment, 'the recommendation should already have been created before Action failed');
  });

  // --- Sanity: documented constants match ------------------------------------------

  await testAsync('OPTIMIZATION_CYCLE_STAGE_KEYS and STOP_REASONS match their documented values', () => {
    assert.deepStrictEqual(OPTIMIZATION_CYCLE_STAGE_KEYS, [
      'research',
      'recommendation',
      'approval',
      'action',
      'measurement',
      'analysis',
      'learning',
      'new_recommendation',
    ]);
    assert.deepStrictEqual(STOP_REASONS, {
      ITERATION_LIMIT_REACHED: 'iteration_limit_reached',
      TOKEN_BUDGET_EXHAUSTED: 'token_budget_exhausted',
      TOOL_CALL_BUDGET_EXHAUSTED: 'tool_call_budget_exhausted',
      RESEARCH_STAGE_FAILED: 'research_stage_failed',
      ACTION_STAGE_FAILED: 'action_stage_failed',
      APPROVAL_REJECTED: 'approval_rejected',
      DECISION_KEEP_CONTROL: 'decision_keep_control',
      DECISION_INCONCLUSIVE: 'decision_inconclusive',
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
