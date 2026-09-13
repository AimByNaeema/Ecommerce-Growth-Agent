'use strict';

// CHIEF OBJECTIVE INTENT - natural-language objectives, end to end through the Dashboard path.
//
// THE DEFECT. planRouting split an objective at commas/"and"/sentences and asked every fragment
// to name a capability by word overlap. It never asked what a fragment ASKS FOR, so:
//   - ordinary read language dead-ended the whole objective ("Identify the most important
//     actions needed to increase sales" -> No known capability matches ...), one production
//     phrasing after another, and every word-list patch only moved the gap;
//   - a consequential request whose NOUN routed was silently planned as a read ("Delete my
//     worst products" -> Product, "Analyse my eBay store's sales" -> Analytics).
//
// THE FIX (agent/core/objectiveInterpretation.js + resolveObjectiveIntent in
// orchestratorExecutionContract.js) classifies each clause's speech act from sentence structure
// and resolves the objective as a whole: task clauses choose specialists, read-type clauses
// frame the task, safety constraints narrow the run, and unsupported actions or platforms are
// refused with a reason.
//
// EVERY REQUEST HERE GOES THROUGH THE DASHBOARD'S OWN PATH: POST /session, then
// POST /session/:id/message on the real server, the real session layer and the real Chief;
// the saved run is read back from GET /history/:runId. The planRouting result for the same text
// is checked against what the Dashboard run actually did, so unit behaviour and Dashboard
// behaviour cannot drift apart again.
//
// NO NETWORK, NO MODEL CALL, NO STORE WRITE: global.fetch fails the call, Shopify reads are
// fixtures, and every Shopify write function is a tripwire.

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
  process.env[env] = fs.mkdtempSync(path.join(os.tmpdir(), `chief-objective-intent-${name}-`));
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
delete process.env.VERCEL;
// HERMETIC WHEREVER IT RUNS. The provider clients load the repository's .env lazily from the
// working directory (npm test runs from the root), and that load never overwrites a variable that
// is already set. Empty values make every external provider - AI, web search, Etsy and a real
// Shopify token - report itself unconfigured, so no request in this file can attempt a network call.
for (const key of [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY',
  'ETSY_API_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_OAUTH_REFRESH_TOKEN', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID',
  'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
]) {
  process.env[key] = '';
}

const FETCH_CALLS = [];
const originalFetch = global.fetch;
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');

