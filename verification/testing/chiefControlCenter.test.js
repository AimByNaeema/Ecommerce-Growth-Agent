'use strict';

// The Chief as the owner's primary interface, end to end over HTTP:
//
//   Ask the Chief (POST /session + /session/:id/message)
//   -> the REAL Chief (runOrchestratorContract) picks and dispatches the specialist
//   -> consolidated owner_view
//   -> a consequential step stops for a DURABLE pending approval (GET /approvals/pending)
//   -> forged client approvals are refused
//   -> a real Ed25519 signed decision -> the existing authorization, compliance and dispatch
//   -> the Shopify write -> re-read -> independent verification -> audit -> history -> usage
//
// NOTHING ABOUT THE SAFETY CHAIN IS MOCKED. The Chief, compliance engine, approval gate,
// publish authorization, dispatcher and verification all run for real. Only the Shopify
// boundary is substituted - shopifyClient's module functions for the vendor correction, and
// global.fetch (Shopify GraphQL only) for the live analytics read - so no real store is read
// or written and no network call can leave this process.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const [env, name] of [
  ['RUN_HISTORY_STORE_DIR', 'runs'],
  ['APPROVAL_STORE_DIR', 'approvals'],
  ['VERIFICATION_STORE_DIR', 'verifications'],
  ['COMMAND_CENTER_SESSION_DIR', 'sessions'],
  ['SCHEDULE_STORE_DIR', 'schedules'],
  ['SNAPSHOT_STORE_DIR', 'snapshots'],
  ['CIRCUIT_BREAKER_STORE_DIR', 'circuits'],
  ['MEMORY_STORE_DIR', 'memory'],
]) {
  process.env[env] = fs.mkdtempSync(path.join(os.tmpdir(), `chief-control-center-${name}-`));
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
delete process.env.VERCEL;

// Real Ed25519 signing, as the human would do it - see approvalSigningTestKey.js.
const { signPayloadString } = require('./approvalSigningTestKey');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { prepareApprovalExecutionRequest } = require('../../agent/core/orchestratorExecutionContract');
const { createAndPersistApprovalRequest } = require('../../approvals/approvalWorkflow');
const ownerRunView = require('../../agent/core/ownerRunView');
const { createApp } = require('../../server');

// Static-token Shopify path pinned for the live analytics read (see chiefToApprovalIntegration's
// withEnvConfigured for why the .env is loaded first and the client-credential pair removed).
shopifyClient.loadEnvOnce();
process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
delete process.env.SHOPIFY_CLIENT_ID;
delete process.env.SHOPIFY_CLIENT_SECRET;

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

// ---------------------------------------------------------------------------------
// The Shopify boundary
// ---------------------------------------------------------------------------------

// Live analytics reads: Shopify GraphQL only. Anything else - a model provider, a search API -
// is refused, so the suite cannot quietly reach the network.
const fetchCalls = [];
global.fetch = async (url, options) => {
  const target = String(url);
  fetchCalls.push(target);
  if (!target.includes('test-store.myshopify.com')) {
    throw new Error(`This suite makes no network call outside the substituted Shopify boundary (${target}).`);
  }
  const node = {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2026-01-15T10:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
    lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
  };
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { orders: { edges: [{ node }] } } }) };
};

// The store the vendor correction writes to: a product map the substituted client reads and writes.
const storeVendors = new Map([
  ['gid://shopify/Product/1', 'Old Vendor'],
  ['gid://shopify/Product/2', 'Old Vendor'],
  ['gid://shopify/Product/3', 'Old Vendor'],
]);
const vendorWrites = [];
shopifyClient.updateProductVendor = async ({ productId, vendor }) => {
  vendorWrites.push({ productId, vendor });
  storeVendors.set(productId, vendor);
  return { id: productId, vendor };
};
// Every catalogue read through the existing Shopify client is counted, so a test can prove a
// specialist actually read the connected store rather than answering without it.
let productReads = 0;
shopifyClient.getProducts = async () => {
  productReads += 1;
  return Array.from(storeVendors.entries()).map(([id, vendor]) => ({ id, vendor, title: `Product ${id.split('/').pop()}` }));
};

// ---------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------

