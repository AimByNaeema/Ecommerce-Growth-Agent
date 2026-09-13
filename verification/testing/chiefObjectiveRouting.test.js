'use strict';

// CHIEF OBJECTIVE ROUTING - real production regression from the dashboard "Ask the Chief".
//
// THE FAILURE. This plain-English owner request stopped with
//   No known capability matches "sales opportunities. Identify the 10 highest-priority
//   opportunities" - please clarify what you need.
// because clause splitting tore one objective into fragments and two of them - a
// presentation instruction and a read-only constraint - matched no capability, so the
// owner's own words were treated as if they had to name one.
//
// WHAT THESE TESTS ASSERT. The exact request plans, reaches the real Shopify read tools
// through the existing Chief -> specialist pipeline, returns data from those reads, and
// stays read-only (no write function, no approval). And the guard rails still hold: a
// genuinely unknown instruction, an instruction to make changes, and a request made only
// of framing words still ask for clarification.
//
// NO NETWORK, NO MODEL CALL: global.fetch fails the run, Shopify reads are in-memory
// fixtures, and every write path is a tripwire.

const assert = require('node:assert');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => { FETCH_CALLS.push(String(url)); throw new Error('NETWORK CALL ATTEMPTED: ' + url); };

const STUBBED = ['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers', 'updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle'];
const originalShopify = {};
for (const fn of STUBBED) originalShopify[fn] = shopifyClient[fn];

const READ_CALLS = [];
shopifyClient.isConfigured = () => true;
shopifyClient.getShopInfo = async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' }; };
shopifyClient.getProducts = async () => {
  READ_CALLS.push('getProducts');
  return [
    { id: 'gid://fixture/Product/1', title: 'Fixture Bundle A', handle: 'a', status: 'ACTIVE', productType: '', vendor: 'Studio A', tags: ['svg'], variants: [{ id: 'v1', price: '2.99', inventory_quantity: -1 }], collections: [], metafields: [] },
  ];
};
shopifyClient.getCollections = async () => { READ_CALLS.push('getCollections'); return []; };
shopifyClient.getInventoryLevels = async () => { READ_CALLS.push('getInventoryLevels'); return []; };
shopifyClient.getOrders = async () => {
  READ_CALLS.push('getOrders');
  return [{ id: 'gid://fixture/Order/1', createdAt: '2026-09-01T00:00:00Z', totalPrice: '2.68', currency: 'USD', lineItems: [] }];
};
shopifyClient.getCustomers = async () => { READ_CALLS.push('getCustomers'); return []; };

const MUTATION_CALLS = [];
for (const fn of ['updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle']) {
  shopifyClient[fn] = async () => { MUTATION_CALLS.push(fn); throw new Error('MUTATION TRIPWIRE: ' + fn); };
}

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const mutationIntent = require('../../agent/core/mutationIntent');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');

const { planRouting, understandObjective, runOrchestratorContract } = orchestratorExecutionContract;

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
function restore() {
  global.fetch = originalFetch;
  for (const [k, v] of Object.entries(originalShopify)) shopifyClient[k] = v;
}
function plan(text) { return planRouting(understandObjective(text)); }
function ids(result) { return (result.targets || []).map((t) => t.id); }

// The exact request the owner typed into the production dashboard.
const PRODUCTION_REQUEST =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';

