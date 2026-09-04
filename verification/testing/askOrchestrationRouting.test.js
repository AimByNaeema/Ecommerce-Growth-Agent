'use strict';

// Focused tests for POST /ask running through the shared execution stack
// (agent/core/orchestratorExecutionContract.js's buildPlanStep) instead of calling a
// model client directly.
//
// The point of every test here is that /ask is no longer a side channel: the same
// checkToolAccess() gate, TOOL_EXECUTORS dispatch, token/usage budgets, approval
// classification, and audit trail that govern every other tool call now govern a
// conversational question too.
//
// No real network/API call is ever made. agent/core/claudeClient.js's sendMessage is
// monkey-patched on the shared cached module instance, which is what
// tools/aiReasoningCompletion.js actually calls - so the whole real path
// (buildPlanStep -> executeSelectedCapability -> runExecutor -> TOOL_EXECUTORS ->
// aiReasoningCompletion -> claudeClient) executes for real, with only the outermost
// HTTP call to Anthropic replaced.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeClient = require('../../agent/core/claudeClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const toolPermissions = require('../../agent/core/toolPermissions');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-routing-test-run-history-'));

// security/serverAccessControl.js fails closed, so these tests must authenticate.
// The rate limit is raised above anything one test needs - rate limiting itself is
// verification/testing/serverAccessControl.test.js's concern, not this file's.
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
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Replaces the ONE real outbound call (claudeClient.sendMessage). Everything between
// the HTTP handler and this point is the project's real code.
function withMockedClaude(mockImpl, fn) {
  const saved = claudeClient.sendMessage;
  claudeClient.sendMessage = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      claudeClient.sendMessage = saved;
    });
}

function successfulClaudeReply(text = 'a real mocked reply') {
  return async () => ({
    text,
    model: 'claude-test',
    stopReason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 8 },
  });
}

// Silences the endpoint's deliberate console.error on the non-completion paths, so a
// test asserting a 502 does not print alarming output. Returns what was logged.
function withCapturedErrorLog(fn) {
  const saved = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(() => fn(lines))
    .finally(() => {
      console.error = saved;
    });
}

