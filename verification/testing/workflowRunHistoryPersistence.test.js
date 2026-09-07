'use strict';

// Restart-persistence tests for the two multi-step orchestrator surfaces:
//
//   POST /growth-workflow[/approve]
//   POST /optimization-cycle[/approve|/measure|/next]
//
// THE GAP THIS COVERS. /run and /orchestrate have written every result to
// agent/core/runHistoryStore.js since that store was built, so their audit trail, usage
// ledger and approval outcomes survive a server restart and appear under /history. These
// two surfaces - the ones that actually produce multi-stage runs with real, accountable
// human approval decisions - were never connected to it, so their record existed only in
// the process that produced it. CLAUDE.md section 3's Audit requirement ("a record of
// what actions were taken/proposed, by which specialist, and under what approval - so
// behavior is traceable after the fact") already assumes that record outlives the run.
//
// WHAT IS DELIBERATELY STILL NOT PERSISTED, and is asserted as such below: the paused
// run's `_resumeState`. It carries a non-serializable tool-result cache (a Map) and the
// live token/usage/approval trackers that ARE this run's cost controls, so a JSON copy
// would be neither resumable nor safe to trust. Continuing a run stays bound to the
// process; only the record of what happened is durable.
//
// Deliberately separate from verification/testing/workflowOrchestratorEndpoints.test.js,
// which covers those endpoints' request/response behavior. This file covers only what
// crosses a restart. Its conventions (withServer, request, withMockedFns, a throwaway
// RUN_HISTORY_STORE_DIR) are mirrored from that file on purpose.
//
// NO REAL EXTERNAL CALLS: every orchestrator function is replaced outright.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const growthWorkflowOrchestrator = require('../../agent/core/growthWorkflowOrchestrator');
const optimizationCycleOrchestrator = require('../../agent/core/optimizationCycleOrchestrator');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');

// A throwaway store directory, so this suite never writes into the project's own
// memory/state/runs/. Read at call time by runHistoryStore, so setting it before
// createApp() is sufficient.
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-history-persistence-test-'));
process.env.RUN_HISTORY_STORE_DIR = STORE_DIR;
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const { createApp } = require('../../server');
const runHistoryStore = require('../../agent/core/runHistoryStore');

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

// Each call builds a FRESH app - a new process's worth of in-memory state (new
// orchestratorRuns/growthWorkflowRuns/optimizationCycleRuns Maps). That is what makes
// "survives a restart" a real assertion here rather than a claim: nothing carries over
// except what actually reached disk.
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

function buildPendingApproval(id) {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'seo',
    toolId: 'seo_analysis',
    executionRequest: { objective: 'test', tool_id: 'seo_analysis' },
    reason: 'Executing this tool requires explicit approval before it can proceed.',
  });
}

// Shaped exactly like a real paused orchestrator response, including the live-tracker
// `_resumeState` with the Map that JSON.stringify silently guts.
function buildPausedResult(runId, approvalId) {
  return {
    status: 'workflow_paused',
    run_id: runId,
    plan: [],
    stages: [{ stage: 'research' }],
    pending_approval: buildPendingApproval(approvalId),
    audit_trail: [
      { type: 'agent', summary: 'Routed a stage.' },
      { type: 'approval', summary: 'Stage gated pending human approval.' },
    ],
    usage_ledger: [{ category: 'agent_task', quantity: 1 }],
    usage_summary: { run_id: runId, total_events: 1 },
    _resumeState: {
      runId,
      nextStageIndex: 1,
      plan: [],
      runTokenTracker: { tokensUsedThisRun: 4321 },
      runApprovalTracker: { requests: [buildPendingApproval(approvalId)] },
      runToolResultCache: { entries: new Map([['seo_analysis', { cached: true }]]) },
      runUsageTracker: { toolCalls: 3, modelCalls: 1 },
    },
  };
}

function buildCompletedResult(runId) {
  return {
    status: 'completed',
    run_id: runId,
    stages: [{ stage: 'research' }, { stage: 'action' }],
    audit_trail: [
      { type: 'agent', summary: 'Routed a stage.' },
      { type: 'approval', summary: 'Approved by a named human.' },
      { type: 'execution', summary: 'Gated stage executed after approval.' },
    ],
    usage_ledger: [{ category: 'tool_call', quantity: 1 }],
    usage_summary: { run_id: runId, total_events: 2 },
  };
}

