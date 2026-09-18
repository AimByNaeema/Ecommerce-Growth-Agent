'use strict';

// CHIEF ROUTING REGRESSION - a live, read-only Etsy inspection reached Shopify instead.
//
// THE PRODUCTION FAILURE. The store owner typed, against the real connected store:
//
//   "Chief, inspect my connected Etsy store and show me the current shop name, shop ID,
//    listing count, and whether Etsy is connected as read-only. Do not make any changes."
//
// The platform resolved to Shopify, the Listing specialist was selected, and no Etsy read
// happened at all. Nothing was mutated - every write gate held - but the answer was about the
// wrong store.
//
// ROOT CAUSE (all four measured against the code before the fix):
//   1. Routing was platform-blind. buildRoutingTargets() builds each specialist's routing text
//      from its id/title/description/ROUTING_SYNONYMS only, never its tools', so the word
//      "etsy" existed in NO routing target - and distinctiveRoutingWords() additionally drops a
//      connected platform's name on purpose. "inspect my connected Etsy store" therefore scored
//      analytics_optimization 1, on the single incidental word "store" (from "Store
//      performance ..." in that specialist's description), and that step then read SHOPIFY.
//   2. No capability task referenced etsy_shop_data_retrieval - specialistCapabilityRegistry.js
//      declared exactly that as an open gap - so the Etsy shop read was unreachable by routing.
//   3. buildPlanStep()'s tool selection had no platform awareness: a clause about Etsy could
//      select a tool bound to Shopify, and the reverse was also measurable.
//   4. "listing count" - a FIELD of the answer - scored listing 3 all by itself, because
//      "listing" repeats three times in that specialist's own routing text, selecting a second
//      specialist for a column of the first one's result.
//
// WHAT THESE TESTS ASSERT: the exact request resolves to Etsy, selects only the Product
// specialist's etsy_shop_inspection capability, calls only the existing read-only Etsy tool,
// can never select an Etsy write, invents no shop field, and changes nothing. Plus the pinned
// negatives that keep the two new routing rules narrow.
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. The Etsy read is stubbed at
// integrations/adapters/adapterRegistry.js's getReadAdapter seam - the one
// tools/etsyShopDataTool.js actually uses - so no ETSY_* value is read and no transport runs.
// A fetch tripwire and Shopify mutation tripwires are installed and asserted empty.

const assert = require('node:assert');

// Resolved at call time by the tool selector, and the local .env may name another provider with
// a real key - pin it so no billable call is even possible. Same reason as
// orchestratorExecutionContract.test.js's own header.
process.env.AI_PROVIDER = 'claude';

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const adapterRegistry = require('../../integrations/adapters/adapterRegistry');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');

// The Etsy shop record as the read client's own normalizeEtsyShop() shapes it - so the fixture
// cannot describe a shape Etsy never returns. `announcement` is deliberately absent from the
// input: this shop has none, and the tests below prove absent stays null rather than defaulted.
const FIXTURE_SHOP = etsyReadClient.normalizeEtsyShop({
  shop_id: 90210,
  shop_name: 'FixtureInvites',
  title: 'Fixture digital invitations',
  currency_code: 'GBP',
  url: 'https://www.etsy.com/shop/FixtureInvites',
  listing_active_count: 42,
  digital_listing_count: 40,
  is_vacation: false,
});

// THE ETSY READ SEAM, STUBBED - AND STUBBED BEFORE THE ORCHESTRATOR IS REQUIRED.
// tools/etsyShopDataTool.js destructures getReadAdapter at require time, so a stub installed
// after that module has loaded would never be reached and this suite would silently assert
// against an "Etsy reading is not configured" failure instead of a real read. Every other
// platform still resolves to its real adapter, so a step that wrongly routed to Shopify would
// hit the fetch/mutation tripwires below rather than quietly pass.
const SHOP_READS = [];
const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return {
    isConfigured: () => true,
    getShopInfo: async (params) => {
      SHOP_READS.push(params || {});
      return { name: FIXTURE_SHOP.shop_name, domain: FIXTURE_SHOP.url, email: null, channel: 'etsy', native: FIXTURE_SHOP };
    },
  };
};

const etsyClient = require('../../integrations/adapters/etsyClient');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const mutationIntent = require('../../agent/core/mutationIntent');
const { TOOL_REGISTRY, getToolById } = require('../../tools/toolRegistry');
const { checkToolAccess } = require('../../agent/core/toolPermissions');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const {
  planRouting,
  understandObjective,
  runOrchestratorContract,
  resolveEnabledPlatformsForBusiness,
} = require('../../agent/core/orchestratorExecutionContract');

// Every Shopify write is a tripwire: called at all, this run fails loudly.
const MUTATION_CALLS = [];
const SAVED_SHOPIFY = {};
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function') continue;
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

// The exact request the owner typed, character for character.
const PRODUCTION_REQUEST =
  'Chief, inspect my connected Etsy store and show me the current shop name, shop ID, listing count, and whether Etsy is connected as read-only. Do not make any changes.';

