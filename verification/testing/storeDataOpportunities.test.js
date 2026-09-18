'use strict';

// REAL DATA -> OPPORTUNITY -> EVIDENCE -> ACTION.
//
// THE GAP THIS CLOSES. The growth cycle read both stores and reported what each specialist
// found, but a list of findings is not an answer to "find the highest-confidence
// opportunities, explain the evidence, propose actions". Nothing turned the records already in
// the run into something the owner could act on.
//
// THE TRAP THIS SUITE EXISTS TO HOLD SHUT. Only a field that was genuinely READ can be
// assessed. tools/productDataRetrievalTool.js's mapShopifyProductToCandidate() hardcodes
// pricing.cost: '' and pricing.currency: '' - it never asks Shopify for them - and
// agent/core/productModel.js has no description field at all. An "opportunity" built on those
// empties would be a problem invented out of this project's own mapping, not a fact about the
// store. They are declared in not_assessed instead, and the tests below pin that: an empty
// cost must NEVER become a finding, however tempting a "no margin data" recommendation looks.
//
// The same rule governs Etsy: normalizeEtsyShop() returns null for a field Etsy did not send,
// so null is "not established" and only a value Etsy really returned is treated as a fact.
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. The derivation is a pure function over the plan;
// the end-to-end case stubs both store reads at their module seams. A fetch tripwire and write
// tripwires are installed and asserted empty.

const assert = require('node:assert');

process.env.AI_PROVIDER = 'claude';

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const adapterRegistry = require('../../integrations/adapters/adapterRegistry');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');

const FIXTURE_SHOP = etsyReadClient.normalizeEtsyShop({
  shop_id: 62500594,
  shop_name: 'HappyInviteHouse',
  listing_active_count: 79,
  digital_listing_count: 69,
  is_vacation: false,
});

const ADAPTER_CALLS = [];
const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return {
    isConfigured: () => true,
    getShopInfo: async () => { ADAPTER_CALLS.push('etsy.getShopInfo'); return { native: FIXTURE_SHOP }; },
    getProducts: async () => { ADAPTER_CALLS.push('etsy.getProducts'); return []; },
  };
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyClient = require('../../integrations/adapters/etsyClient');
const mutationIntent = require('../../agent/core/mutationIntent');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { CONFIDENCE_LEVELS } = require('../../agent/core/researchRecordModel');
const { deriveStoreDataOpportunities } = require('../../agent/core/storeDataOpportunities');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

const MUTATION_CALLS = [];
const SAVED_SHOPIFY = {};
const SHOPIFY_READS = {
  isConfigured: () => true,
  getShopInfo: async () => ({ name: 'Fixture Store', domain: 'fixture.myshopify.com', email: null }),
  getProducts: async () => {
    ADAPTER_CALLS.push('shopify.getProducts');
    return [
      { id: 'gid://shopify/Product/1', title: 'Christmas Invite Bundle', productType: '', status: 'ACTIVE', variants: [{ price: '5.00' }] },
      { id: 'gid://shopify/Product/2', title: 'Baby Shower Bundle', productType: 'Invitations', status: 'DRAFT', variants: [{ price: '9.00' }] },
      { id: 'gid://shopify/Product/3', title: 'Menu Card', productType: '', status: 'ACTIVE', variants: [{}] },
    ];
  },
  getOrders: async () => { ADAPTER_CALLS.push('shopify.getOrders'); return [{ id: 'o1', created_at: '2026-09-01', total_price: '25.00', line_items: [] }]; },
  getCustomers: async () => [],
  getInventoryLevels: async () => [],
  getCollections: async () => [],
};
for (const [name, stub] of Object.entries(SHOPIFY_READS)) {
  SAVED_SHOPIFY[name] = shopifyClient[name];
  shopifyClient[name] = stub;
}
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || name in SHOPIFY_READS) continue;
  if (!/^(update|create|add|adjust|delete|remove|set|publish|write)/i.test(name)) continue;
  SAVED_SHOPIFY[name] = shopifyClient[name];
  shopifyClient[name] = async () => { MUTATION_CALLS.push(name); throw new Error(`MUTATION TRIPWIRE: ${name}`); };
}

