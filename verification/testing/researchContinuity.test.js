'use strict';

// RESEARCH CONTINUITY - the Chief session-context failure from the Dashboard test.
//
// THE FAILURE. Session A: "Analyse my Shopify store using real Shopify data. ..." completed with
// Product, SEO and Analytics & Optimization results. Session B (a NEW Dashboard session): "Using
// the real Shopify data you just analysed, identify exactly the 10 highest-priority sales/growth
// opportunities. Rank them from #1 (highest priority) to #10. ..." -> "This session has no
// numbered results yet, so there is nothing for #1, #10 to refer to."
//
// ROOT CAUSE, pinned here:
//   1. commandCenterSession.js read the requested numbering scale ("from #1 ... to #10") as
//      citations of earlier results, and resolved citations only inside the current session.
//   2. Completed research lived in the run history store, but nothing recorded which business and
//      store it belonged to, whether it was complete, or when it was produced - so no later session
//      could find or trust it. The Chief had no way to answer from it.
//
// Every scenario goes through the Dashboard's own path (POST /session + /session/:id/message on the
// real server and the real Chief). NO NETWORK, NO MODEL CALL, NO STORE WRITE.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `research-continuity-${name}-`));
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
// Hermetic wherever it runs: the provider clients never overwrite an already-set variable when they
// load .env, so empty values keep every external provider unconfigured.
for (const key of [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY',
  'ETSY_API_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_OAUTH_REFRESH_TOKEN', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID',
  'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
]) {
  process.env[key] = '';
}
// The connected store's domain is what identifies the store. Fixture domains only.
const STORE_A = 'fixture-store-a.myshopify.com';
const STORE_B = 'fixture-store-b.myshopify.com';
process.env.SHOPIFY_STORE_DOMAIN = STORE_A;

const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');

const FIXTURE_PRODUCTS = [
  {
    id: 'gid://fixture/Product/1', title: 'Watercolor Clipart PNG Bundle', handle: 'watercolor-clipart-png-bundle',
    description: 'A bundle of 118 hand-painted watercolor clipart PNG files for crafts, invitations and print projects.',
    seo: { title: 'Watercolor Clipart PNG Bundle | Fixture Studio', description: 'Hand-painted watercolor clipart PNG files for crafts, invitations and print-on-demand projects.' },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['png', 'watercolor'],
    variants: [{ id: 'v1', price: '4.99', inventoryQuantity: 5 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/2', title: 'Halloween SVG Cut Files', handle: 'halloween-svg-cut-files',
    description: 'Spooky SVG cut files.', seo: { title: null, description: null },
    status: 'ACTIVE', productType: '', vendor: 'Fixture Studio', tags: [],
    variants: [{ id: 'v2', price: '2.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/3', title: 'Christmas Invitation Template', handle: 'christmas-invitation-template',
    description: '', seo: null,
    status: 'DRAFT', productType: 'Template', vendor: 'Fixture Studio', tags: ['christmas'],
    variants: [{ id: 'v3', price: '6.99', inventoryQuantity: 12 }], collections: [], metafields: [],
  },
];
const FIXTURE_ORDERS = [
  { id: 'gid://fixture/Order/1', createdAt: '2026-09-01T00:00:00Z', totalPrice: '4.99', currency: 'USD', lineItems: [] },
  { id: 'gid://fixture/Order/2', createdAt: '2026-09-05T00:00:00Z', totalPrice: '9.98', currency: 'USD', lineItems: [] },
];

let productReadFails = false;
const READ_CALLS = [];
const WRITE_CALLS = [];
function substitute(name, fn) {
  shopifyClient[name] = fn;
}
const substituted = new Set(['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers']);
substitute('isConfigured', () => true);
substitute('getShopInfo', async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: STORE_A, email: null, apiVersion: 'fixture' }; });
substitute('getProducts', async () => {
  READ_CALLS.push('getProducts');
  if (productReadFails) throw new Error('Fixture: the product read is unavailable.');
  return FIXTURE_PRODUCTS;
});
substitute('getCollections', async () => { READ_CALLS.push('getCollections'); return []; });
substitute('getInventoryLevels', async () => { READ_CALLS.push('getInventoryLevels'); return []; });
substitute('getOrders', async () => { READ_CALLS.push('getOrders'); return FIXTURE_ORDERS; });
substitute('getCustomers', async () => { READ_CALLS.push('getCustomers'); return []; });
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || substituted.has(name)) continue;
  if (/^(update|create|add|adjust|delete|remove|set|publish|write|mutate)/i.test(name)) {
    substitute(name, async () => {
      WRITE_CALLS.push(name);
      throw new Error(`STORE WRITE TRIPWIRE: ${name}`);
    });
  }
}

