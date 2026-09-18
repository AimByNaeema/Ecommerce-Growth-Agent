'use strict';

// THE ETSY LISTING ANALYSIS THE CHIEF COULD NOT REACH.
//
// THE PRODUCTION FAILURE. Against the real connected shop (HappyInviteHouse, 79 active, 69
// digital), the owner asked the Chief to analyze their active digital listings and name up to
// five with real evidence behind them. The Chief read the SHOP record, then failed: the SEO
// specialist asked for keywords, the Listing specialist could not tell which of its two
// authoring capabilities was meant, and an Analytics step ran a Shopify sales read. No listing
// was ever read.
//
// ROOT CAUSE. tools/etsyListingDataTool.js exists, is read-only and is bound to Etsy - but NO
// capability task referenced it, so capability matching could never select it. The registry
// documented exactly that as an open gap. With nowhere correct to go, "analyze my current
// active digital listings" routed on the word "listings" to the LISTING specialist, which
// AUTHORS listing copy and cannot read Etsy at all; both of its capabilities then scored 0
// against the clause and its ambiguity guard correctly refused to guess. Naming Etsy did not
// help either - measured: "analyze my current active digital Etsy listings" also routed to
// Listing, because the platform-named routing rule declines to a specialist the clause names by
// its own vocabulary, and "listings" is in ROUTING_SYNONYMS.listing.
//
// THE FIX HAS THREE PARTS, ALL PINNED BELOW: the etsy_listing_inspection capability; an
// objective-level platform inheritance so a clause naming no platform is still understood as
// being about the store the request already named; and an owner-facing projection so the
// analysis reaches the person who asked for it instead of sitting in the raw run result.
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. The Etsy read is stubbed at
// integrations/adapters/adapterRegistry.js's getReadAdapter seam - before the orchestrator is
// required, because tools/etsyListingDataTool.js destructures that function at require time.
// A fetch tripwire and Shopify mutation tripwires are installed and asserted empty.

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

// Listings shaped by the read client's own normalizeEtsyListing(), so no fixture can describe a
// record Etsy never produces. Deliberate gaps: one with no tags, one with no materials and an
// empty description, one physical (to prove the digital filter), and NONE with `views` or
// `num_favorers`, which Etsy does not return on the listings-by-shop response.
const listing = (id, title, state, extra) =>
  etsyReadClient.normalizeEtsyListing(
    Object.assign(
      {
        listing_id: id,
        shop_id: 62500594,
        title,
        state,
        is_digital: true,
        description: 'A printable invitation.',
        tags: ['invitation', 'printable'],
        materials: ['digital download'],
        price: { amount: 500, divisor: 100, currency_code: 'GBP' },
        quantity: 1,
      },
      extra || {}
    )
  );

const FIXTURE_LISTINGS = [
  listing(101, 'Pink Birthday Invite', 'active', { tags: [] }),
  listing(102, 'Blue Baby Shower Invite', 'active', { materials: [], description: '' }),
  listing(103, 'Wedding Suite Bundle', 'active'),
  listing(104, 'Printed Thank You Card', 'active', { is_digital: false, listing_type: 'physical' }),
];

const READ_PARAMS = [];
const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return {
    isConfigured: () => true,
    getProducts: async (params) => {
      READ_PARAMS.push(params || {});
      return FIXTURE_LISTINGS.map((record) => ({ native: record }));
    },
    getShopInfo: async () => ({ native: etsyReadClient.normalizeEtsyShop({ shop_id: 62500594, shop_name: 'HappyInviteHouse' }) }),
  };
};

