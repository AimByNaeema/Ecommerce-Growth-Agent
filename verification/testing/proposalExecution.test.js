'use strict';

// PROPOSAL EXECUTION - the Chief routing failure from the Dashboard test.
//
// THE FAILURE. After "Review the Shopify SEO issues you found ... Prepare the proposed changes for my
// approval" left pending SEO proposals, the owner asked:
//
//   "Apply the proposed SEO title and meta description only to the 200 Wild Flowers Clipart product
//    from the pending approval ..."
//
// and the Chief answered '"Apply the proposed SEO title" asks for something no capability here can do
// ("apply")'. ROOT CAUSE: objectiveInterpretation.js classified the clause by its verb alone - "apply" is
// a consequential verb no tool performs - and never looked at its object, an existing proposal held in
// durable approval state. And no tool could write Shopify SEO fields, so even a resolved request had
// nothing gated to execute.
//
// Every scenario goes through the Dashboard's own path (POST /session + /session/:id/message, then
// POST /orchestrate/approve with a REAL Ed25519 signature) on the real server and the real Chief.
// NO NETWORK, NO MODEL CALL. The only store write is the substituted updateProductSeo, recorded.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `proposal-execution-${name}-`));
}
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
  process.env[env] = tempDir(name);
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
delete process.env.VERCEL;
delete process.env.RESEARCH_CONTEXT_MAX_AGE_HOURS;
for (const key of [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY',
  'ETSY_API_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_OAUTH_REFRESH_TOKEN', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID',
  'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
]) {
  process.env[key] = '';
}
const STORE_A = 'fixture-store-a.myshopify.com';
process.env.SHOPIFY_STORE_DOMAIN = STORE_A;

const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

// A real Ed25519 key standing in for the HUMAN approver (see approvalSigningTestKey.js).
const { signApproval } = require('./approvalSigningTestKey');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

const clone = (value) => JSON.parse(JSON.stringify(value));