const researchContext = require('../../agent/core/researchContext');
const prioritization = require('../../agent/core/storeOpportunityPrioritization');
const { referencesPriorWork } = require('../../agent/core/objectiveInterpretation');
const commandCenterSession = require('../../agent/core/commandCenterSession');
const commandCenterSessionStore = require('../../agent/core/commandCenterSessionStore');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { createApp } = require('../../server');

const ANALYSIS_REQUEST =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';
const FOLLOW_UP_REQUEST =
  'Using the real Shopify data you just analysed, identify exactly the 10 highest-priority sales/growth opportunities. Rank them from #1 (highest priority) to #10. For each opportunity give: the specific issue/opportunity, the real Shopify evidence behind it, why it matters, estimated impact if the data supports it, and the recommended first action. Separate quick wins from higher-effort opportunities. Do not make any changes.';

// The later Dashboard request that went PARTIAL in production: it refers to existing research by
// possession ("you already have"), and its clauses routed to Research (trends) and Product
// (catalogue expansion) although neither was asked to produce anything.
const EXISTING_RESEARCH_REQUEST =
  'Review the most recent Shopify research you already have for this store. Without doing another full store analysis unless necessary, identify the highest-priority actions that could realistically increase sales. Rank the top opportunities by priority using only real Shopify evidence. For each one, give the evidence, expected business impact only where supported by data, and the first recommended action. Do not make any changes.';

// The later Dashboard request the Chief answered with "could belong to more than one capability":
// a follow-up that reviews earlier SEO findings and asks for changes to be PROPOSED for approval.
const SEO_PROPOSAL_REQUEST =
  'Review the Shopify SEO issues you found in the latest research. Propose the safest way to fix the highest-priority SEO issues, starting with the 3 most important products. Prepare the proposed changes for my approval, but do not make any changes yet.';

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

// One Dashboard "Ask the Chief" in a NEW session, exactly as public/dashboard.js sends it.
async function askInNewSession(port, message) {
  const created = await request(port, { method: 'POST', path: '/session', body: { goal: message } });
  assert.strictEqual(created.status, 200);
  READ_CALLS.length = 0;
  const turn = await request(port, { method: 'POST', path: `/session/${created.data.session_id}/message`, body: { message } });
  assert.strictEqual(turn.status, 200, turn.raw.slice(0, 300));
  return { ...turn.data, reads: [...READ_CALLS], raw: turn.raw };
}

function freshRunStore() {
  process.env.RUN_HISTORY_STORE_DIR = tempDir('runs');
}

function lastChiefText(turn) {
  const messages = turn.session.messages;
  return messages[messages.length - 1].text;
}

function rewriteRecord(runId, mutate) {
  const record = runHistoryStore.getRunRecordById(runId);
  mutate(record);
  runHistoryStore.saveRunRecord(record);
}