const FIXTURE_PRODUCTS = [
  {
    id: 'gid://fixture/Product/1', title: 'Watercolor Clipart PNG Bundle', handle: 'watercolor-clipart-png-bundle',
    description: 'A bundle of 118 hand-painted watercolor clipart PNG files for crafts and invitations.',
    seo: { title: 'Watercolor Clipart PNG Bundle | Fixture Studio', description: 'Hand-painted watercolor clipart PNG files.' },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['png'],
    variants: [{ id: 'v1', price: '4.99', inventoryQuantity: 0 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/2', title: 'Halloween SVG Cut Files', handle: 'halloween-svg-cut-files',
    description: 'Spooky SVG cut files.', seo: { title: null, description: null },
    status: 'ACTIVE', productType: '', vendor: 'Fixture Studio', tags: ['svg'],
    variants: [{ id: 'v2', price: '2.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/3', title: 'Christmas Invitation Template', handle: 'christmas-invitation-template',
    description: '', seo: null,
    status: 'DRAFT', productType: 'Template', vendor: 'Fixture Studio', tags: [],
    variants: [{ id: 'v3', price: '6.99', inventoryQuantity: 12 }], collections: [], metafields: [],
  },
];
const FIXTURE_ORDERS = [
  { id: 'gid://fixture/Order/1', createdAt: '2026-09-01T00:00:00Z', totalPrice: '4.99', currency: 'USD', lineItems: [] },
  { id: 'gid://fixture/Order/2', createdAt: '2026-09-05T00:00:00Z', totalPrice: '9.98', currency: 'USD', lineItems: [] },
];

const READ_CALLS = [];
const WRITE_CALLS = [];
const originalShopify = {};
function substitute(name, fn) {
  originalShopify[name] = shopifyClient[name];
  shopifyClient[name] = fn;
}
const reader = (name, value) => async () => {
  READ_CALLS.push(name);
  return value;
};
substitute('isConfigured', () => true);
substitute('getShopInfo', reader('getShopInfo', { name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' }));
substitute('getProducts', reader('getProducts', FIXTURE_PRODUCTS));
substitute('getCollections', reader('getCollections', []));
substitute('getInventoryLevels', reader('getInventoryLevels', []));
substitute('getOrders', reader('getOrders', FIXTURE_ORDERS));
substitute('getCustomers', reader('getCustomers', []));
// Every function that could change the store is a tripwire - named ones and anything else the
// client exports with a write-shaped name.
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || name in originalShopify) continue;
  if (/^(update|create|add|adjust|delete|remove|set|publish|write|mutate)/i.test(name)) {
    substitute(name, async () => {
      WRITE_CALLS.push(name);
      throw new Error(`STORE WRITE TRIPWIRE: ${name}`);
    });
  }
}

const contract = require('../../agent/core/orchestratorExecutionContract');
const interpretation = require('../../agent/core/objectiveInterpretation');
const mutationIntent = require('../../agent/core/mutationIntent');
const { createApp } = require('../../server');

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

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${TEST_API_KEY}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (err) { json = null; }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Exactly what the Dashboard's "Ask the Chief" sends, then the saved run read back.
async function askChief(port, message, researchParams) {
  const created = await request(port, { method: 'POST', path: '/session', body: { goal: message } });
  assert.strictEqual(created.status, 200, created.raw.slice(0, 200));
  const turn = await request(port, {
    method: 'POST',
    path: `/session/${encodeURIComponent(created.body.session_id)}/message`,
    body: researchParams ? { message, research_params: researchParams } : { message },
  });
  assert.strictEqual(turn.status, 200, turn.raw.slice(0, 300));
  assert.ok(turn.body.run_id, `the turn saved no run: ${turn.raw.slice(0, 300)}`);
  const history = await request(port, { method: 'GET', path: `/history/${encodeURIComponent(turn.body.run_id)}` });
  assert.strictEqual(history.status, 200, history.raw.slice(0, 200));
  const record = history.body.record || history.body;
  return { turn: turn.body, result: record.result, routing: record.result.routing, raw: turn.raw + history.raw };
}

function specialistsRun(routing) {
  return (routing.plan || []).map((step) => step.selected_specialist.id);
}
function plannedIds(plan) {
  return (plan.targets || []).map((target) => target.id);
}

// The Dashboard run must do what planRouting says for the same text. The Chief may add the
// declared Product read in front of SEO's quality check, and nothing else.
function assertDashboardMatchesPlan(message, dashboard) {
  const direct = contract.planRouting(contract.understandObjective(message));
  assert.strictEqual(dashboard.routing.status, direct.status, `Dashboard ${dashboard.routing.status} vs planRouting ${direct.status}`);
  if (direct.status !== 'planned') {
    assert.strictEqual(dashboard.routing.reason, direct.reason);
    return direct;
  }
  const ran = specialistsRun(dashboard.routing);
  for (const id of plannedIds(direct)) assert.ok(ran.includes(id), `planned ${id} did not run (${ran.join(',')})`);
  const extra = ran.filter((id) => !plannedIds(direct).includes(id));
  assert.ok(extra.every((id) => id === 'product') && (extra.length === 0 || ran.includes('seo')), `unexpected extra steps ${extra.join(',')}`);
  return direct;
}

function assertNoStoreEffects(dashboard, label) {
  assert.deepStrictEqual(WRITE_CALLS, [], `${label}: a store write was attempted`);
  assert.strictEqual((dashboard.result.pending_approvals || []).length, 0, `${label}: an approval was created`);
  assert.deepStrictEqual(dashboard.turn.owner_view ? dashboard.turn.owner_view.mutations : [], [], `${label}: owner view reports a mutation`);
}

const EXACT_1 =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';
const EXACT_2 =
  'Review the SEO findings from my Shopify products. Show me the 10 products with the highest-priority SEO issues, explain each issue and recommend the exact improvement. Do not make any changes.';
const EXACT_3 =
  'Review my Shopify store using real store data. Identify the most important actions needed to increase sales. Prioritize the opportunities by impact and urgency. For each opportunity, explain the problem, why it matters, and what you recommend doing. Do not make any changes.';

// Read-only objectives, by category: [category, message, specialists that must be planned].
const READ_ONLY_MATRIX = [
  ['sales', 'How are my Shopify sales doing this month?', ['analytics_optimization']],
  ['sales', 'Analyse my sales performance and tell me what is driving the drop in revenue.', ['analytics_optimization']],
  ['sales growth', 'I want to increase my sales. What are the most important things to look at in my store?', ['analytics_optimization']],
  ['sales growth', 'What should I focus on to grow sales next quarter? Keep it read-only.', ['analytics_optimization']],
  ['orders', 'Look at my orders from the last 30 days and summarise the trends.', ['analytics_optimization']],
  ['orders', 'How many orders have we had recently, and is that more or less than usual?', ['analytics_optimization']],
  ['inventory', 'Which products are low on inventory? List them by urgency.', ['product']],
  ['inventory', 'Check my inventory levels and flag anything that could run out soon.', ['product']],
  ['product', 'Review my product catalog and identify the weakest products.', ['product']],
  ['product', 'What are my best selling products and why are they performing well?', ['product']],
  ['product optimization', 'Prioritise my products by revenue and show why the top three matter most.', ['product']],
  ['SEO', 'Audit the SEO of my product pages and rank the pages that need the most work.', ['seo']],
  ['SEO question', "Can you tell me what's wrong with my store's SEO and what I should do about it?", ['seo']],
  ['SEO', 'For every product with SEO problems, describe the problem and the likely impact.', ['seo']],
  ['listing optimization', 'Find the listings with the weakest titles and suggest better wording.', ['listing']],
  ['listing optimization', 'Evaluate my listing quality and tell me which listings to improve first and why.', ['listing']],
  ['marketing', 'Analyse my marketing strategy and recommend what to change first.', ['marketing']],
  ['marketing', 'Suggest marketing campaign ideas for my best products.', ['marketing']],
  ['analytics', 'Summarise my store analytics in plain English and highlight anything unusual.', ['analytics_optimization']],
  ['analytics', 'Show me my conversion rate and explain what is hurting it.', ['analytics_optimization']],
  ['analytics', "Give me an overview of my store's growth and the biggest risks.", ['analytics_optimization']],
  ['analytics', 'Identify quick wins that would improve my store performance without making changes.', ['analytics_optimization']],
  ['growth', 'Look through my Shopify data and point out the opportunities I am missing.', ['product']],
  ['multi-specialist', 'Check orders and inventory together and tell me where I am losing money.', ['product', 'analytics_optimization']],
  ['multi-specialist list', 'Review products and SEO, then list the top 5 issues with a short explanation for each.', ['product', 'seo']],
  ['multi-specialist', 'Analyse my listings and my marketing, and rank the problems by impact.', ['listing', 'marketing']],
  ['commas and lists', 'Analyze my store performance, rank the problems by impact, and explain how each one affects revenue.', ['analytics_optimization']],
  ['questions', 'Go through my SEO. Which issues matter most? Why? What would you fix first?', ['seo']],
  ['multi-sentence', 'Check my inventory, orders and SEO. Rank what needs attention, explain why, and recommend next steps.', ['product', 'seo', 'analytics_optimization']],
  ['prioritization', 'Prioritize my SEO problems by impact and urgency, and recommend what to tackle first.', ['seo']],
  ['ranking', 'Rank my products by how much attention they need and tell me the reason for each.', ['product']],
];

// Requests that must NOT run: [category, message, what the clarification must name].
const REFUSED_MATRIX = [
  ['unsupported subject', 'Analyse my SEO and explain the flibbertigibbet dance.', /flibbertigibbet/],
  ['unsupported subject', 'Review my sales and tell me my tax obligations.', /tax obligations/],
  ['unsupported subject', 'Check my inventory. What will the weather be tomorrow?', /weather/],
  ['unsupported platform', 'Analyse my SEO. Also compare my prices with Amazon.', /Amazon/],
  ['unsupported platform', "Analyse my eBay store's sales.", /eBay/],
  ['external data', 'Pull my Amazon seller orders and rank my best sellers.', /Amazon/],
  ['unknown business task', 'Research my market and do the flibbertigibbet dance.', /flibbertigibbet/],
  ['unknown business task', 'Analyse my SEO and book a photoshoot.', /photoshoot/],
  ['unknown business task', 'Hire a photographer for my store.', /photographer/],
  ['publishing', 'Review my SEO and publish the improved titles.', /publish/],
  ['publishing', 'Post my best products on Instagram.', /Post my best products/],
  ['deleting', 'Delete my worst products.', /Delete/],
  ['deleting', 'Analyse my listings and remove the worst ones.', /remove the worst ones/],
  ['purchasing', 'Buy ads for my best products.', /Buy ads/],
  ['purchasing', 'Purchase more stock for my top sellers.', /Purchase/],
  ['spending', 'Spend 500 dollars on Facebook ads for my top product.', /Spend/],
  ['spending', 'Pay for a sponsored post for my top product.', /Pay/],
  ['applying changes', 'Analyse my SEO issues and apply the recommended improvements.', /apply/],
  ['applying changes', 'Implement the recommendations on my listings.', /Implement/],
  ['framing only', 'Explain each issue.', /Explain each issue/],
  ['constraint only', 'Do not make any changes.', /Do not make any changes/],
];

(async () => {
  // --- The speech act of a clause, read from structure -------------------------------------

  const ACTS = [
    ['Identify the most important actions needed to increase sales.', 'inform'],
    ['why it matters', 'inform'],
    ['What should I focus on to grow sales next quarter?', 'inform'],
    ['Can you tell me what is wrong with my SEO?', 'inform'],
    ['I want to increase my sales.', 'goal'],
    ['For each opportunity', 'scope'],
    ['Using real store data', 'scope'],
    ['Do not make any changes.', 'safety'],
    ['Keep it read-only.', 'safety'],
    ['Write new titles for my listings', 'produce'],
    ['Fix the vendor on my products', 'change'],
    ['Delete my worst products', 'unsupported_action'],
    ['we need help hiring a photographer', 'unsupported_action'],
    ['Compare my prices with Amazon', 'unsupported_platform'],
    ['reformat my listing content for the Etsy marketplace', 'act'],
  ];
  for (const [clause, act] of ACTS) {
    test(`ACT: ${JSON.stringify(clause)} is ${act}`, () => {
      assert.strictEqual(interpretation.interpretClause(clause).act, act);
    });
  }

  test('ACT: a list item continues the act of the clause before it in the same sentence only', () => {
    assert.strictEqual(interpretation.interpretClause('the recommended improvement', { previousAct: 'inform' }).act, 'inform');
    assert.strictEqual(interpretation.interpretClause('the recommended improvement', { previousAct: null }).act, 'scope');
  });

  test('NOT A WORD LIST: an ordinary word unknown to the system cannot turn a read request into a clarification', () => {
    // Nonsense modifiers and verbs around a known subject are still understood as framing ...
    for (const variation of ['explain the zorbly issue', 'show why the top three glimmer most', 'tell me what is frobbing the drop in revenue']) {
      const result = contract.planRouting(`Analyse my SEO. ${variation}.`);
      assert.strictEqual(result.status, 'planned', `${variation}: ${result.reason}`);
      assert.deepStrictEqual(plannedIds(result), ['seo']);
    }
    // ... while a noun phrase made ONLY of unknown words is a new subject and still asks.
    assert.strictEqual(contract.planRouting('Analyse my SEO. Explain the zorbly frobnicator.').status, 'clarification_required');
  });

  test('NOT A WORD LIST: what an objective may talk about is derived from the registries, not listed', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/core/objectiveInterpretation.js'), 'utf8');
    for (const subject of ['sales', 'revenue', 'inventory', 'trends', 'conversion', 'wording']) {
      assert.ok(!new RegExp(`'${subject}'`).test(source), `subject word '${subject}' is hand-listed in objectiveInterpretation.js`);
    }
  });

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    // --- The three exact historical failures --------------------------------------------------

    await testAsync('EXACT 1 (store analysis with sales opportunities): Product, SEO and Analytics run on real store data, read-only', async () => {
      const readsBefore = READ_CALLS.length;
      const dashboard = await askChief(port, EXACT_1);
      assert.ok(!/No known capability matches/.test(dashboard.raw), 'clarification text returned');
      assert.strictEqual(dashboard.routing.status, 'planned', dashboard.routing.reason);
      assertDashboardMatchesPlan(EXACT_1, dashboard);
      assert.deepStrictEqual(specialistsRun(dashboard.routing), ['product', 'seo', 'analytics_optimization']);
      const seo = dashboard.routing.plan.find((step) => step.selected_specialist.id === 'seo');
      assert.strictEqual(seo.inputs.capability_id, 'seo_quality_check');
      assert.strictEqual(seo.outputs.result.products_checked, FIXTURE_PRODUCTS.length);
      const reads = READ_CALLS.slice(readsBefore);
      assert.ok(reads.includes('getProducts') && reads.includes('getOrders'), `real store reads: ${reads.join(',')}`);
      assertNoStoreEffects(dashboard, 'EXACT 1');
    });

    await testAsync('EXACT 2 (SEO findings): the Product read feeds SEO, which audits every real product, read-only', async () => {
      const dashboard = await askChief(port, EXACT_2);
      assert.ok(!/No known capability matches/.test(dashboard.raw));
      assertDashboardMatchesPlan(EXACT_2, dashboard);
      assert.deepStrictEqual(specialistsRun(dashboard.routing), ['product', 'seo']);
      const [product, seo] = dashboard.routing.plan;
      assert.strictEqual(product.outputs.status, 'success');
      assert.strictEqual(seo.inputs.capability_id, 'seo_quality_check');
      assert.deepStrictEqual(
        seo.outputs.result.checks.map((check) => check.result.specialized_records.listing_record.product_title),
        FIXTURE_PRODUCTS.map((p) => p.title)
      );
      assertNoStoreEffects(dashboard, 'EXACT 2');
    });

    await testAsync('EXACT 3 (actions to increase sales): the Chief understands the goal and runs Analytics on the real orders, read-only', async () => {
      const readsBefore = READ_CALLS.length;
      const dashboard = await askChief(port, EXACT_3);
      assert.ok(!/No known capability matches/.test(dashboard.raw), dashboard.routing.reason);
      assert.strictEqual(dashboard.routing.status, 'planned', dashboard.routing.reason);
      const direct = assertDashboardMatchesPlan(EXACT_3, dashboard);
      assert.ok(specialistsRun(dashboard.routing).includes('analytics_optimization'), specialistsRun(dashboard.routing).join(','));
      assert.ok(READ_CALLS.slice(readsBefore).includes('getOrders'), 'the sales analysis read the real orders');
      const understood = Object.fromEntries(direct.interpretation.map((entry) => [entry.clause, entry.disposition]));
      assert.strictEqual(understood['Identify the most important actions needed to increase sales.'], 'task');
      for (const clause of ['explain the problem', 'why it matters', 'what you recommend doing.']) {
        assert.strictEqual(understood[clause], 'framing', `${clause}: ${understood[clause]}`);
      }
      assertNoStoreEffects(dashboard, 'EXACT 3');
    });

    test('EXACT 1-3: "Do not make any changes" is recorded as a safety constraint and no mutation tool is selectable', () => {
      for (const objective of [EXACT_1, EXACT_2, EXACT_3]) {
        assert.deepStrictEqual(contract.planRouting(objective).instructions.safety, ['Do not make any changes']);
        assert.strictEqual(mutationIntent.maySelectMutationTool(objective), false);
      }
    });

    // --- Broad read-only matrix through the Dashboard ---------------------------------------

    for (const [category, message, expected] of READ_ONLY_MATRIX) {
      await testAsync(`READ-ONLY [${category}] plans ${expected.join('+')} through the Dashboard: ${JSON.stringify(message)}`, async () => {
        const dashboard = await askChief(port, message);
        assert.strictEqual(dashboard.routing.status, 'planned', dashboard.routing.reason);
        assert.ok(!/No known capability matches/.test(dashboard.raw));
        const direct = assertDashboardMatchesPlan(message, dashboard);
        assert.deepStrictEqual(plannedIds(direct), expected);
        assertNoStoreEffects(dashboard, category);
      });
    }

    // --- Unsupported, consequential and unknown requests are refused, never run -------------

    for (const [category, message, named] of REFUSED_MATRIX) {
      await testAsync(`REFUSED [${category}] asks for clarification through the Dashboard: ${JSON.stringify(message)}`, async () => {
        const readsBefore = READ_CALLS.length;
        const dashboard = await askChief(port, message);
        assert.strictEqual(dashboard.routing.status, 'clarification_required', `ran ${specialistsRun(dashboard.routing).join(',')}`);
        assert.ok(named.test(dashboard.routing.unmatched_segment || dashboard.routing.reason), dashboard.routing.reason);
        assertDashboardMatchesPlan(message, dashboard);
        assert.strictEqual(READ_CALLS.length, readsBefore, 'a refused request still read the store');
        assertNoStoreEffects(dashboard, category);
      });
    }

    test('REFUSED: consequential actions are never absorbed as framing of a read task', () => {
      for (const message of ['Analyse my SEO and book a photoshoot.', 'Review my SEO and publish the improved titles.', 'Analyse my listings and remove the worst ones.']) {
        const result = contract.planRouting(message);
        assert.strictEqual(result.status, 'clarification_required');
        assert.strictEqual(result.interpretation_blocked, true, 'an understood refusal must not be re-segmented by the AI fallback');
      }
    });

    // --- Mutation requests keep the existing approval chain exactly ----------------------------

    await testAsync('MUTATION: an explicit vendor change still stops for a durable human approval and writes nothing', async () => {
      const message = 'Change the vendor of Shopify product gid://fixture/Product/1 to Aurora Ceramics';
      const dashboard = await askChief(port, message, { productId: 'gid://fixture/Product/1', newVendor: 'Aurora Ceramics' });
      assertDashboardMatchesPlan(message, dashboard);
      assert.strictEqual(dashboard.turn.owner_view.status, 'waiting_for_approval', JSON.stringify(dashboard.turn.owner_view.status));
      assert.strictEqual((dashboard.result.pending_approvals || []).length, 1);
      const pending = await request(port, { method: 'GET', path: '/approvals/pending' });
      assert.ok(pending.body.approvals.some((item) => item.run_id === dashboard.turn.run_id), 'approval not registered durably');
      assert.deepStrictEqual(WRITE_CALLS, [], 'a store write happened before any approval');
    });

    test('MUTATION: a change clause is never framing, and a how-to question never selects a mutation tool', () => {
      const result = contract.planRouting('Review my SEO issues and fix the vendor on each product.');
      assert.ok(!result.instructions || !result.instructions.framing.some((text) => /fix/.test(text)));
      assert.strictEqual(mutationIntent.maySelectMutationTool('Review my SEO issues and explain how to fix each one.'), false);
    });

    // --- Global guarantees --------------------------------------------------------------------

    test('NO NETWORK CALL WAS MADE BY ANY REQUEST IN THIS FILE', () => {
      assert.deepStrictEqual(FETCH_CALLS, []);
    });

    test('NO SHOPIFY WRITE FUNCTION WAS CALLED BY ANY REQUEST IN THIS FILE', () => {
      assert.deepStrictEqual(WRITE_CALLS, []);
    });

    test('this test file is registered in the suite runner', () => {
      const { TEST_FILES } = require('./runAllTests');
      assert.ok(TEST_FILES.includes('chiefObjectiveIntent.test.js'));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    for (const [name, fn] of Object.entries(originalShopify)) shopifyClient[name] = fn;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