async function run() {
  // --- 1. Authentication still applies ---

  await testAsync('/ask still requires authentication', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'POST', path: '/ask', body: { message: 'hello' } });
      assert.strictEqual(res.status, 401);
    });
  });

  // --- 2/3. No direct model-client call; the shared stack is what runs ---

  await testAsync('/ask no longer calls aiProviderSelector.sendMessage directly', async () => {
    let providerCalled = false;
    const savedProvider = aiProviderSelector.sendMessage;
    aiProviderSelector.sendMessage = async () => {
      providerCalled = true;
      return { text: 'this must never be used' };
    };
    try {
      await withMockedClaude(successfulClaudeReply(), async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'how are sales doing' },
            headers: authHeaders,
          });
          assert.strictEqual(res.status, 200);
          assert.strictEqual(JSON.parse(res.raw).reply, 'a real mocked reply');
        });
      });
    } finally {
      aiProviderSelector.sendMessage = savedProvider;
    }
    assert.strictEqual(providerCalled, false, '/ask must not reach aiProviderSelector any more');
  });

  await testAsync('/ask dispatches through buildPlanStep with the pinned ai_reasoning tool', async () => {
    const saved = orchestratorExecutionContract.buildPlanStep;
    const calls = [];
    orchestratorExecutionContract.buildPlanStep = async (...args) => {
      calls.push(args);
      return saved(...args);
    };
    try {
      await withMockedClaude(successfulClaudeReply(), async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'what should I focus on' },
            headers: authHeaders,
          });
          assert.strictEqual(res.status, 200);
        });
      });
    } finally {
      orchestratorExecutionContract.buildPlanStep = saved;
    }

    assert.strictEqual(calls.length, 1, '/ask should build exactly one plan step');
    const [target, , currentTask] = calls[0];
    const forcedSelection = calls[0][12];
    assert.strictEqual(target.type, 'shared_infrastructure');
    assert.strictEqual(target.id, 'ai_reasoning');
    assert.strictEqual(currentTask, 'what should I focus on', 'the clean question is the audited task text');
    assert.deepStrictEqual(forcedSelection, { toolId: 'ai_reasoning_completion', capabilityId: null });
  });

  await testAsync('the real tool dispatch path runs (TOOL_EXECUTORS -> aiReasoningCompletion -> claudeClient)', async () => {
    let sawInstruction = null;
    await withMockedClaude(
      async ({ messages, maxTokens }) => {
        sawInstruction = messages[0].content;
        // tokenControls capped the request rather than passing an unbounded value.
        assert.ok(typeof maxTokens === 'number' && maxTokens > 0, 'maxTokens must be capped by tokenControls');
        return {
          text: 'grounded answer',
          model: 'claude-test',
          stopReason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        };
      },
      async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'summarize my store' },
            headers: authHeaders,
          });
          assert.strictEqual(res.status, 200);
        });
      }
    );
    assert.ok(sawInstruction, 'claudeClient.sendMessage should have been reached through the tool');
    assert.ok(sawInstruction.includes('summarize my store'), 'the question must reach the model');
    // Business context is still attached, exactly as before the reroute.
    assert.ok(sawInstruction.includes('You are the assistant for the following business'));
  });

  // --- 4. Permissions remain authoritative ---

  await testAsync('a permission denial blocks the reply (checkToolAccess is authoritative)', async () => {
    const saved = toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion;
    let claudeCalled = false;
    // An unknown classification makes evaluateToolAccess deny the tool - the same
    // gate every other tool goes through. /ask must surface that, never bypass it.
    delete toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion;
    try {
      await withMockedClaude(
        async () => {
          claudeCalled = true;
          return { text: 'must not happen', model: 'x', stopReason: 'end_turn', usage: {} };
        },
        async () => {
          await withCapturedErrorLog(async () => {
            await withServer(async (port) => {
              const res = await request(port, {
                method: 'POST',
                path: '/ask',
                body: { message: 'hello' },
                headers: authHeaders,
              });
              assert.strictEqual(res.status, 502, 'a denied tool must not return a 200 reply');
              assert.ok(!res.raw.includes('must not happen'));
            });
          });
        }
      );
    } finally {
      toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion = saved;
    }
    assert.strictEqual(claudeCalled, false, 'a denied tool must never reach the model');
  });

  // --- 5. Token / usage controls remain enforced ---

  await testAsync('token controls cap the request and are enforced on the /ask path', async () => {
    const savedPerCall = process.env.MAX_TOKENS_PER_CALL;
    process.env.MAX_TOKENS_PER_CALL = '64';
    try {
      let observedMaxTokens = null;
      await withMockedClaude(
        async ({ maxTokens }) => {
          observedMaxTokens = maxTokens;
          return { text: 'ok', model: 'claude-test', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        },
        async () => {
          await withServer(async (port) => {
            const res = await request(port, {
              method: 'POST',
              path: '/ask',
              body: { message: 'hello' },
              headers: authHeaders,
            });
            assert.strictEqual(res.status, 200);
          });
        }
      );
      assert.strictEqual(observedMaxTokens, 64, 'the per-call token ceiling must be applied');
    } finally {
      if (savedPerCall === undefined) delete process.env.MAX_TOKENS_PER_CALL;
      else process.env.MAX_TOKENS_PER_CALL = savedPerCall;
    }
  });

  await testAsync('usage limits are live on the /ask path (the model call is counted)', async () => {
    // NOTE on what this can and cannot assert: agent/core/usageLimits.js's ceilings are
    // PER RUN, and one /ask request is exactly one run making exactly one model call,
    // so no configured ceiling can be tripped by a single question (its env overrides
    // also ignore 0 - `envOverride > 0 ? envOverride : default` - so the budget cannot
    // be set to zero either). Both are pre-existing properties of that module, not of
    // this endpoint. What IS verifiable, and what actually matters here, is that /ask
    // goes through the metered path at all: checkUsageLimits/recordUsage run against a
    // real tracker, so the moment a future /ask path makes more than one call the
    // ceiling applies to it automatically.
    const saved = orchestratorExecutionContract.buildPlanStep;
    let usageTracker = null;
    orchestratorExecutionContract.buildPlanStep = async (...args) => {
      usageTracker = args[9];
      return saved(...args);
    };
    try {
      await withMockedClaude(successfulClaudeReply(), async () => {
        await withServer(async (port) => {
          const res = await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'hello' },
            headers: authHeaders,
          });
          assert.strictEqual(res.status, 200);
        });
      });
    } finally {
      orchestratorExecutionContract.buildPlanStep = saved;
    }

    assert.ok(usageTracker, 'a real usage tracker is required for usageLimits to run at all');
    assert.strictEqual(usageTracker.modelCalls, 1, 'the model call must be counted against the run budget');
    assert.strictEqual(usageTracker.toolCalls, 1, 'the tool call must be counted against the run budget');
  });

  // --- 6. Audit is produced ---

  await testAsync('/ask produces a real audit trail through the shared tracker', async () => {
    const saved = orchestratorExecutionContract.buildPlanStep;
    let auditTracker = null;
    orchestratorExecutionContract.buildPlanStep = async (...args) => {
      auditTracker = args[7];
      return saved(...args);
    };
    try {
      await withMockedClaude(successfulClaudeReply(), async () => {
        await withServer(async (port) => {
          await request(port, {
            method: 'POST',
            path: '/ask',
            body: { message: 'audit me' },
            headers: authHeaders,
          });
        });
      });
    } finally {
      orchestratorExecutionContract.buildPlanStep = saved;
    }

    assert.ok(auditTracker, '/ask must pass a real audit tracker, not null');
    assert.ok(Array.isArray(auditTracker.events) && auditTracker.events.length > 0, 'audit events must be recorded');
    const types = auditTracker.events.map((event) => event.type);
    assert.ok(types.includes('agent'), `expected a routing/agent audit event, got: ${types.join(', ')}`);
    assert.ok(
      auditTracker.events.some((event) => event.tool_id === 'ai_reasoning_completion'),
      'the real tool call must appear in the audit trail'
    );
  });

  await testAsync('/ask passes a real usage ledger and usage tracker (not null)', async () => {
    const saved = orchestratorExecutionContract.buildPlanStep;
    let usageTracker = null;
    let usageLedger = null;
    orchestratorExecutionContract.buildPlanStep = async (...args) => {
      usageTracker = args[9];
      usageLedger = args[11];
      return saved(...args);
    };
    try {
      await withMockedClaude(successfulClaudeReply(), async () => {
        await withServer(async (port) => {
          await request(port, { method: 'POST', path: '/ask', body: { message: 'meter me' }, headers: authHeaders });
        });
      });
    } finally {
      orchestratorExecutionContract.buildPlanStep = saved;
    }
    assert.ok(usageTracker, 'a real usage tracker is required for usageLimits to be enforced at all');
    assert.ok(usageLedger && Array.isArray(usageLedger.events) && usageLedger.events.length > 0);
  });

  // --- 7. Existing behavior preserved ---

  await testAsync('an empty/missing message is still a 400, before any execution', async () => {
    await withServer(async (port) => {
      for (const body of [{}, { message: '' }, { message: '   ' }, { message: 42 }]) {
        const res = await request(port, { method: 'POST', path: '/ask', body, headers: authHeaders });
        assert.strictEqual(res.status, 400, `body ${JSON.stringify(body)} should be 400`);
      }
    });
  });

  await testAsync('a model failure is still a 502 with a generic message (no secret/detail leak)', async () => {
    await withMockedClaude(
      async () => {
        throw new Error('Claude API request failed (500): Internal error with sk-ant-SECRET');
      },
      async () => {
        await withCapturedErrorLog(async () => {
          await withServer(async (port) => {
            const res = await request(port, {
              method: 'POST',
              path: '/ask',
              body: { message: 'hello' },
              headers: authHeaders,
            });
            assert.strictEqual(res.status, 502);
            assert.ok(!res.raw.includes('sk-ant-SECRET'), 'the error response must not leak upstream detail');
            assert.strictEqual(JSON.parse(res.raw).error, 'The assistant is unavailable right now. Please try again shortly.');
          });
        });
      }
    );
  });

  await testAsync('the successful response contract is still exactly { reply }', async () => {
    await withMockedClaude(successfulClaudeReply('contract check'), async () => {
      await withServer(async (port) => {
        const res = await request(port, {
          method: 'POST',
          path: '/ask',
          body: { message: 'hello' },
          headers: authHeaders,
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(Object.keys(JSON.parse(res.raw)), ['reply']);
      });
    });
  });

  // --- 8. Approval gating is not bypassed ---

  await testAsync('a gated classification is never executed or answered', async () => {
    const saved = toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion;
    let claudeCalled = false;
    // Reclassify the tool as one that requires human sign-off. /ask must stop at the
    // gate exactly like every other path - approvals/approvalArchitecture.js stays
    // authoritative.
    toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion = 'approval_required';
    try {
      await withMockedClaude(
        async () => {
          claudeCalled = true;
          return { text: 'must not happen', model: 'x', stopReason: 'end_turn', usage: {} };
        },
        async () => {
          await withCapturedErrorLog(async (lines) => {
            await withServer(async (port) => {
              const res = await request(port, {
                method: 'POST',
                path: '/ask',
                body: { message: 'do the gated thing' },
                headers: authHeaders,
              });
              assert.strictEqual(res.status, 502, 'a gated step must not produce a reply');
              assert.ok(!res.raw.includes('must not happen'));
            });
            assert.ok(
              lines.some((line) => line.includes('gated awaiting human approval')),
              `the gate should be logged honestly, got: ${lines.join(' | ')}`
            );
          });
        }
      );
    } finally {
      toolPermissions.TOOL_CLASSIFICATIONS.ai_reasoning_completion = saved;
    }
    assert.strictEqual(claudeCalled, false, 'a gated tool must never reach the model without approval');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
