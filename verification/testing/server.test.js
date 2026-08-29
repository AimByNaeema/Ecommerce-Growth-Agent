'use strict';

const assert = require('node:assert');
const http = require('node:http');

const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { createApp } = require('../../server');

// This test never makes a real network/API call. Instead of mocking global.fetch
// (this repo's usual convention - see aiProviderSelector.test.js), it monkey-patches
// aiProviderSelector.sendMessage directly: Node caches required modules by resolved
// path, so server.js's own require('../agent/core/aiProviderSelector') returns this
// same object, meaning the patch is what the running server actually calls. That
// avoids a collision that mocking global.fetch would cause here, since the test's own
// HTTP requests to the locally started server would go through the same global.
//
// /run tests mock orchestratorExecutionContract.buildPlanStep the same way - never
// invoking the real tool/Shopify pipeline underneath it.

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

function withMockedSendMessage(mockImpl, fn) {
  const saved = aiProviderSelector.sendMessage;
  aiProviderSelector.sendMessage = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      aiProviderSelector.sendMessage = saved;
    });
}

function withMockedBuildPlanStep(mockImpl, fn) {
  const saved = orchestratorExecutionContract.buildPlanStep;
  orchestratorExecutionContract.buildPlanStep = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      orchestratorExecutionContract.buildPlanStep = saved;
    });
}

const DASHBOARD_SPECIALIST_IDS = [
  'research',
  'product',
  'seo',
  'listing',
  'marketing',
  'social_advertising',
  'analytics',
];

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

async function main() {
  await testAsync('GET / serves the dashboard HTML', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'GET', path: '/' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.raw.includes('Studio Assistant — Digital Studio By Naeema'));
    });
  });

  await testAsync('POST /ask returns a reply on success', async () => {
    await withMockedSendMessage(
      async () => ({ text: 'mocked reply' }),
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'What products do we sell?' },
          });
          assert.strictEqual(res.status, 200);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(parsed.reply, 'mocked reply');
        });
      }
    );
  });

  await testAsync('POST /ask returns a clear error when sendMessage fails', async () => {
    await withMockedSendMessage(
      async () => {
        throw new Error('ANTHROPIC_API_KEY is not set.');
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'What products do we sell?' },
          });
          assert.ok(res.status >= 400 && res.status < 600);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
          assert.ok(parsed.error.length > 0);
          assert.ok(!parsed.error.includes('ANTHROPIC_API_KEY'));
          assert.ok(!('reply' in parsed));
        });
      }
    );
  });

  await testAsync('POST /ask rejects an empty message without calling sendMessage', async () => {
    let called = false;
    await withMockedSendMessage(
      async () => {
        called = true;
        return { text: 'should not be reached' };
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, { method: 'POST', path: '/ask', body: { message: '  ' } });
          assert.strictEqual(res.status, 400);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
        });
      }
    );
    assert.strictEqual(called, false);
  });

  for (const specialistId of DASHBOARD_SPECIALIST_IDS) {
    await testAsync(`POST /run returns a success result for specialist "${specialistId}"`, async () => {
      await withMockedBuildPlanStep(
        async () => ({
          request: 'test objective',
          current_task: 'test objective',
          selected_specialist: { type: 'specialist', id: specialistId, title: specialistId },
          inputs: { category: 'test', tool_id: 'test_tool', capability_id: null, input_contract: null },
          required_context: [],
          outputs: { summary: 'mocked specialist output' },
          evidence: [{ tool_id: 'test_tool', status: 'success' }],
          confidence: 'high',
          tool_calls: ['test_tool'],
          approvals: [],
          errors: [],
          completion_state: 'complete',
        }),
        async () => {
          await withServer(async (port) => {
            const res = await request(port, {
              method: 'POST',
              path: '/run',
              body: { specialist: specialistId, objective: 'Do something real.' },
            });
            assert.strictEqual(res.status, 200);
            const parsed = JSON.parse(res.raw);
            assert.strictEqual(parsed.status, 'success');
            assert.strictEqual(parsed.completion_state, 'complete');
            assert.deepStrictEqual(parsed.outputs, { summary: 'mocked specialist output' });
          });
        }
      );
    });
  }

  await testAsync('POST /run returns status "partial" when the step did not complete', async () => {
    await withMockedBuildPlanStep(
      async () => ({
        request: 'test objective',
        current_task: 'test objective',
        selected_specialist: { type: 'specialist', id: 'research', title: 'research' },
        inputs: null,
        required_context: [],
        outputs: null,
        evidence: [],
        confidence: 'unassessed',
        tool_calls: [],
        approvals: [],
        errors: ['No tool is registered yet for this capability.'],
        completion_state: 'blocked',
      }),
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'research', objective: 'Do something.' },
          });
          assert.strictEqual(res.status, 200);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(parsed.status, 'partial');
        });
      }
    );
  });

  await testAsync('POST /run returns a clear error for an unrecognized specialist id', async () => {
    let called = false;
    await withMockedBuildPlanStep(
      async () => {
        called = true;
        return { completion_state: 'complete' };
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'not_a_real_specialist', objective: 'Do something.' },
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

  await testAsync('POST /run returns a clear error when the orchestrator call throws', async () => {
    await withMockedBuildPlanStep(
      async () => {
        throw new Error('internal orchestrator failure with sensitive detail');
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'research', objective: 'Do something.' },
          });
          assert.ok(res.status >= 400 && res.status < 600);
          const parsed = JSON.parse(res.raw);
          assert.strictEqual(typeof parsed.error, 'string');
          assert.ok(parsed.error.length > 0);
          assert.ok(!parsed.error.includes('sensitive detail'));
        });
      }
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
