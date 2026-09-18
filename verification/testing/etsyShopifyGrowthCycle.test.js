'use strict';

// A TWO-STORE REQUEST RAN ON ONE STORE, AND SPENT SEARCH BUDGET GETTING THERE.
//
// THE PRODUCTION FAILURE. The owner asked for a combined growth cycle:
//
//   "Chief, run today's growth cycle for my Shopify and Etsy stores. Use real available store
//    data only. Find the highest-confidence opportunities, explain the evidence, propose
//    actions, and do not make consequential changes without my approval. Record what worked
//    and what did not for future cycles."
//
// Result: status partial, platform "shopify", Product failed on SEARCH_QUOTA_EXCEEDED, and NO
// Etsy step was produced at all.
//
// ROOT CAUSE A - the Etsy target was never created, for two compounding reasons, both measured:
//   A1. The produce/change/act branch of resolveObjectiveIntent routed on word overlap alone
//       and never consulted the platform rules. Same subject, different opening verb:
//       "Inspect my Etsy store." resolved etsy_shop_inspection, while "Run the growth cycle for
//       my Etsy store." resolved nothing and went to Analytics, whose only live tool is
//       Shopify-bound. The owner should not have to know which verb unlocks their own data.
//   A2. Every platform rule required exactly ONE platform (platformNamedCapabilityTarget
//       returns null for two; soleObjectivePlatform returns null for two), so a genuinely
//       two-store request resolved no platform capability on the read path either.
//   Downstream, planRouting deduplicated by specialist, so even two resolved platform matches
//   on Product would have collapsed into one step and dropped a store.
//
// ROOT CAUSE B - the Product step spent live web-search budget on a store-data question. The
// catalogue-expansion override scored capability descriptions against the raw clause, and
// "Find the highest-confidence opportunities" scored catalogue_expansion_opportunities 2 to
// product_recommendation's 1 purely because "opportunities" appears twice in that capability's
// own title and description. "opportunities" is an ANSWER_STRUCTURE word - the shape of an
// answer, not the subject of one. The override won, dispatched batched Claude + web_search
// calls, and the run died on SEARCH_QUOTA_EXCEEDED having read nothing from either store -
// in a request whose own words were "Use real available store data only".
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. Both store reads are stubbed at their module
// seams before the orchestrator is required. A fetch tripwire and write tripwires are
// installed and asserted empty.

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
});

const ETSY_READS = [];
const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return {
    isConfigured: () => true,
    getShopInfo: async () => {
      ETSY_READS.push('getShopInfo');
      return { native: FIXTURE_SHOP };
    },
    getProducts: async () => {
      ETSY_READS.push('getProducts');
      return [];
    },
  };
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyClient = require('../../integrations/adapters/etsyClient');
const mutationIntent = require('../../agent/core/mutationIntent');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const { planRouting, understandObjective, runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

// Shopify reads return fixtures; every Shopify WRITE is a tripwire.
const SHOPIFY_READS = [];
const MUTATION_CALLS = [];
const SAVED_SHOPIFY = {};
const SHOPIFY_READ_STUBS = {
  isConfigured: () => true,
  getShopInfo: async () => { SHOPIFY_READS.push('getShopInfo'); return { name: 'Fixture Store', domain: 'fixture.myshopify.com', email: null }; },
  getProducts: async () => { SHOPIFY_READS.push('getProducts'); return [{ id: 'gid://1', title: 'Fixture Bundle A', vendor: 'Fixture', variants: [] }]; },
  getOrders: async () => { SHOPIFY_READS.push('getOrders'); return []; },
  getCustomers: async () => { SHOPIFY_READS.push('getCustomers'); return []; },
  getInventoryLevels: async () => { SHOPIFY_READS.push('getInventoryLevels'); return []; },
  getCollections: async () => { SHOPIFY_READS.push('getCollections'); return []; },
};
for (const [name, stub] of Object.entries(SHOPIFY_READ_STUBS)) {
  SAVED_SHOPIFY[name] = shopifyClient[name];
  shopifyClient[name] = stub;
}
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || name in SHOPIFY_READ_STUBS) continue;
  if (!/^(update|create|add|adjust|delete|remove|set|publish|write)/i.test(name)) continue;
  SAVED_SHOPIFY[name] = shopifyClient[name];
  shopifyClient[name] = async () => {
    MUTATION_CALLS.push(name);
    throw new Error(`MUTATION TRIPWIRE: ${name}`);
  };
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