(async () => {
  // ------------------------------------------------------------------------------
  // 1. The record itself survives a restart.
  // ------------------------------------------------------------------------------

  await testAsync('a growth-workflow run is readable through /history after a restart, with its audit trail intact', async () => {
    const runId = 'growth-persist-1';
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => buildPausedResult(runId, 'apr-persist-1') }, () =>
      withServer(async (port) => {
        const res = await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
        assert.strictEqual(res.status, 200);
      })
    );

    // A brand-new app instance: every in-memory Map is empty. Only disk carries over.
    await withServer(async (port) => {
      const listed = JSON.parse((await request(port, { method: 'GET', path: '/history' })).raw);
      const row = listed.runs.find((entry) => entry.run_id === runId);
      assert.ok(row, 'the growth-workflow run is missing from /history after a restart');
      assert.strictEqual(row.kind, 'growth_workflow');
      assert.strictEqual(row.status, 'partial');

      const detail = await request(port, { method: 'GET', path: `/history/${runId}` });
      assert.strictEqual(detail.status, 200);
      const record = JSON.parse(detail.raw);
      // The audit trail is the whole point of persisting this - CLAUDE.md section 3.
      assert.strictEqual(record.result.audit_trail.length, 2);
      assert.ok(record.result.audit_trail.some((event) => event.type === 'approval'));
      assert.strictEqual(record.result.usage_ledger.length, 1);
    });
  });

  await testAsync('an optimization-cycle run is persisted under its own kind and business_id', async () => {
    const runId = 'cycle-persist-1';
    await withMockedFns(optimizationCycleOrchestrator, { startOptimizationCycle: async () => buildPausedResult(runId, 'apr-persist-2') }, () =>
      withServer(async (port) => {
        const res = await request(port, {
          method: 'POST',
          path: '/optimization-cycle',
          body: {
            business_id: 'business-alpha',
            researchTarget: { specialistId: 'seo', forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' } },
            actionTarget: { specialistId: 'seo', forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' } },
          },
        });
        assert.strictEqual(res.status, 200);
      })
    );

    const record = runHistoryStore.getRunRecordById(runId, { storeDir: STORE_DIR });
    assert.ok(record, 'the optimization-cycle run was never saved');
    assert.strictEqual(record.kind, 'optimization_cycle');
    assert.strictEqual(record.business_id, 'business-alpha');
  });

  // ------------------------------------------------------------------------------
  // 2. What must NOT reach disk.
  // ------------------------------------------------------------------------------

  await testAsync('the saved record never contains _resumeState - not the Map cache, not the cost-control trackers', async () => {
    const runId = 'growth-no-resume-state';
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => buildPausedResult(runId, 'apr-persist-3') }, () =>
      withServer(async (port) => {
        await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
      })
    );

    const record = runHistoryStore.getRunRecordById(runId, { storeDir: STORE_DIR });
    assert.ok(record);
    assert.strictEqual('_resumeState' in record.result, false);
    // Belt and braces: nothing anywhere in the saved JSON mentions it or the token
    // tracker figure a forged resume could have reset.
    const rawJson = fs.readFileSync(path.join(STORE_DIR, `${runId}.json`), 'utf8');
    assert.ok(!rawJson.includes('_resumeState'));
    assert.ok(!rawJson.includes('4321'));
  });

  await testAsync('a paused run is still NOT resumable after a restart - the honest expired-run error, never a degraded resume', async () => {
    const runId = 'growth-not-resumable';
    await withMockedFns(growthWorkflowOrchestrator, { runGrowthWorkflow: async () => buildPausedResult(runId, 'apr-persist-4') }, () =>
      withServer(async (port) => {
        await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
      })
    );

    let resumeReached = 0;
    await withMockedFns(growthWorkflowOrchestrator, { resumeGrowthWorkflow: async () => { resumeReached += 1; return {}; } }, () =>
      withServer(async (port) => {
        const res = await request(port, {
          method: 'POST',
          path: '/growth-workflow/approve',
          body: { run_id: runId, approvalId: 'apr-persist-4', decision: 'approved', decidedBy: 'a-named-human' },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(JSON.parse(res.raw).error, 'Unrecognized or expired run id.');
      })
    );
    assert.strictEqual(resumeReached, 0, 'a restarted server must never resume a run from a saved record');
  });

  // ------------------------------------------------------------------------------
  // 3. A continuation updates the same record rather than creating a second one.
  // ------------------------------------------------------------------------------

  await testAsync('an approval decision re-saves the SAME run_id, keeping created_at and updating the outcome', async () => {
    const runId = 'growth-continuation';
    let firstCreatedAt = null;

    await withMockedFns(
      growthWorkflowOrchestrator,
      {
        runGrowthWorkflow: async () => buildPausedResult(runId, 'apr-persist-5'),
        resumeGrowthWorkflow: async () => buildCompletedResult(runId),
      },
      () =>
        withServer(async (port) => {
          await request(port, { method: 'POST', path: '/growth-workflow', body: {} });
          const paused = runHistoryStore.getRunRecordById(runId, { storeDir: STORE_DIR });
          assert.strictEqual(paused.status, 'partial');
          firstCreatedAt = paused.created_at;

          const res = await request(port, {
            method: 'POST',
            path: '/growth-workflow/approve',
            body: { run_id: runId, approvalId: 'apr-persist-5', decision: 'approved', decidedBy: 'a-named-human' },
          });
          assert.strictEqual(res.status, 200);
        })
    );

    const finalRecord = runHistoryStore.getRunRecordById(runId, { storeDir: STORE_DIR });
    assert.strictEqual(finalRecord.status, 'success');
    assert.strictEqual(finalRecord.created_at, firstCreatedAt, 'a continuation must not restart the record');
    assert.ok(finalRecord.updated_at, 'a re-saved record must record when it was updated');
    assert.ok(
      new Date(finalRecord.updated_at).getTime() >= new Date(finalRecord.created_at).getTime(),
      'updated_at must not predate created_at'
    );
    // The post-approval audit trail replaced the paused snapshot - one record per run,
    // always the latest known state.
    assert.strictEqual(finalRecord.result.audit_trail.length, 3);
    assert.ok(finalRecord.result.audit_trail.some((event) => event.summary.includes('after approval')));

    // Exactly one file for this run, never two conflicting copies.
    const files = fs.readdirSync(STORE_DIR).filter((name) => name === `${runId}.json`);
    assert.strictEqual(files.length, 1);
  });

  // ------------------------------------------------------------------------------
  // 4. Business isolation across the restart boundary.
  // ------------------------------------------------------------------------------

  await testAsync('/history?business_id= returns only that business\'s runs after a restart', async () => {
    await withMockedFns(optimizationCycleOrchestrator, { startOptimizationCycle: async () => buildPausedResult('cycle-business-beta', 'apr-persist-6') }, () =>
      withServer(async (port) => {
        await request(port, {
          method: 'POST',
          path: '/optimization-cycle',
          body: {
            business_id: 'business-beta',
            researchTarget: { specialistId: 'seo', forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' } },
            actionTarget: { specialistId: 'seo', forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' } },
          },
        });
      })
    );

    await withServer(async (port) => {
      const scoped = JSON.parse((await request(port, { method: 'GET', path: '/history?business_id=business-beta' })).raw);
      assert.deepStrictEqual(scoped.runs.map((entry) => entry.run_id), ['cycle-business-beta']);

      // business-alpha's run (saved earlier in this file) must not appear in beta's scope,
      // and neither must any unattributed run.
      assert.ok(!scoped.runs.some((entry) => entry.business_id !== 'business-beta'));

      const alphaScoped = JSON.parse((await request(port, { method: 'GET', path: '/history?business_id=business-alpha' })).raw);
      assert.ok(alphaScoped.runs.some((entry) => entry.run_id === 'cycle-persist-1'));
      assert.ok(!alphaScoped.runs.some((entry) => entry.run_id === 'cycle-business-beta'));

      // Unscoped listing still shows everything - existing callers are unchanged.
      const all = JSON.parse((await request(port, { method: 'GET', path: '/history' })).raw);
      assert.ok(all.runs.length >= scoped.runs.length + alphaScoped.runs.length);
    });
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('workflowRunHistoryPersistence.test.js'));
  });

  fs.rmSync(STORE_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

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
