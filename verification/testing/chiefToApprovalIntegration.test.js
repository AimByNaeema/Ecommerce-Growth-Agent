'use strict';

// Integration tests for the full real pipeline:
//
//   Chief (runOrchestratorContract/executeSelectedCapability)
//     -> specialist (analytics_optimization, owns the 'analytics' category per
//        agent/core/toolPermissions.js's CATEGORY_TO_SPECIALIST)
//     -> tool (analytics_data_retrieval - tools/analyticsDataTool.js)
//     -> external client (integrations/adapters/shopifyClient.js, mocked at the
//        global.fetch boundary - no real network call is ever made)
//     -> result (the structured outcome/response)
//     -> approval, where required (approvals/approvalWorkflow.js)
//
// analytics_data_retrieval is the only TOOL_EXECUTORS entry that is BOTH owned by a
// real specialist (not shared infrastructure, unlike ai_reasoning_completion) AND
// backed by a real external client (shopifyClient) - the exact combination this suite
// needs to prove "specialist -> tool -> external client" end-to-end, distinct from
// verification/testing/orchestratorExecutionContract.test.js's existing Claude-backed
// shared-infrastructure coverage and its business_configuration_retrieval-based
// approval-flow coverage (both already thorough - not duplicated here).
//
// No real, implemented tool is classified approval_required today (see
// agent/core/toolPermissions.js's TOOL_CLASSIFICATIONS and its own header comment on
// this honest gap) - the approval-flow tests below use the same
// temporarily-reclassify-and-restore-in-`finally` technique already established in
// orchestratorExecutionContract.test.js, applied to analytics_data_retrieval instead
// of business_configuration_retrieval, so the external-client leg sits INSIDE the
// approval gate rather than beside it.

const assert = require('node:assert');
const { runOrchestratorContract, executeSelectedCapability, resumeApprovedExecution } = require('../../agent/core/orchestratorExecutionContract');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');

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

// This objective's word-overlap score against agent/core/specialistRegistry.js's
// analytics_optimization description ("Store performance, growth metrics, and
// optimization recommendations") was empirically verified (score 5) to beat every
// other routing target (next-highest score 1) by running the real orchestrator - the
// same practice orchestratorExecutionContract.test.js's own header documents for its
// routing fixtures, not a hand-guess.
const ANALYTICS_OBJECTIVE = 'analyze store performance growth metrics and sales analytics data';

function withEnvConfigured(fn) {
  const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
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

function withReclassifiedAnalyticsDataRetrieval(classification, fn) {
  const original = TOOL_CLASSIFICATIONS.analytics_data_retrieval;
  TOOL_CLASSIFICATIONS.analytics_data_retrieval = classification;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      TOOL_CLASSIFICATIONS.analytics_data_retrieval = original;
    });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'status text', json: async () => body };
}

const SAMPLE_ORDER_NODE = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-01-15T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
  lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
};

function ordersResponse(nodes) {
  return jsonResponse(200, { data: { orders: { edges: nodes.map((node) => ({ node })) } } });
}

function buildAnalyticsExecutionRequest(researchParams) {
  return {
    objective: ANALYTICS_OBJECTIVE,
    category: 'analytics',
    tool_id: 'analytics_data_retrieval',
    specialist_id: 'analytics_optimization',
    is_shared_infrastructure: false,
    research_params: researchParams,
  };
}