const plan = (text) => planRouting(understandObjective(text));
const targetIds = (result) => (result.targets || []).map((target) => target.id);

(async () => {
  // --- 1. The request resolves to platform = Etsy ------------------------------------

  test('the platform gate is genuinely engaged - this business has Etsy enabled', () => {
    // If Etsy were not enabled, checkToolAccess would refuse the Etsy tool and everything
    // below would be asserting against a gate that never actually ran.
    assert.ok(resolveEnabledPlatformsForBusiness(null).includes('etsy'));
  });

  test('EXACT PRODUCTION REQUEST plans instead of asking for clarification', () => {
    const result = plan(PRODUCTION_REQUEST);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
  });

  test('EXACT PRODUCTION REQUEST routes to Etsy, not Shopify - Product alone', () => {
    assert.deepStrictEqual(targetIds(plan(PRODUCTION_REQUEST)), ['product']);
  });

  test('the Etsy clause is the task; "listing count" and "shop ID" are fields of its answer', () => {
    const by = {};
    for (const entry of plan(PRODUCTION_REQUEST).interpretation) by[entry.clause] = entry;
    assert.deepStrictEqual(
      {
        disposition: by['inspect my connected Etsy store'].disposition,
        target: by['inspect my connected Etsy store'].target,
      },
      { disposition: 'task', target: 'product' }
    );
    // The defect: this clause used to become a second, Listing task on the bare word "listing".
    assert.strictEqual(by['listing count'].disposition, 'framing');
    assert.strictEqual(by['listing count'].target, null);
    assert.strictEqual(by['shop ID'].disposition, 'framing');
    assert.strictEqual(by['Do not make any changes.'].disposition, 'constraint');
  });

  test('"Do not make any changes" and "read-only" are both recorded as run constraints', () => {
    assert.deepStrictEqual(plan(PRODUCTION_REQUEST).instructions.safety, ['read-only', 'Do not make any changes']);
  });

  // --- 2, 3, 5, 6, 7. One real run of the Chief, asserted from end to end -------------
  //
  // Run ONCE and assert against that one result: every claim below is about the same
  // execution, so a later assertion cannot be satisfied by a different run than an earlier one.

  const readsBefore = SHOP_READS.length;
  const result = await runOrchestratorContract(PRODUCTION_REQUEST);
  const steps = result.routing.plan || [];
  const step = steps[0] || null;
  const describeStep = () => JSON.stringify(step, null, 1);

  test('the run plans, and runs exactly one step', () => {
    assert.strictEqual(result.routing.status, 'planned', `routing ${result.routing.status}: ${result.routing.reason}`);
    assert.strictEqual(steps.length, 1, `expected one step, got: ${steps.map((s) => s.selected_specialist.id).join(', ')}`);
  });

  test('that step is the Product specialist running the etsy_shop_inspection capability', () => {
    assert.strictEqual(step.selected_specialist.id, 'product');
    assert.strictEqual(step.inputs.capability_id, 'etsy_shop_inspection', describeStep());
  });

  test('it calls only the existing read-only Etsy tool, and it succeeds', () => {
    assert.deepStrictEqual(step.tool_calls, ['etsy_shop_data_retrieval']);
    assert.strictEqual(step.completion_state, 'complete', describeStep());
    assert.strictEqual(step.outputs.status, 'success', describeStep());
  });

  test('the Etsy shop read really ran, exactly once', () => {
    assert.strictEqual(SHOP_READS.length - readsBefore, 1);
  });

  test('no other specialist is selected - not Listing, not Analytics, not SEO', () => {
    const selected = steps.map((entry) => entry.selected_specialist.id);
    for (const specialistId of ['listing', 'analytics_optimization', 'seo', 'research', 'marketing', 'social_advertising']) {
      assert.ok(!selected.includes(specialistId), `${specialistId} was selected for an Etsy shop read`);
    }
  });

  test('every reported shop field is exactly what Etsy returned - nothing is invented', () => {
    assert.deepStrictEqual(step.outputs.result, FIXTURE_SHOP);
    assert.strictEqual(step.outputs.result.shop_name, 'FixtureInvites');
    assert.strictEqual(step.outputs.result.shop_id, 90210);
    assert.strictEqual(step.outputs.result.listing_active_count, 42);
    assert.strictEqual(step.outputs.result.channel, 'etsy');
  });

  test('a field Etsy did not return stays null - never defaulted or inferred', () => {
    assert.strictEqual(step.outputs.result.announcement, null);
  });

  test('the run selects no correction tool and requests no approval', () => {
    for (const toolId of mutationIntent.CORRECTION_TOOL_IDS) {
      assert.ok(!step.tool_calls.includes(toolId), `${toolId} selected for a read-only request`);
    }
    assert.strictEqual((result.pending_approvals || []).length, 0);
  });

  test('no mutation was attempted, and no network was touched', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(FETCH_CALLS, []);
  });

  test('the owner-facing view reports no change and no clarification', () => {
    const ownerView = describeChiefResultForOwner({ result, runId: 'etsy-shop-inspection-regression' });
    assert.notStrictEqual(ownerView.status, 'needs_clarification');
    assert.deepStrictEqual(ownerView.mutations, []);
  });

  // --- 4. An Etsy publishing/write capability can never be selected -------------------

  test('no Etsy-bound tool in the registry is anything but a read', () => {
    const nonRead = TOOL_REGISTRY.filter(
      (tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy') && tool.operation !== 'read'
    );
    assert.deepStrictEqual(nonRead.map((tool) => tool.id), []);
  });

  test('the capability the Chief selected declares only that one read tool', () => {
    assert.deepStrictEqual(getCapabilityTask('product', 'etsy_shop_inspection').tool_ids, ['etsy_shop_data_retrieval']);
  });

  test('the Etsy publish adapter is unreachable by configuration, not merely unselected', () => {
    // canPublish() is false regardless of credentials - integrations/adapters/etsyClient.js.
    assert.strictEqual(etsyClient.canPublish(), false);
  });

  test('the whole request is read-only to the mutation gate', () => {
    assert.strictEqual(mutationIntent.classifyRequestIntent(PRODUCTION_REQUEST), 'read_only');
    assert.strictEqual(mutationIntent.maySelectMutationTool(PRODUCTION_REQUEST), false);
  });

  test('the selected tool is the existing read-only Etsy integration, and Etsy-bound', () => {
    const tool = getToolById('etsy_shop_data_retrieval');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.status, 'implemented');
    assert.deepStrictEqual(tool.platforms, ['etsy']);
  });

  test('the platform gate agrees: allowed for an Etsy business, denied for a Shopify-only one', () => {
    assert.strictEqual(
      checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval', enabledPlatforms: ['etsy'] }).decision,
      'allowed'
    );
    assert.strictEqual(
      checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval', enabledPlatforms: ['shopify'] }).decision,
      'denied'
    );
  });

  test('the capability promises exactly the fields the read client actually returns', () => {
    // The registry writes the field list out rather than importing the adapter (it is a
    // composition layer over the model and registry files only). This is what keeps that copy
    // honest: it must equal normalizeEtsyShop()'s real keys, which needs no network and no
    // credential to compute.
    assert.deepStrictEqual(
      getCapabilityTask('product', 'etsy_shop_inspection').output_contract.fields,
      Object.keys(etsyReadClient.normalizeEtsyShop({}))
    );
  });

  // --- 8. The two new routing rules stay narrow --------------------------------------
  //
  // Each of these passed BEFORE the fix and must keep passing after it. They are the guard
  // against a later, well-meaning widening of either rule.

  test('naming Etsy does not capture a clause that names another specialist by its own name', () => {
    // "listings" is Listing's own declared vocabulary (ROUTING_SYNONYMS), which outranks the
    // platform pairing - so this is still Listing's work, alongside Product's.
    assert.deepStrictEqual(
      targetIds(plan('Analyse my Etsy invitation listings and my Shopify products.')).slice().sort(),
      ['listing', 'product']
    );
  });

  test('"listing quality" is still a Listing task - only "listing count" is an answer field', () => {
    // The discriminator is the selected capability's own output_contract.fields, not a word
    // list: etsy_shop_inspection returns listing_active_count and returns nothing named
    // "quality". This objective names no platform at all, so the field rule cannot even run.
    assert.deepStrictEqual(targetIds(plan('Check my SEO and listing quality and recommend next steps.')), ['seo', 'listing']);
  });

  test('an Etsy clause naming no capability keeps its existing routing', () => {
    // The platform rule requires a capability whose OWN id/title names the platform. Nothing
    // here is named "etsy" beyond the platform itself being scope, so this is unchanged.
    assert.deepStrictEqual(targetIds(plan('reformat my listing content for the Etsy marketplace')), ['listing']);
  });

  await testAsync('a Shopify request still reaches the Shopify read, never the Etsy one', async () => {
    // etsy_shop_data_retrieval's description mentions Shopify only to say its records are never
    // merged with it - which used to let it outscore product_data_retrieval on "my Shopify
    // data" and dispatch an ETSY read for a Shopify question. The platform filter in
    // buildPlanStep settles this by binding rather than by wording.
    const shopifyRequest = 'Look through my Shopify data and point out the opportunities I am missing.';
    assert.deepStrictEqual(targetIds(plan(shopifyRequest)), ['product']);
    const shopifyResult = await runOrchestratorContract(shopifyRequest);
    const productStep = (shopifyResult.routing.plan || []).find((entry) => entry.selected_specialist.id === 'product');
    assert.ok(productStep, 'the Product step is missing');
    assert.deepStrictEqual(productStep.tool_calls, ['product_data_retrieval']);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('etsyShopInspectionRouting.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
