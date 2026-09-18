'use strict';

// A PLATFORM NAME WAS READ AS A CAPABILITY NOBODY HAD BUILT.
//
// THE PRODUCTION FAILURE. The owner asked for a combined growth cycle:
//
//   "Chief, run today's growth cycle for my Shopify and Etsy stores. Use real available store
//    data only. Find the highest-confidence opportunities, explain the evidence, propose
//    actions, and do not make consequential changes without my approval. Record what worked
//    and what did not for future cycles."
//
// The whole request stopped with: No known capability matches "Etsy stores."
//
// ROOT CAUSE, measured. CLAUSE_SPLIT_REGEX splits on "and", so the single prepositional phrase
// "for my Shopify and Etsy stores" was cut in half: "run today's growth cycle for my Shopify"
// and an orphan "Etsy stores". The orphan inherited the previous clause's PRODUCE act, and the
// produce branch of resolveObjectiveIntent routes by plain word overlap only - it never
// consults the platform rules. "Etsy stores" scores zero against every specialist's routing
// text, because distinctiveRoutingWords deliberately keeps connected platform names out of it
// ("my Shopify sales" is about sales, not the catalogue). So a platform this system is
// connected to was reported back to the owner as an unknown capability.
//
// THE FIX, at the cause rather than the symptom: a run of words joined by "and"/comma in which
// EVERY word is a connected platform survives the splitter as one clause - exactly the
// treatment protectFileFormatLists already gives "PNG and SVG", generalized into one shared
// helper rather than copied. The clause then keeps both platform names, so
// connectedPlatformNamesIn sees Shopify AND Etsy and buildPlanStep's platform filter keeps the
// tools for both, and there is no orphan fragment left to be unmatched.
//
// NO NETWORK, NO MODEL CALL. planRouting is a pure function over the registries; a fetch
// tripwire is installed and asserted empty.

const assert = require('node:assert');

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const { connectedPlatformNamesIn } = require('../../agent/core/objectiveInterpretation');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { planRouting, understandObjective } = require('../../agent/core/orchestratorExecutionContract');

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

const plan = (text) => planRouting(understandObjective(text));
const targetIds = (text) => (plan(text).targets || []).map((target) => target.id);

// The exact request the owner typed, character for character.
const GROWTH_CYCLE =
  "Chief, run today's growth cycle for my Shopify and Etsy stores. Use real available store data only. Find the highest-confidence opportunities, explain the evidence, propose actions, and do not make consequential changes without my approval. Record what worked and what did not for future cycles.";