const INITIAL_PRODUCTS = [
  {
    id: 'gid://fixture/Product/200', title: '200 Wild Flowers Clipart Huge Bundle', handle: '200-wild-flowers-clipart',
    description: 'A huge bundle of 200 hand-painted wild flower clipart PNG files for invitations, stickers and print projects. Commercial use is included.',
    seo: { title: null, description: null },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['flowers', 'clipart'],
    variants: [{ id: 'v200', price: '5.99', inventoryQuantity: 9 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/118', title: '118 Watercolor Mega Clipart PNG Bundle', handle: '118-watercolor-mega-clipart',
    description: 'One hundred and eighteen watercolor clipart PNG images with transparent backgrounds for crafts and scrapbooking. Instant download.',
    seo: { title: null, description: null },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['watercolor'],
    variants: [{ id: 'v118', price: '4.99', inventoryQuantity: 5 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/1000', title: '1,000 Funny T-Shirt SVG Bundle', handle: '1000-funny-t-shirt-svg-bundle',
    description: 'A thousand funny t-shirt SVG cut files for Cricut and Silhouette machines, ready for shirts, mugs and tote bags. Personal use.',
    seo: { title: null, description: null },
    status: 'ACTIVE', productType: 'SVG', vendor: 'Fixture Studio', tags: ['svg'],
    variants: [{ id: 'v1000', price: '7.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/7', title: 'Christmas Invitation Template', handle: 'christmas-invitation-template',
    description: '', seo: null,
    status: 'DRAFT', productType: 'Template', vendor: 'Fixture Studio', tags: ['christmas'],
    variants: [{ id: 'v7', price: '6.99', inventoryQuantity: 12 }], collections: [], metafields: [],
  },
];
let storeProducts = clone(INITIAL_PRODUCTS);
const FIXTURE_ORDERS = [
  { id: 'gid://fixture/Order/1', createdAt: '2026-09-01T00:00:00Z', totalPrice: '5.99', currency: 'USD', lineItems: [] },
  { id: 'gid://fixture/Order/2', createdAt: '2026-09-05T00:00:00Z', totalPrice: '12.98', currency: 'USD', lineItems: [] },
];

const READ_CALLS = [];
const SEO_WRITES = [];
const TRIPWIRE_WRITES = [];
// 'apply' writes what it is sent; 'ignore' accepts and changes nothing; 'collateral' also renames the product.
let seoWriteMode = 'apply';
function substitute(name, fn) {
  shopifyClient[name] = fn;
}
const substituted = new Set(['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers', 'updateProductSeo']);
substitute('isConfigured', () => true);
substitute('getShopInfo', async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: STORE_A, email: null, apiVersion: 'fixture' }; });
substitute('getProducts', async () => { READ_CALLS.push('getProducts'); return clone(storeProducts); });
substitute('getCollections', async () => { READ_CALLS.push('getCollections'); return []; });
substitute('getInventoryLevels', async () => { READ_CALLS.push('getInventoryLevels'); return []; });
substitute('getOrders', async () => { READ_CALLS.push('getOrders'); return FIXTURE_ORDERS; });
substitute('getCustomers', async () => { READ_CALLS.push('getCustomers'); return []; });
substitute('updateProductSeo', async ({ productId, seoTitle, seoDescription, ...rest }) => {
  SEO_WRITES.push({ productId, seoTitle, seoDescription, other_arguments: Object.keys(rest).filter((key) => key !== 'businessId') });
  const product = storeProducts.find((entry) => entry.id === productId);
  if (!product) throw new Error('Fixture: no such product.');
  if (seoWriteMode !== 'ignore') product.seo = { title: seoTitle, description: seoDescription };
  if (seoWriteMode === 'collateral') product.title = `${product.title} (renamed)`;
  return { id: productId, seo: { title: seoTitle, description: seoDescription } };
});
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || substituted.has(name)) continue;
  if (/^(update|create|add|adjust|delete|remove|set|publish|write|mutate)/i.test(name)) {
    substitute(name, async () => {
      TRIPWIRE_WRITES.push(name);
      throw new Error(`STORE WRITE TRIPWIRE: ${name}`);
    });
  }
}

const approvalStore = require('../../approvals/approvalStore');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const dispatch = require('../../integrations/approvedCorrectionDispatch');
const seoUpdate = require('../../integrations/shopifyProductSeoUpdate');
const seoChangeProposal = require('../../agent/core/seoChangeProposal');
const proposalExecution = require('../../agent/core/proposalExecution');
const orchestrator = require('../../agent/core/orchestratorExecutionContract');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const researchContext = require('../../agent/core/researchContext');
const { getToolById } = require('../../tools/toolRegistry');
const { createApp } = require('../../server');

const ANALYSIS_REQUEST =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';
const SEO_PROPOSAL_REQUEST =
  'Review the Shopify SEO issues you found in the latest research. Propose the safest way to fix the highest-priority SEO issues, starting with the 3 most important products. Prepare the proposed changes for my approval, but do not make any changes yet.';
// The exact request the Chief refused, and the same request with the owner's usual follow-on sentences.
const EXACT_REQUEST =
  'Apply the proposed SEO title and meta description only to the 200 Wild Flowers Clipart product from the pending approval.';
const EXACT_REQUEST_FULL =
  'Apply the proposed SEO title and meta description only to the 200 Wild Flowers Clipart product from the pending approval. Do not change anything else. Verify the exact resulting Shopify values after the change.';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; }
  catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; }
  catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