function restore() {
  global.fetch = originalFetch;
  adapterRegistry.getReadAdapter = originalGetReadAdapter;
  for (const [name, fn] of Object.entries(SAVED_SHOPIFY)) shopifyClient[name] = fn;
}

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

const GROWTH_CYCLE =
  "Chief, run today's growth cycle for my Shopify and Etsy stores. Use real available store data only. Find the highest-confidence opportunities, explain the evidence, propose actions, and do not make consequential changes without my approval. Record what worked and what did not for future cycles.";

// One product step's plan, built straight from the real productModel shape.
const productStep = (records) => ({
  completion_state: 'complete',
  selected_specialist: { id: 'product', title: 'Product' },
  inputs: { tool_id: 'product_data_retrieval', capability_id: 'product_discovery' },
  outputs: { status: 'success', result: records },
});

(async () => {
  const callsBeforeRun = ADAPTER_CALLS.length;
  const result = await runOrchestratorContract(GROWTH_CYCLE);
  const callsAfterRun = ADAPTER_CALLS.length;
  const view = describeChiefResultForOwner({ result, runId: 'opportunities', objective: GROWTH_CYCLE });
  const callsAfterView = ADAPTER_CALLS.length;
  const opportunities = view.store_opportunities;
  const shopify = opportunities.filter((entry) => entry.platform === 'shopify');
  const etsy = opportunities.filter((entry) => entry.platform === 'etsy');

  // --- 1. Real data becomes a specific, evidenced, actionable opportunity -----------------

  test('the run derives specific opportunities from the records it actually read', () => {
    assert.ok(opportunities.length > 0, 'no opportunity was derived from real store data');
    for (const entry of opportunities) {
      assert.ok(entry.issue && entry.issue.length > 10, `weak issue: ${entry.issue}`);
      assert.ok(entry.evidence.length > 0, `${entry.issue} has no evidence`);
      assert.ok(entry.proposed_action && entry.proposed_action.length > 10, `${entry.issue} has no action`);
      assert.ok(CONFIDENCE_LEVELS.includes(entry.confidence), `${entry.issue} -> ${entry.confidence}`);
      assert.strictEqual(typeof entry.requires_approval, 'boolean');
    }
  });

  test('each opportunity quotes the exact field value it rests on', () => {
    const missingType = shopify.find((entry) => /no product type/.test(entry.issue));
    assert.ok(missingType, `no product-type opportunity: ${shopify.map((e) => e.issue).join(' | ')}`);
    assert.strictEqual(missingType.issue, '2 of 3 product(s) have no product type set in Shopify.');
    assert.ok(missingType.evidence.some((line) => /Christmas Invite Bundle/.test(line) && /Menu Card/.test(line)), JSON.stringify(missingType.evidence));
    assert.ok(!/Baby Shower/.test(JSON.stringify(missingType.evidence)), 'a product WITH a type was named as missing one');
    assert.strictEqual(missingType.confidence, 'high');
    assert.strictEqual(missingType.requires_approval, true);
  });

  test('a real store status becomes an opportunity, quoting that status', () => {
    const notBuyable = shopify.find((entry) => /not available to buy/.test(entry.issue));
    assert.ok(notBuyable, 'the DRAFT product produced no opportunity');
    assert.ok(notBuyable.evidence.some((line) => /Baby Shower Bundle/.test(line) && /planned/.test(line)), JSON.stringify(notBuyable.evidence));
  });

  test('the opportunities reach the owner-facing recommendations list', () => {
    assert.ok(view.recommendations.length > 0, 'the owner sees no recommendations');
    assert.ok(view.recommendations.some((line) => /^\[shopify\]/.test(line) && /Evidence:/.test(line) && /Proposed:/.test(line)), view.recommendations.join(' | '));
    assert.ok(view.recommendations.some((line) => /confidence: /.test(line)), 'confidence is not surfaced');
  });

  // --- 2. Shopify and Etsy stay separate ---------------------------------------------------

  test('Shopify and Etsy opportunities are separately identifiable', () => {
    assert.ok(shopify.length > 0, 'no Shopify opportunity');
    assert.ok(etsy.length > 0, 'no Etsy opportunity');
    for (const entry of opportunities) assert.ok(['shopify', 'etsy'].includes(entry.platform), entry.platform);
    // Etsy's opportunity rests on Etsy's own counts, not on anything Shopify returned.
    assert.ok(etsy.every((entry) => entry.evidence.every((line) => /Etsy returned/.test(line))), JSON.stringify(etsy));
  });

  test('an Etsy count difference is graded lower than a directly observed field', () => {
    const counts = etsy.find((entry) => /not reported as digital/.test(entry.issue));
    assert.ok(counts, `no count opportunity: ${etsy.map((e) => e.issue).join(' | ')}`);
    assert.strictEqual(counts.confidence, 'medium');
    assert.strictEqual(counts.requires_approval, false, 'reading Etsy counts must not claim to need a store change');
    assert.match(counts.evidence[0], /listing_active_count: 79 and digital_listing_count: 69/);
  });

  // --- 3. THE TRAP: a field that was never read is never a finding --------------------------

  test('an unread field NEVER becomes an opportunity - cost, currency, description, margin', () => {
    // mapShopifyProductToCandidate hardcodes cost and currency to '' and productModel has no
    // description. Every one of these is empty on every record, and none may be a finding.
    const text = JSON.stringify(opportunities.map((entry) => ({ issue: entry.issue, evidence: entry.evidence, action: entry.proposed_action })));
    for (const forbidden of [/unit cost/i, /no cost/i, /margin/i, /currency/i, /description is empty/i, /missing description/i]) {
      assert.ok(!forbidden.test(text), `an unread field became a finding: ${forbidden}`);
    }
  });

  test('...and every such field is declared as not assessed, with the reason', () => {
    const [entry] = shopify;
    const fields = entry.not_assessed.map((item) => item.field);
    assert.deepStrictEqual(fields.slice().sort(), ['currency', 'description', 'margin', 'unit_cost']);
    for (const item of entry.not_assessed) assert.ok(item.reason.length > 30, `${item.field} has no real reason`);
    // The reason must name WHY the field is unreadable, not just that it is empty.
    assert.ok(
      entry.not_assessed.some((item) => /without asking Shopify for it/.test(item.reason)),
      JSON.stringify(entry.not_assessed)
    );
    assert.ok(
      entry.not_assessed.some((item) => /productModel\.js has no description field/.test(item.reason)),
      JSON.stringify(entry.not_assessed)
    );
  });

  test('a field Etsy did not return is "not established", never an empty-value finding', () => {
    // announcement, title, url and currency_code are all null on this fixture - Etsy sent none.
    const derived = deriveStoreDataOpportunities([{
      completion_state: 'complete',
      selected_specialist: { id: 'product', title: 'Product' },
      inputs: { tool_id: 'etsy_shop_data_retrieval', capability_id: 'etsy_shop_inspection' },
      outputs: { status: 'success', result: etsyReadClient.normalizeEtsyShop({ shop_id: 1, shop_name: 'S', listing_active_count: 5, digital_listing_count: 5 }) },
    }]);
    const text = JSON.stringify(derived.opportunities);
    for (const forbidden of [/announcement/i, /no title/i, /url/i]) {
      assert.ok(!forbidden.test(text), `a field Etsy never returned became a finding: ${forbidden}`);
    }
  });

  test('no unavailable metric is ever invented', () => {
    const text = JSON.stringify(view);
    for (const pattern of [/"sales":\s*\d/, /"revenue":\s*\d/, /"conversion[_ ]?rate":\s*\d/, /"impressions":\s*\d/, /"search[_ ]?volume":\s*\d/, /"demand":\s*\d/]) {
      assert.ok(!pattern.test(text), `an invented metric appeared: ${pattern}`);
    }
    // ...and no opportunity claims a sales/demand outcome for its action.
    for (const entry of opportunities) {
      assert.ok(!/\b(increase|boost|grow|lift) (sales|revenue|conversion|traffic)\b/i.test(entry.proposed_action), `an invented outcome claim: ${entry.proposed_action}`);
    }
  });

  // --- 4. Limitations and insufficiency are honest ------------------------------------------

  test('a step\'s own declared limitation is relayed as a limit on the evidence', () => {
    assert.ok(view.evidence_limits.length > 0, 'the capped-read limitation was dropped');
    const sales = view.evidence_limits.find((entry) => entry.capability === 'sales');
    assert.ok(sales, `no analytics limits: ${JSON.stringify(view.evidence_limits.map((e) => e.capability))}`);
    assert.ok(sales.limitations.some((line) => /capped read|never fetches data/.test(line)), JSON.stringify(sales.limitations));
  });

  test('records that support no opportunity produce none, honestly', () => {
    const clean = deriveStoreDataOpportunities([productStep([
      { product_identity: 'A', category: 'Invitations', availability: 'available', pricing: { price: '5.00', cost: '', currency: '' }, source: ['Shopify product 1'] },
    ])]);
    assert.deepStrictEqual(clean.opportunities, []);
    assert.strictEqual(clean.considered.store_reads, 1);
  });

  test('a run that read nothing assessable says so rather than reaching for something weaker', () => {
    const none = deriveStoreDataOpportunities([]);
    assert.deepStrictEqual(none.opportunities, []);
    assert.strictEqual(none.considered.store_reads, 0);
    assert.match(none.considered.note, /No store read/);
  });

  test('no external research is triggered to produce recommendations', () => {
    const tools = result.routing.plan.flatMap((step) => step.tool_calls || []);
    for (const research of ['catalogue_expansion_opportunities', 'live_competitor_research', 'discover_market_questions', 'seo_content_generation']) {
      assert.ok(!tools.includes(research), `${research} ran to build the report`);
    }
  });

  test('building the report makes NO additional store or network call', () => {
    assert.strictEqual(callsAfterView, callsAfterRun, `reporting made ${callsAfterView - callsAfterRun} extra call(s)`);
    assert.ok(callsAfterRun > callsBeforeRun, 'the run itself read nothing - the test would prove nothing');
    assert.deepStrictEqual(FETCH_CALLS, []);
  });

  // --- 5. Safety ----------------------------------------------------------------------------

  test('anything that would change a store is marked as needing approval', () => {
    for (const entry of opportunities) {
      if (/^(Set|Review|Check|Turn|Publish)/.test(entry.proposed_action)) {
        assert.strictEqual(entry.requires_approval, true, `${entry.proposed_action} does not say it needs approval`);
      }
    }
  });

  test('ETSY REMAINS READ-ONLY and nothing was mutated or approved', () => {
    const etsyTools = TOOL_REGISTRY.filter((tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy'));
    assert.deepStrictEqual(etsyTools.filter((tool) => tool.operation !== 'read').map((tool) => tool.id), []);
    assert.strictEqual(etsyClient.canPublish(), false);
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(view.mutations, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.strictEqual(view.approval_state, 'not_needed');
    assert.strictEqual(mutationIntent.maySelectMutationTool(GROWTH_CYCLE), false);
  });

  test('"what worked / what did not" is still reported as unrecorded, never invented', () => {
    assert.strictEqual(view.cycle_learning.recorded, false);
    assert.match(view.cycle_learning.detail, /experimentLearningStore/);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('storeDataOpportunities.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
