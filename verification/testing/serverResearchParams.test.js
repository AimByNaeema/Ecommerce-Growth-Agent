'use strict';

// Tests for the `research_params` wiring fix in server.js's POST /run and
// POST /orchestrate handlers.
//
// Background (see server.js's own comments on validateResearchParams): both
// endpoints already had a real, already-tested `researchParams` passthrough sitting
// one call away - agent/core/orchestratorExecutionContract.js's buildPlanStep (5th
// positional argument) and runOrchestratorContract (`{ researchParams }` option) - but
// neither endpoint ever accepted or forwarded a caller-supplied `research_params`
// field, so the dashboard's own "Provide `<field>` directly" error message described a
// path that did not actually exist over HTTP. This file proves three things:
//
//   1. Omitting `research_params` reproduces today's exact existing call shape
//      (regression safety) - proven by capturing buildPlanStep/runOrchestratorContract's
//      real arguments via a monkey-patched mock, the same convention
//      verification/testing/server.test.js and orchestratorEndpoints.test.js already use.
//   2. A supplied `research_params` object is threaded through untouched.
//   3. A non-object `research_params` (string/array) is rejected with a clear 400,
//      never crashes the server, and never reaches buildPlanStep/runOrchestratorContract.
//
// Two further tests (marked REAL PIPELINE) make the same point end-to-end with NO
// mocking at all, using the real orchestratorExecutionContract.buildPlanStep/
// runOrchestratorContract and the real marketing_analysis tool - chosen because
// agent/core/marketingAgent.js's analyzeMarketingStrategy() only ever needs one
// caller-supplied string field (`marketingChannel`, see
// agent/core/specialistCapabilityRegistry.js's `marketing_strategy` task) and touches
// no network/Shopify/Gemini call at all (tools/marketingAnalysisTool.js is a pure,
// synchronous function) - so this stays fast and deterministic while still proving the
// wiring actually reaches production capability logic, not just a mock.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');

// Redirect run-history persistence to a throwaway directory, same convention as
// server.test.js/orchestratorEndpoints.test.js - never writes into this project's own
// memory/state/runs/. Read at call time, not module load, so setting it before
// createApp() below is sufficient.
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'server-research-params-test-run-history-'));

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
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
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

const MOCK_STEP = {
  request: 'test objective',
  current_task: 'test objective',
  selected_specialist: { type: 'specialist', id: 'marketing', title: 'marketing' },
  inputs: { category: 'marketing', tool_id: 'marketing_analysis', capability_id: 'marketing_strategy', input_contract: null },
  required_context: [],
  outputs: { summary: 'mocked specialist output' },
  evidence: [{ tool_id: 'marketing_analysis', status: 'success' }],
  confidence: 'high',
  tool_calls: ['marketing_analysis'],
  approvals: [],
  errors: [],
  completion_state: 'complete',
};

