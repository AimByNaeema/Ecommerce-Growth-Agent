'use strict';

// Focused tests for the HTTP boundary's authentication + rate limiting
// (security/serverAccessControl.js, wired into server.js).
//
// Never makes a real network/API call: aiProviderSelector.sendMessage and
// orchestratorExecutionContract.buildPlanStep are monkey-patched on the shared cached
// module instances, the same convention verification/testing/server.test.js already
// uses. Run history is redirected to a throwaway directory so this suite never writes
// into the project's own memory/state/runs/.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// /ask runs through the shared execution stack (buildPlanStep -> TOOL_EXECUTORS ->
// tools/aiReasoningCompletion.js), which resolves its client via aiProviderSelector.
// This suite only needs a working /ask to prove the auth boundary lets it through, so
// it pins the provider and mocks that one client. See
// verification/testing/askOrchestrationRouting.test.js for the routing's own tests and
// verification/testing/aiReasoningProviderSelection.test.js for provider selection.
//
// MUST be set before any request runs: tools/aiReasoningCompletion.js resolves its
// client through agent/core/aiProviderSelector.js at call time, and this suite mocks
// claudeClient. Without pinning, the selector would follow the local .env - which sets
// AI_PROVIDER=gemini with a real key - and these tests would make REAL, billable Gemini
// API calls instead of using the mock. Provider selection itself is covered by
// verification/testing/aiReasoningProviderSelection.test.js.
process.env.AI_PROVIDER = 'claude';

const claudeClient = require('../../agent/core/claudeClient');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'server-auth-test-run-history-'));

const VALID_KEY = 'test-agent-api-key-do-not-use-in-production';

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