async function main() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    // ---- I / A / B / J: the exact two-session Dashboard scenario ----------------------------
    freshRunStore();
    const sessionA = await askInNewSession(port, ANALYSIS_REQUEST);
    const sessionB = await askInNewSession(port, FOLLOW_UP_REQUEST);

    await testAsync('I. SESSION A: the store analysis completes with Product, SEO and Analytics on real store reads', async () => {
      assert.strictEqual(sessionA.owner_view.status, 'success');
      assert.deepStrictEqual(sessionA.owner_view.specialists_used, ['Product', 'SEO', 'Analytics & Optimization']);
      assert.ok(sessionA.reads.includes('getProducts') && sessionA.reads.includes('getOrders'));
      const record = runHistoryStore.getRunRecordById(sessionA.run_id);
      const stamp = record.research_context;
      assert.strictEqual(stamp.authoritative, true, JSON.stringify(stamp.not_authoritative_reasons));
      assert.strictEqual(stamp.platform, 'shopify');
      assert.strictEqual(stamp.real_store_data, true);
      assert.strictEqual(stamp.business_id, null);
      assert.strictEqual(stamp.store_reference, researchContext.storeReferenceFor('shopify', STORE_A));
      assert.deepStrictEqual(stamp.specialists.map((entry) => entry.id), ['product', 'seo', 'analytics_optimization']);
      assert.ok(Number.isFinite(Date.parse(stamp.produced_at)));
      // Provenance names the store by an opaque reference, never by its domain.
      assert.ok(!JSON.stringify(stamp).includes(STORE_A));
    });

    await testAsync('I. SESSION B: the exact follow-up in a NEW session no longer dead-ends', async () => {
      assert.strictEqual(sessionB.clarification, null);
      assert.strictEqual(sessionB.error, null);
      assert.ok(!/no numbered results yet/i.test(sessionB.raw));
      assert.strictEqual(sessionB.owner_view.status, 'success');
    });

    await testAsync('A. the previous compatible research is automatically reused - no store read, no rerun', async () => {
      assert.deepStrictEqual(sessionB.reads, [], `Session B read the store again: ${sessionB.reads.join(', ')}`);
      const continuity = sessionB.owner_view.research_continuity;
      assert.strictEqual(continuity.mode, 'reused');
      assert.strictEqual(continuity.source_run_id, sessionA.run_id);
      assert.strictEqual(continuity.platform, 'shopify');
      assert.strictEqual(continuity.real_store_data, true);
      assert.deepStrictEqual(continuity.specialists, ['Product', 'SEO', 'Analytics & Optimization']);
      const record = runHistoryStore.getRunRecordById(sessionB.run_id);
      assert.ok(record.result.routing.plan.every((step) => step.reused_research && step.reused_research.run_id === sessionA.run_id));
      assert.ok(record.result.audit_trail.some((event) => event.type === 'data_access' && event.status === 'reused'));
      assert.strictEqual(record.result.usage_summary.totals ? record.result.usage_summary.totals.tool_calls || 0 : 0, 0);
      assert.ok(lastChiefText(sessionB).includes(`Using completed research run ${sessionA.run_id}`));
    });

    await testAsync('B. the Chief ranks the opportunities from #1, with evidence, why, impact and first action, split by effort', async () => {
      const priorities = runHistoryStore.getRunRecordById(sessionB.run_id).result.store_opportunity_priorities;
      const ranked = priorities.opportunities;
      assert.ok(ranked.length >= 1 && ranked.length <= 10);
      assert.deepStrictEqual(ranked.map((entry) => entry.rank), ranked.map((_, index) => index + 1));
      for (const entry of ranked) {
        assert.ok(entry.issue && entry.why_it_matters && entry.first_action, `rank ${entry.rank} is incomplete`);
        assert.ok(entry.evidence.length > 0 && entry.evidence[0].includes('real store product'));
        assert.strictEqual(entry.estimated_impact.audited_products, FIXTURE_PRODUCTS.length);
        assert.ok(entry.estimated_impact.affected_products >= 1);
        assert.strictEqual(entry.estimated_impact.revenue, null, 'no revenue impact may be invented');
        assert.ok(['quick_win', 'higher_effort'].includes(entry.effort));
        // Every product named is a real product from the store read.
        for (const name of entry.affected_products) assert.ok(FIXTURE_PRODUCTS.some((product) => product.title === name));
      }
      assert.ok(priorities.quick_wins.length > 0 && priorities.higher_effort.length > 0);
      assert.deepStrictEqual([...priorities.quick_wins, ...priorities.higher_effort].sort((a, b) => a - b), ranked.map((entry) => entry.rank));
      // Fewer than 10 supported opportunities is said, never padded.
      assert.ok(priorities.limitations.some((line) => /not padded to 10/.test(line)));
      // The DRAFT product is surfaced from the real store read.
      assert.ok(ranked.some((entry) => /published/i.test(entry.issue) && entry.affected_products.includes('Christmas Invitation Template')));
      // The duplicated "[Missing information] ... is missing" restatement is folded, not listed twice.
      assert.ok(!ranked.some((entry) => entry.dimension === 'Missing information' && /meta_description/.test(entry.issue)));
      // The owner view and the conversation show the ranking; each becomes a numbered result.
      assert.strictEqual(sessionB.owner_view.recommendations.length, ranked.length);
      assert.ok(sessionB.owner_view.recommendations[0].startsWith('#1 ['));
      const text = lastChiefText(sessionB);
      assert.ok(text.includes('Quick wins:') && text.includes('Higher effort:'));
      assert.deepStrictEqual(sessionB.session.specialist_results.map((entry) => entry.label), ranked.map((entry) => entry.title));
    });

    await testAsync('J. the follow-up is strictly read-only: zero store writes, zero approvals, zero network', async () => {
      assert.strictEqual(WRITE_CALLS.length, 0);
      assert.strictEqual(FETCH_CALLS.length, 0);
      const record = runHistoryStore.getRunRecordById(sessionB.run_id);
      assert.deepStrictEqual(record.result.pending_approvals, []);
      assert.deepStrictEqual(sessionB.owner_view.mutations, []);
      assert.strictEqual(sessionB.owner_view.approval_state, 'not_needed');
      assert.strictEqual(record.result.tokens_used, 0);
      const approvals = await request(port, { path: '/approvals/pending' });
      assert.deepStrictEqual(approvals.data.approvals, []);
      assert.ok(lastChiefText(sessionB).includes('Nothing was changed in your store.'));
    });

    await testAsync('J. a change request never rides on prior research - the existing mutation chain handles it', async () => {
      const turn = await askInNewSession(port, 'Using the data you just analysed, fix the vendor on Halloween SVG Cut Files.');
      const record = turn.run_id ? runHistoryStore.getRunRecordById(turn.run_id) : null;
      assert.ok(!record || !record.result.research_continuity, 'a change request must not be answered from research');
      assert.ok(!record || !record.result.store_opportunity_priorities);
      assert.strictEqual(WRITE_CALLS.length, 0);
    });

    await testAsync('G. freshness cannot be renewed by reuse: the continued run keeps the ORIGINAL production time', async () => {
      const original = runHistoryStore.getRunRecordById(sessionA.run_id).research_context;
      const continued = runHistoryStore.getRunRecordById(sessionB.run_id).research_context;
      assert.strictEqual(continued.produced_at, original.produced_at);
    });

    // ---- K: "the research you already have" - reuse it, no trends, no fresh Product search ----
    await testAsync('K. the sales-priority request reuses existing research: no trends step, no fresh Product read, not PARTIAL', async () => {
      const writesBefore = WRITE_CALLS.length;
      const fetchesBefore = FETCH_CALLS.length;
      const turn = await askInNewSession(port, EXISTING_RESEARCH_REQUEST);
      assert.strictEqual(turn.clarification, null);
      assert.strictEqual(turn.owner_view.status, 'success', `owner status was ${turn.owner_view.status}`);
      assert.strictEqual(turn.owner_view.research_continuity.mode, 'reused');
      assert.deepStrictEqual(turn.reads, [], `the store was read again: ${turn.reads.join(', ')}`);
      const record = runHistoryStore.getRunRecordById(turn.run_id);
      const plan = record.result.routing.plan;
      assert.deepStrictEqual(plan.map((step) => step.inputs && step.inputs.capability_id), ['product_discovery', 'seo_quality_check', 'sales']);
      assert.ok(plan.every((step) => step.completion_state === 'complete' && step.reused_research));
      assert.ok(!plan.some((step) => step.inputs && ['trend_research', 'catalogue_expansion_opportunities'].includes(step.inputs.capability_id)));
      assert.ok(record.result.audit_trail.some((event) => /reads, ranks or refers to the research/.test(event.summary || '')));
      assert.ok(record.result.store_opportunity_priorities.opportunities.length > 0);
      assert.ok(turn.owner_view.recommendations[0].startsWith('#1 ['));
      assert.deepStrictEqual(record.result.pending_approvals, []);
      assert.strictEqual(WRITE_CALLS.length, writesBefore);
      assert.strictEqual(FETCH_CALLS.length, fetchesBefore);
    });

    await testAsync('K. a continuation that asks for a new draft still gets that specialist, on top of the reused research', async () => {
      const turn = await askInNewSession(port, 'Based on your existing research, write a marketing campaign plan for the top opportunity. Do not make any changes.');
      const record = runHistoryStore.getRunRecordById(turn.run_id);
      const plan = record.result.routing.plan;
      assert.strictEqual(record.result.research_continuity.mode, 'reused');
      assert.ok(plan.some((step) => step.selected_specialist.id === 'marketing' && !step.reused_research), 'the requested plan must get its own Marketing step');
      assert.ok(!plan.some((step) => step.selected_specialist.id === 'research'), 'the reference to the research must not start Research');
      assert.deepStrictEqual(turn.reads, []);
      assert.strictEqual(WRITE_CALLS.length, 0);
    });

    // ---- L: SEO follow-up -> proposed before/after changes -> approval, zero writes -------------
    await testAsync('L. the SEO follow-up is resolved in context: no clarification, research reused, changes proposed for approval', async () => {
      const writesBefore = WRITE_CALLS.length;
      const fetchesBefore = FETCH_CALLS.length;
      const turn = await askInNewSession(port, SEO_PROPOSAL_REQUEST);
      assert.strictEqual(turn.clarification, null);
      assert.ok(!/more than one capability/.test(turn.raw), 'the follow-up must not be sent back as ambiguous');
      assert.deepStrictEqual(turn.reads, [], `the store was read again: ${turn.reads.join(', ')}`);
      const record = runHistoryStore.getRunRecordById(turn.run_id);
      const result = record.result;
      assert.strictEqual(result.research_continuity.mode, 'reused');
      assert.deepStrictEqual(result.routing.plan.map((step) => step.inputs && step.inputs.capability_id), ['product_discovery', 'seo_quality_check', 'sales']);
      assert.ok(!result.routing.plan.some((step) => step.selected_specialist.id === 'research'));

      const proposal = result.seo_change_proposal;
      assert.strictEqual(proposal.requested_products, 3);
      assert.ok(proposal.products.length >= 1 && proposal.products.length <= 3);
      assert.ok(proposal.seo_issues.length > 0 && proposal.seo_issues[0].issue.startsWith('[Metadata]'));
      // Published products come first; every change is a real before/after from the product's own text.
      const halloween = proposal.products.find((product) => product.product_reference === 'Halloween SVG Cut Files');
      assert.ok(halloween, 'the published product with missing SEO fields must be proposed');
      assert.strictEqual(proposal.products[0].status, 'ACTIVE');
      const titleChange = halloween.proposed_changes.find((change) => change.shopify_field === 'seo.title');
      assert.deepStrictEqual([titleChange.before, titleChange.after, titleChange.derived_from], ['', 'Halloween SVG Cut Files', 'product title']);
      // A 21-character description cannot yield a meta description without inventing text.
      assert.ok(!halloween.proposed_changes.some((change) => change.shopify_field === 'seo.description'));
      assert.ok(halloween.not_proposed.some((entry) => /meta_description/.test(entry.issue) && /without writing new content/.test(entry.reason)));
      assert.ok(halloween.not_proposed.some((entry) => /product type/i.test(entry.issue)));
      assert.ok(proposal.limitations.some((line) => /no tool that writes Shopify SEO fields/.test(line)));

      // Approval required: one pending approval per eligible proposal, persisted, never a store-write tool.
      const pending = result.pending_approvals;
      assert.strictEqual(pending.length, proposal.products.filter((product) => product.approval_eligible).length);
      for (const request of pending) {
        assert.strictEqual(request.status, 'pending');
        assert.strictEqual(request.classification, 'approval_required');
        assert.strictEqual(request.tool_id, 'seo_quality_check');
        assert.strictEqual(require('../../agent/core/mutationIntent').isCorrectionTool(request.tool_id), false);
        assert.ok(request.execution_request.compliance && request.execution_request.compliance.compliance_status !== 'BLOCK');
      }
      const stored = await request(port, { path: '/approvals/pending' });
      for (const approval of pending) assert.ok(stored.raw.includes(approval.id), `approval ${approval.id} must be durable`);
      assert.ok(result.audit_trail.some((event) => event.type === 'approval' && event.status === 'pending'));

      assert.strictEqual(turn.owner_view.status, 'waiting_for_approval');
      assert.strictEqual(turn.owner_view.approval_state, 'pending');
      assert.strictEqual(turn.owner_view.proposed_actions.length, pending.length);
      assert.ok(turn.owner_view.proposed_actions[0].proposed_value.includes('seo.title: "" → "'));
      assert.ok(/does not write to the store/.test(turn.owner_view.proposed_actions[0].what_changes));
      assert.deepStrictEqual(turn.owner_view.mutations, []);
      assert.strictEqual(turn.session.status, 'waiting_for_approval');
      assert.ok(lastChiefText(turn).includes('before "" -> after "Halloween SVG Cut Files"'));

      assert.strictEqual(WRITE_CALLS.length, writesBefore, 'zero Shopify writes');
      assert.strictEqual(FETCH_CALLS.length, fetchesBefore, 'zero network calls');

      // What approving would run: the read-only audit of the proposed values - still no store write.
      const { runSeoQualityCheckTool } = require('../../tools/seoQualityCheckTool');
      const reaudit = runSeoQualityCheckTool(pending[0].execution_request.research_params);
      assert.strictEqual(reaudit.status, 'success');
      assert.ok(!reaudit.result.checks[0].result.recommendations.includes('[Metadata] Add a meta_title.'));
      assert.strictEqual(WRITE_CALLS.length, writesBefore);
    });

    await testAsync('L. without research context the same request still asks - the resolution is context-aware, not a word patch', async () => {
      const contract = require('../../agent/core/orchestratorExecutionContract');
      const bare = await contract.runOrchestratorContract(SEO_PROPOSAL_REQUEST);
      assert.strictEqual(bare.routing.status, 'clarification_required');
      assert.strictEqual(bare.routing.clarification_type, 'ambiguous');
      // And an ambiguity that is NOT a reference to earlier research still asks, even with context.
      const decision = researchContext.decideResearchContinuity({
        objective: 'Review the SEO research you found and compare it with market trends.',
        routingResult: {
          status: 'clarification_required',
          clarification_type: 'ambiguous',
          interpretation: [
            { clause: 'Review the SEO research you found', act: 'inform', disposition: 'task', target: 'seo' },
            { clause: 'compare it with market trends', act: 'inform', disposition: 'ambiguous', target: null },
          ],
        },
        researchContext: { platform: 'shopify', research: null, considered: {} },
      });
      assert.strictEqual(decision.applies, false);
    });

    test('L. change intent is resolved from the whole objective: proposal, change or none', () => {
      assert.strictEqual(researchContext.resolveChangeIntent(SEO_PROPOSAL_REQUEST), 'change_proposal');
      assert.strictEqual(researchContext.resolveChangeIntent('Fix the vendor on Halloween SVG Cut Files.'), 'change');
      assert.strictEqual(researchContext.resolveChangeIntent(FOLLOW_UP_REQUEST), 'none');
    });

    test('L. proposed values are derived, never invented, and held to the audit\'s own limits', () => {
      const proposalModule = require('../../agent/core/seoChangeProposal');
      assert.strictEqual(proposalModule.requestedProductCount('starting with the 3 most important products'), 3);
      assert.strictEqual(proposalModule.requestedProductCount('the two most important products'), 2);
      assert.strictEqual(proposalModule.requestedProductCount('fix the SEO'), 3);
      const longTitle = 'Hand Painted Watercolor Floral Clipart Bundle With Transparent PNG Files For Invitations';
      const metaTitle = proposalModule.deriveMetaTitle(longTitle);
      assert.ok(metaTitle.length <= 60 && longTitle.startsWith(metaTitle) && !metaTitle.endsWith(' '));
      assert.strictEqual(proposalModule.deriveMetaDescription('Spooky SVG cut files.'), null);
      const description = 'A bundle of 118 hand-painted watercolor clipart PNG files. Perfect for crafts, invitations and print projects. Includes commercial use.';
      const metaDescription = proposalModule.deriveMetaDescription(description);
      assert.ok(metaDescription.length >= 50 && metaDescription.length <= 160 && description.startsWith(metaDescription));
    });

    await testAsync('L. a proposal compliance BLOCKS is shown but never sent for approval', async () => {
      const proposalModule = require('../../agent/core/seoChangeProposal');
      const { PROTECTED_MARK_INDICATORS } = require('../../compliance/etsyIpRiskDetector');
      const steps = JSON.parse(JSON.stringify(runHistoryStore.getRunRecordById(sessionA.run_id).result.routing.plan));
      const mark = PROTECTED_MARK_INDICATORS[0];
      const renamed = `${mark} SVG Cut Files`;
      for (const source of steps[0].outputs.listing_sources) if (source.product_reference === 'Halloween SVG Cut Files') { source.product_reference = renamed; source.title = renamed; }
      for (const check of steps[1].outputs.result.checks) if (check.subject_reference === 'Halloween SVG Cut Files') check.subject_reference = renamed;
      const priorities = prioritization.prioritizeStoreOpportunities({ steps });
      const proposal = proposalModule.proposeSeoChanges({ steps, priorities, objective: SEO_PROPOSAL_REQUEST });
      const blocked = proposal.products.find((product) => product.product_reference === renamed);
      assert.ok(blocked, 'the product is still shown');
      assert.strictEqual(blocked.compliance.compliance_status, 'BLOCK');
      assert.strictEqual(blocked.approval_eligible, false);
    });

    // ---- H: explicit numbered references keep working --------------------------------------
    test('H. "#3" and "deep research #1" still resolve against the session', () => {
      assert.deepStrictEqual(commandCenterSession.extractReferences('deep research #1'), [1]);
      assert.deepStrictEqual(commandCenterSession.extractReferences('compare #1 and #4'), [1, 4]);
      assert.deepStrictEqual(commandCenterSession.extractReferences('show #2-#5'), [2, 5]);
      // A numbering scale for the answer is not a citation.
      assert.deepStrictEqual(commandCenterSession.extractReferences('Rank them from #1 (highest priority) to #10.'), []);

      const stored = commandCenterSessionStore.getSessionById(sessionB.session.session_id);
      const resolved = commandCenterSession.resolveObjective(stored, 'deep research #3');
      assert.strictEqual(resolved.ok, true);
      assert.ok(resolved.objective.includes(stored.specialist_results[2].label));

      const empty = commandCenterSessionStore.createSession({ goal: 'x' });
      const unresolved = commandCenterSession.resolveObjective(empty, 'deep research #1');
      assert.strictEqual(unresolved.ok, false);
      assert.ok(/no numbered results yet/i.test(unresolved.clarification));
    });

    // ---- C: no previous research -> fresh research, not a dead end ---------------------------
    await testAsync('C. with no previous research, the Chief runs the read-only research first and still answers', async () => {
      freshRunStore();
      const turn = await askInNewSession(port, FOLLOW_UP_REQUEST);
      assert.strictEqual(turn.clarification, null);
      assert.strictEqual(turn.owner_view.research_continuity.mode, 'fresh');
      assert.ok(/No completed Shopify research for this store/.test(turn.owner_view.research_continuity.reason));
      assert.ok(turn.reads.includes('getProducts') && turn.reads.includes('getOrders'));
      assert.deepStrictEqual(turn.owner_view.specialists_used, ['Product', 'SEO', 'Analytics & Optimization']);
      assert.strictEqual(turn.owner_view.status, 'success');
      assert.ok(turn.owner_view.recommendations[0].startsWith('#1 ['));
      assert.strictEqual(WRITE_CALLS.length, 0);
    });

    // ---- D: partial / failed research is never authoritative ---------------------------------
    await testAsync('D. a partial prior run is not treated as completed research', async () => {
      freshRunStore();
      productReadFails = true;
      const partial = await askInNewSession(port, ANALYSIS_REQUEST);
      productReadFails = false;
      assert.notStrictEqual(partial.owner_view.status, 'success');
      const stamp = runHistoryStore.getRunRecordById(partial.run_id).research_context;
      assert.strictEqual(stamp.authoritative, false);
      assert.ok(stamp.not_authoritative_reasons.length > 0);

      const turn = await askInNewSession(port, FOLLOW_UP_REQUEST);
      const continuity = turn.owner_view.research_continuity;
      assert.strictEqual(continuity.mode, 'fresh');
      assert.ok(/partial or failed run/.test(continuity.reason));
      assert.ok(turn.reads.includes('getProducts'), 'fresh research must be read, not the partial run reused');
    });

    await testAsync('D. a hand-edited stamp claiming authority is re-checked against the saved result', async () => {
      freshRunStore();
      productReadFails = true;
      const partial = await askInNewSession(port, ANALYSIS_REQUEST);
      productReadFails = false;
      rewriteRecord(partial.run_id, (record) => {
        record.research_context.authoritative = true;
        record.research_context.not_authoritative_reasons = [];
      });
      const found = researchContext.lookupResearchContext({});
      assert.strictEqual(found.research, null);
      assert.strictEqual(found.considered.not_authoritative, 1);
    });

    // ---- E: another business ------------------------------------------------------------------
    await testAsync('E. research saved for another business is not accessible', async () => {
      freshRunStore();
      const other = await askInNewSession(port, ANALYSIS_REQUEST);
      rewriteRecord(other.run_id, (record) => {
        record.business_id = 'other-business';
        record.research_context.business_id = 'other-business';
      });
      const turn = await askInNewSession(port, FOLLOW_UP_REQUEST);
      assert.strictEqual(turn.owner_view.research_continuity.mode, 'fresh');
      assert.notStrictEqual(turn.owner_view.research_continuity.source_run_id, other.run_id);
      // Nothing about the other business's research is described, not even as "passed over".
      assert.ok(!/partial|past the freshness/.test(turn.owner_view.research_continuity.reason));

      // And the reverse: a named business never sees the single-business default's research.
      const defaultReference = researchContext.storeReferenceFor('shopify', STORE_A);
      const ownResearch = researchContext.findReusableResearch({ businessId: null, storeReference: defaultReference });
      assert.ok(ownResearch.research, 'the default business sees its own research');
      const named = researchContext.findReusableResearch({ businessId: 'business-a', storeReference: defaultReference });
      assert.strictEqual(named.research, null);
    });

    // ---- F: another store / another platform -------------------------------------------------
    await testAsync('F. research from a different connected store is not reused', async () => {
      freshRunStore();
      await askInNewSession(port, ANALYSIS_REQUEST);
      process.env.SHOPIFY_STORE_DOMAIN = STORE_B;
      try {
        const turn = await askInNewSession(port, FOLLOW_UP_REQUEST);
        assert.strictEqual(turn.owner_view.research_continuity.mode, 'fresh');
        assert.ok(turn.reads.includes('getProducts'));
      } finally {
        process.env.SHOPIFY_STORE_DOMAIN = STORE_A;
      }
      // An unidentifiable store matches nothing.
      assert.strictEqual(researchContext.findReusableResearch({ storeReference: null }).research, null);
    });

    test('F. an objective about a different platform is not answered from Shopify research', () => {
      const context = { platform: 'shopify', research: { steps: [{}] }, considered: {} };
      const etsy = researchContext.decideResearchContinuity({
        objective: 'Using the Etsy data you just analysed, rank my top opportunities.',
        routingResult: { status: 'planned', interpretation: [] },
        researchContext: context,
      });
      assert.strictEqual(etsy.applies, false);
      const shopify = researchContext.decideResearchContinuity({
        objective: 'Using the Shopify data you just analysed, rank my top opportunities.',
        routingResult: { status: 'planned', interpretation: [] },
        researchContext: context,
      });
      assert.strictEqual(shopify.applies, true);
    });

    // ---- G: stale research ---------------------------------------------------------------------
    await testAsync('G. research older than the freshness limit is reported stale and fresh research runs', async () => {
      freshRunStore();
      const old = await askInNewSession(port, ANALYSIS_REQUEST);
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      rewriteRecord(old.run_id, (record) => {
        record.created_at = sevenHoursAgo;
        record.research_context.recorded_at = sevenHoursAgo;
        record.research_context.produced_at = sevenHoursAgo;
      });
      const turn = await askInNewSession(port, FOLLOW_UP_REQUEST);
      const continuity = turn.owner_view.research_continuity;
      assert.strictEqual(continuity.mode, 'fresh');
      assert.ok(continuity.reason.includes(`produced ${sevenHoursAgo}`) && /freshness limit/.test(continuity.reason));
      assert.ok(turn.reads.includes('getProducts'));

      // The limit is configurable, and the same record is reusable under a longer one.
      const withinLongerLimit = researchContext.findReusableResearch({
        storeReference: researchContext.storeReferenceFor('shopify', STORE_A),
        maxAgeHours: 24,
      });
      assert.ok(withinLongerLimit.research);
    });

    // ---- The interpretation boundary ------------------------------------------------------------
    test('referencesPriorWork is grammatical: earlier-work references match, new requests do not', () => {
      for (const text of [
        FOLLOW_UP_REQUEST,
        'Based on the previous analysis, what should I prioritise?',
        'From your earlier audit, rank the issues.',
        'Using the results you gave me, pick the top 3.',
        'Given the prior results, which products need attention?',
        EXISTING_RESEARCH_REQUEST,
        'Use the results you have on file to rank my opportunities.',
        'Based on your existing research, which listings need work first?',
        'Review the latest Shopify SEO research and prepare the stored SEO proposal for execution.',
        'Using the most recent analysis, rank my listings.',
      ]) {
        assert.strictEqual(referencesPriorWork(text), true, text);
      }
      for (const text of [
        ANALYSIS_REQUEST,
        'Show me sales for the last 30 days.',
        'Analyse my latest orders.',
        'Can you check my SEO?',
        'I analysed my store yesterday, now find products to add.',
        'What listings do you have that need better titles?',
        'Improve my existing listings.',
        'Rewrite the last listing description.',
        'Give me the analysis you think is most useful for my sales.',
        'Show me my recent orders.',
        'What are the latest trends in clipart?',
      ]) {
        assert.strictEqual(referencesPriorWork(text), false, text);
      }
    });

    test('the prioritisation ranks nothing it was not given', () => {
      const empty = prioritization.prioritizeStoreOpportunities({ steps: [] });
      assert.deepStrictEqual(empty.opportunities, []);
      assert.ok(empty.limitations.some((line) => /No completed SEO\/listing audit/.test(line)));
      assert.ok(empty.basis_coverage.every((entry) => entry.available === false));
    });

    test('this test file is registered in the suite runner', () => {
      const { TEST_FILES } = require('./runAllTests');
      assert.ok(TEST_FILES.includes('researchContinuity.test.js'));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
