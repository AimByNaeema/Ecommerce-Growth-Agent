'use strict';

// Tests for the Chief Orchestrator's own dashboard entry point: POST /orchestrate
// (free-text objective -> the Chief's own routing/plan, never a caller-picked
// specialist - see server.js's header comment distinguishing this from /run) and
// POST /orchestrate/approve (the human-in-the-loop decision point for any
// approval_required/externally_executable step that plan produced).
//
// Same conventions as verification/testing/server.test.js: never a real network/API
// call. runOrchestratorContract, resumeApprovedExecution, reviseStepAfterResume, and
// aggregatePlanState are monkey-patched on the shared, cached
// agent/core/orchestratorExecutionContract.js module object (server.js requires it as
// a whole object for exactly this reason) - so a running server picks up the mock.
// decideApprovalRequest/getApprovalRequestById (approvals/approvalWorkflow.js) are
// NOT mocked - they are pure, already-tested (verification/testing/approvalWorkflow.test.js)
// functions, and exercising the real ones here is what proves server.js wires them
// correctly, not just that a mock was called.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');

// /orchestrate and /orchestrate/approve now also save/update a run-history record
// (see agent/core/runHistoryStore.js) - redirected to a throwaway directory so this
// suite never writes real files into this project's own memory/state/runs/. Read at
// call time, not module load, so setting it before createApp() below is sufficient.
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-endpoints-test-run-history-'));

// security/serverAccessControl.js fails closed: with no AGENT_API_KEY set, every
// endpoint below would return 503 instead of running. Set before createApp() is
// called, exactly like RUN_HISTORY_STORE_DIR above. The rate limit is raised well
// above what any single test needs so these suites test their own behavior, never
// the limiter (that is serverAccessControl.test.js's job).
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

function withMockedOrchestratorFns(mocks, fn) {
  const saved = {};
  for (const key of Object.keys(mocks)) {
    saved[key] = orchestratorExecutionContract[key];
    orchestratorExecutionContract[key] = mocks[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(mocks)) {
        orchestratorExecutionContract[key] = saved[key];
      }
    });
}

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        // Every endpoint these suites exercise now sits behind
        // security/serverAccessControl.js's shared-secret check, so each request
        // presents the TEST_API_KEY set at the top of this file. Authentication
        // itself is covered by verification/testing/serverAccessControl.test.js -
        // these suites authenticate only so they can keep testing their own concern.
        headers: Object.assign(
          payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
          { Authorization: 'Bearer ' + TEST_API_KEY }
        ),
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A minimal but real (not fabricated-shape) execution-state step, matching
// agent/core/executionState.js's EXECUTION_STATE_FIELDS exactly - the same shape
// verification/testing/server.test.js's own /run mocks already use.
function buildStep({ approvals = [], completion_state = 'complete', outputs = null, errors = [] } = {}) {
  return {
    request: 'test objective',
    current_task: 'test objective',
    selected_specialist: { type: 'specialist', id: 'analytics_optimization', title: 'Analytics & Optimization' },
    inputs: { category: 'analytics', tool_id: 'analytics_data_retrieval', capability_id: 'sales', input_contract: null },
    required_context: [],
    outputs,
    evidence: outputs ? [{ tool_id: 'analytics_data_retrieval', status: 'success' }] : [],
    confidence: outputs ? 'high' : 'unassessed',
    tool_calls: ['analytics_data_retrieval'],
    approvals,
    errors,
    completion_state,
  };
}

