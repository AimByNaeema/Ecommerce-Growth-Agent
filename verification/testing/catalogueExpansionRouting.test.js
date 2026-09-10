'use strict';

// Natural-language routing for catalogue-expansion intent.
//
// THE BUG THIS PINS. Specialist routing is word-overlap over each specialist's own
// description, which had nothing to match on a plainly-worded business goal. Measured
// before the fix: "What should this store sell next?" scored analytics_optimization 1 /
// configuration 1, and "Analyze our existing catalogue and identify expansion
// opportunities." scored analytics_optimization 0.5 and nothing else. Both are requests
// to find what the store should SELL NEXT, which the Product specialist's
// catalogue_expansion_opportunities capability exists to answer.
//
// NO MODEL CALL IS MADE ANYWHERE IN THIS FILE. The gate is pure regex over the objective
// text, so these assertions are deterministic and free. buildPlanStep is exercised only
// far enough to read which tool it selected.

const assert = require('node:assert');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { getToolById, TOOL_REGISTRY } = require('../../tools/toolRegistry');

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

function routedSpecialists(objective) {
  const routing = orchestratorExecutionContract.planRouting(objective);
  return { status: routing.status, ids: (routing.targets || []).map((t) => t.id), segments: routing.segments || [] };
}

// The goals the Command Center must handle in the user's own words.
const CATALOGUE_EXPANSION_GOALS = [
  'What should this store sell next?',
  'Find products related to my existing products.',
  'Scan the market for products we could add to our catalogue.',
  'Find new product opportunities based on what we already sell.',
  'Find the best products for us to sell next.',
  'Analyze our existing catalogue and identify expansion opportunities.',
  'Research related products with strong market opportunity.',
];

// Each must keep its existing owner. A null expectation means "anything except product" -
// used where the pre-existing router already returns a clarification for that wording, a
// behaviour this change does not touch and must not silently alter.
const BOUNDARY_GOALS = [
  ['What are our competitors doing?', null],
  ['What is trending in the market?', 'research'],
  ['Analyze our sales performance.', 'analytics_optimization'],
  ['Why did our revenue fall?', null],
  ['Improve SEO for our existing products.', 'seo'],
  ['Rewrite our product listings.', null],
  ['Create a marketing strategy.', 'marketing'],
  ['Run Facebook ads.', null],
  ['Research competitor products.', 'research'],
  ['Research the market.', 'research'],
];

