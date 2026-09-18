'use strict';

// A PROHIBITION BECAME THE TASKS IT FORBADE.
//
// THE PRODUCTION FAILURE. The owner ended a read-only Etsy request with:
//
//   "Do not invent sales, demand, search volume, or performance metrics."
//
// The Chief split that at its commas and dispatched three of the four fragments as WORK: SEO
// ran on "search volume" and asked for keywords, and Analytics & Optimization ran twice - on
// "Do not invent sales" and on "or performance metrics" - performing a live SHOPIFY sales read
// during an Etsy request. The owner's own prohibition produced the exact metrics they had just
// forbidden the system to go looking for.
//
// TWO BREAKAGES, BOTH MEASURED BEFORE THE FIX:
//   1. THE HEAD OF A NEGATED LIST WAS NEVER A CONSTRAINT. resolveObjectiveIntent required
//      `negated && continuation`, and the head clause ("Do not invent sales") has negated true
//      and continuation false - so it fell through to routing and scored analytics_optimization
//      on the word "sales" (a GOAL_ROUTING_WORDS entry, weight 2). Every plain "Don't include
//      drafts" clause had the same shape and the same fate.
//   2. NEGATION STOPPED CARRYING AT THE FIRST MULTI-WORD ITEM. interpretClause only carried it
//      to a fragment starting with "or"/"nor" or consisting of a single word. "search volume"
//      is neither, so it was read as a request of its own - and because previousNegated was
//      then false, the following "or performance metrics" lost the negation too, even though it
//      does start with "or".
//
// WHAT THESE TESTS ASSERT: every fragment of a negated list is a constraint, in several list
// shapes, and no specialist is ever created from one - while a real request that follows a
// negated clause still routes exactly as it did.
//
// NO NETWORK, NO MODEL CALL. planRouting and interpretClause are pure functions over the
// registries; a fetch tripwire is installed and asserted empty.

const assert = require('node:assert');

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const interpretation = require('../../agent/core/objectiveInterpretation');
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
const dispositionsFor = (text) => {
  const map = {};
  for (const entry of plan(text).interpretation) map[entry.clause] = entry.disposition;
  return map;
};

const PRODUCTION_REQUEST =
  'Chief, inspect my Etsy store and analyze my current active digital listings. Identify up to 5 specific listings with clear optimization opportunities based only on real Etsy data currently available. For each, show the listing title, current status, and the exact data/evidence that supports the opportunity. Do not invent sales, demand, search volume, or performance metrics. Do not make any changes.';

(async () => {
  // --- 1. The exact prohibition, fragment by fragment ---------------------------------

  test('EXACT PRODUCTION PROHIBITION: every fragment is a constraint, not a task', () => {
    const dispositions = dispositionsFor(PRODUCTION_REQUEST);
    for (const fragment of ['Do not invent sales', 'demand', 'search volume', 'or performance metrics.']) {
      assert.strictEqual(dispositions[fragment], 'constraint', `"${fragment}" was ${dispositions[fragment]}, not a constraint`);
    }
  });

  test('EXACT PRODUCTION REQUEST: no SEO and no Analytics specialist is created from the prohibition', () => {
    const ids = targetIds(PRODUCTION_REQUEST);
    assert.ok(!ids.includes('seo'), `SEO was selected: ${ids.join(', ')}`);
    assert.ok(!ids.includes('analytics_optimization'), `Analytics was selected: ${ids.join(', ')}`);
  });

  // --- 2. Every list shape, not just this wording -------------------------------------
  //
  // The head fails on its own, and a multi-word item breaks the chain for everything after it,
  // so all three shapes have to be pinned - the bug is not specific to four items.

  const SHAPES = [
    ['single-word items', 'Analyse my Etsy shop. Do not invent sales, demand, or metrics.'],
    ['multi-word items', 'Analyse my Etsy shop. Do not invent sales data, search volume, or performance metrics.'],
    ['head only', 'Analyse my Etsy shop. Do not invent sales.'],
    ['no "or" anywhere', 'Analyse my Etsy shop. Do not invent sales figures, conversion rates, search volume.'],
    ["don't contraction", "Analyse my Etsy shop. Don't invent revenue, search volume, or demand."],
    ['never', 'Analyse my Etsy shop. Never invent sales, search volume, or performance metrics.'],
  ];
  for (const [label, objective] of SHAPES) {
    test(`NEGATED LIST (${label}) creates no specialist of its own`, () => {
      const ids = targetIds(objective);
      assert.deepStrictEqual(ids, ['product'], `got ${ids.join(', ')} for ${JSON.stringify(objective)}`);
    });
  }

  test('a multi-word fragment after a negation still inherits it', () => {
    // Breakage 2, at the interpretation layer: this is what used to return negated false.
    const result = interpretation.interpretClause('search volume', { previousAct: 'scope', previousNegated: true });
    assert.strictEqual(result.negated, true);
    assert.strictEqual(result.continuation, true);
  });

  test('the head of a negated list is negated even though it continues nothing', () => {
    const result = interpretation.interpretClause('Do not invent sales');
    assert.strictEqual(result.act, 'scope');
    assert.strictEqual(result.negated, true);
    assert.ok(!result.continuation, 'the head continues nothing - that is exactly why it used to route');
  });

  // --- 3. A real request after a negated clause still routes ---------------------------

  test('PINNED: "Don\'t change prices, and write new titles." still produces the titles task', () => {
    // The clause opens with a PRODUCE verb, so it is never negated and never inherits -
    // this is the boundary the fix had to respect.
    assert.deepStrictEqual(targetIds("Don't change prices, and write new titles."), ['listing']);
  });

  test('a negated clause never swallows the request that follows it in the same sentence', () => {
    const ids = targetIds("Don't invent demand figures, and analyse my Shopify products.");
    assert.ok(ids.includes('product'), `the real request was lost: ${ids.join(', ')}`);
  });

  test('the prohibition is reported as a run constraint rather than silently dropped', () => {
    const result = plan(PRODUCTION_REQUEST);
    assert.deepStrictEqual(result.instructions.safety, ['Do not make any changes']);
    // The forbidden subjects are absorbed, so they appear in neither the targets nor the
    // segments - the run simply never goes looking for them.
    assert.ok(!JSON.stringify(result.segments).includes('search volume'), JSON.stringify(result.segments));
  });

  test('a message that is ONLY a prohibition still asks what to work on', () => {
    assert.strictEqual(plan('Do not invent sales, demand, search volume, or performance metrics.').status, 'clarification_required');
  });

  // --- 4. Pinned objectives that must not move -----------------------------------------

  const UNCHANGED = [
    ['Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.', ['product', 'seo', 'analytics_optimization']],
    ['Check my SEO and listing quality and recommend next steps.', ['seo', 'listing']],
    ['Review my Shopify products and orders, then show me the top 5 priorities. Don\'t change anything.', ['product', 'analytics_optimization']],
    ['Check my products for vendor issues and summarise them by priority. Do not make any changes.', ['product']],
  ];
  for (const [objective, expected] of UNCHANGED) {
    test(`UNCHANGED: ${JSON.stringify(objective.slice(0, 52))}... -> ${expected.join('+')}`, () => {
      assert.deepStrictEqual(targetIds(objective), expected);
    });
  }

  test('no network was touched', () => {
    assert.deepStrictEqual(FETCH_CALLS, []);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('negatedConstraintRouting.test.js'));
  });

  global.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  global.fetch = originalFetch;
  console.error('Test harness error:', err);
  process.exit(1);
});
