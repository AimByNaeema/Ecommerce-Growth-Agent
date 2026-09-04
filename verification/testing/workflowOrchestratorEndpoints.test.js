'use strict';

// Tests for the HTTP surface over the two previously-unreachable orchestrators:
//
//   POST /growth-workflow[/approve]      -> agent/core/growthWorkflowOrchestrator.js
//   POST /optimization-cycle[/approve|/measure|/next]
//                                        -> agent/core/optimizationCycleOrchestrator.js
//
// Deliberately named apart from verification/testing/orchestratorEndpoints.test.js,
// which covers a DIFFERENT thing: /orchestrate, the Chief's own free-text routing
// entry point. Its conventions (testAsync, request(), withServer(), a monkey-patch
// helper over the shared cached module object) are mirrored here on purpose.
//
// NO REAL EXTERNAL CALLS ANYWHERE. Most tests replace the orchestrator functions
// outright. The one test that runs an orchestrator for real (the shared-infrastructure
// proof at the bottom) pins seo_analysis, whose executor is tools/seoAnalysisTool.js ->
// agent/core/seoAgent.js - pure local logic with no network, no model, and no store
// access. Nothing here can reach Gemini, Claude, Shopify, or an ad platform.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const growthWorkflowOrchestrator = require('../../agent/core/growthWorkflowOrchestrator');
const optimizationCycleOrchestrator = require('../../agent/core/optimizationCycleOrchestrator');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');

// Same reasons as orchestratorEndpoints.test.js: a throwaway run-history directory so
// this suite never writes into the project's own memory/state/runs/, and an
// AGENT_API_KEY so security/serverAccessControl.js's fail-closed check does not turn
// every request below into a 503. Both read at call time, so setting them before
// createApp() is sufficient. The rate limit is raised far above what this suite needs
// so it tests its own concern, never the limiter (serverAccessControl.test.js's job).
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-endpoints-test-run-history-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const { createApp } = require('../../server');

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

// server.js requires both orchestrators as whole module objects precisely so this
// works - the running server picks up the substitution because it reads the property
// at call time, not at require time.
function withMockedFns(moduleObject, mocks, fn) {
  const saved = {};
  for (const key of Object.keys(mocks)) {
    saved[key] = moduleObject[key];
    moduleObject[key] = mocks[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(mocks)) {
        moduleObject[key] = saved[key];
      }
    });
}

function request(port, { method, path: reqPath, body, authenticated = true }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    if (authenticated) headers.Authorization = `Bearer ${TEST_API_KEY}`;

    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A real approvals/approvalWorkflow.js request record - never a fabricated shape, so
// the real decideApprovalRequest() below actually accepts it.
function buildPendingApproval(id = 'apr-workflow-1') {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'seo',
    toolId: 'seo_analysis',
    executionRequest: { objective: 'test', tool_id: 'seo_analysis' },
    reason: 'Executing this tool requires explicit approval before it can proceed.',
  });
}

// A paused response shaped exactly like the real orchestrators' own paused responses,
// including the live-tracker `_resumeState` neither of them ever intends to send over
// the wire.
function buildPausedResult(runId, { tokensUsedThisRun = 0, approvalId = 'apr-workflow-1' } = {}) {
  return {
    status: 'workflow_paused',
    run_id: runId,
    business_id: null,
    plan: [],
    pending_approval: buildPendingApproval(approvalId),
    audit_trail: [{ type: 'agent', summary: 'Routed a stage.' }],
    usage_ledger: [{ category: 'agent_task', quantity: 1 }],
    usage_summary: { run_id: runId, total_events: 1 },
    _resumeState: {
      runId,
      nextStageIndex: 1,
      plan: [],
      runTokenTracker: { tokensUsedThisRun },
      runApprovalTracker: { requests: [buildPendingApproval(approvalId)] },
      runToolResultCache: { entries: new Map() },
      runUsageTracker: { toolCalls: 3, modelCalls: 1 },
    },
  };
}

// The two well-formed optimization-cycle targets used throughout. seo/seo_analysis is
// a real, permitted pairing (agent/core/toolPermissions.js); seo/analytics_data_retrieval
// is a real, DENIED one - the SEO specialist does not own the analytics category.
const PERMITTED_TARGET = {
  specialistId: 'seo',
  objective: 'Run on-page SEO analysis for this product listing.',
  forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' },
};
const DENIED_TARGET = {
  specialistId: 'seo',
  objective: 'Retrieve store sales analytics.',
  forcedSelection: { toolId: 'analytics_data_retrieval', capabilityId: 'sales' },
};