function request(port, { method, path: reqPath, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (auth) headers.Authorization = `Bearer ${TEST_API_KEY}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (err) {
          json = null;
        }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const allResponses = [];
async function call(port, options) {
  const res = await request(port, options);
  allResponses.push(res.raw);
  return res;
}

async function askChief(port, message, researchParams) {
  const created = await call(port, { method: 'POST', path: '/session', body: { goal: message } });
  assert.strictEqual(created.status, 200, created.raw.slice(0, 200));
  const turn = await call(port, {
    method: 'POST',
    path: `/session/${encodeURIComponent(created.body.session_id)}/message`,
    body: researchParams ? { message, research_params: researchParams } : { message },
  });
  assert.strictEqual(turn.status, 200, turn.raw.slice(0, 300));
  return turn.body;
}

async function signedBody(port, body) {
  const query = new URLSearchParams({ approvalId: body.approvalId, decision: body.decision, decidedBy: body.decidedBy });
  const challenge = await call(port, { method: 'GET', path: '/approval-challenge?' + query.toString() });
  assert.strictEqual(challenge.status, 200, challenge.raw.slice(0, 200));
  return { ...body, nonce: challenge.body.nonce, signature: signPayloadString(challenge.body.payload) };
}

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

const ANALYTICS_OBJECTIVE = 'analyze store performance growth metrics and sales analytics data';
const VENDOR_PRODUCT = 'gid://shopify/Product/1';
const NEW_VENDOR = 'Aurora Ceramics';

(async () => {
  // --- The owner-view module on its own: consolidation and honest status ---------------

  await testAsync('OWNER VIEW: results from several specialists are consolidated under the Chief', async () => {
    const step = (id, title, tool) => ({
      selected_specialist: { type: 'specialist', id, title },
      inputs: { tool_id: tool },
      completion_state: 'complete',
      summary: `${title} finished.`,
      errors: [],
      approvals: [],
    });
    const view = ownerRunView.describeChiefResultForOwner({
      result: {
        routing: { status: 'planned', plan: [step('product', 'Product', 'product_data_retrieval'), step('seo', 'SEO', 'seo_analysis')] },
        verification_status: 'passed',
        pending_approvals: [],
      },
    });
    assert.deepStrictEqual(view.specialists_used, ['Product', 'SEO']);
    assert.strictEqual(view.status, 'success');
    assert.strictEqual(view.findings.length, 2);
  });

  await testAsync('OWNER VIEW: an executed change that was not independently verified is never a success', async () => {
    const view = ownerRunView.describeChiefResultForOwner({
      result: {
        routing: { status: 'planned', plan: [{ completion_state: 'complete', inputs: { tool_id: 'shopify_vendor_correction' } }] },
        verification_status: 'passed',
        pending_approvals: [],
        approval_executions: [{ approval_id: 'a', tool_id: 'shopify_vendor_correction', decision: 'approved', execution_status: 'success', entity_verification: { status: 'unverifiable' } }],
      },
    });
    assert.strictEqual(view.status, 'verification_failed');
    assert.notStrictEqual(view.verification_state, 'verified');
  });

  await testAsync('OWNER VIEW: a rejected action and an incomplete plan are reported as exactly that', async () => {
    const rejected = ownerRunView.describeChiefResultForOwner({
      result: {
        routing: { status: 'planned', plan: [{ completion_state: 'blocked', inputs: { tool_id: 'shopify_vendor_correction' } }] },
        pending_approvals: [],
        approval_executions: [{ approval_id: 'a', decision: 'rejected', execution_status: 'denied' }],
      },
    });
    assert.strictEqual(rejected.status, 'rejected');
    const failedRun = ownerRunView.describeChiefResultForOwner({ result: { routing: { status: 'planned', plan: [{ completion_state: 'failed' }] } } });
    assert.strictEqual(failedRun.status, 'failed');
  });

  await withServer(async (port) => {
    // --- Ask the Chief: the owner never picks a specialist ------------------------------

    let analyticsRunId = null;
    await testAsync('ASK THE CHIEF: a plain goal reaches the real Chief, which dispatches the specialist itself and consolidates the result', async () => {
      const readsBefore = productReads + fetchCalls.filter((url) => url.includes('test-store.myshopify.com')).length;
      const turn = await askChief(port, ANALYTICS_OBJECTIVE);
      const readsAfter = productReads + fetchCalls.filter((url) => url.includes('test-store.myshopify.com')).length;
      assert.ok(turn.run_id, 'the Chief turn was saved as a run');
      analyticsRunId = turn.run_id;
      const view = turn.owner_view;
      assert.ok(view, 'the turn carries the owner view');
      assert.ok(view.specialists_used.includes('Analytics & Optimization'), `the Chief chose the specialist (${JSON.stringify(view.specialists_used)})`);
      assert.strictEqual(view.platform, 'shopify');
      assert.ok(view.findings.length > 0, 'the specialist result came back to the Chief');
      assert.strictEqual(view.status, 'success');
      assert.strictEqual(view.approval_state, 'not_needed');
      assert.ok(readsAfter > readsBefore, 'the specialist read the connected Shopify store through the existing client');
    });

    await testAsync('ASK THE CHIEF: an empty goal is refused before the Chief runs', async () => {
      const created = await call(port, { method: 'POST', path: '/session', body: { goal: 'x' } });
      const turn = await call(port, { method: 'POST', path: `/session/${created.body.session_id}/message`, body: { message: '   ' } });
      assert.strictEqual(turn.status, 400);
    });

    await testAsync('ASK THE CHIEF: requires the API key', async () => {
      const res = await request(port, { method: 'POST', path: '/session', body: { goal: 'x' }, auth: false });
      assert.strictEqual(res.status, 401);
      const pending = await request(port, { method: 'GET', path: '/approvals/pending', auth: false });
      assert.strictEqual(pending.status, 401);
    });

    // --- A consequential step stops for the owner -----------------------------------------

    let vendorTurn = null;
    let vendorApproval = null;
    await testAsync('APPROVAL REQUIRED: the Chief stops a store change for the owner and registers a durable, decidable approval', async () => {
      vendorTurn = await askChief(port, `Change the vendor of Shopify product ${VENDOR_PRODUCT} to ${NEW_VENDOR}`, {
        productId: VENDOR_PRODUCT,
        newVendor: NEW_VENDOR,
      });
      const view = vendorTurn.owner_view;
      assert.strictEqual(view.status, 'waiting_for_approval');
      assert.strictEqual(view.proposed_actions.length, 1);
      assert.strictEqual(view.proposed_actions[0].what_changes, 'Product vendor');
      assert.strictEqual(view.proposed_actions[0].proposed_value, NEW_VENDOR);
      assert.strictEqual(vendorWrites.length, 0, 'nothing was written');

      const pending = await call(port, { method: 'GET', path: '/approvals/pending' });
      assert.strictEqual(pending.status, 200);
      vendorApproval = pending.body.approvals.find((item) => item.entity_id === VENDOR_PRODUCT);
      assert.ok(vendorApproval, 'the approval is listed from durable storage');
      assert.strictEqual(vendorApproval.origin, 'chief');
      assert.strictEqual(vendorApproval.decidable, true);
      assert.strictEqual(vendorApproval.run_id, vendorTurn.run_id);
      assert.strictEqual(vendorApproval.platform, 'shopify');
      assert.strictEqual(vendorApproval.current_value, 'Old Vendor', 'the current value is read from the store');
      assert.strictEqual(vendorApproval.proposed_value, NEW_VENDOR);
      assert.ok(['PASS', 'REVIEW'].includes(vendorApproval.compliance_status), `compliance verdict shown (${vendorApproval.compliance_status})`);
      assert.strictEqual(vendorApproval.risk, 'high');
    });

    await testAsync('FORGED APPROVAL: client-supplied approved/compliance/authorization flags and a bad signature are refused, and nothing is written', async () => {
      const flagsOnly = await call(port, {
        method: 'POST',
        path: '/orchestrate/approve',
        body: { runId: vendorTurn.run_id, approvalId: vendorApproval.approval_id, decision: 'approved', decidedBy: 'naeema', approved: true, compliance: true, authorization: true },
      });
      assert.strictEqual(flagsOnly.status, 400);

      const query = new URLSearchParams({ approvalId: vendorApproval.approval_id, decision: 'approved', decidedBy: 'naeema' });
      const challenge = await call(port, { method: 'GET', path: '/approval-challenge?' + query.toString() });
      const forged = await call(port, {
        method: 'POST',
        path: '/orchestrate/approve',
        body: { runId: vendorTurn.run_id, approvalId: vendorApproval.approval_id, decision: 'approved', decidedBy: 'naeema', nonce: challenge.body.nonce, signature: signPayloadString('not the challenge payload') },
      });
      assert.strictEqual(forged.status, 400);
      assert.strictEqual(vendorWrites.length, 0, 'no Shopify write was attempted');

      const stillPending = await call(port, { method: 'GET', path: '/approvals/pending' });
      assert.ok(stillPending.body.approvals.some((item) => item.approval_id === vendorApproval.approval_id), 'the approval is still pending');
    });

    await testAsync('COMPLIANCE BLOCK: a change whose content is blocked creates no approval and can never be written', async () => {
      const turn = await askChief(port, 'Change the vendor of Shopify product gid://shopify/Product/2 to Guaranteed Copyright-Free Designs', {
        productId: 'gid://shopify/Product/2',
        newVendor: 'Guaranteed Copyright-Free Designs',
      });
      assert.strictEqual(turn.owner_view.status, 'blocked_by_compliance');
      assert.strictEqual(turn.owner_view.proposed_actions.length, 0);
      const pending = await call(port, { method: 'GET', path: '/approvals/pending' });
      assert.ok(!pending.body.approvals.some((item) => item.entity_id === 'gid://shopify/Product/2'), 'no approval exists to decide');
      assert.strictEqual(storeVendors.get('gid://shopify/Product/2'), 'Old Vendor');
    });

    // --- The signed decision runs the existing chain ---------------------------------------

    let approveResponse = null;
    await testAsync('APPROVED MUTATION: a real signed decision runs the existing authorization, writes once, and is independently verified', async () => {
      const body = await signedBody(port, { runId: vendorTurn.run_id, approvalId: vendorApproval.approval_id, decision: 'approved', decidedBy: 'naeema' });
      const res = await call(port, { method: 'POST', path: '/orchestrate/approve', body });
      assert.strictEqual(res.status, 200, res.raw.slice(0, 400));
      approveResponse = res.body;
      assert.strictEqual(res.body.approval_request.status, 'approved');
      assert.deepStrictEqual(vendorWrites, [{ productId: VENDOR_PRODUCT, vendor: NEW_VENDOR }], 'exactly one write, of exactly the approved change');
      assert.strictEqual(res.body.step.outputs.authorization.authorized, true, 'the existing publish authorization authorized it');
      assert.strictEqual(res.body.entity_verification.status, 'verified', 'the shared entity verification confirmed the re-read');
      assert.strictEqual(res.body.owner_view.status, 'success');
      assert.strictEqual(res.body.owner_view.verification_state, 'verified');
      assert.strictEqual(res.body.owner_view.mutations.length, 1);
      assert.strictEqual(res.body.owner_view.mutations[0].entity_id, VENDOR_PRODUCT);

      const replay = await call(port, { method: 'POST', path: '/orchestrate/approve', body });
      assert.strictEqual(replay.status, 400, 'the same signed decision cannot run twice');
      assert.strictEqual(vendorWrites.length, 1);
    });

    await testAsync('AUDIT: the approved execution is recorded on the saved run, with its verification', async () => {
      assert.ok(approveResponse, 'the approval ran');
      const record = await call(port, { method: 'GET', path: `/history/${encodeURIComponent(vendorTurn.run_id)}` });
      assert.strictEqual(record.status, 200);
      const events = record.body.result.audit_trail;
      assert.ok(events.some((e) => e.type === 'approval' && e.status === 'approved'), 'the approval is audited');
      assert.ok(events.some((e) => e.type === 'execution' && e.tool_id === 'shopify_vendor_correction' && e.status === 'success'), 'the execution is audited');
      const execution = record.body.result.approval_executions[0];
      assert.strictEqual(execution.entity_verification.status, 'verified');
      assert.strictEqual(record.body.result.pending_approvals.find((a) => a.id === vendorApproval.approval_id).status, 'approved');
    });

    await testAsync('APPROVAL CENTER: a decided approval leaves the pending list; an autonomous one is listed with its own decision path', async () => {
      const prepared = prepareApprovalExecutionRequest('shopify_vendor_correction', {
        objective: 'Correct the vendor on the product.',
        category: 'products',
        tool_id: 'shopify_vendor_correction',
        specialist_id: 'product',
        is_shared_infrastructure: false,
        business_id: null,
        research_params: { content: 'North Studio', productId: 'gid://shopify/Product/3', newVendor: 'North Studio' },
        autonomy: { origin: 'autonomous_cycle', cycle_id: 'cycle-http', job_id: 'fix-vendor', occurrence_key: '2026-03-04T09:00:00.000Z', platform: 'shopify' },
      });
      createAndPersistApprovalRequest({
        id: 'apr-autonomous-listing-1',
        classification: 'externally_executable',
        specialistId: 'product',
        toolId: 'shopify_vendor_correction',
        executionRequest: prepared.executionRequest,
        reason: 'Changes a real product record in the connected store.',
      });
      const pending = await call(port, { method: 'GET', path: '/approvals/pending' });
      assert.ok(!pending.body.approvals.some((item) => item.approval_id === vendorApproval.approval_id), 'decided approvals are not pending');
      const autonomous = pending.body.approvals.find((item) => item.approval_id === 'apr-autonomous-listing-1');
      assert.ok(autonomous, 'the autonomous approval is listed');
      assert.strictEqual(autonomous.origin, 'autonomous_cycle');
      assert.strictEqual(autonomous.decidable, true);
      assert.strictEqual(autonomous.proposed_value, 'North Studio');
      assert.strictEqual(vendorWrites.length, 1, 'listing never writes');
    });

    // --- History and usage -----------------------------------------------------------------

    await testAsync('HISTORY: Chief runs show the agent, platform, approval, verification and store changes', async () => {
      const history = await call(port, { method: 'GET', path: '/history' });
      assert.strictEqual(history.status, 200);
      const vendorRow = history.body.runs.find((run) => run.run_id === vendorTurn.run_id);
      assert.ok(vendorRow && vendorRow.owner_view, 'the approved run is in history with an owner view');
      assert.ok(vendorRow.owner_view.agent.startsWith('Chief'));
      assert.strictEqual(vendorRow.owner_view.mutation_count, 1);
      assert.strictEqual(vendorRow.owner_view.verification_state, 'verified');
      const analyticsRow = history.body.runs.find((run) => run.run_id === analyticsRunId);
      assert.ok(analyticsRow && analyticsRow.owner_view.agent.includes('Analytics & Optimization'));
      assert.strictEqual(analyticsRow.owner_view.mutation_count, 0);
    });

    await testAsync('USAGE: the Autonomy state reports today\'s real usage and the recent verified store change', async () => {
      const state = await call(port, { method: 'GET', path: '/autonomy/state' });
      assert.strictEqual(state.status, 200);
      for (const field of ['kill_switch', 'business_autonomy', 'enabled_platforms', 'schedules', 'recent_runs', 'pending_approvals']) {
        assert.ok(field in state.body, `existing field ${field} is preserved`);
      }
      assert.strictEqual(state.body.daily_usage.available, true);
      assert.ok(state.body.daily_usage.runs_counted >= 3, 'the Chief runs are counted');
      assert.strictEqual(typeof state.body.daily_usage.tokens_total, 'number');
      const change = state.body.recent_mutations.find((m) => m.entity_id === VENDOR_PRODUCT);
      assert.ok(change, 'the approved change is listed');
      assert.strictEqual(change.verification_status, 'verified');
    });

    await testAsync('SECRETS: no response carried an API key, a provider key, a store token or a private key', async () => {
      const secrets = [
        TEST_API_KEY,
        process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
        process.env.ANTHROPIC_API_KEY,
        process.env.GEMINI_API_KEY,
        process.env.TAVILY_API_KEY,
        process.env.ETSY_SHARED_SECRET,
        process.env.ETSY_OAUTH_REFRESH_TOKEN,
      ].filter((value) => typeof value === 'string' && value.length >= 8);
      assert.ok(allResponses.length > 10);
      for (const raw of allResponses) {
        for (const secret of secrets) {
          assert.ok(!raw.includes(secret), 'a secret value appeared in a response');
        }
        assert.ok(!raw.includes('PRIVATE KEY'), 'a private key appeared in a response');
      }
    });
  });

  // --- The dashboard wiring, statically: added without removing anything ----------------

  await testAsync('DASHBOARD: Ask the Chief, the durable approval list and every existing page are present', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    for (const id of ['askChiefInput', 'askChiefBtn', 'durableApprovalArea']) {
      assert.ok(html.includes(`id="${id}"`), `${id} is present`);
    }
    for (const id of ['navOverview', 'navAsk', 'navSpecialists', 'navOrchestrator', 'navApprovals', 'navAutonomy', 'navWorkflow', 'navHistory',
      'pageOverview', 'pageAsk', 'pageSpecialists', 'pageOrchestrator', 'pageApprovals', 'pageAutonomy', 'pageWorkflow', 'pageHistory',
      'chiefObjective', 'chiefRunBtn', 'approvalListArea', 'autonomyArea', 'historyListArea', 'storeMetricGrid']) {
      assert.ok(html.includes(`id="${id}"`), `existing ${id} is preserved`);
    }
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
    assert.ok(js.includes("apiFetch('/approvals/pending')"));
    assert.ok(js.includes('chiefRunBtn.click()'), 'Ask the Chief hands off to the existing Chief flow');
    assert.ok(/chief:\s*'\/orchestrate\/approve'/.test(js) && /autonomous_cycle:\s*'\/autonomy\/approvals\/decide'/.test(js), 'decisions go only to the two existing endpoints');
    assert.ok(!/approved:\s*true/.test(js), 'the page never sends an approved flag');
    assert.ok(!/BEGIN PRIVATE KEY|privateKey/.test(js), 'the page never handles a private key');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