async function main() {
  // -----------------------------------------------------------------------------
  // /run - argument-shape regression + passthrough + validation
  // -----------------------------------------------------------------------------

  await testAsync('POST /run without research_params calls buildPlanStep with an untouched 4th arg and null researchParams (unchanged behavior)', async () => {
    let capturedArgs = null;
    await withMockedOrchestratorFns(
      {
        buildPlanStep: async (...args) => {
          capturedArgs = args;
          return MOCK_STEP;
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'marketing', objective: 'Do something real.' },
          });
          assert.strictEqual(res.status, 200);
        });
      }
    );
    assert.ok(capturedArgs, 'buildPlanStep must have been called');
    assert.strictEqual(capturedArgs[0].id, 'marketing');
    assert.strictEqual(capturedArgs[1], 'Do something real.');
    assert.strictEqual(capturedArgs[2], 'Do something real.');
    // 4th positional arg (runTokenTracker) left `undefined` so buildPlanStep's own
    // default still applies - never forced to some new value by this change.
    assert.strictEqual(capturedArgs[3], undefined);
    // 5th positional arg (researchParams) is null when omitted - identical to
    // buildPlanStep's own default and to today's pre-fix behavior.
    assert.strictEqual(capturedArgs[4], null);
  });

  await testAsync('POST /run with a research_params object threads it through as buildPlanStep\'s 5th argument, untouched', async () => {
    let capturedArgs = null;
    const suppliedResearchParams = { marketingChannel: 'email', evidence: ['past campaign data'] };
    await withMockedOrchestratorFns(
      {
        buildPlanStep: async (...args) => {
          capturedArgs = args;
          return MOCK_STEP;
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'marketing', objective: 'Plan our marketing strategy.', research_params: suppliedResearchParams },
          });
          assert.strictEqual(res.status, 200);
        });
      }
    );
    assert.ok(capturedArgs, 'buildPlanStep must have been called');
    assert.deepStrictEqual(capturedArgs[4], suppliedResearchParams);
  });

  for (const badValue of ['not-an-object', ['array', 'not', 'object'], 42]) {
    await testAsync(`POST /run rejects a non-object research_params (${JSON.stringify(badValue)}) with 400, never calling buildPlanStep`, async () => {
      let called = false;
      await withMockedOrchestratorFns(
        {
          buildPlanStep: async () => {
            called = true;
            return MOCK_STEP;
          },
        },
        async () => {
          await withServer(async (port) => {
            const res = await request(port, {
              method: 'POST',
              path: '/run',
              body: { specialist: 'marketing', objective: 'Plan our marketing strategy.', research_params: badValue },
            });
            assert.strictEqual(res.status, 400);
            const parsed = JSON.parse(res.raw);
            assert.strictEqual(typeof parsed.error, 'string');
            assert.ok(parsed.error.length > 0);
          });
        }
      );
      assert.strictEqual(called, false);
    });
  }

  // -----------------------------------------------------------------------------
  // /orchestrate - argument-shape regression + passthrough + validation
  // -----------------------------------------------------------------------------

  await testAsync('POST /orchestrate without research_params calls runOrchestratorContract with researchParams: null (unchanged behavior)', async () => {
    let capturedOptions = null;
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective, options) => {
          capturedOptions = options;
          return {
            objective,
            routing: { status: 'planned', plan: [] },
            needs_more_information: false,
            verification_status: 'unverified',
            pending_approvals: [],
          };
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Analyze store performance.' },
          });
          assert.strictEqual(res.status, 200);
        });
      }
    );
    assert.ok(capturedOptions, 'runOrchestratorContract must have been called with an options object');
    assert.strictEqual(capturedOptions.researchParams, null);
    // businessId behavior must stay exactly as it was before this change - /orchestrate
    // has never accepted/passed one, so it must remain absent here too.
    assert.strictEqual(capturedOptions.businessId, undefined);
  });

  await testAsync('POST /orchestrate with a research_params object threads it through as the researchParams option, untouched', async () => {
    let capturedOptions = null;
    const suppliedResearchParams = { marketingChannel: 'email', evidence: ['past campaign data'] };
    await withMockedOrchestratorFns(
      {
        runOrchestratorContract: async (objective, options) => {
          capturedOptions = options;
          return {
            objective,
            routing: { status: 'planned', plan: [] },
            needs_more_information: false,
            verification_status: 'unverified',
            pending_approvals: [],
          };
        },
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/orchestrate',
            body: { objective: 'Plan our marketing strategy.', research_params: suppliedResearchParams },
          });
          assert.strictEqual(res.status, 200);
        });
      }
    );
    assert.ok(capturedOptions);
    assert.deepStrictEqual(capturedOptions.researchParams, suppliedResearchParams);
    assert.strictEqual(capturedOptions.businessId, undefined);
  });

  for (const badValue of ['not-an-object', ['array', 'not', 'object'], 42]) {
    await testAsync(`POST /orchestrate rejects a non-object research_params (${JSON.stringify(badValue)}) with 400, never calling runOrchestratorContract`, async () => {
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
            const res = await request(port, {
              method: 'POST',
              path: '/orchestrate',
              body: { objective: 'Plan our marketing strategy.', research_params: badValue },
            });
            assert.strictEqual(res.status, 400);
            const parsed = JSON.parse(res.raw);
            assert.strictEqual(typeof parsed.error, 'string');
            assert.ok(parsed.error.length > 0);
          });
        }
      );
      assert.strictEqual(called, false);
    });
  }

  // -----------------------------------------------------------------------------
  // REAL PIPELINE (no mocking at all): proves research_params actually reaches and
  // satisfies a real capability's required field, using the marketing specialist's
  // marketing_strategy capability (required: ['marketingChannel'] only - see
  // agent/core/specialistCapabilityRegistry.js) and the real, synchronous,
  // network-free tools/marketingAnalysisTool.js.
  // -----------------------------------------------------------------------------

  await testAsync('REAL PIPELINE: POST /run for the marketing specialist is blocked on the missing marketingChannel field when research_params is omitted', async () => {
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/run',
        body: { specialist: 'marketing', objective: 'Plan our marketing strategy.' },
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.raw);
      assert.notStrictEqual(parsed.completion_state, 'complete');
      assert.ok(
        parsed.errors.some((e) => /marketingChannel/.test(e)),
        'the honest missing-field error must name marketingChannel'
      );
    });
  });

  await testAsync('REAL PIPELINE: POST /run for the marketing specialist completes once research_params supplies marketingChannel + evidence', async () => {
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/run',
        body: {
          specialist: 'marketing',
          objective: 'Plan our marketing strategy.',
          research_params: { marketingChannel: 'email', evidence: ['past campaign performance data'] },
        },
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.raw);
      assert.strictEqual(parsed.status, 'success');
      assert.strictEqual(parsed.completion_state, 'complete');
      assert.deepStrictEqual(parsed.errors, []);
      assert.strictEqual(parsed.outputs.status, 'success');
    });
  });

  await testAsync('REAL PIPELINE: POST /orchestrate for a marketing objective completes once research_params supplies marketingChannel + evidence', async () => {
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/orchestrate',
        body: {
          objective: 'Plan our marketing strategy.',
          research_params: { marketingChannel: 'email', evidence: ['past campaign performance data'] },
        },
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.raw);
      assert.strictEqual(parsed.routing.status, 'planned');
      assert.strictEqual(parsed.routing.plan.length, 1);
      const step = parsed.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'marketing');
      assert.strictEqual(step.completion_state, 'complete');
      assert.strictEqual(parsed.verification_status, 'passed');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