function request(port, { method = 'GET', path: reqPath, body } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: reqPath, method,
        headers: Object.assign(
          { Authorization: `Bearer ${TEST_API_KEY}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
        ),
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, raw, data: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function askInNewSession(port, message) {
  const created = await request(port, { method: 'POST', path: '/session', body: { goal: message } });
  assert.strictEqual(created.status, 200);
  READ_CALLS.length = 0;
  const turn = await request(port, { method: 'POST', path: `/session/${created.data.session_id}/message`, body: { message } });
  assert.strictEqual(turn.status, 200, turn.raw.slice(0, 300));
  return { ...turn.data, reads: [...READ_CALLS], raw: turn.raw };
}

function resultOf(turn) {
  return runHistoryStore.getRunRecordById(turn.run_id).result;
}

function lastChiefText(turn) {
  const messages = turn.session.messages;
  return messages[messages.length - 1].text;
}

// The owner approves the ONE pending approval of a turn, with a real signature, on the Dashboard's route.
async function approveTurn(port, turn, decidedBy = 'owner@example.com') {
  const record = resultOf(turn).pending_approvals[0];
  const authorization = signApproval({ request: record, decision: 'approved', decidedBy });
  return request(port, {
    method: 'POST',
    path: '/orchestrate/approve',
    body: { runId: turn.run_id, approvalId: record.id, decision: 'approved', decidedBy, nonce: authorization.nonce, signature: authorization.signature },
  });
}

function productById(id) {
  return storeProducts.find((product) => product.id === id);
}

function assertNoApprovalAndNoWrite(result, writesBefore) {
  assert.ok(!Array.isArray(result.pending_approvals) || result.pending_approvals.length === 0, 'no approval may be created');
  assert.strictEqual(SEO_WRITES.length, writesBefore, 'nothing may be written');
  assert.deepStrictEqual(TRIPWIRE_WRITES, []);
}

async function main() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    // ---- The two earlier Dashboard turns that left the pending SEO proposals ---------------------
    await askInNewSession(port, ANALYSIS_REQUEST);
    const proposalTurn = await askInNewSession(port, SEO_PROPOSAL_REQUEST);
    const proposal = resultOf(proposalTurn).seo_change_proposal;
    const proposed = (prefix) => proposal.products.find((product) => product.product_reference.startsWith(prefix));
    const wild = proposed('200 Wild Flowers');
    const watercolor = proposed('118 Watercolor');
    const funny = proposed('1,000 Funny');

    test('SETUP: the SEO proposal turn left pending proposals for the three products, with the store they came from', () => {
      assert.ok(wild && watercolor && funny, JSON.stringify(proposal.products.map((product) => product.product_reference)));
      for (const product of [wild, watercolor, funny]) {
        assert.ok(product.approval_id, `${product.product_reference} has no approval`);
        assert.deepStrictEqual(product.proposed_changes.map((change) => change.shopify_field), ['seo.title', 'seo.description']);
        assert.strictEqual(product.execution_request.research_params.store_reference, researchContext.storeReferenceFor('shopify', STORE_A));
        assert.strictEqual(approvalStore.loadApprovalRecord(product.approval_id).approval_request.status, 'pending');
      }
      assert.strictEqual(SEO_WRITES.length, 0);
    });

    test('ROOT CAUSE: the router alone still reads the clause verb-first - the fix is the proposal it names, not a new verb', () => {
      const routed = orchestrator.planRouting(EXACT_REQUEST);
      assert.strictEqual(routed.status, 'clarification_required');
      assert.ok(routed.interpretation.some((entry) => entry.act === 'unsupported_action'));
      const decision = proposalExecution.decideProposalExecution({ objective: EXACT_REQUEST, routingResult: routed });
      assert.strictEqual(decision.applies, true);
      assert.deepStrictEqual(decision.additional_requests, []);
    });

    // ---- THE EXACT REQUEST ----------------------------------------------------------------------
    const exact = await askInNewSession(port, EXACT_REQUEST);
    const exactResult = resultOf(exact);
    const execution = exactResult.proposal_execution;
    const writeApproval = exactResult.pending_approvals && exactResult.pending_approvals[0];

    await testAsync('EXACT REQUEST: no longer refused - it resolves to the pending proposal for that product', async () => {
      assert.ok(!/no capability here can do/i.test(exact.raw), 'the Chief still refused the request');
      assert.strictEqual(exactResult.routing.status, 'planned');
      assert.strictEqual(execution.status, 'awaiting_approval');
      assert.strictEqual(execution.source_approval_id, wild.approval_id);
      assert.strictEqual(execution.product_id, wild.shopify_product_id);
      assert.strictEqual(execution.product_reference, wild.product_reference);
      assert.deepStrictEqual(execution.not_applied, []);
    });

    await testAsync('EXACT REQUEST: exactly the proposal\'s own SEO title and meta description are prepared - nothing from the wording', async () => {
      const expected = wild.proposed_changes.map((change) => ({ shopify_field: change.shopify_field, field: change.field, before: change.before, after: change.after }));
      assert.deepStrictEqual(execution.applied_changes, expected);
      assert.deepStrictEqual(writeApproval.execution_request.research_params.appliedChanges, expected);
      assert.strictEqual(writeApproval.execution_request.research_params.sourceApprovalId, wild.approval_id);
    });

    await testAsync('EXACT REQUEST: it is a consequential Shopify action - one externally_executable approval, compliance attached', async () => {
      assert.strictEqual(exactResult.pending_approvals.length, 1);
      assert.strictEqual(writeApproval.tool_id, 'shopify_product_seo_update');
      assert.strictEqual(writeApproval.classification, 'externally_executable');
      assert.strictEqual(writeApproval.specialist_id, 'product');
      assert.strictEqual(writeApproval.status, 'pending');
      const input = writeApproval.execution_request.compliance_input;
      assert.strictEqual(input.content_reference, wild.shopify_product_id);
      for (const change of wild.proposed_changes) assert.ok(input.content.includes(change.after));
      assert.ok(['PASS', 'REVIEW'].includes(writeApproval.execution_request.compliance.compliance_status));
      const stored = approvalStore.loadApprovalRecord(writeApproval.id);
      assert.strictEqual(stored.execution_state, 'awaiting_decision');
      assert.strictEqual(stored.platform, 'shopify');
      const plan = exactResult.routing.plan;
      assert.strictEqual(plan.length, 1);
      assert.strictEqual(plan[0].approvals[0].approval_request_id, writeApproval.id);
    });

    await testAsync('EXACT REQUEST: nothing is read or written, and the owner is told what waits for them', async () => {
      assert.deepStrictEqual(exact.reads, [], `the store was read: ${exact.reads.join(', ')}`);
      assert.strictEqual(SEO_WRITES.length, 0);
      assert.deepStrictEqual(TRIPWIRE_WRITES, []);
      assert.strictEqual(exact.owner_view.status, 'waiting_for_approval');
      assert.ok(exact.owner_view.proposed_actions[0].proposed_value.includes(wild.proposed_changes[0].after));
      const text = lastChiefText(exact);
      assert.ok(text.includes(writeApproval.id) && text.includes(wild.approval_id), text);
      assert.ok(/Nothing has been written to your store/.test(text), text);
      assert.ok(exactResult.audit_trail.some((event) => event.type === 'approval' && event.status === 'pending' && event.tool_id === 'shopify_product_seo_update'));
    });

    await testAsync('EXACT REQUEST (with "do not change anything else" and "verify ..."): resolved the same way', async () => {
      const full = await askInNewSession(port, EXACT_REQUEST_FULL);
      const result = resultOf(full);
      assert.strictEqual(result.proposal_execution.status, 'awaiting_approval', JSON.stringify(result.routing.reason));
      assert.strictEqual(result.proposal_execution.source_approval_id, wild.approval_id);
      assert.deepStrictEqual(result.proposal_execution.answered_by_execution, ['Verify the exact resulting Shopify values after the change.']);
      assert.strictEqual(SEO_WRITES.length, 0);
    });

    await testAsync('NO WRITE BEFORE APPROVAL: the pending approval cannot be executed by any path', async () => {
      const pending = approvalStore.loadApprovalRecord(writeApproval.id).approval_request;
      const direct = await dispatch.executeApprovedCorrection(pending);
      assert.strictEqual(direct.reason_code, 'approval_not_approved');
      const resumed = await orchestrator.resumeApprovedExecution(pending);
      assert.strictEqual(resumed.status, 'approval_required');
      // A forged in-memory "approved" copy is refused too: authority comes from durable, signed state.
      const forged = await dispatch.executeApprovedCorrection({ ...pending, status: 'approved', decided_by: 'me' });
      assert.strictEqual(forged.status, 'error');
      assert.strictEqual(SEO_WRITES.length, 0);
    });

    // ---- APPROVED: applied, independently verified, recorded ------------------------------------
    const approved = await approveTurn(port, exact);

    await testAsync('APPROVED: only the approved SEO title and meta description are written, once, to that product', async () => {
      assert.strictEqual(approved.status, 200, approved.raw.slice(0, 300));
      assert.strictEqual(SEO_WRITES.length, 1);
      const [title, description] = wild.proposed_changes;
      assert.deepStrictEqual(SEO_WRITES[0], { productId: wild.shopify_product_id, seoTitle: title.after, seoDescription: description.after, other_arguments: [] });
      assert.deepStrictEqual(TRIPWIRE_WRITES, []);
      const after = productById(wild.shopify_product_id);
      const before = INITIAL_PRODUCTS.find((product) => product.id === wild.shopify_product_id);
      assert.deepStrictEqual(after, { ...before, seo: { title: title.after, description: description.after } });
      for (const other of INITIAL_PRODUCTS.filter((product) => product.id !== wild.shopify_product_id)) {
        assert.deepStrictEqual(productById(other.id), other, `${other.title} changed`);
      }
    });

    await testAsync('APPROVED: the resulting Shopify values are independently re-read and verified', async () => {
      assert.strictEqual(approved.data.entity_verification.status, 'verified');
      assert.strictEqual(approved.data.owner_view.status, 'success');
      assert.strictEqual(approved.data.owner_view.verification_state, 'verified');
      const record = runHistoryStore.getRunRecordById(exact.run_id);
      const executionRecord = record.result.approval_executions[0];
      assert.strictEqual(executionRecord.tool_id, 'shopify_product_seo_update');
      assert.strictEqual(executionRecord.execution_status, 'success');
      assert.strictEqual(executionRecord.entity_verification.status, 'verified');
      assert.strictEqual(executionRecord.entity_id, wild.shopify_product_id);
      const { verifyExecution: _unused, ...verification } = require('../../reliability/executionVerification');
      const key = dispatch.checkCorrectionAlreadyVerified('shopify_product_seo_update', writeApproval.execution_request);
      assert.strictEqual(key.allowed, false, 'the verified change must be recorded under its idempotency key');
      const stored = verification.getVerificationRecord(key.idempotency_key);
      assert.strictEqual(stored.status, 'verified');
      assert.ok(stored.findings.every((finding) => finding.matched));
      assert.deepStrictEqual(stored.unintended_mutations, []);
    });

    await testAsync('APPROVED: the execution and audit trail are recorded on the run', async () => {
      const record = runHistoryStore.getRunRecordById(exact.run_id);
      const summaries = record.result.audit_trail.map((event) => event.summary || '');
      assert.ok(summaries.some((summary) => /Publish authorization GRANTED/.test(summary)));
      assert.ok(summaries.some((summary) => /Shopify SEO update ATTEMPTED/.test(summary)));
      assert.ok(summaries.some((summary) => /Shopify SEO update SUCCEEDED and was independently re-read/.test(summary)));
      assert.ok(record.result.audit_trail.some((event) => event.type === 'execution' && event.status === 'success' && event.tool_id === 'shopify_product_seo_update'));
      assert.strictEqual(approvalStore.loadApprovalRecord(writeApproval.id).execution_state, 'executed');
      assert.strictEqual(approved.data.owner_view.mutations.length, 1);
    });

    await testAsync('IDEMPOTENT: the same approval never writes twice, and the applied change is not asked for again', async () => {
      const again = await approveTurn(port, exact);
      assert.strictEqual(again.status, 400);
      const stored = approvalStore.loadApprovalRecord(writeApproval.id).approval_request;
      const direct = await dispatch.executeApprovedCorrection(stored);
      assert.ok(['already_completed', 'already_executed'].includes(direct.reason_code), direct.reason_code);
      const repeat = await askInNewSession(port, EXACT_REQUEST);
      const result = resultOf(repeat);
      assert.strictEqual(result.routing.clarification_type, 'proposal_already_applied');
      assertNoApprovalAndNoWrite(result, 1);
    });

    // ---- FAILURE AFTER APPROVAL: never reported as done -----------------------------------------
    await testAsync('STALE: the store changed after the proposal - nothing is written, and it is not reported as done', async () => {
      const turn = await askInNewSession(port, 'Apply the proposed SEO title and meta description to the 118 Watercolor Mega Clipart PNG Bundle product from the pending approval.');
      assert.strictEqual(resultOf(turn).proposal_execution.source_approval_id, watercolor.approval_id);
      productById(watercolor.shopify_product_id).seo = { title: 'Owner Edited Title', description: null };
      const response = await approveTurn(port, turn);
      assert.strictEqual(response.status, 200, response.raw.slice(0, 300));
      assert.strictEqual(SEO_WRITES.length, 1, 'a stale proposal must not be written');
      assert.strictEqual(response.data.entity_verification, null);
      assert.strictEqual(response.data.owner_view.status, 'failed');
      const audit = runHistoryStore.getRunRecordById(turn.run_id).result.audit_trail.map((event) => event.summary || '');
      assert.ok(audit.some((summary) => /store changed since the proposal/.test(summary)));
      productById(watercolor.shopify_product_id).seo = { title: null, description: null };
    });

    await testAsync('UNCONFIRMED: Shopify accepts but the re-read does not show the values - verification fails, never success', async () => {
      const turn = await askInNewSession(port, 'Apply the proposed SEO title to the 1,000 Funny T-Shirt SVG Bundle product from the pending approval.');
      assert.deepStrictEqual(resultOf(turn).proposal_execution.applied_changes.map((change) => change.shopify_field), ['seo.title']);
      seoWriteMode = 'ignore';
      try {
        const response = await approveTurn(port, turn);
        assert.strictEqual(SEO_WRITES.length, 2);
        assert.strictEqual(response.data.entity_verification.status, 'failed');
        assert.notStrictEqual(response.data.owner_view.status, 'success');
        assert.deepStrictEqual(productById(funny.shopify_product_id).seo, { title: null, description: null });
      } finally {
        seoWriteMode = 'apply';
      }
    });

    await testAsync('NO OTHER CHANGE: a re-read showing any other field changed is unconfirmed', async () => {
      const execReq = orchestrator.createExecutionRequest(
        'Apply the proposed SEO title to the 118 Watercolor Mega Clipart PNG Bundle product from the pending approval.',
        { category: 'products', tool: getToolById('shopify_product_seo_update') },
        {
          platform: 'shopify', proposal_kind: 'seo_metadata_application', productId: watercolor.shopify_product_id,
          productReference: watercolor.product_reference, sourceApprovalId: watercolor.approval_id,
          storeReference: researchContext.storeReferenceFor('shopify', STORE_A),
          appliedChanges: [watercolor.proposed_changes[0]].map(({ shopify_field, field, before, after }) => ({ shopify_field, field, before, after })),
        },
        null
      );
      const tracker = { requests: [] };
      const outcome = await orchestrator.executeSelectedCapability(execReq, { tokensUsedThisRun: 0 }, tracker);
      assert.strictEqual(outcome.status, 'approval_required', outcome.error);
      const record = tracker.requests[0];
      const decided = decideApprovalRequest(tracker.requests, record.id, {
        decision: 'approved', decidedBy: 'owner@example.com',
        authorization: signApproval({ request: record, decision: 'approved', decidedBy: 'owner@example.com' }),
      });
      seoWriteMode = 'collateral';
      try {
        const result = await seoUpdate.applyApprovedProductSeo({
          requests: decided, requestId: record.id, contentReference: watercolor.shopify_product_id,
          productId: watercolor.shopify_product_id, appliedChanges: execReq.research_params.appliedChanges,
        });
        assert.strictEqual(result.succeeded, false);
        assert.strictEqual(result.status, 'unconfirmed');
        assert.ok(/title changed although it was not approved/.test(result.reason), result.reason);
      } finally {
        seoWriteMode = 'apply';
        storeProducts = storeProducts.map((product) => (product.id === watercolor.shopify_product_id ? clone(INITIAL_PRODUCTS.find((entry) => entry.id === product.id)) : product));
      }
    });

    // ---- REJECTION: no approval, no write -------------------------------------------------------
    const writesNow = () => SEO_WRITES.length;

    await testAsync('REJECTED: a product with no pending proposal - a precise question back, not "apply is unsupported"', async () => {
      const before = writesNow();
      const turn = await askInNewSession(port, 'Apply the proposed SEO title to the Christmas Invitation Template product from the pending approval.');
      const result = resultOf(turn);
      assert.strictEqual(result.routing.clarification_type, 'proposal_not_resolved');
      assert.ok(/No pending SEO proposal is for the product named/.test(result.routing.reason), result.routing.reason);
      assert.ok(!/no capability here can do/.test(result.routing.reason));
      assertNoApprovalAndNoWrite(result, before);
    });

    await testAsync('REJECTED: a product name matching two proposals is ambiguous - nothing is guessed', async () => {
      const before = writesNow();
      const turn = await askInNewSession(port, 'Apply the proposed SEO title to the Clipart product from the pending approval.');
      const result = resultOf(turn);
      assert.strictEqual(result.routing.clarification_type, 'proposal_ambiguous');
      assert.strictEqual(result.proposal_execution.candidates.length, 2);
      assertNoApprovalAndNoWrite(result, before);
    });

    await testAsync('REJECTED: another operation in the same message is not silently dropped', async () => {
      const before = writesNow();
      const turn = await askInNewSession(port, 'Apply the proposed SEO title to the 118 Watercolor Mega Clipart PNG Bundle product from the pending approval and write a new marketing campaign for it.');
      const result = resultOf(turn);
      assert.strictEqual(result.routing.clarification_type, 'proposal_execution_mixed');
      assertNoApprovalAndNoWrite(result, before);
    });

    await testAsync('REJECTED: the product\'s own title is never changed by an SEO proposal', async () => {
      const before = writesNow();
      const turn = await askInNewSession(port, 'Apply the proposed product title to the 118 Watercolor Mega Clipart PNG Bundle product from the pending approval.');
      const result = resultOf(turn);
      assert.strictEqual(result.routing.clarification_type, 'proposal_not_resolved');
      assert.ok(/never changes the product title/.test(result.routing.reason), result.routing.reason);
      assertNoApprovalAndNoWrite(result, before);
    });

    await testAsync('NO REGRESSION: "apply" with no proposal as its object is still refused as unsupported', async () => {
      const before = writesNow();
      const turn = await askInNewSession(port, 'Apply a 20% discount to all my Shopify products.');
      const result = resultOf(turn);
      assert.strictEqual(result.routing.status, 'clarification_required');
      assert.ok(/no capability here can do \("Apply"\)|no capability here can do \("apply"\)/i.test(result.routing.reason), result.routing.reason);
      assert.strictEqual(result.proposal_execution, undefined);
      assertNoApprovalAndNoWrite(result, before);
    });

    await testAsync('NO REGRESSION: proposing SEO changes is still a proposal, not an execution', async () => {
      const routed = orchestrator.planRouting(SEO_PROPOSAL_REQUEST);
      assert.strictEqual(proposalExecution.decideProposalExecution({ objective: SEO_PROPOSAL_REQUEST, routingResult: routed }).applies, false);
      assert.strictEqual(proposalExecution.referencesExistingProposal('Apply a 20% discount to all products'), false);
      assert.strictEqual(proposalExecution.referencesExistingProposal('Apply the proposed meta description'), true);
    });

    await testAsync('REJECTED: a tampered value, another business, or no named proposal never becomes an approval', async () => {
      const base = orchestrator.createExecutionRequest(
        'Update the SEO title on the 118 Watercolor Mega Clipart PNG Bundle product.',
        { category: 'products', tool: getToolById('shopify_product_seo_update') },
        {
          platform: 'shopify', productId: watercolor.shopify_product_id, sourceApprovalId: watercolor.approval_id,
          storeReference: researchContext.storeReferenceFor('shopify', STORE_A),
          appliedChanges: [{ ...watercolor.proposed_changes[0], after: 'Buy Now Best Clipart Ever' }],
        },
        null
      );
      const cases = [
        [base, 'change_differs_from_proposal'],
        [{ ...base, research_params: { ...base.research_params, sourceApprovalId: undefined } }, 'source_not_named'],
        [{ ...base, research_params: { ...base.research_params, appliedChanges: [{ shopify_field: 'title', before: '', after: 'X' }] } }, 'changes_invalid'],
      ];
      for (const [executionRequest, reasonCode] of cases) {
        const tracker = { requests: [] };
        const outcome = await orchestrator.executeSelectedCapability(executionRequest, { tokensUsedThisRun: 0 }, tracker);
        assert.strictEqual(outcome.status, 'denied', `${reasonCode}: ${outcome.status}`);
        assert.strictEqual(outcome.source_proposal, reasonCode);
        assert.strictEqual(tracker.requests.length, 0);
      }
      const otherBusiness = seoUpdate.verifySeoProposalSource({ ...base, business_id: 'beta-co', research_params: { ...base.research_params, appliedChanges: [watercolor.proposed_changes[0]] } });
      assert.strictEqual(otherBusiness.reason_code, 'source_not_found');
      assert.strictEqual(proposalExecution.resolveProposalExecution({ objective: EXACT_REQUEST, businessId: 'beta-co' }).status, 'not_resolved');
    });

    await testAsync('REJECTED: another store, or no stored proposals at all', async () => {
      const otherStore = proposalExecution.resolveProposalExecution({ objective: EXACT_REQUEST, storeReference: researchContext.storeReferenceFor('shopify', 'fixture-store-b.myshopify.com') });
      assert.strictEqual(otherStore.status, 'not_resolved');
      assert.ok(otherStore.considered.other_store > 0);
      const empty = proposalExecution.resolveProposalExecution({ objective: EXACT_REQUEST, storeDir: tempDir('empty-approvals') });
      assert.strictEqual(empty.status, 'not_resolved');
      assert.ok(/no SEO change proposal waiting/.test(empty.reason), empty.reason);
    });

    await testAsync('WITHDRAWN: a proposal cancelled after the write approval was created is never applied', async () => {
      const turn = await askInNewSession(port, 'Apply the proposed meta description to the 1,000 Funny T-Shirt SVG Bundle product from the pending approval.');
      assert.strictEqual(resultOf(turn).proposal_execution.status, 'awaiting_approval');
      approvalStore.cancelStoredApproval(funny.approval_id);
      const before = writesNow();
      const response = await approveTurn(port, turn);
      assert.strictEqual(response.status, 200, response.raw.slice(0, 300));
      assert.strictEqual(SEO_WRITES.length, before);
      const executionRecord = runHistoryStore.getRunRecordById(turn.run_id).result.approval_executions[0];
      assert.strictEqual(executionRecord.execution_status, 'error');
      const again = resultOf(await askInNewSession(port, 'Apply the proposed meta description to the 1,000 Funny T-Shirt SVG Bundle product from the pending approval.'));
      assert.strictEqual(again.routing.clarification_type, 'proposal_not_resolved');
      assertNoApprovalAndNoWrite(again, before);
    });

    test('GATES: the SEO update is a gated correction, never scheduled, never scored from free text', () => {
      assert.strictEqual(dispatch.isCorrectionTool('shopify_product_seo_update'), true);
      assert.strictEqual(dispatch.requiresSourceProposal('shopify_product_seo_update'), true);
      assert.strictEqual(dispatch.requiresSourceProposal('shopify_vendor_correction'), false);
      assert.strictEqual(seoUpdate.SOURCE_PROPOSAL_KIND, seoChangeProposal.PROPOSAL_KIND);
      assert.strictEqual(seoUpdate.SOURCE_PROPOSAL_TOOL_ID, seoChangeProposal.PROPOSAL_TOOL_ID);
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'autonomousCycle.js'), 'utf8');
      assert.ok(source.includes('requiresSourceProposal(toolId)'), 'the autonomous cycle must refuse to queue it');
      assert.deepStrictEqual(FETCH_CALLS, []);
      assert.deepStrictEqual(TRIPWIRE_WRITES, []);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