(async () => {
  // --- Full pipeline, auto-approved (analysis_only): SUCCESS ----------------------

  await testAsync('SUCCESS: Chief routes the objective to the Analytics & Optimization specialist, which pulls real (mocked) order data through the external Shopify client', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => {
          calls += 1;
          return ordersResponse([SAMPLE_ORDER_NODE]);
        },
        async () => {
          const response = await runOrchestratorContract(ANALYTICS_OBJECTIVE, {
            researchParams: { analyticsCapability: 'sales', limit: 5 },
          });
          assert.strictEqual(response.routing.status, 'planned');
          assert.strictEqual(response.routing.plan.length, 1);
          const step = response.routing.plan[0];
          assert.strictEqual(step.selected_specialist.type, 'specialist');
          assert.strictEqual(step.selected_specialist.id, 'analytics_optimization');
          assert.deepStrictEqual(step.tool_calls, ['analytics_data_retrieval']);
          assert.strictEqual(step.completion_state, 'complete');
          assert.strictEqual(step.outputs.status, 'success');
          // The result is the real (mocked) order, not a fabricated one - nested under
          // the sales category of the composed analytics snapshot record (see
          // agent/core/analyticsAgent.js's composeAnalyticsSnapshotResult).
          const salesRecord = step.outputs.result.specialized_records[0].sales;
          const actualMetric = salesRecord.actual_metrics[0];
          assert.strictEqual(actualMetric.value, '89.00');
          assert.strictEqual(actualMetric.orderId, 'gid://shopify/Order/1');
          assert.ok(step.outputs.result.limitations.some((line) => /Pulled 1 order/.test(line)));
          // analysis_only needs no human sign-off - the plan completed with no pending
          // approval anywhere in the response.
          assert.deepStrictEqual(response.pending_approvals, []);
        }
      )
    );
    assert.strictEqual(calls, 1, 'the external client should be called exactly once for one plan step');
  });

  // --- Full pipeline, auto-approved: FAILURE (external client errors) -------------

  // NOTE: tools/analyticsDataTool.js's own contract is "Returns { status, result,
  // error } - never throws" - a Shopify-level failure is caught INSIDE the tool and
  // returned as an honest { status: 'failed', result: null, error } value, not a
  // rejected promise. So at the ORCHESTRATOR's own dispatch level this is still a
  // successful call (the executor resolved) - completion_state stays 'complete' and
  // step.errors stays empty; the honest failure instead shows up one level in, on
  // step.outputs (the tool's own reported status/error). Asserting on the wrong level
  // would be exactly the kind of blind spot this integration suite exists to catch.

  await testAsync('FAILURE: a GraphQL-level error from the external Shopify client propagates as an honest failure, never fabricated data', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }),
        async () => {
          const response = await runOrchestratorContract(ANALYTICS_OBJECTIVE, {
            researchParams: { analyticsCapability: 'sales', limit: 5 },
          });
          const step = response.routing.plan[0];
          assert.strictEqual(step.selected_specialist.id, 'analytics_optimization');
          assert.strictEqual(step.completion_state, 'complete');
          assert.strictEqual(step.outputs.status, 'failed');
          assert.strictEqual(step.outputs.result, null);
          assert.ok(/GraphQL errors/.test(step.outputs.error));
        }
      )
    );
  });

  await testAsync('FAILURE: the external Shopify client is unreachable (fetch throws), and this is surfaced as an honest failure, never a fabricated result', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => {
          throw new Error('simulated DNS failure');
        },
        async () => {
          const response = await runOrchestratorContract(ANALYTICS_OBJECTIVE, {
            researchParams: { analyticsCapability: 'sales', limit: 5 },
          });
          const step = response.routing.plan[0];
          assert.strictEqual(step.completion_state, 'complete');
          assert.strictEqual(step.outputs.status, 'failed');
          assert.strictEqual(step.outputs.result, null);
          assert.ok(/Could not reach the Shopify Admin API/.test(step.outputs.error));
        }
      )
    );
  });

  // --- Full pipeline, approval required: the external client sits INSIDE the gate -

  await testAsync('APPROVAL -> APPROVED: the external client is never reached before a real decision is recorded, then executes for real and returns the real (mocked) result', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedAnalyticsDataRetrieval('externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            return ordersResponse([SAMPLE_ORDER_NODE]);
          },
          async () => {
            const response = await runOrchestratorContract(ANALYTICS_OBJECTIVE, {
              researchParams: { analyticsCapability: 'sales', limit: 5 },
            });
            const step = response.routing.plan[0];
            assert.strictEqual(step.completion_state, 'blocked');
            assert.strictEqual(step.outputs, null);
            assert.strictEqual(response.pending_approvals.length, 1);
            const pendingRequest = response.pending_approvals[0];
            assert.strictEqual(pendingRequest.status, 'pending');
            assert.strictEqual(pendingRequest.tool_id, 'analytics_data_retrieval');
            assert.strictEqual(pendingRequest.specialist_id, 'analytics_optimization');
            assert.strictEqual(calls, 0, 'the external client must never be reached before approval');

            const approvedRequests = decideApprovalRequest(response.pending_approvals, pendingRequest.id, {
              decision: 'approved',
              decidedBy: 'owner@example.com',
            });
            const resumedOutcome = await resumeApprovedExecution(approvedRequests[0]);

            assert.strictEqual(resumedOutcome.status, 'success');
            assert.strictEqual(calls, 1, 'the external client must be reached exactly once, only after approval');
            assert.strictEqual(resumedOutcome.data.status, 'success');
            const salesRecord = resumedOutcome.data.result.specialized_records[0].sales;
            assert.strictEqual(salesRecord.actual_metrics[0].value, '89.00');
          }
        )
      )
    );
  });

  await testAsync('APPROVAL -> REJECTED: the external client is never reached at all', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedAnalyticsDataRetrieval('externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            throw new Error('the external client must never be called for a rejected request');
          },
          async () => {
            const executionRequest = buildAnalyticsExecutionRequest({ analyticsCapability: 'sales', limit: 5 });
            const runApprovalTracker = { requests: [] };
            const gated = await executeSelectedCapability(executionRequest, undefined, runApprovalTracker);
            assert.strictEqual(gated.status, 'approval_required');

            const rejectedRequests = decideApprovalRequest(runApprovalTracker.requests, gated.approval_request_id, {
              decision: 'rejected',
              decidedBy: 'owner@example.com',
              notes: 'Not needed right now.',
            });
            const resumedOutcome = await resumeApprovedExecution(rejectedRequests[0]);

            assert.strictEqual(resumedOutcome.status, 'denied');
            assert.strictEqual(calls, 0, 'a rejected request must never reach the external client');
          }
        )
      )
    );
  });

  await testAsync('APPROVAL -> APPROVED, but the external client itself then fails: the result is an honest failure, never a fabricated success', async () => {
    await withEnvConfigured(() =>
      withReclassifiedAnalyticsDataRetrieval('externally_executable', () =>
        withMockedFetch(
          async () => jsonResponse(500, { errors: [{ message: 'Internal error' }] }),
          async () => {
            const executionRequest = buildAnalyticsExecutionRequest({ analyticsCapability: 'sales', limit: 5 });
            const runApprovalTracker = { requests: [] };
            const gated = await executeSelectedCapability(executionRequest, undefined, runApprovalTracker);
            assert.strictEqual(gated.status, 'approval_required');

            const approvedRequests = decideApprovalRequest(runApprovalTracker.requests, gated.approval_request_id, {
              decision: 'approved',
              decidedBy: 'owner@example.com',
            });
            const resumedOutcome = await resumeApprovedExecution(approvedRequests[0]);

            // The orchestrator dispatch itself still "succeeds" (analyticsDataTool.js
            // never throws - see the NOTE above) - the honest failure is carried one
            // level in, on the tool's own reported status/error, never upgraded to a
            // fabricated success.
            assert.strictEqual(resumedOutcome.status, 'success');
            assert.strictEqual(resumedOutcome.data.status, 'failed');
            assert.strictEqual(resumedOutcome.data.result, null);
            assert.ok(/request failed \(500\)/.test(resumedOutcome.data.error));
          }
        )
      )
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