(async () => {
  // --- 1. The exact failure ------------------------------------------------------------

  test('EXACT PRODUCTION REQUEST plans instead of asking for clarification', () => {
    const result = plan(GROWTH_CYCLE);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
  });

  test('"Etsy stores" is never emitted as an unmatched capability', () => {
    const result = plan(GROWTH_CYCLE);
    assert.ok(!/No known capability matches/.test(JSON.stringify(result)), result.reason);
    assert.strictEqual(result.unmatched_segment, undefined, `unmatched: ${result.unmatched_segment}`);
    // The phrase never survives as a clause of its own at all.
    for (const entry of result.interpretation) {
      assert.ok(!/^Etsy stores/i.test(entry.clause), `"${entry.clause}" was still split off as its own clause`);
    }
  });

  test('EXACT PRODUCTION REQUEST routes to real specialists for the work it names', () => {
    // Three steps, not two: the Product specialist is planned TWICE - once scoped to the Etsy
    // read the clause named, once unscoped for the Shopify side - because a request about two
    // stores cannot be answered by one step on a specialist whose tools are platform-bound.
    // See etsyShopifyGrowthCycle.test.js for the full per-platform coverage assertions.
    assert.deepStrictEqual(targetIds(GROWTH_CYCLE), ['product', 'product', 'analytics_optimization']);
  });

  // --- 2. Both platforms are recognised, as platforms --------------------------------------

  test('"Shopify and Etsy stores" resolves to BOTH platform targets', () => {
    assert.deepStrictEqual(connectedPlatformNamesIn('my Shopify and Etsy stores'), ['shopify', 'etsy']);
  });

  test('the clause that names both platforms carries both into its plan segment', () => {
    // This is what buildPlanStep's platform filter reads, so both platforms' tools stay
    // candidates for that step instead of one of them being lost with the torn-off fragment.
    const result = plan(GROWTH_CYCLE);
    const segment = result.segments.find((text) => /growth cycle/i.test(text));
    assert.ok(segment, `no growth-cycle segment: ${JSON.stringify(result.segments)}`);
    assert.deepStrictEqual(connectedPlatformNamesIn(segment), ['shopify', 'etsy']);
  });

  const ORDERINGS = [
    'my Shopify and Etsy stores',
    'my Etsy and Shopify stores',
    'my Shopify, Etsy stores',
    'my Shopify, and Etsy stores',
  ];
  for (const phrase of ORDERINGS) {
    test(`both platforms survive the splitter in "${phrase}"`, () => {
      const result = plan(`Run today's growth cycle for ${phrase}.`);
      assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
      const named = new Set(result.segments.flatMap((segment) => connectedPlatformNamesIn(segment)));
      assert.deepStrictEqual([...named].sort(), ['etsy', 'shopify']);
    });
  }

  // --- 3. Existing Etsy routing is untouched ----------------------------------------------

  test('the Etsy shop request still resolves to etsy_shop_inspection', () => {
    const shop =
      'Chief, inspect my connected Etsy store and show me the current shop name, shop ID, listing count, and whether Etsy is connected as read-only. Do not make any changes.';
    assert.deepStrictEqual(targetIds(shop), ['product']);
    assert.deepStrictEqual(plan(shop).capabilities, [
      { toolId: 'etsy_shop_data_retrieval', capabilityId: 'etsy_shop_inspection' },
    ]);
  });

  test('the Etsy listing request still resolves to etsy_listing_inspection and its read tool', () => {
    const listings =
      'Chief, inspect my Etsy store and analyze my current active digital listings. Identify up to 5 specific listings with clear optimization opportunities based only on real Etsy data currently available. For each, show the listing title, current status, and the exact data/evidence that supports the opportunity. Do not invent sales, demand, search volume, or performance metrics. Do not make any changes.';
    assert.deepStrictEqual(targetIds(listings), ['product']);
    assert.deepStrictEqual(plan(listings).capabilities, [
      { toolId: 'etsy_listing_data_retrieval', capabilityId: 'etsy_listing_inspection' },
    ]);
  });

  test('an Etsy authoring request is still Listing work, not a platform read', () => {
    assert.deepStrictEqual(targetIds('Analyse my Etsy invitation listings and my Shopify products.').slice().sort(), ['listing', 'product']);
  });

  // --- 4. Existing Shopify routing is untouched -------------------------------------------

  const SHOPIFY_PINNED = [
    ['Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.', ['product', 'seo', 'analytics_optimization']],
    ['Review my Shopify products and orders, then show me the top 5 priorities. Don\'t change anything.', ['product', 'analytics_optimization']],
    ['Check my SEO and listing quality and recommend next steps.', ['seo', 'listing']],
    ['Check my products for vendor issues and summarise them by priority. Do not make any changes.', ['product']],
  ];
  for (const [objective, expected] of SHOPIFY_PINNED) {
    test(`UNCHANGED: ${JSON.stringify(objective.slice(0, 46))}... -> ${expected.join('+')}`, () => {
      assert.deepStrictEqual(targetIds(objective), expected);
    });
  }

  // --- 5. The protection is narrow ----------------------------------------------------------

  test('a list containing an UNSUPPORTED platform is untouched and still refused by name', () => {
    // Amazon is not connected, so the run is not protected and the existing refusal still fires.
    const result = plan('Compare my prices on Shopify and Amazon.');
    assert.strictEqual(result.status, 'clarification_required');
    assert.match(result.reason, /Amazon/);
    assert.strictEqual(result.interpretation_blocked, true);
  });

  test('a list of ordinary words that merely contains a platform name is untouched', () => {
    // "listings and my" is not a platform list, so nothing is joined and this keeps routing
    // to both specialists exactly as it did before.
    assert.deepStrictEqual(targetIds('Analyse my Etsy invitation listings and my Shopify products.').slice().sort(), ['listing', 'product']);
  });

  test('the file-format list protection this generalizes still works', () => {
    assert.deepStrictEqual(targetIds('research my top competitors for my digital PNG and SVG bundle products'), ['research']);
  });

  test('a single platform name is not a list and is unaffected', () => {
    assert.deepStrictEqual(connectedPlatformNamesIn('my Shopify store'), ['shopify']);
    assert.deepStrictEqual(targetIds('Analyse my Shopify products.'), ['product']);
  });

  // --- 6. Etsy stays read-only --------------------------------------------------------------

  test('no Etsy write or publish capability exists or was introduced', () => {
    const etsyTools = TOOL_REGISTRY.filter((tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy'));
    assert.ok(etsyTools.length > 0, 'the Etsy tools must still be registered');
    assert.deepStrictEqual(etsyTools.filter((tool) => tool.operation !== 'read').map((tool) => tool.id), []);
    assert.strictEqual(require('../../integrations/adapters/etsyClient').canPublish(), false);
  });

  test('no network was touched', () => {
    assert.deepStrictEqual(FETCH_CALLS, []);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('platformListRouting.test.js'));
  });

  global.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  global.fetch = originalFetch;
  console.error('Test harness error:', err);
  process.exit(1);
});