const VALID_EXPERIMENT = {
  experimentId: 'test-exp-1',
  domain: 'pricing',
  subjectReference: '(Example) Jacket X',
  hypothesis: 'A lower price increases conversion (placeholder).',
  variable: 'list_price',
  control: { description: 'Current price (placeholder).', evidence: [] },
  variant: { description: 'Test price (placeholder).', evidence: [] },
  targetMetric: 'conversion_rate',
  duration: { plannedDurationDays: 14 },
  successCriteria: 'Net revenue improves (placeholder).',
};

// Every endpoint this task adds, with a minimal valid-shaped body.
const ALL_NEW_ENDPOINTS = [
  { path: '/growth-workflow', body: {} },
  { path: '/growth-workflow/approve', body: { run_id: 'x', approvalId: 'a', decision: 'approved', decidedBy: 'tester' } },
  { path: '/optimization-cycle', body: { researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT } },
  { path: '/optimization-cycle/approve', body: { run_id: 'x', approvalId: 'a', decision: 'approved', decidedBy: 'tester' } },
  { path: '/optimization-cycle/measure', body: { run_id: 'x', measurement: {}, analysis: {} } },
  { path: '/optimization-cycle/next', body: { run_id: 'x', researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT } },
];

(async () => {
  // --- 1. Authentication: no new unauthenticated route exposes either orchestrator ---

  await testAsync('every new endpoint rejects an unauthenticated request with 401', async () => {
    await withServer(async (port) => {
      for (const endpoint of ALL_NEW_ENDPOINTS) {
        const res = await request(port, { method: 'POST', path: endpoint.path, body: endpoint.body, authenticated: false });
        assert.strictEqual(res.status, 401, `${endpoint.path} returned ${res.status}, not 401`);
        // The response must never hint at the configured key.
        assert.ok(!res.raw.includes(TEST_API_KEY), `${endpoint.path} leaked the API key`);
      }
    });
  });

  await testAsync('an unauthenticated request never reaches either orchestrator at all', async () => {
    let reached = 0;
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => { reached += 1; return {}; } }, () =>
      withMockedFns(optimizationCycleOrchestrator, { startOptimizationCycle: async () => { reached += 1; return {}; } }, () =>
        withServer(async (port) => {
          await request(port, { method: 'POST', path: '/growth-workflow', body: {}, authenticated: false });
          await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: { researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT },
            authenticated: false,
          });
          assert.strictEqual(reached, 0, 'an orchestrator ran for an unauthenticated request');
        })
      )
    );
  });

  // --- 2. An authorized request reaches the correct EXISTING orchestrator ---

  await testAsync('/growth-workflow calls the real runGrowthWorkflow with the caller\'s own business id and stage inputs', async () => {
    let received = null;
    const stageInputs = { research: { markets: [] }, product: { productIdentity: '(Example) Jacket X' } };

    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async (businessId, inputs) => {
          received = { businessId, inputs };
          return { status: 'completed', run_id: 'growth-run-1', plan: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/growth-workflow',
            body: { business_id: 'business-42', stage_inputs: stageInputs },
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(JSON.parse(res.raw).status, 'completed');
          assert.strictEqual(received.businessId, 'business-42');
          // Threaded through untouched - the endpoint never rewrites, defaults, or
          // invents a caller's real business input.
          assert.deepStrictEqual(received.inputs, stageInputs);
        })
    );
  });

  await testAsync('/optimization-cycle calls the real startOptimizationCycle with the caller\'s own targets and experiment', async () => {
    let received = null;
    await withMockedFns(
      optimizationCycleOrchestrator,
      {
        startOptimizationCycle: async (args) => {
          received = args;
          return { status: 'awaiting_measurement', run_id: 'optimization-cycle-1', iterations: [], lessons: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: {
              researchTarget: PERMITTED_TARGET,
              researchParams: { productReference: '(Example) Jacket X' },
              experiment: VALID_EXPERIMENT,
              actionTarget: PERMITTED_TARGET,
              actionParams: { productReference: '(Example) Jacket X' },
            },
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(JSON.parse(res.raw).status, 'awaiting_measurement');
          assert.deepStrictEqual(received.researchTarget, PERMITTED_TARGET);
          assert.deepStrictEqual(received.actionTarget, PERMITTED_TARGET);
          assert.deepStrictEqual(received.experiment, VALID_EXPERIMENT);
          assert.deepStrictEqual(received.researchParams, { productReference: '(Example) Jacket X' });
        })
    );
  });

  await testAsync('/optimization-cycle/measure forwards the caller\'s real measurement, analysis and lesson unchanged', async () => {
    let received = null;
    const measurement = { controlValue: '1.9%', variantValue: '2.4%', observedEffect: 'up', evidence: ['(placeholder)'] };
    const analysis = { outcome: 'ship_variant', rationale: 'clears the bar', evidence: ['(placeholder)'], actionClassification: 'recommendation' };
    const lesson = { lesson: 'A lower price works here.', confidence: 'medium' };

    await withMockedFns(
      optimizationCycleOrchestrator,
      {
        startOptimizationCycle: async () => buildPausedResult('optimization-cycle-measure'),
        recordMeasurementAndAnalyze: async (state, args) => {
          received = { state, args };
          return { status: 'completed', run_id: 'optimization-cycle-measure', iterations: [], lessons: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: { researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT },
          });
          const res = await request(port, {
            method: 'POST',
            path: '/optimization-cycle/measure',
            body: { run_id: 'optimization-cycle-measure', measurement, analysis, lesson },
          });
          assert.strictEqual(res.status, 200);
          assert.deepStrictEqual(received.args, { measurement, analysis, lesson });
          // The state came from the server's own store, not the request body.
          assert.strictEqual(received.state.runId, 'optimization-cycle-measure');
        })
    );
  });

  // --- 3. Authenticated is NOT automatically authorized ---

  await testAsync('a target naming a tool its specialist does not own is refused 403 before the orchestrator runs', async () => {
    let reached = 0;
    await withMockedFns(
      optimizationCycleOrchestrator,
      { startOptimizationCycle: async () => { reached += 1; return {}; } },
      () =>
        withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: { researchTarget: DENIED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT },
          });
          assert.strictEqual(res.status, 403);
          // agent/core/toolPermissions.js's own reason, not an invented one.
          assert.match(JSON.parse(res.raw).error, /not permitted to use tools in category 'analytics'/);
          // The whole point: no tool call, no token, no audit entry was spent deciding
          // this - the deterministic permission check refused it up front.
          assert.strictEqual(reached, 0, 'the orchestrator ran despite a denied target');
        })
    );
  });

  await testAsync('an unknown tool id is refused, and a denied ACTION target is caught too', async () => {
    await withServer(async (port) => {
      const unknown = await request(port, {
        method: 'POST',
        path: '/optimization-cycle',
        body: {
          researchTarget: { ...PERMITTED_TARGET, forcedSelection: { toolId: 'no_such_tool', capabilityId: 'x' } },
          actionTarget: PERMITTED_TARGET,
          experiment: VALID_EXPERIMENT,
        },
      });
      assert.strictEqual(unknown.status, 403);

      const deniedAction = await request(port, {
        method: 'POST',
        path: '/optimization-cycle',
        body: { researchTarget: PERMITTED_TARGET, actionTarget: DENIED_TARGET, experiment: VALID_EXPERIMENT },
      });
      assert.strictEqual(deniedAction.status, 403);
      assert.match(JSON.parse(deniedAction.raw).error, /actionTarget|analytics/);
    });
  });

  await testAsync('a malformed target, or an unknown stage_inputs key, is rejected 400 without running anything', async () => {
    let reached = 0;
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => { reached += 1; return {}; } }, () =>
      withMockedFns(optimizationCycleOrchestrator, { startOptimizationCycle: async () => { reached += 1; return {}; } }, () =>
        withServer(async (port) => {
          const noToolId = await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: { researchTarget: { specialistId: 'seo', objective: 'x' }, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT },
          });
          assert.strictEqual(noToolId.status, 400);
          assert.match(JSON.parse(noToolId.raw).error, /forcedSelection\.toolId/);

          // A typo'd stage key would otherwise silently drop that stage's real input
          // and let the workflow run on defaults - an honest 400 instead.
          const badStage = await request(port, {
            method: 'POST',
            path: '/growth-workflow',
            body: { stage_inputs: { reserch: {} } },
          });
          assert.strictEqual(badStage.status, 400);
          assert.match(JSON.parse(badStage.raw).error, /reserch/);
          assert.match(JSON.parse(badStage.raw).error, /research/);

          const badType = await request(port, { method: 'POST', path: '/growth-workflow', body: { stage_inputs: [] } });
          assert.strictEqual(badType.status, 400);

          assert.strictEqual(reached, 0, 'an orchestrator ran on invalid input');
        })
      )
    );
  });

  // --- 4. Cost/token controls are enforced across a resumed run ---

  await testAsync('a resume uses the SERVER-held trackers - a forged _resumeState in the body is ignored', async () => {
    let receivedState = null;

    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async () => buildPausedResult('growth-run-budget', { tokensUsedThisRun: 4321 }),
        resumeGrowthWorkflow: async (decidedRequest, state) => {
          receivedState = state;
          return { status: 'completed', run_id: 'growth-run-budget', plan: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          await request(port, { method: 'POST', path: '/growth-workflow', body: {} });

          await request(port, {
            method: 'POST',
            path: '/growth-workflow/approve',
            body: {
              run_id: 'growth-run-budget',
              approvalId: 'apr-workflow-1',
              decision: 'approved',
              decidedBy: 'tester',
              // A caller attempting to zero this run's spend and hand itself a fresh
              // budget. It must have no effect whatsoever.
              _resumeState: { runTokenTracker: { tokensUsedThisRun: 0 }, runUsageTracker: { toolCalls: 0, modelCalls: 0 } },
            },
          });

          assert.strictEqual(
            receivedState.runTokenTracker.tokensUsedThisRun,
            4321,
            'the forged _resumeState overrode the run\'s real accumulated token spend'
          );
          assert.strictEqual(receivedState.runUsageTracker.toolCalls, 3, 'the run\'s real tool-call count was reset');
        })
    );
  });

  await testAsync('an unknown or already-finished run id cannot be resumed', async () => {
    let reached = 0;
    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async () => ({ status: 'completed', run_id: 'growth-run-done', plan: [], audit_trail: [], usage_ledger: [], usage_summary: {} }),
        resumeGrowthWorkflow: async () => { reached += 1; return {}; },
      },
      () =>
        withServer(async (port) => {
          const body = { approvalId: 'apr-workflow-1', decision: 'approved', decidedBy: 'tester' };

          const unknown = await request(port, { method: 'POST', path: '/growth-workflow/approve', body: { ...body, run_id: 'never-existed' } });
          assert.strictEqual(unknown.status, 400);

          // A completed run keeps no resume state, so it cannot be resumed either.
          await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
          const finished = await request(port, { method: 'POST', path: '/growth-workflow/approve', body: { ...body, run_id: 'growth-run-done' } });
          assert.strictEqual(finished.status, 400);

          assert.strictEqual(reached, 0, 'a resume ran for a run with no held state');
        })
    );
  });

  // --- 5. Approval gating is preserved, and audit information is produced ---

  await testAsync('the real decideApprovalRequest gates the resume: a bad decision or missing decidedBy never resumes', async () => {
    let reached = 0;
    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async () => buildPausedResult('growth-run-gate'),
        resumeGrowthWorkflow: async () => { reached += 1; return {}; },
      },
      () =>
        withServer(async (port) => {
          await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
          const base = { run_id: 'growth-run-gate', approvalId: 'apr-workflow-1' };

          const noDecider = await request(port, { method: 'POST', path: '/growth-workflow/approve', body: { ...base, decision: 'approved' } });
          assert.strictEqual(noDecider.status, 400);
          assert.match(JSON.parse(noDecider.raw).error, /decidedBy/);

          const badDecision = await request(port, { method: 'POST', path: '/growth-workflow/approve', body: { ...base, decision: 'maybe', decidedBy: 'tester' } });
          assert.strictEqual(badDecision.status, 400);

          const wrongId = await request(port, { method: 'POST', path: '/growth-workflow/approve', body: { ...base, approvalId: 'apr-nope', decision: 'approved', decidedBy: 'tester' } });
          assert.strictEqual(wrongId.status, 400);
          // approvalWorkflow.js's own specific message, surfaced rather than replaced.
          assert.match(JSON.parse(wrongId.raw).error, /found no request with id/);

          assert.strictEqual(reached, 0, 'a stage resumed without a valid, accountable decision');
        })
    );
  });

  await testAsync('an approved decision is recorded on the run\'s own tracker and passed to the real resume function', async () => {
    let decided = null;
    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async () => buildPausedResult('growth-run-approve'),
        resumeGrowthWorkflow: async (decidedRequest, state) => {
          decided = { decidedRequest, state };
          return { status: 'completed', run_id: 'growth-run-approve', plan: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
          const res = await request(port, {
            method: 'POST',
            path: '/growth-workflow/approve',
            body: { run_id: 'growth-run-approve', approvalId: 'apr-workflow-1', decision: 'approved', decidedBy: 'a.human@example.com', notes: 'ok' },
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(decided.decidedRequest.status, 'approved');
          assert.strictEqual(decided.decidedRequest.decided_by, 'a.human@example.com');
          // Written back onto the tracker the orchestrator itself will consult.
          assert.strictEqual(decided.state.runApprovalTracker.requests[0].status, 'approved');
        })
    );
  });

  await testAsync('a rejected decision is still recorded and handed to the orchestrator, which decides the outcome', async () => {
    let decided = null;
    await withMockedFns(
      optimizationCycleOrchestrator,
      {
        startOptimizationCycle: async () => buildPausedResult('optimization-cycle-reject'),
        resumeAfterApproval: async (decidedRequest) => {
          decided = decidedRequest;
          return { status: 'stopped', stop_reason: 'approval_rejected', run_id: 'optimization-cycle-reject', iterations: [], lessons: [], audit_trail: [], usage_ledger: [], usage_summary: {} };
        },
      },
      () =>
        withServer(async (port) => {
          await request(port, {
            method: 'POST',
            path: '/optimization-cycle',
            body: { researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT },
          });
          const res = await request(port, {
            method: 'POST',
            path: '/optimization-cycle/approve',
            body: { run_id: 'optimization-cycle-reject', approvalId: 'apr-workflow-1', decision: 'rejected', decidedBy: 'tester' },
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(decided.status, 'rejected');
          // The endpoint reports the orchestrator's own outcome, never its own verdict.
          assert.strictEqual(JSON.parse(res.raw).stop_reason, 'approval_rejected');
        })
    );
  });

  await testAsync('responses carry the orchestrator\'s audit trail and usage ledger, and never its internal _resumeState', async () => {
    await withMockedFns(
      growthWorkflowOrchestrator,
      { runGrowthWorkflow: async () => buildPausedResult('growth-run-audit') },
      () =>
        withServer(async (port) => {
          const res = await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
          assert.strictEqual(res.status, 200);
          const body = JSON.parse(res.raw);

          assert.ok(Array.isArray(body.audit_trail) && body.audit_trail.length > 0, 'no audit trail was returned');
          assert.ok(Array.isArray(body.usage_ledger) && body.usage_ledger.length > 0, 'no usage ledger was returned');
          assert.ok(body.usage_summary, 'no usage summary was returned');
          assert.strictEqual(body.status, 'workflow_paused');
          assert.ok(body.pending_approval, 'the pending approval was dropped');

          // The live-tracker state must never cross the wire: it is unserializable
          // (its tool-result cache is a Map, which JSON.stringify silently empties)
          // and accepting one back would let a caller reset this run's budgets.
          assert.strictEqual('_resumeState' in body, false, '_resumeState was returned to the client');
          assert.ok(!res.raw.includes('_resumeState'));
        })
    );
  });

  // --- 6. Orchestrator errors are returned safely ---

  await testAsync('a throwing orchestrator yields a generic 502 that leaks no path, stack, or internal detail', async () => {
    const leakyError = new Error('ENOENT: no such file C:\\Users\\Admin\\secret\\.env AGENT_API_KEY=hunter2');
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => { throw leakyError; } }, () =>
      withMockedFns(optimizationCycleOrchestrator, { startOptimizationCycle: async () => { throw leakyError; } }, () =>
        withServer(async (port) => {
          for (const reqSpec of [
            { path: '/growth-workflow', body: {} },
            { path: '/optimization-cycle', body: { researchTarget: PERMITTED_TARGET, actionTarget: PERMITTED_TARGET, experiment: VALID_EXPERIMENT } },
          ]) {
            const res = await request(port, { method: 'POST', path: reqSpec.path, body: reqSpec.body });
            assert.strictEqual(res.status, 502, `${reqSpec.path} returned ${res.status}`);
            assert.ok(!res.raw.includes('ENOENT'), `${reqSpec.path} leaked the raw error`);
            assert.ok(!res.raw.includes('C:\\'), `${reqSpec.path} leaked a filesystem path`);
            assert.ok(!res.raw.includes('hunter2'), `${reqSpec.path} leaked a secret`);
            assert.ok(!res.raw.includes('at '), `${reqSpec.path} leaked a stack frame`);
            assert.deepStrictEqual(Object.keys(JSON.parse(res.raw)), ['error']);
          }
        })
      )
    );
  });

  // --- 7. No duplicate orchestrator was created ---

  await testAsync('server.js delegates to both existing orchestrator modules and reimplements neither', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

    assert.ok(source.includes("require('./agent/core/growthWorkflowOrchestrator')"), 'server.js does not use the existing growth workflow orchestrator');
    assert.ok(source.includes("require('./agent/core/optimizationCycleOrchestrator')"), 'server.js does not use the existing optimization cycle orchestrator');

    // Checked against CODE only - server.js's comments legitimately discuss the shared
    // machinery they defer to (TOOL_EXECUTORS, buildPlanStep, ...), and matching prose
    // would make this assert the wrong thing.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');

    // A second orchestration layer would have to declare its own stage list, its own
    // stop-reason set, or reach the tool dispatch table itself. None of that is here.
    for (const forbidden of ['STAGE_DEFINITIONS', 'TOOL_EXECUTORS', 'STOP_REASONS', 'requiresApproval(']) {
      assert.ok(!code.includes(forbidden), `server.js appears to reimplement shared execution logic: found "${forbidden}"`);
    }
    // server.js calls buildPlanStep exactly twice - /ask and /run, both of which
    // predate this surface. The six workflow/cycle endpoints add ZERO direct dispatch
    // calls of their own: every stage they run is dispatched by the orchestrator
    // modules. A third call here would mean an endpoint had begun executing stages
    // itself instead of delegating.
    assert.strictEqual(
      code.split('buildPlanStep(').length - 1,
      2,
      'server.js dispatches steps itself beyond the pre-existing /ask and /run calls'
    );
    // checkToolAccess IS called here - but only as the deterministic pre-check that
    // refuses an unauthorized target before any spend. It is the project's existing
    // gate, reused, and buildPlanStep still runs its own identical check underneath.
    assert.ok(code.includes('checkToolAccess({'), 'server.js does not apply the existing permission gate to caller-supplied targets');
    // The stage list is read from the orchestrator's own export, never copied.
    assert.ok(source.includes('growthWorkflowOrchestrator.STAGE_KEYS'), 'server.js does not reuse the orchestrator\'s own STAGE_KEYS');

    // Both orchestrators must still be the ones going through the shared execution
    // contract - if either stopped doing so, these endpoints would be exposing a
    // side channel around permissions/audit/cost.
    for (const file of ['growthWorkflowOrchestrator.js', 'optimizationCycleOrchestrator.js']) {
      const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', file), 'utf8');
      assert.ok(orchestratorSource.includes("require('./orchestratorExecutionContract')"), `${file} no longer uses the shared execution contract`);
      assert.ok(orchestratorSource.includes('buildPlanStep('), `${file} no longer dispatches through buildPlanStep`);
    }
  });

  // --- 9. The endpoints really do run through the shared infrastructure ---

  await testAsync('an UNMOCKED /optimization-cycle run reaches the real permission gate, tool dispatch, audit trail and usage ledger', async () => {
    // Nothing is mocked here. seo_analysis's executor is tools/seoAnalysisTool.js ->
    // agent/core/seoAgent.js: pure local logic, no network, no model call, no store
    // access - so this exercises the genuine shared stack without any external call.
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/optimization-cycle',
        body: {
          researchTarget: PERMITTED_TARGET,
          researchParams: { productReference: '(Example) Jacket X' },
          experiment: VALID_EXPERIMENT,
          actionTarget: PERMITTED_TARGET,
          actionParams: { productReference: '(Example) Jacket X' },
        },
      });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.raw);

      const researchStep = (body.iterations[0] && body.iterations[0].research_step) || null;
      assert.ok(researchStep, 'the real cycle produced no research step');

      // The pinned tool really was the one dispatched - proving forcedSelection was
      // honored through buildPlanStep rather than re-scored or bypassed.
      assert.strictEqual(researchStep.inputs.tool_id, 'seo_analysis');
      assert.strictEqual(researchStep.inputs.capability_id, 'product_seo');
      assert.deepStrictEqual(researchStep.tool_calls, ['seo_analysis']);
      // Genuine output from the real tool, not a stub.
      assert.strictEqual(researchStep.outputs.result.capability, 'product_seo');

      // audit/auditTrail.js and usage/usageTracker.js recorded the run for real.
      const auditTypes = body.audit_trail.map((event) => event.type);
      assert.ok(auditTypes.includes('tools'), 'no permission/tool-selection audit event was produced');
      assert.ok(auditTypes.includes('execution'), 'no execution audit event was produced');
      assert.strictEqual(body.usage_summary.by_category.tool_call.count, 1);

      assert.strictEqual('_resumeState' in body, false);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