async function main() {
  // --- A-F: the natural-language goals -------------------------------------------------

  for (const goal of CATALOGUE_EXPANSION_GOALS) {
    await testAsync(`ROUTES TO PRODUCT: ${JSON.stringify(goal)}`, async () => {
      const routed = routedSpecialists(goal);
      assert.strictEqual(routed.status, 'planned', `expected a plan, got ${routed.status}`);
      assert.deepStrictEqual(routed.ids, ['product'], `routed to ${routed.ids.join(',')}`);
      // The whole goal stays ONE clause - "Analyze our existing catalogue and identify
      // expansion opportunities." must not be torn in half by the conjunction splitter.
      assert.strictEqual(routed.segments.length, 1);

      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget('product'),
        goal,
        goal
      );
      assert.deepStrictEqual(
        step.tool_calls,
        ['catalogue_expansion_opportunities'],
        `selected ${JSON.stringify(step.tool_calls)}`
      );
      assert.strictEqual(step.selected_specialist.id, 'product');
    });
  }

  // --- Regression: every other specialist keeps its own work ---------------------------

  for (const [goal, expected] of BOUNDARY_GOALS) {
    test(`NOT HIJACKED: ${JSON.stringify(goal)}`, () => {
      const routed = routedSpecialists(goal);
      assert.ok(!routed.ids.includes('product'), `catalogue expansion hijacked "${goal}" -> ${routed.ids.join(',')}`);
      if (expected) {
        assert.ok(
          routed.ids.includes(expected),
          `expected ${expected}, got ${routed.ids.join(',') || `[${routed.status}]`}`
        );
      }
    });
  }

  // --- The veto, which is what makes the weaker signals safe ---------------------------

  test('VETO: "related products" does NOT mean catalogue expansion in a competitor or ranking context', () => {
    // Asserted on the GATE itself, not on the final route. The gate's guarantee is that it
    // declines these - what the pre-existing word-overlap scorer then does with a declined
    // clause is separate behaviour this change does not touch.
    //
    // The first two matched the related-products pattern before the veto was added - found
    // by adversarial testing, not by the original goal list.
    for (const goal of [
      'Compare similar products from our competitors.',
      'Which related products do competitors rank for?',
      'Write listings for our new products.',
      'Add SEO keywords to our product listings.',
      'Add a marketing campaign for our top products.',
    ]) {
      assert.strictEqual(
        orchestratorExecutionContract.hasCatalogueExpansionIntent(goal),
        false,
        `the gate must decline "${goal}"`
      );
    }
  });

  test('PRE-EXISTING, AND UNCHANGED: a declined clause keeps whatever routing it already had', () => {
    // "Compare similar products from our competitors." scores product:1 on plain word
    // overlap (the Product specialist's description contains "products"), and did so
    // before this gate existed. The gate declines it, so planRouting falls through to that
    // same pre-existing scoring - this change neither caused nor fixed it. Pinned here so
    // a future reader can see the distinction rather than mistake it for a regression.
    const goal = 'Compare similar products from our competitors.';
    assert.strictEqual(orchestratorExecutionContract.hasCatalogueExpansionIntent(goal), false);
    const scores = orchestratorExecutionContract.scoreRoutingTargets(goal);
    assert.strictEqual(scores[0].target.id, 'product');
    assert.strictEqual(scores[0].score, 1, 'a single incidental word, not an intent signal');
  });

  test('UNAMBIGUOUS wording still wins over the veto - it can mean nothing else', () => {
    assert.deepStrictEqual(routedSpecialists('Our catalogue expansion strategy needs a marketing plan.').ids, ['product']);
  });

  // --- Ambiguity is preserved, never forced --------------------------------------------

  test('AMBIGUOUS wording is NOT forced to Product', () => {
    for (const goal of ['Research products.', 'Research market opportunities.', 'Analyze our existing catalogue.']) {
      const routed = routedSpecialists(goal);
      assert.ok(!routed.ids.includes('product'), `"${goal}" is not clear catalogue-expansion intent and must not be forced`);
    }
  });

  // --- Structural guarantees ------------------------------------------------------------

  test('NO NEW TOOL, NO NEW SPECIALIST: the gate routes only to what already exists', () => {
    const tool = getToolById('catalogue_expansion_opportunities');
    assert.ok(tool, 'the tool must already exist');
    assert.strictEqual(tool.operation, 'read');
    const capability = getSpecialistCapabilityById('product').supported_tasks.find(
      (t) => t.id === 'catalogue_expansion_opportunities'
    );
    assert.ok(capability, 'the capability must already be owned by Product');
    assert.deepStrictEqual(capability.tool_ids, ['catalogue_expansion_opportunities']);
    // Exactly one tool serves it - the gate cannot have introduced a duplicate.
    assert.strictEqual(TOOL_REGISTRY.filter((t) => /catalogue|expansion/i.test(t.id)).length, 1);
  });

  test('NO MODEL CALL: the gate is pure text matching', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'), 'utf8');
    const start = source.indexOf('const CATALOGUE_EXPANSION_UNAMBIGUOUS_PATTERNS');
    const gate = source.slice(start, source.indexOf('function hasCatalogueExpansionIntent', start) + 600);
    assert.ok(start > -1, 'the gate must exist');
    for (const forbidden of ['sendMessage', 'claudeClient', 'fetch(', 'await ']) {
      assert.ok(!gate.includes(forbidden), `the routing gate must stay deterministic - found "${forbidden}"`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('catalogueExpansionRouting.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