const plan = (text) => planRouting(understandObjective(text));
const routeOf = (text) => {
  const result = plan(text);
  return (result.targets || []).map((target, index) => {
    const capability = (result.capabilities || [])[index];
    return capability ? `${target.id}/${capability.capabilityId}` : target.id;
  });
};

(async () => {
  const etsyBefore = ETSY_READS.length;
  const shopifyBefore = SHOPIFY_READS.length;
  const result = await runOrchestratorContract(GROWTH_CYCLE);
  const steps = result.routing.plan || [];
  const view = describeChiefResultForOwner({ result, runId: 'growth-cycle', objective: GROWTH_CYCLE });
  const toolsUsed = steps.flatMap((step) => step.tool_calls || []);
  const capabilities = steps.map((step) => step.inputs && step.inputs.capability_id);

  // --- 1. BOTH platforms get execution coverage -------------------------------------------

  test('the combined request plans a separate step per platform instead of collapsing to one', () => {
    assert.strictEqual(result.routing.status, 'planned', `routing ${result.routing.status}: ${result.routing.reason}`);
    // The Product specialist appears TWICE - once scoped to the Etsy read the clause named,
    // once for the Shopify side. Deduplicating by specialist is what dropped a store before.
    assert.deepStrictEqual(steps.map((step) => step.selected_specialist.id), ['product', 'product', 'analytics_optimization']);
  });

  test('ETSY is executed, through its existing read-only inspection capability', () => {
    assert.ok(capabilities.includes('etsy_shop_inspection'), `capabilities: ${capabilities.join(', ')}`);
    assert.ok(toolsUsed.includes('etsy_shop_data_retrieval'), `tools: ${toolsUsed.join(', ')}`);
    assert.ok(ETSY_READS.length > etsyBefore, 'no Etsy read actually ran');
  });

  test('SHOPIFY is executed, through its existing store-data capabilities', () => {
    assert.ok(toolsUsed.includes('product_data_retrieval'), `tools: ${toolsUsed.join(', ')}`);
    assert.ok(toolsUsed.includes('analytics_data_retrieval'), `tools: ${toolsUsed.join(', ')}`);
    assert.ok(SHOPIFY_READS.length > shopifyBefore, 'no Shopify read actually ran');
  });

  test('the owner-facing result names both platforms rather than reporting one or none', () => {
    assert.deepStrictEqual(view.platforms.slice().sort(), ['etsy', 'shopify']);
    assert.match(view.platform, /etsy/);
    assert.match(view.platform, /shopify/);
  });

  test('both platforms\' findings are combined into the one result', () => {
    assert.ok(view.findings.length >= 2, `only ${view.findings.length} finding(s)`);
    assert.ok(view.store_connections.some((entry) => entry.platform === 'etsy'), 'the Etsy read is missing from the result');
  });

  // --- 2. Data-first: no live research for a store-data question ---------------------------

  test('"opportunities" alone does NOT trigger catalogue expansion or live research', () => {
    assert.ok(!toolsUsed.includes('catalogue_expansion_opportunities'), 'live catalogue research ran');
    assert.ok(!toolsUsed.includes('live_competitor_research'), 'live competitor research ran');
    assert.ok(!toolsUsed.includes('discover_market_questions'), 'live question discovery ran');
  });

  test('"Use real available store data only" is answered from live store reads', () => {
    // Product reaches its own live store source rather than an external one.
    assert.ok(capabilities.includes('product_discovery'), `capabilities: ${capabilities.join(', ')}`);
    assert.ok(toolsUsed.includes('product_data_retrieval'));
  });

  test('explicit market-research intent STILL reaches the existing research capability', () => {
    // The override is narrowed, not removed: a real catalogue-expansion question still routes
    // to Product's catalogue_expansion_opportunities exactly as it did.
    for (const goal of ['What should this store sell next?', 'Analyze our existing catalogue and identify expansion opportunities.']) {
      assert.deepStrictEqual(routeOf(goal), ['product'], `${goal} -> ${routeOf(goal).join(',')}`);
    }
  });

  test('the research usage guard and its quota refusal are untouched - nothing was weakened', () => {
    // Asserted on the guard's REAL declared limits and on the retry classifier, not on source
    // prose: this change reduces how often live research is ASKED for and bypasses nothing.
    const guard = require('../../agent/core/researchUsageGuard');
    assert.deepStrictEqual(guard.getLimits(), {
      attempts_per_run: 12,
      daily_attempts: 60,
      daily_runs: 20,
      quota_cooldown_minutes: 60,
    });
    // A quota exhaustion is still classified as NOT retryable - it fails closed rather than
    // being retried around.
    assert.strictEqual(require('../../agent/core/networkRetry').isQuotaExhaustedMessage('quota exceeded'), true);
    // The orchestrator still routes every live-research dispatch through the guard.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'),
      'utf8'
    );
    assert.ok(/researchUsageGuard/.test(source), 'the orchestrator no longer references the research usage guard');
  });

  // --- 3. Single-platform behaviour is unchanged -------------------------------------------

  test('an ETSY-ONLY request behaves exactly as before', () => {
    assert.deepStrictEqual(
      routeOf('Chief, inspect my connected Etsy store and show me the current shop name, shop ID, listing count, and whether Etsy is connected as read-only. Do not make any changes.'),
      ['product/etsy_shop_inspection']
    );
    assert.deepStrictEqual(
      routeOf('Chief, inspect my Etsy store and analyze my current active digital listings. Identify up to 5 specific listings with clear optimization opportunities based only on real Etsy data currently available. Do not make any changes.'),
      ['product/etsy_listing_inspection']
    );
  });

  test('a SHOPIFY-ONLY request behaves exactly as before', () => {
    assert.deepStrictEqual(
      routeOf('Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.'),
      ['product', 'seo', 'analytics_optimization']
    );
    assert.deepStrictEqual(routeOf("Review my Shopify products and orders, then show me the top 5 priorities. Don't change anything."), ['product', 'analytics_optimization']);
  });

  test('a single-platform request never gains a second step for the same specialist', () => {
    for (const objective of [
      'Chief, inspect my connected Etsy store and show me the shop name. Do not make any changes.',
      'Analyse my Shopify products.',
    ]) {
      const ids = routeOf(objective).map((entry) => entry.split('/')[0]);
      assert.strictEqual(new Set(ids).size, ids.length, `${objective} -> duplicate specialist in ${ids.join(',')}`);
    }
  });

  // --- 4. Etsy stays read-only; every gate holds -------------------------------------------

  test('ETSY REMAINS READ-ONLY - no write or publish capability exists or was introduced', () => {
    const etsyTools = TOOL_REGISTRY.filter((tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy'));
    assert.ok(etsyTools.length > 0);
    assert.deepStrictEqual(etsyTools.filter((tool) => tool.operation !== 'read').map((tool) => tool.id), []);
    assert.strictEqual(etsyClient.canPublish(), false);
  });

  test('no mutation, no approval request, no network', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(FETCH_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.deepStrictEqual(view.mutations, []);
    for (const step of steps) {
      for (const toolId of mutationIntent.CORRECTION_TOOL_IDS) {
        assert.ok(!(step.tool_calls || []).includes(toolId), `${toolId} selected`);
      }
    }
  });

  test('the request is read-only to the mutation gate', () => {
    assert.strictEqual(mutationIntent.classifyRequestIntent(GROWTH_CYCLE), 'read_only');
    assert.strictEqual(mutationIntent.maySelectMutationTool(GROWTH_CYCLE), false);
  });

  test('no unavailable metric is invented anywhere in the answer', () => {
    const answer = JSON.stringify(view.findings) + JSON.stringify(view.store_connections);
    for (const pattern of [/"sales":\s*\d/, /"revenue":\s*\d/, /"conversion[_ ]?rate":\s*\d/, /"impressions":\s*\d/, /"search[_ ]?volume":\s*\d/, /"demand":\s*\d/]) {
      assert.ok(!pattern.test(answer), `an invented metric appeared: ${pattern}`);
    }
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('etsyShopifyGrowthCycle.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