const etsyClient = require('../../integrations/adapters/etsyClient');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const mutationIntent = require('../../agent/core/mutationIntent');
const { TOOL_REGISTRY, getToolById } = require('../../tools/toolRegistry');
const { checkToolAccess } = require('../../agent/core/toolPermissions');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const { planRouting, understandObjective, runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

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

const PRODUCTION_REQUEST =
  'Chief, inspect my Etsy store and analyze my current active digital listings. Identify up to 5 specific listings with clear optimization opportunities based only on real Etsy data currently available. For each, show the listing title, current status, and the exact data/evidence that supports the opportunity. Do not invent sales, demand, search volume, or performance metrics. Do not make any changes.';

const plan = (text) => planRouting(understandObjective(text));
const targetIds = (text) => (plan(text).targets || []).map((target) => target.id);

(async () => {
  // --- Routing -----------------------------------------------------------------------

  test('EXACT PRODUCTION REQUEST routes to Product alone - not Listing, not SEO, not Analytics', () => {
    const result = plan(PRODUCTION_REQUEST);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
    assert.deepStrictEqual(targetIds(PRODUCTION_REQUEST), ['product']);
  });

  test('routing resolves the Etsy listing capability by name, not by word overlap on a tool', () => {
    assert.deepStrictEqual(plan(PRODUCTION_REQUEST).capabilities, [
      { toolId: 'etsy_listing_data_retrieval', capabilityId: 'etsy_listing_inspection' },
    ]);
  });

  test('the listing clause is a task on Product, and the prohibition stays a constraint', () => {
    const by = {};
    for (const entry of plan(PRODUCTION_REQUEST).interpretation) by[entry.clause] = entry;
    assert.strictEqual(by['analyze my current active digital listings.'].disposition, 'task');
    assert.strictEqual(by['analyze my current active digital listings.'].target, 'product');
    assert.strictEqual(by['search volume'].disposition, 'constraint');
  });

  // --- The run ------------------------------------------------------------------------

  const readsBefore = READ_PARAMS.length;
  const result = await runOrchestratorContract(PRODUCTION_REQUEST);
  const steps = result.routing.plan || [];
  const step = steps[0] || null;
  const view = describeChiefResultForOwner({ result, runId: 'etsy-listing-analysis', objective: PRODUCTION_REQUEST });
  const derived = (view.listing_opportunities || [])[0] || null;

  test('exactly one step runs, on Product, through the Etsy listing capability', () => {
    assert.strictEqual(result.routing.status, 'planned', `routing ${result.routing.status}: ${result.routing.reason}`);
    assert.strictEqual(steps.length, 1, `expected one step, got: ${steps.map((s) => s.selected_specialist.id).join(', ')}`);
    assert.strictEqual(step.selected_specialist.id, 'product');
    assert.strictEqual(step.inputs.capability_id, 'etsy_listing_inspection');
    assert.deepStrictEqual(step.tool_calls, ['etsy_listing_data_retrieval']);
  });

  test('no Analytics or Shopify step is created - the accidental Shopify read is gone', () => {
    const selected = steps.map((entry) => entry.selected_specialist.id);
    for (const specialistId of ['analytics_optimization', 'seo', 'listing']) {
      assert.ok(!selected.includes(specialistId), `${specialistId} was selected`);
    }
    for (const entry of steps) {
      assert.ok(!(entry.tool_calls || []).includes('analytics_data_retrieval'), 'a Shopify analytics read ran');
      assert.ok(!(entry.tool_calls || []).includes('product_data_retrieval'), 'a Shopify product read ran');
    }
  });

  test('ACTIVE listings are requested from Etsy, not filtered afterwards', () => {
    assert.strictEqual(READ_PARAMS.length - readsBefore, 1, 'the Etsy listing read did not run exactly once');
    assert.strictEqual(READ_PARAMS[READ_PARAMS.length - 1].state, 'active');
  });

  test('analysis is restricted to the listings Etsy reported as digital', () => {
    assert.ok(derived, 'no listing analysis was surfaced');
    assert.strictEqual(derived.considered.listings_returned, 4);
    assert.strictEqual(derived.considered.digital_filter_applied, true);
    assert.strictEqual(derived.considered.listings_considered, 3);
    const titles = derived.opportunities.map((entry) => entry.title);
    assert.ok(!titles.includes('Printed Thank You Card'), 'a physical listing was analysed');
  });

  test('at most 5 opportunities are returned, each with real evidence', () => {
    assert.ok(derived.opportunities.length > 0, 'no opportunities were identified');
    assert.ok(derived.opportunities.length <= 5, `got ${derived.opportunities.length}`);
    for (const entry of derived.opportunities) {
      assert.ok(entry.evidence.length > 0, `${entry.title} has no evidence`);
      assert.ok(entry.opportunity, `${entry.title} has no stated opportunity`);
    }
  });

  test('listing title and status are propagated verbatim from Etsy', () => {
    const first = derived.opportunities.find((entry) => entry.listing_id === 101);
    assert.ok(first, 'listing 101 is missing from the analysis');
    assert.strictEqual(first.title, 'Pink Birthday Invite');
    assert.strictEqual(first.state, 'active');
    assert.strictEqual(first.is_digital_product, true);
    // Its evidence quotes the real, observable gap - Etsy returned an empty tags array.
    assert.ok(first.evidence.some((item) => /0 tags/.test(item)), JSON.stringify(first.evidence));
  });

  test('a field Etsy did not return stays unavailable - never 0, never invented', () => {
    for (const entry of derived.opportunities) {
      const unavailable = entry.unavailable.map((field) => field.id);
      assert.ok(unavailable.includes('views'), `${entry.title} did not mark views unavailable`);
      assert.ok(unavailable.includes('num_favorers'), `${entry.title} did not mark num_favorers unavailable`);
      for (const field of entry.unavailable) assert.ok(field.reason, `${field.id} has no reason`);
    }
    // The owner-facing sentence says so too, rather than quietly omitting them.
    assert.match(view.findings[0].summary, /Unavailable: views, num_favorers/);
  });

  test('no sales, revenue, conversion, impression, search-volume or demand figure is ever produced', () => {
    assert.deepStrictEqual(
      derived.unavailable_metrics.map((metric) => metric.id),
      ['sales', 'revenue', 'orders', 'conversion_rate', 'impressions', 'search_volume', 'demand']
    );
    for (const metric of derived.unavailable_metrics) assert.match(metric.reason, /Not retrievable from Etsy/);
    // Nothing anywhere in the owner's answer states one of those as a value.
    const answer = JSON.stringify(view.findings) + JSON.stringify(view.listing_opportunities);
    for (const pattern of [/"sales":\s*\d/, /"revenue":\s*\d/, /"conversion[_ ]?rate":\s*\d/, /"impressions":\s*\d/, /"search[_ ]?volume":\s*\d/, /"demand":\s*\d/]) {
      assert.ok(!pattern.test(answer), `an invented metric appeared: ${pattern}`);
    }
  });

  // --- Owner-facing result -------------------------------------------------------------

  test('the owner-facing finding carries the analysis, not a generic success line', () => {
    const [finding] = view.findings;
    assert.ok(!/completed this request successfully/.test(finding.summary), finding.summary);
    assert.match(finding.summary, /"Pink Birthday Invite" \(status active\)/);
    assert.match(finding.summary, /Evidence:/);
    assert.match(finding.summary, /Not retrievable from Etsy, and not estimated: sales, revenue/);
  });

  test('the platform is reported as Etsy', () => {
    assert.strictEqual(view.platform, 'etsy');
  });

  // --- Read-only, no approval, no mutation ---------------------------------------------

  test('the capability and its tool are read-only and Etsy-bound', () => {
    const tool = getToolById('etsy_listing_data_retrieval');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.status, 'implemented');
    assert.deepStrictEqual(tool.platforms, ['etsy']);
    assert.deepStrictEqual(getCapabilityTask('product', 'etsy_listing_inspection').tool_ids, ['etsy_listing_data_retrieval']);
    assert.deepStrictEqual(getCapabilityTask('product', 'etsy_listing_inspection').platforms, ['etsy']);
  });

  test('it is classified analysis_only and needs no approval', () => {
    const access = checkToolAccess({ specialistId: 'product', toolId: 'etsy_listing_data_retrieval', enabledPlatforms: ['etsy'] });
    assert.strictEqual(access.decision, 'allowed');
    assert.strictEqual(access.classification, 'analysis_only');
    assert.strictEqual(access.approval_required, false);
    assert.strictEqual(
      checkToolAccess({ specialistId: 'product', toolId: 'etsy_listing_data_retrieval', enabledPlatforms: ['shopify'] }).decision,
      'denied'
    );
  });

  test('no write or publish capability exists or was introduced', () => {
    const nonRead = TOOL_REGISTRY.filter(
      (tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy') && tool.operation !== 'read'
    );
    assert.deepStrictEqual(nonRead.map((tool) => tool.id), []);
    assert.strictEqual(etsyClient.canPublish(), false);
    assert.strictEqual(mutationIntent.classifyRequestIntent(PRODUCTION_REQUEST), 'read_only');
    assert.strictEqual(mutationIntent.maySelectMutationTool(PRODUCTION_REQUEST), false);
  });

  test('zero mutations, zero approvals, zero network', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(FETCH_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.deepStrictEqual(view.mutations, []);
    for (const toolId of mutationIntent.CORRECTION_TOOL_IDS) {
      assert.ok(!step.tool_calls.includes(toolId), `${toolId} selected`);
    }
  });

  // --- Regressions the routing change must not break -------------------------------------

  test('PINNED: "Analyse my Etsy invitation listings and my Shopify products." stays Listing work', () => {
    assert.deepStrictEqual(targetIds('Analyse my Etsy invitation listings and my Shopify products.').slice().sort(), ['listing', 'product']);
  });

  test('PINNED: "Check my SEO and listing quality and recommend next steps." stays SEO + Listing', () => {
    assert.deepStrictEqual(targetIds('Check my SEO and listing quality and recommend next steps.'), ['seo', 'listing']);
  });

  test('PINNED: the Etsy shop request still resolves to the SHOP capability, not the listing one', () => {
    const shopRequest =
      'Chief, inspect my connected Etsy store and show me the current shop name, shop ID, listing count, and whether Etsy is connected as read-only. Do not make any changes.';
    assert.deepStrictEqual(targetIds(shopRequest), ['product']);
    assert.deepStrictEqual(plan(shopRequest).capabilities, [
      { toolId: 'etsy_shop_data_retrieval', capabilityId: 'etsy_shop_inspection' },
    ]);
  });

  test('PINNED: a Shopify objective resolves no platform-named capability at all', () => {
    // No capability is named after Shopify, so the inheritance rule is a strict no-op there.
    const shopify =
      'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';
    assert.deepStrictEqual(targetIds(shopify), ['product', 'seo', 'analytics_optimization']);
    assert.deepStrictEqual(plan(shopify).capabilities, [null, null, null]);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('etsyListingInspectionRouting.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