async function main() {
  await testAsync('POST /orchestrate rejects an empty objective without calling the orchestrator', async () => {
    let called = false;
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => {
          called = true;
          return {};
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, { method: 'POST', path: '/orchestrate', body: { objective: '   ' } });
          assert.strictEqual(res.status, 400);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
        });
      }
    );
    assert.strictEqual(called, false);
  });

  await testAsync('POST /orchestrate returns the routing result plus a run_id when nothing needs approval', async () => {
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective) => ({
          objective,
          routing: { status: 'planned', plan: [buildStep({ outputs: { status: 'success', result: { ok: true } } })] },
          needs_more_information: false,
          verification_status: 'passed',
          pending_approvals: [],
        }),
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          assert.strictEqual(res.status, 200);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(parsed.verification_status, 'passed');
          assert.strictEqual(typeof parsed.run_id, 'string');
          assert.ok(parsed.run_id.length > 0);
          assert.deepStrictEqual(parsed.pending_approvals, []);
        });
      }
    );
  });

  await testAsync('POST /orchestrate returns a clear error when the orchestrator call throws', async () => {
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => {
          throw new Error('internal routing failure with sensitive detail');
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          assert.ok(res.status >= 400 && res.status < 600);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
          assert.ok(!parsed.error.includes('sensitive detail'));
        });
      }
    );
  });

  await testAsync('POST /orchestrate/approve rejects an unrecognized run id', async () => {
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/orchestrate/approve',
        body: { runId: 'not-a-real-run', approvalId: 'apr-1', decision: 'approved', decidedBy: 'naeema' },
      });
      assert.strictEqual(res.status, 400);
      const parsed = JSON.parse(res.raw);
      assert.strictEqual(typeof parsed.error, 'string');
    });
  });

  await testAsync('POST /orchestrate/approve rejects a missing decidedBy (every decision must be accountable)', async () => {
    const realApprovalRequest = createApprovalRequest({
      id: 'apr-1',
      classification: 'externally_executable',
      specialistId: 'analytics_optimization',
      toolId: 'analytics_data_retrieval',
      executionRequest: { objective: 'test', tool_id: 'analytics_data_retrieval' },
      reason: 'Executing this tool requires explicit approval before it can proceed.',
    });

    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => ({
          objective: 'test',
          routing: { status: 'planned', plan: [buildStep({ approvals: [{ classification: 'externally_executable', status: 'required', approval_request_id: 'apr-1' }], completion_state: 'blocked' })] },
          pending_approvals: [realApprovalRequest],
        }),
      },
      async () => {
        await withServer(async (port) => {
          const orchestrateRes = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'test' },
          });
          const runId = JSON.parse(orchestrateRes.raw).run_id;

          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate/approve',
            body: { runId, approvalId: 'apr-1', decision: 'approved', decidedBy: '  ' },
          });
          assert.strictEqual(res.status, 400);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
        });
      }
    );
  });

  await testAsync('APPROVE flow: a real decideApprovalRequest + resumeApprovedExecution round trip resolves the gated step', async () => {
    const realApprovalRequest = createApprovalRequest({
      id: 'apr-1',
      classification: 'externally_executable',
      specialistId: 'analytics_optimization',
      toolId: 'analytics_data_retrieval',
      executionRequest: { objective: 'Analyze store performance.', tool_id: 'analytics_data_retrieval' },
      reason: 'Executing this tool requires explicit approval before it can proceed.',
    });
    const gatedStep = buildStep({
      approvals: [{ classification: 'externally_executable', status: 'required', approval_request_id: 'apr-1' }],
      completion_state: 'blocked',
      outputs: null,
    });

    let resumeCalls = 0;
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => ({
          objective: 'Analyze store performance.',
          routing: { status: 'planned', plan: [gatedStep] },
          pending_approvals: [realApprovalRequest],
        }),
        resumeApprovedExecution: async (decidedRequest) => {
          resumeCalls += 1;
          assert.strictEqual(decidedRequest.status, 'approved');
          assert.strictEqual(decidedRequest.decided_by, 'naeema');
          return { status: 'success', data: { status: 'success', result: { ok: true } }, error: null, classification: 'externally_executable' };
        },
      },
      async () => {
        await withServer(async (port) => {
          const orchestrateRes = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          const runId = JSON.parse(orchestrateRes.raw).run_id;

          const approveRes = await request(port, {
            method: 'POST',
            path: '/orchestrate/approve',
            body: { runId, approvalId: 'apr-1', decision: 'approved', decidedBy: 'naeema', notes: 'Looks right.' },
          });
          assert.strictEqual(approveRes.status, 200);
          const parsed = JSON.parse(approveRes.raw);
          assert.strictEqual(parsed.approval_request.status, 'approved');
          assert.strictEqual(parsed.approval_request.decided_by, 'naeema');
          assert.strictEqual(parsed.step.completion_state, 'complete');
          assert.deepStrictEqual(parsed.step.outputs, { status: 'success', result: { ok: true } });
          assert.strictEqual(parsed.task_status, 'complete');
          assert.strictEqual(parsed.verification_status, 'passed');

          // A second decision on the same already-decided request must be refused
          // (approvals/approvalWorkflow.js's decideApprovalRequest never re-decides) -
          // proving server.js didn't quietly reset state between calls.
          const secondRes = await request(port, {
            method: 'POST',
            path: '/orchestrate/approve',
            body: { runId, approvalId: 'apr-1', decision: 'approved', decidedBy: 'naeema' },
          });
          assert.strictEqual(secondRes.status, 400);
        });
      }
    );
    assert.strictEqual(resumeCalls, 1);
  });

  await testAsync('REJECT flow: a rejected decision never calls resumeApprovedExecution\'s executor path and reports denied', async () => {
    const realApprovalRequest = createApprovalRequest({
      id: 'apr-1',
      classification: 'externally_executable',
      specialistId: 'analytics_optimization',
      toolId: 'analytics_data_retrieval',
      executionRequest: { objective: 'Analyze store performance.', tool_id: 'analytics_data_retrieval' },
      reason: 'Executing this tool requires explicit approval before it can proceed.',
    });
    const gatedStep = buildStep({
      approvals: [{ classification: 'externally_executable', status: 'required', approval_request_id: 'apr-1' }],
      completion_state: 'blocked',
      outputs: null,
    });

    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => ({
          objective: 'Analyze store performance.',
          routing: { status: 'planned', plan: [gatedStep] },
          pending_approvals: [realApprovalRequest],
        }),
        // Deliberately NOT mocked further - resumeApprovedExecution is the REAL
        // implementation here, proving a rejected decision is refused by its own
        // real logic (status !== 'approved') rather than by a mock pretending to.
      },
      async () => {
        await withServer(async (port) => {
          const orchestrateRes = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          const runId = JSON.parse(orchestrateRes.raw).run_id;

          const approveRes = await request(port, {
            method: 'POST',
            path: '/orchestrate/approve',
            body: { runId, approvalId: 'apr-1', decision: 'rejected', decidedBy: 'naeema', notes: 'Not needed.' },
          });
          assert.strictEqual(approveRes.status, 200);
          const parsed = JSON.parse(approveRes.raw);
          assert.strictEqual(parsed.approval_request.status, 'rejected');
          assert.strictEqual(parsed.step.completion_state, 'blocked');
          assert.strictEqual(parsed.step.outputs, null);
        });
      }
    );
  });

  // ---------------------------------------------------------------------------------
  // Regression coverage: the final, user-facing HTTP response must never present a
  // failed/empty specialist result as a completed answer, and must clearly name what
  // data is missing rather than staying silent about it.
  // ---------------------------------------------------------------------------------

  await testAsync('TEST D: an empty analytics result (tool ran, found zero records) is never presented as a completed answer', async () => {
    const emptyStep = buildStep({
      completion_state: 'blocked',
      outputs: { status: 'empty', result: { findings: [], limitations: ['No records were retrieved.'] }, error: null },
    });

    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective) => ({
          objective,
          routing: { status: 'planned', plan: [emptyStep] },
          needs_more_information: false,
          verification_status: 'unverified',
          pending_approvals: [],
        }),
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          assert.strictEqual(res.status, 200);
          const parsed = JSON.parse(res.raw);
          const step = parsed.routing.plan[0];
          assert.notStrictEqual(step.completion_state, 'complete');
          assert.notStrictEqual(parsed.verification_status, 'passed');
          // The step's own summary must exist and must not read like a completed
          // success (e.g. never claims the request was "completed successfully").
          assert.strictEqual(typeof step.summary, 'string');
          assert.ok(step.summary.length > 0);
          assert.ok(!/completed this request successfully/.test(step.summary));
        });
      }
    );
  });

  await testAsync('TEST E: when required data is unavailable, the response summary clearly names what is missing', async () => {
    const missingDataStep = buildStep({
      completion_state: 'failed',
      outputs: {
        status: 'failed',
        result: null,
        error:
          "'Market-connected product opportunity analysis' requires structured input this request did not supply: marketRow, productIdentity.",
      },
      errors: [
        "'Market-connected product opportunity analysis' requires structured input this request did not supply: marketRow, productIdentity.",
      ],
    });

    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective) => ({
          objective,
          routing: { status: 'planned', plan: [missingDataStep] },
          needs_more_information: false,
          verification_status: 'failed',
          pending_approvals: [],
        }),
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze my ecommerce business and identify the single biggest opportunity to increase sales.' },
          });
          assert.strictEqual(res.status, 200);
          const parsed = JSON.parse(res.raw);
          const step = parsed.routing.plan[0];
          assert.strictEqual(typeof step.summary, 'string');
          assert.ok(step.summary.length > 0, 'summary must not be blank');
          // Not a generic "done" message - it names the real missing fields.
          assert.ok(!/completed this request successfully/i.test(step.summary));
          assert.ok(/marketRow, productIdentity/.test(step.summary));
        });
      }
    );
  });

  await testAsync('POST /orchestrate saves a run-history record, retrievable via GET /history and GET /history/:runId', async () => {
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective) => ({
          objective,
          routing: { status: 'planned', plan: [buildStep({ outputs: { status: 'success', result: { ok: true } } })] },
          needs_more_information: false,
          verification_status: 'passed',
          pending_approvals: [],
        }),
      },
      async () => {
        await withServer(async (port) => {
          const orchestrateRes = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance and suggest one growth idea.' },
          });
          const runId = JSON.parse(orchestrateRes.raw).run_id;

          const listRes = await request(port, { method: 'GET', path: '/history' });
          assert.strictEqual(listRes.status, 200);
          const entry = JSON.parse(listRes.raw).runs.find((r) => r.run_id === runId);
          assert.ok(entry, 'the saved orchestrator run must appear in the history list');
          assert.strictEqual(entry.kind, 'orchestrate');
          assert.strictEqual(entry.objective, 'Analyze store performance and suggest one growth idea.');
          assert.strictEqual(entry.status, 'success');

          const detailRes = await request(port, { method: 'GET', path: '/history/' + runId });
          assert.strictEqual(detailRes.status, 200);
          const detail = JSON.parse(detailRes.raw);
          assert.strictEqual(detail.result.verification_status, 'passed');
        });
      }
    );
  });

  await testAsync('APPROVE flow re-saves the run-history record under the same run_id, reflecting the resolved outcome', async () => {
    const realApprovalRequest = createApprovalRequest({
      id: 'apr-1',
      classification: 'externally_executable',
      specialistId: 'analytics_optimization',
      toolId: 'analytics_data_retrieval',
      executionRequest: { objective: 'Analyze store performance.', tool_id: 'analytics_data_retrieval' },
      reason: 'Executing this tool requires explicit approval before it can proceed.',
    });
    const gatedStep = buildStep({
      approvals: [{ classification: 'externally_executable', status: 'required', approval_request_id: 'apr-1' }],
      completion_state: 'blocked',
      outputs: null,
    });

    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async () => ({
          objective: 'Analyze store performance.',
          routing: { status: 'planned', plan: [gatedStep] },
          pending_approvals: [realApprovalRequest],
        }),
        resumeApprovedExecution: async () => ({
          status: 'success',
          data: { status: 'success', result: { ok: true } },
          error: null,
          classification: 'externally_executable',
        }),
      },
      async () => {
        await withServer(async (port) => {
          const orchestrateRes = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          const runId = JSON.parse(orchestrateRes.raw).run_id;

          // Before the approval, the saved record still reflects the blocked step.
          const beforeDetail = JSON.parse((await request(port, { method: 'GET', path: '/history/' + runId })).raw);
          assert.strictEqual(beforeDetail.result.routing.plan[0].completion_state, 'blocked');

          await request(port, {
            method: 'POST',
            path: '/orchestrate/approve',
            body: { runId, approvalId: 'apr-1', decision: 'approved', decidedBy: 'naeema' },
          });

          const afterDetail = JSON.parse((await request(port, { method: 'GET', path: '/history/' + runId })).raw);
          assert.strictEqual(afterDetail.result.routing.plan[0].completion_state, 'complete');
          assert.strictEqual(afterDetail.status, 'success');
          assert.strictEqual(afterDetail.objective, 'Analyze store performance.', 'the original objective must be preserved across the re-save');
        });
      }
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
