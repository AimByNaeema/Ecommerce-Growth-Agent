'use strict';

// The Command Center session: model, store, session layer, and the four HTTP routes.
//
// THE CHIEF IS NEVER REALLY RUN HERE. Every turn's orchestrator call is injected
// (runSessionTurn's `runChief` option) or monkey-patched at the module boundary, so this
// suite spends no Claude tokens, makes no network request, and tests the session logic
// rather than the Chief's routing - which orchestratorExecutionContract.test.js already
// covers and which this work deliberately did not change.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.COMMAND_CENTER_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-test-'));
process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-run-test-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const model = require('../../agent/core/commandCenterSessionModel');
const store = require('../../agent/core/commandCenterSessionStore');
const session = require('../../agent/core/commandCenterSession');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { createApp } = require('../../server');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const etsyClient = require('../../integrations/adapters/etsyClient');
const etsyOAuth = require('../../integrations/etsyOAuth');

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

function request(port, { method = 'GET', path: reqPath, body, auth = true } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: Object.assign(
          auth ? { Authorization: `Bearer ${TEST_API_KEY}` } : {},
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
        ),
      },
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

function withMocked(moduleObj, fnName, mockImpl, fn) {
  const saved = moduleObj[fnName];
  moduleObj[fnName] = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      moduleObj[fnName] = saved;
    });
}

// A Chief result shaped exactly like runOrchestratorContract's real return value, carrying
// a ranked opportunity list - the case a user actually numbers.
function chiefResultWithOpportunities(products, extra = {}) {
  return Object.assign(
    {
      objective: 'test',
      routing: {
        status: 'complete',
        plan: [
          {
            selected_specialist: { type: 'specialist', id: 'research', title: 'Research' },
            tool_calls: ['catalogue_expansion_opportunities'],
            completion_state: 'complete',
            outputs: {
              result: {
                top_opportunities: products.map((product, index) => ({
                  rank: index + 1,
                  product,
                  customer_fit_reason: `Relevant because it overlaps ${product}.`,
                  channel: null,
                  evidence: [{ source_url: 'https://example.test/a' }],
                })),
              },
            },
          },
        ],
      },
      pending_approvals: [],
    },
    extra
  );
}