(async () => {
  // --- 1. The exact failure --------------------------------------------------------

  test('EXACT PRODUCTION REQUEST plans instead of "No known capability matches"', () => {
    const result = plan(PRODUCTION_REQUEST);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
    assert.ok(!/No known capability matches/.test(JSON.stringify(result)));
  });

  test('EXACT PRODUCTION REQUEST selects the existing Product, SEO and Analytics specialists', () => {
    assert.deepStrictEqual(ids(plan(PRODUCTION_REQUEST)), ['product', 'seo', 'analytics_optimization']);
  });

  test('the whole request is read-only to the mutation gate', () => {
    assert.strictEqual(mutationIntent.classifyRequestIntent(PRODUCTION_REQUEST), 'read_only');
    assert.strictEqual(mutationIntent.maySelectMutationTool(PRODUCTION_REQUEST), false);
  });

  await testAsync('EXACT PRODUCTION REQUEST runs the real Chief pipeline on Shopify reads, read-only', async () => {
    const readsBefore = READ_CALLS.length;
    const result = await runOrchestratorContract(PRODUCTION_REQUEST);

    assert.strictEqual(result.routing.status, 'planned', `routing ${result.routing.status}: ${result.routing.reason}`);
    const steps = result.routing.plan;
    const selected = steps.map((step) => step.selected_specialist.id);
    assert.deepStrictEqual(selected, ['product', 'seo', 'analytics_optimization']);
    // Every step receives the WHOLE objective, not a fragment of it.
    for (const step of steps) assert.strictEqual(step.request, PRODUCTION_REQUEST);

    const product = steps.find((s) => s.selected_specialist.id === 'product');
    const analytics = steps.find((s) => s.selected_specialist.id === 'analytics_optimization');
    assert.deepStrictEqual(product.tool_calls, ['product_data_retrieval']);
    assert.deepStrictEqual(analytics.tool_calls, ['analytics_data_retrieval']);
    assert.strictEqual(product.outputs.status, 'success');
    assert.strictEqual(analytics.outputs.status, 'success');
    // The product result is the fixture catalogue the Shopify client returned - real read, not invented.
    assert.ok(JSON.stringify(product.outputs.result).includes('Fixture Bundle A'));
    assert.ok(READ_CALLS.slice(readsBefore).includes('getProducts'), 'products were not read from Shopify');
    assert.ok(READ_CALLS.slice(readsBefore).includes('getOrders'), 'orders were not read from Shopify');

    // Read-only: no write, no approval, no correction tool, no network.
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    for (const step of steps) {
      for (const id of mutationIntent.CORRECTION_TOOL_IDS) assert.ok(!(step.tool_calls || []).includes(id), `${id} selected`);
    }
    assert.deepStrictEqual(FETCH_CALLS, []);

    const ownerView = describeChiefResultForOwner({ result, runId: 'regression' });
    assert.notStrictEqual(ownerView.status, 'needs_clarification');
    assert.deepStrictEqual(ownerView.mutations, []);
  });

  // --- 2. Normal natural-language multi-part objectives ----------------------------

  const NATURAL_OBJECTIVES = [
    ['Review my Shopify products and orders, then show me the top 5 priorities. Don\'t change anything.', ['product', 'analytics_optimization']],
    ['Check my SEO and listing quality and recommend next steps.', ['seo', 'listing']],
    ['Analyse my sales and inventory. Identify the biggest opportunities and tell me what should be done first.', ['product', 'analytics_optimization']],
    ['Check my products for vendor issues and summarise them by priority. Do not make any changes.', ['product']],
  ];
  for (const [objective, expected] of NATURAL_OBJECTIVES) {
    test(`NATURAL OBJECTIVE plans to ${expected.join('+')}: ${JSON.stringify(objective)}`, () => {
      const result = plan(objective);
      assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
      assert.deepStrictEqual(ids(result), expected);
    });
  }

  // --- 3. Guard rails: framing is absorbed, real instructions are not ---------------

  test('an unknown second instruction still asks for clarification', () => {
    const result = plan('Research my market and do the flibbertigibbet dance.');
    assert.strictEqual(result.status, 'clarification_required');
    assert.ok(/flibbertigibbet/.test(result.unmatched_segment));
  });

  test('"make changes" is never absorbed as framing', () => {
    const result = plan('Analyze my products and make changes');
    assert.strictEqual(result.status, 'clarification_required');
    assert.strictEqual(result.unmatched_segment, 'make changes');
  });

  test('a request made only of framing still asks what to do', () => {
    assert.strictEqual(plan('Do not make any changes.').status, 'clarification_required');
    assert.strictEqual(plan('Recommend what should be done first.').status, 'clarification_required');
  });

  test('framing never adds a target of its own', () => {
    assert.deepStrictEqual(
      ids(plan('Analyze my store sales performance and recommend what should be done first.')),
      ids(plan('Analyze my store sales performance'))
    );
  });

  test('explicit mutation requests keep their mutation intent', () => {
    assert.strictEqual(mutationIntent.classifyRequestIntent('Fix the vendor on product X and recommend next steps'), 'mutation');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('chiefObjectiveRouting.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