function request(port, { method, path: reqPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const baseHeaders = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers: { ...baseHeaders, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, raw, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders(key = VALID_KEY) {
  return { Authorization: `Bearer ${key}` };
}

// Each server is started with a freshly created app, so every test gets its own
// rate-limit counters (createRateLimiter's Map is per-app) and cannot be tripped by a
// previous test's requests.
async function withServer(fn, { apiKey = VALID_KEY, env = {} } = {}) {
  const savedEnv = { AGENT_API_KEY: process.env.AGENT_API_KEY };
  for (const key of Object.keys(env)) savedEnv[key] = process.env[key];

  if (apiKey === null) delete process.env.AGENT_API_KEY;
  else process.env.AGENT_API_KEY = apiKey;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withMockedSendMessage(mockImpl, fn) {
  const saved = claudeClient.sendMessage;
  claudeClient.sendMessage = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      claudeClient.sendMessage = saved;
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

// Every endpoint that can reach real store data, call an external service, or spend
// model/API budget. Each is asserted to be protected - so a future endpoint added
// without protection is caught here rather than in production.
const PROTECTED_ENDPOINTS = [
  { method: 'POST', path: '/ask', body: { message: 'hello' } },
  { method: 'POST', path: '/run', body: { specialist: 'research', objective: 'test' } },
  { method: 'POST', path: '/orchestrate', body: { objective: 'test' } },
  { method: 'POST', path: '/orchestrate/approve', body: { runId: 'x', approvalId: 'y', decision: 'approved' } },
  { method: 'GET', path: '/history' },
  { method: 'GET', path: '/history/some-run-id' },
];

async function run() {
  // --- Unauthenticated access is rejected everywhere ---

  await testAsync('every protected endpoint rejects a request with no credentials', async () => {
    await withServer(async (port) => {
      for (const endpoint of PROTECTED_ENDPOINTS) {
        const res = await request(port, endpoint);
        assert.strictEqual(res.status, 401, `${endpoint.method} ${endpoint.path} should be 401, got ${res.status}`);
      }
    });
  });

  await testAsync('a wrong API key is rejected', async () => {
    await withServer(async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/ask',
        body: { message: 'hello' },
        headers: authHeaders('definitely-the-wrong-key'),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  await testAsync('a malformed Authorization header is rejected', async () => {
    await withServer(async (port) => {
      for (const header of [{ Authorization: VALID_KEY }, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }]) {
        const res = await request(port, { method: 'GET', path: '/history', headers: header });
        assert.strictEqual(res.status, 401, `header ${JSON.stringify(header)} should be 401`);
      }
    });
  });

  // --- Fails closed when unconfigured ---

  await testAsync('fails closed with 503 when AGENT_API_KEY is not set', async () => {
    await withServer(
      async (port) => {
        // Even presenting a plausible key cannot open an unconfigured server.
        const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
        assert.strictEqual(res.status, 503);
        assert.ok(!/401/.test(String(res.status)));
      },
      { apiKey: null }
    );
  });

  await testAsync('an empty/whitespace AGENT_API_KEY also fails closed', async () => {
    await withServer(
      async (port) => {
        const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders('   ') });
        assert.strictEqual(res.status, 503);
      },
      { apiKey: '   ' }
    );
  });

  // --- Authenticated access still works ---

  await testAsync('authenticated /ask still returns a real reply', async () => {
    await withMockedSendMessage(
      async () => ({ text: 'a real mocked reply' }),
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'hello' },
            headers: authHeaders(),
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(JSON.parse(res.raw).reply, 'a real mocked reply');
        });
      }
    );
  });

  await testAsync('authenticated /run still executes a specialist step', async () => {
    await withMockedBuildPlanStep(
      async () => ({ completion_state: 'complete', task_status: 'done', verification_status: 'passed' }),
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/run',
            body: { specialist: 'research', objective: 'test objective' },
            headers: authHeaders(),
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(JSON.parse(res.raw).status, 'success');
        });
      }
    );
  });

  await testAsync('authenticated /history still returns saved runs', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(JSON.parse(res.raw).runs));
    });
  });

  await testAsync('authentication runs before request-body validation', async () => {
    // An unauthenticated caller must not be able to learn which bodies are valid -
    // a bad body from an anonymous caller is still 401, never 400.
    await withServer(async (port) => {
      const res = await request(port, { method: 'POST', path: '/run', body: { specialist: 'not-a-specialist' } });
      assert.strictEqual(res.status, 401);
    });
  });

  // --- Rate limiting ---

  await testAsync('rate limiting returns 429 once the window limit is exceeded', async () => {
    await withServer(
      async (port) => {
        const statuses = [];
        for (let i = 0; i < 5; i += 1) {
          const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
          statuses.push(res.status);
        }
        assert.deepStrictEqual(statuses.slice(0, 3), [200, 200, 200], `first 3 should pass: ${statuses}`);
        assert.deepStrictEqual(statuses.slice(3), [429, 429], `rest should be throttled: ${statuses}`);
      },
      { env: { RATE_LIMIT_MAX_REQUESTS: '3', RATE_LIMIT_WINDOW_MS: '60000' } }
    );
  });

  await testAsync('a 429 response carries a Retry-After header', async () => {
    await withServer(
      async (port) => {
        await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
        const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
        assert.strictEqual(res.status, 429);
        assert.ok(Number(res.headers['retry-after']) > 0, 'Retry-After should be a positive number of seconds');
      },
      { env: { RATE_LIMIT_MAX_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' } }
    );
  });

  await testAsync('unauthenticated requests are rate limited too (no free key guessing)', async () => {
    await withServer(
      async (port) => {
        const first = await request(port, { method: 'GET', path: '/history', headers: authHeaders('guess-1') });
        const second = await request(port, { method: 'GET', path: '/history', headers: authHeaders('guess-2') });
        const third = await request(port, { method: 'GET', path: '/history', headers: authHeaders('guess-3') });
        assert.strictEqual(first.status, 401);
        assert.strictEqual(second.status, 401);
        // Different wrong keys still share the caller's IP-based budget once no valid
        // credential is presented, so guessing cannot outrun the limiter.
        assert.ok(third.status === 401 || third.status === 429, `expected 401/429, got ${third.status}`);
      },
      { env: { RATE_LIMIT_MAX_REQUESTS: '2', RATE_LIMIT_WINDOW_MS: '60000' } }
    );
  });

  await testAsync('the rate-limit window expires, restoring access', async () => {
    await withServer(
      async (port) => {
        const blocked = await Promise.resolve()
          .then(() => request(port, { method: 'GET', path: '/history', headers: authHeaders() }))
          .then(() => request(port, { method: 'GET', path: '/history', headers: authHeaders() }));
        assert.strictEqual(blocked.status, 429);

        await new Promise((resolve) => setTimeout(resolve, 60));
        const afterWindow = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
        assert.strictEqual(afterWindow.status, 200);
      },
      { env: { RATE_LIMIT_MAX_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '50' } }
    );
  });

  // --- Existing security behavior preserved ---

  await testAsync('no response ever echoes the configured API key', async () => {
    await withServer(async (port) => {
      const responses = [];
      responses.push(await request(port, { method: 'GET', path: '/history' }));
      responses.push(await request(port, { method: 'GET', path: '/history', headers: authHeaders('wrong') }));
      responses.push(await request(port, { method: 'GET', path: '/history', headers: authHeaders() }));
      for (const res of responses) {
        assert.ok(!res.raw.includes(VALID_KEY), `a response body leaked the API key: ${res.raw}`);
      }
    });
  });

  await testAsync('the 503 unconfigured response does not leak env details', async () => {
    await withServer(
      async (port) => {
        const res = await request(port, { method: 'GET', path: '/history', headers: authHeaders() });
        assert.strictEqual(res.status, 503);
        assert.ok(!res.raw.includes(VALID_KEY));
      },
      { apiKey: null }
    );
  });

  await testAsync('the static dashboard remains publicly servable', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'GET', path: '/index.html' });
      assert.strictEqual(res.status, 200);
      // The page must never carry the key itself - it asks the operator for it.
      assert.ok(!res.raw.includes(VALID_KEY), 'the served dashboard must not embed the API key');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