async function main() {
  // --- 1-2. Model + store -------------------------------------------------------------

  test('SESSION CREATION: a new session persists with its goal and a stated channel', () => {
    const created = store.createSession({ goal: 'Find products related to my catalogue.', channel: 'etsy' });
    assert.ok(created.session_id.startsWith('cc-'));
    assert.strictEqual(created.status, 'active');
    assert.strictEqual(created.original_goal, 'Find products related to my catalogue.');
    assert.strictEqual(created.current_goal, created.original_goal);
    assert.strictEqual(created.channel, 'etsy');
    assert.strictEqual(model.validateCommandCenterSessionShape(created).valid, true);
  });

  test('SESSION PERSISTENCE + RESUME: a saved session reads back identically', () => {
    const created = store.createSession({ goal: 'Persisted goal.' });
    created.messages.push({ role: 'user', text: 'Persisted goal.', at: new Date().toISOString(), run_id: null });
    created.specialist_results.push({ ref: 1, label: 'Widget', specialist: 'research', run_id: 'r1', channel: null, channel_reference: null, summary: 's', source: [], payload_ref: null });
    store.saveSession(created);

    const resumed = store.getSessionById(created.session_id);
    assert.strictEqual(resumed.session_id, created.session_id);
    assert.strictEqual(resumed.original_goal, 'Persisted goal.');
    assert.strictEqual(resumed.messages.length, 1);
    assert.strictEqual(resumed.specialist_results[0].ref, 1);
    // And it appears in the listing a resume control reads.
    assert.ok(store.listSessions({ limit: 50 }).some((s) => s.session_id === created.session_id));
    assert.strictEqual(store.getSessionById('does-not-exist'), null);
  });

  test('NO SECRET IN A SESSION: the store refuses to persist a credential-shaped key', () => {
    const created = store.createSession({ goal: 'Secret test.' });
    for (const leaky of [
      { messages: [{ role: 'user', text: 'x', access_token: 'v' }] },
      { decisions: [{ at: 'now', refresh_token: 'v' }] },
      { final_result: { api_key: 'v' } },
      { next_actions: [{ id: 'a', title: 't', basis: 'b', oauth_code: 'v' }] },
    ]) {
      assert.throws(
        () => store.saveSession(Object.assign({}, created, leaky)),
        /credential-shaped key/i,
        `a session carrying ${Object.keys(leaky)[0]} must be refused`
      );
    }
    // A legitimate session with no such key still saves.
    assert.ok(store.saveSession(created));
  });

  // --- 3. Reference resolution --------------------------------------------------------

  test('REFERENCE: "#3" resolves to the stored result, and a quantity is NOT a reference', () => {
    assert.deepStrictEqual(session.extractReferences('deep research #3'), [3]);
    assert.deepStrictEqual(session.extractReferences('tell me about opportunity 2'), [2]);
    assert.deepStrictEqual(session.extractReferences('compare #1 and #4'), [1, 4]);
    // The distinction that matters: "top 3" is how many, not which one.
    assert.deepStrictEqual(session.extractReferences('give me the top 3 opportunities'), []);
    assert.deepStrictEqual(session.extractReferences('find 10 products'), []);
  });

  test('REFERENCE: the resolved objective NAMES the subject and keeps the user\'s own verbs', () => {
    const s = model.createEmptyCommandCenterSession({ session_id: 'x' });
    s.specialist_results.push({ ref: 3, label: 'Monogram Font Bundle', specialist: 'research', run_id: 'r1', channel: 'etsy', channel_reference: '123', summary: 'Overlaps font bundles.', source: [] });
    const resolved = session.resolveObjective(s, 'deep research #3');
    assert.strictEqual(resolved.ok, true);
    assert.ok(resolved.objective.startsWith('deep research #3'), "the user's own wording must lead");
    assert.ok(resolved.objective.includes('Monogram Font Bundle'), 'the subject must be named');
    assert.ok(resolved.objective.includes('etsy'), 'the stored channel travels with it');
    assert.strictEqual(resolved.resolved[0].ref, 3);
  });

  test('REFERENCE: an unresolvable reference ASKS rather than guessing', () => {
    const s = model.createEmptyCommandCenterSession({ session_id: 'x' });
    const empty = session.resolveObjective(s, 'deep research #3');
    assert.strictEqual(empty.ok, false);
    assert.ok(/no numbered results yet/i.test(empty.clarification));

    s.specialist_results.push({ ref: 1, label: 'A', specialist: 'research', run_id: 'r', channel: null, channel_reference: null, summary: '', source: [] });
    const outOfRange = session.resolveObjective(s, 'deep research #9');
    assert.strictEqual(outOfRange.ok, false);
    assert.ok(/#9 does not exist/i.test(outOfRange.clarification));
  });

  await testAsync('REFERENCE: an unresolvable reference spends NOTHING - the Chief is never called', async () => {
    let chiefCalls = 0;
    const s = store.createSession({ goal: 'g' });
    const outcome = await session.runSessionTurn(s, 'deep research #3', {
      runChief: async () => {
        chiefCalls += 1;
        return chiefResultWithOpportunities(['X']);
      },
    });
    assert.strictEqual(chiefCalls, 0, 'no tokens may be spent resolving a reference that does not exist');
    assert.ok(outcome.clarification);
    assert.strictEqual(outcome.session.status, 'waiting_for_user');
  });

  // --- 4-6. The turn: delegation, recording, continuation ------------------------------

  await testAsync('CHIEF DELEGATION: a turn calls the EXISTING orchestrator exactly once', async () => {
    let calls = 0;
    let receivedObjective = null;
    const s = store.createSession({ goal: 'Find related products.' });
    await session.runSessionTurn(s, 'Find related products.', {
      runChief: async (objective) => {
        calls += 1;
        receivedObjective = objective;
        return chiefResultWithOpportunities(['Alpha', 'Beta', 'Gamma']);
      },
    });
    assert.strictEqual(calls, 1, 'exactly one orchestrator call per turn - no second engine');
    assert.strictEqual(receivedObjective, 'Find related products.');
  });

  await testAsync('RESULTS RETURN TO THE SESSION, numbered for later reference', async () => {
    const s = store.createSession({ goal: 'Find related products.' });
    const outcome = await session.runSessionTurn(s, 'Find related products.', {
      runChief: async () => chiefResultWithOpportunities(['Alpha', 'Beta', 'Gamma']),
      saveRun: () => 'run-1',
    });
    const updated = outcome.session;
    assert.deepStrictEqual(updated.specialist_results.map((r) => r.ref), [1, 2, 3]);
    assert.deepStrictEqual(updated.specialist_results.map((r) => r.label), ['Alpha', 'Beta', 'Gamma']);
    assert.strictEqual(updated.status, 'waiting_for_user');
    assert.deepStrictEqual(updated.run_refs, ['run-1']);
    assert.strictEqual(updated.current_plan[0].specialist, 'research');
    assert.strictEqual(updated.specialist_tasks[0].run_id, 'run-1');
    // The persisted copy matches, so a resume shows the same thing.
    assert.strictEqual(store.getSessionById(updated.session_id).specialist_results.length, 3);
  });

  await testAsync('MULTI-TURN: a follow-up resolves #2 without the user repeating the name', async () => {
    const s = store.createSession({ goal: 'Find related products.' });
    await session.runSessionTurn(s, 'Find related products.', {
      runChief: async () => chiefResultWithOpportunities(['Alpha', 'Beta', 'Gamma']),
      saveRun: () => 'run-1',
    });

    let secondObjective = null;
    let secondParams = null;
    const second = await session.runSessionTurn(store.getSessionById(s.session_id), 'deep research #2', {
      runChief: async (objective, options) => {
        secondObjective = objective;
        secondParams = options.researchParams;
        return chiefResultWithOpportunities(['Beta deep dive']);
      },
      saveRun: () => 'run-2',
    });

    assert.ok(secondObjective.includes('Beta'), 'the Chief must receive the resolved subject, not "#2"');
    // Prior evidence is carried forward so the same research is not paid for twice.
    assert.ok(secondParams && Array.isArray(secondParams.sessionEvidence));
    assert.strictEqual(secondParams.sessionEvidence[0].topic, 'Beta');
    // Refs continue rather than restarting.
    assert.deepStrictEqual(second.session.specialist_results.map((r) => r.ref), [1, 2, 3, 4]);
    assert.deepStrictEqual(second.session.run_refs, ['run-1', 'run-2']);
  });

  test('CALLER PARAMS WIN: session context only fills gaps, never overrides real input', () => {
    const s = model.createEmptyCommandCenterSession({ session_id: 'x' });
    s.specialist_results.push({ ref: 1, label: 'A', specialist: 'research', run_id: 'r', channel: null, channel_reference: null, summary: 's', source: [] });
    const merged = session.buildSessionResearchParams(s, [], { sessionEvidence: ['caller wins'], limit: 5 });
    assert.deepStrictEqual(merged.sessionEvidence, ['caller wins']);
    assert.strictEqual(merged.limit, 5);
  });

  // --- 7. Approval + failure boundaries -----------------------------------------------

  await testAsync('APPROVAL BOUNDARY: a gated step marks the session waiting, and only REFERENCES the approval', async () => {
    const s = store.createSession({ goal: 'Do something consequential.' });
    const outcome = await session.runSessionTurn(s, 'Do something consequential.', {
      runChief: async () => chiefResultWithOpportunities(['Alpha'], { pending_approvals: [{ id: 'ap-1', reason: 'needs sign-off' }] }),
      saveRun: () => 'run-A',
    });
    assert.strictEqual(outcome.session.status, 'waiting_for_approval');
    assert.strictEqual(outcome.session.pending_items[0].kind, 'approval');
    assert.deepStrictEqual(outcome.session.approvals_reference, ['run-A']);
    // The approval RECORD itself is not copied into the session - only its run id.
    assert.ok(!JSON.stringify(outcome.session).includes('needs sign-off'));
  });

  await testAsync('FAILURE RECOVERY: a failed turn is reported, never fabricated, and the session survives', async () => {
    const s = store.createSession({ goal: 'Trigger a failure.' });
    const outcome = await session.runSessionTurn(s, 'Trigger a failure.', {
      runChief: async () => {
        throw new Error('simulated orchestrator failure');
      },
    });
    assert.strictEqual(outcome.runResult, null);
    assert.ok(/simulated orchestrator failure/.test(outcome.error));
    assert.strictEqual(outcome.session.status, 'waiting_for_user');
    assert.strictEqual(outcome.session.specialist_results.length, 0, 'a failed turn must produce no results');
    assert.ok(outcome.session.limitations.some((l) => /could not complete/i.test(l)));
    // Still readable, so the user can continue.
    assert.ok(store.getSessionById(s.session_id));
  });

  // --- 8. Channel -----------------------------------------------------------------------

  test('CHANNEL IS STATED, NEVER INFERRED', () => {
    // A goal that MENTIONS Etsy does not make the session an Etsy session.
    const s = store.createSession({ goal: 'Look at my Etsy listings and my Shopify products.' });
    assert.strictEqual(s.channel, null, 'channel must never be read out of the goal text');
    assert.strictEqual(store.createSession({ goal: 'x', channel: 'etsy' }).channel, 'etsy');
    // The model refuses a channel outside the declared set.
    const bad = model.createEmptyCommandCenterSession({ session_id: 'b', channel: 'amazon' });
    assert.strictEqual(model.validateCommandCenterSessionShape(bad).valid, false);
  });

  await testAsync('CHANNEL ISOLATION: a result keeps the channel its own record carried', async () => {
    const s = store.createSession({ goal: 'g' });
    const outcome = await session.runSessionTurn(s, 'g', {
      runChief: async () => {
        const result = chiefResultWithOpportunities(['Etsy thing', 'Unstamped thing']);
        result.routing.plan[0].outputs.result.top_opportunities[0].channel = 'etsy';
        return result;
      },
      saveRun: () => 'run-C',
    });
    const [etsyResult, plainResult] = outcome.session.specialist_results;
    assert.strictEqual(etsyResult.channel, 'etsy');
    assert.strictEqual(plainResult.channel, null, 'an unstamped record must not acquire a channel');
  });

  // --- 9. Etsy safety -------------------------------------------------------------------

  test('ETSY REMAINS READ-ONLY: no write scope, no write tool, publishing closed', () => {
    assert.deepStrictEqual([...etsyOAuth.ETSY_REQUIRED_SCOPES].sort(), ['listings_r', 'shops_r']);
    assert.ok(etsyOAuth.ETSY_REQUIRED_SCOPES.every((s) => s.endsWith('_r')));
    assert.strictEqual(etsyClient.canPublish(), false);
    for (const tool of TOOL_REGISTRY.filter((t) => /etsy/i.test(t.id))) {
      assert.strictEqual(tool.operation, 'read', `${tool.id} must be a read`);
    }
    // The session layer itself introduces no Etsy path at all.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'commandCenterSession.js'), 'utf8');
    for (const forbidden of ['etsyClient', 'publishListing', 'listings_w', 'createDraftListing', 'etsyReadClient']) {
      assert.ok(!source.includes(forbidden), `the session layer must not reference ${forbidden}`);
    }
  });

  test('NO SECOND ORCHESTRATOR: the session layer contains no routing or dispatch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'commandCenterSession.js'), 'utf8');
    // Comment lines are dropped WHOLESALE rather than pattern-stripped: this file's own
    // header legitimately discusses the orchestrator it defers to, and matching prose
    // would make this assert the wrong thing.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    for (const forbidden of ['TOOL_EXECUTORS', 'planRouting', 'routeClause', 'buildPlanStep', 'scoreRoutingTargets', 'getToolById', 'checkToolAccess']) {
      assert.ok(!code.includes(forbidden), `the session layer must not reimplement dispatch: found "${forbidden}"`);
    }
    // The ONLY member of the orchestrator this module touches is its single entry point.
    // Reaching for any other export would mean it had started doing the Chief's job.
    const members = [...code.matchAll(/orchestratorExecutionContract\.(\w+)/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(members)], ['runOrchestratorContract'], `it also reached for: ${members.join(', ')}`);
  });

  // --- 10. HTTP routes -------------------------------------------------------------------

  await testAsync('ROUTES: create, list, read, and continue a session - all API-key gated', async () => {
    await withServer(async (port) => {
      for (const spec of [
        { method: 'POST', path: '/session', body: { goal: 'x' } },
        { method: 'GET', path: '/sessions' },
      ]) {
        const unauthed = await request(port, Object.assign({}, spec, { auth: false }));
        assert.strictEqual(unauthed.status, 401, `${spec.path} must require the API key`);
      }

      const created = await request(port, { method: 'POST', path: '/session', body: { goal: 'Find related products.' } });
      assert.strictEqual(created.status, 200);
      const sessionId = JSON.parse(created.raw).session_id;

      assert.strictEqual((await request(port, { path: '/sessions' })).status, 200);
      assert.strictEqual((await request(port, { path: `/session/${sessionId}` })).status, 200);
      assert.strictEqual((await request(port, { path: '/session/unknown-id' })).status, 404);
      // An empty goal and an undeclared channel are both refused.
      assert.strictEqual((await request(port, { method: 'POST', path: '/session', body: { goal: '   ' } })).status, 400);
      assert.strictEqual((await request(port, { method: 'POST', path: '/session', body: { goal: 'x', channel: 'amazon' } })).status, 400);
      assert.strictEqual(
        (await request(port, { method: 'POST', path: `/session/${sessionId}/message`, body: { message: '' } })).status,
        400
      );
      assert.strictEqual(
        (await request(port, { method: 'POST', path: '/session/unknown/message', body: { message: 'hi' } })).status,
        404
      );
    });
  });

  await testAsync('ROUTES: a turn saves a real run record, and the session only references it', async () => {
    await withMocked(
      orchestratorExecutionContract,
      'runOrchestratorContract',
      async () => chiefResultWithOpportunities(['Alpha', 'Beta']),
      () =>
        withServer(async (port) => {
          const created = await request(port, { method: 'POST', path: '/session', body: { goal: 'Find related products.' } });
          const sessionId = JSON.parse(created.raw).session_id;
          const turn = await request(port, {
            method: 'POST',
            path: `/session/${sessionId}/message`,
            body: { message: 'Find related products.' },
          });
          assert.strictEqual(turn.status, 200);
          const data = JSON.parse(turn.raw);
          assert.ok(data.run_id, 'a turn must save a run');
          assert.strictEqual(data.session.specialist_results.length, 2);

          // The run is a NORMAL run record - the History page reads it unchanged.
          const record = runHistoryStore.getRunRecordById(data.run_id);
          assert.ok(record, 'the run must be in the existing run store');
          assert.strictEqual(record.session_id, sessionId);
          assert.strictEqual(record.kind, 'orchestrate');
          // The session references the run; it does not copy it.
          assert.ok(data.session.run_refs.includes(data.run_id));
          assert.ok(!JSON.stringify(data.session).includes('selected_specialist'), 'a session must not embed a full run');

          // No credential reaches the wire.
          assert.ok(!/accessToken|access_token|refresh_token|keystring|shared_secret|api_key/i.test(turn.raw));
          assert.ok(!turn.raw.includes(TEST_API_KEY));
        })
    );
  });

  await testAsync('ROUTES: /orchestrate still works exactly as before - the session layer is additive', async () => {
    await withMocked(
      orchestratorExecutionContract,
      'runOrchestratorContract',
      async () => chiefResultWithOpportunities(['Alpha']),
      () =>
        withServer(async (port) => {
          const res = await request(port, { method: 'POST', path: '/orchestrate', body: { objective: 'Do a thing.' } });
          assert.strictEqual(res.status, 200);
          const data = JSON.parse(res.raw);
          assert.ok(data.run_id, 'the pre-existing endpoint must keep returning a run id');
          assert.ok(data.routing, 'and its pre-existing shape');
        })
    );
  });

  test('BACKWARD COMPATIBLE: run history keeps working for records with no session_id', () => {
    const runId = `run-legacy-${Math.random().toString(36).slice(2, 8)}`;
    runHistoryStore.saveRunRecord({
      run_id: runId,
      kind: 'run',
      objective: 'A legacy run with no session.',
      status: 'success',
      summary: 'Done.',
      created_at: new Date().toISOString(),
      result: {},
    });
    const summary = runHistoryStore.listRunRecordSummaries({ limit: 50 }).find((s) => s.run_id === runId);
    assert.ok(summary, 'a run with no session must still list');
    assert.strictEqual(summary.channel, null, 'and must not be retroactively labelled');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('commandCenterSession.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
