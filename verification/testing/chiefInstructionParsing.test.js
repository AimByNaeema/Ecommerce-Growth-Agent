'use strict';

// CHIEF INSTRUCTION PARSING - the root-cause routing fix.
//
// THE PRODUCTION FAILURE (deployed c1922bb, identical code and input locally):
//   "Review the SEO findings from my Shopify products. Show me the 10 products with the
//    highest-priority SEO issues, explain each issue and recommend the exact improvement.
//    Do not make any changes."
//   -> No known capability matches "explain each issue"
//
// ROOT CAUSE. Every clause had to name a capability, and the previous fix only excused
// clauses made ENTIRELY of a fixed framing-word list; "each", "issue", "exact", "improvement"
// were not on it. The fix parses a clause that did not route into TASK / FRAMING / SAFETY /
// NEW ACTION structurally, and the Chief adds the Product read when SEO needs its data.
//
// These tests pin behaviour, not word lists: framing with ordinary answer language is
// absorbed, new subject matter and change intent are not, safety stays a constraint, and the
// SEO request reaches real product data with no write.
//
// NO NETWORK, NO MODEL CALL: global.fetch fails the run, Shopify reads are fixtures, every
// write path is a tripwire.

const assert = require('node:assert');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

const originalFetch = global.fetch;
const FETCH_CALLS = [];
global.fetch = async (url) => { FETCH_CALLS.push(String(url)); throw new Error('NETWORK CALL ATTEMPTED: ' + url); };

const STUBBED = ['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers', 'updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle'];
const originalShopify = {};
for (const fn of STUBBED) originalShopify[fn] = shopifyClient[fn];

const FIXTURE_PRODUCTS = [
  {
    id: 'gid://fixture/Product/1', title: 'Watercolor Clipart PNG Bundle', handle: 'watercolor-clipart-png-bundle',
    description: 'A bundle of 118 hand-painted watercolor clipart PNG files for crafts, invitations and print projects.',
    seo: { title: 'Watercolor Clipart PNG Bundle | Fixture Studio', description: 'Hand-painted watercolor clipart PNG files for crafts, invitations and print-on-demand projects.' },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['png'],
    variants: [{ id: 'v1', price: '4.99', inventoryQuantity: 0 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/2', title: 'Halloween SVG Cut Files', handle: 'halloween-svg-cut-files',
    description: 'Spooky SVG cut files.', seo: { title: null, description: null },
    status: 'DRAFT', productType: '', vendor: 'Fixture Studio', tags: ['svg'],
    variants: [{ id: 'v2', price: '2.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
];

const READ_CALLS = [];
shopifyClient.isConfigured = () => true;
shopifyClient.getShopInfo = async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' }; };
shopifyClient.getProducts = async () => { READ_CALLS.push('getProducts'); return FIXTURE_PRODUCTS; };
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

const contract = require('../../agent/core/orchestratorExecutionContract');
const mutationIntent = require('../../agent/core/mutationIntent');
const { LIVE_EVIDENCE_PROVIDERS } = require('../../agent/core/crossAgentContext');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');

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
function plan(text) { return contract.planRouting(contract.understandObjective(text)); }
function ids(result) { return (result.targets || []).map((t) => t.id); }
function specialists(result) { return result.routing.plan.map((step) => step.selected_specialist.id); }

const PRODUCTION_FAILURE =
  'Review the SEO findings from my Shopify products. Show me the 10 products with the highest-priority SEO issues, explain each issue and recommend the exact improvement. Do not make any changes.';
const SEO_SUBJECT = 'Review the SEO findings from my Shopify products';

(async () => {
  // --- 1. The exact production failure ------------------------------------------------

  test('EXACT PRODUCTION FAILURE plans instead of "No known capability matches"', () => {
    const result = plan(PRODUCTION_FAILURE);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
    assert.ok(!/No known capability matches/.test(JSON.stringify(result)));
    assert.deepStrictEqual(ids(result), ['seo']);
  });

  test('"explain each issue" is understood as output framing, not a capability', () => {
    const result = plan(PRODUCTION_FAILURE);
    assert.ok(result.instructions.framing.includes('explain each issue'), JSON.stringify(result.instructions));
    assert.ok(result.instructions.framing.some((text) => /recommend the exact improvement/.test(text)));
    const groundedBySubject = new Set(['review', 'seo', 'finding', 'shopify', 'product', 'show', 'highest', 'priority', 'issue']);
    const parsed = contract.classifyObjectiveClause('explain each issue', groundedBySubject);
    assert.strictEqual(parsed.kind, 'instruction');
    assert.strictEqual(parsed.fragments[0].kind, 'framing');
    assert.strictEqual(parsed.fragments[0].directive, 'explain');
  });

  test('"Do not make any changes" stays a safety constraint on the whole run', () => {
    const result = plan(PRODUCTION_FAILURE);
    assert.deepStrictEqual(result.instructions.safety, ['Do not make any changes']);
    assert.strictEqual(mutationIntent.classifyRequestIntent(PRODUCTION_FAILURE), 'read_only');
    assert.strictEqual(mutationIntent.maySelectMutationTool(PRODUCTION_FAILURE), false);
    assert.strictEqual(contract.classifyObjectiveClause('Do not make any changes.').fragments[0].kind, 'safety');
  });

  // --- 2. Framing language refers back to the identified task --------------------------

  const FRAMING = [
    'explain each issue', 'show the top 10', 'list the problems', 'recommend the exact improvement',
    'summarize the findings', 'tell me why', 'compare the results', 'describe each finding',
    'identify the biggest risks', 'give me a short summary', 'prioritise them',
  ];
  const baseTargets = ids(plan(`${SEO_SUBJECT}.`));
  for (const phrase of FRAMING) {
    test(`FRAMING "${phrase}" is absorbed and adds no target`, () => {
      const result = plan(`${SEO_SUBJECT}, ${phrase}.`);
      assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
      assert.deepStrictEqual(ids(result), baseTargets);
      assert.strictEqual(result.instructions.framing.length, 1, JSON.stringify(result.instructions));
    });
  }

  // --- 3. Multi-part natural objectives ------------------------------------------------

  const MULTI_PART = [
    ['Analyze my store sales performance and inventory, list the problems and tell me why. Do not make any changes.', ['product', 'analytics_optimization']],
    ['Review the SEO of my Shopify products and my sales performance, compare the results and summarize the findings.', ['seo', 'analytics_optimization']],
    ['Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.', ['product', 'seo', 'analytics_optimization']],
  ];
  for (const [objective, expected] of MULTI_PART) {
    test(`MULTI-PART routes to ${expected.join('+')}: ${JSON.stringify(objective.slice(0, 60))}...`, () => {
      const result = plan(objective);
      assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
      assert.deepStrictEqual(ids(result), expected);
    });
  }

  // --- 4. Genuine new or unsupported business actions still ask ------------------------

  const NEW_ACTIONS = [
    [`${SEO_SUBJECT} and book a photoshoot with a model.`, /photoshoot/],
    [`${SEO_SUBJECT}, explain the flibbertigibbet dance.`, /flibbertigibbet/],
    [`${SEO_SUBJECT}, compare prices with Amazon.`, /Amazon/],
    ['Research my market and do the flibbertigibbet dance', /flibbertigibbet/],
    ['Research our market and we need help with the flibbertigibbet dance.', /flibbertigibbet/],
  ];
  for (const [objective, segment] of NEW_ACTIONS) {
    test(`NEW ACTION still asks for clarification: ${JSON.stringify(objective)}`, () => {
      const result = plan(objective);
      assert.strictEqual(result.status, 'clarification_required', `planned ${ids(result).join(',')}`);
      assert.ok(segment.test(result.unmatched_segment || result.reason), result.reason);
    });
  }

  test('a message made only of framing or constraints still asks what to work on', () => {
    for (const text of ['Do not make any changes.', 'Explain each issue.', 'Recommend what should be done first.']) {
      assert.strictEqual(plan(text).status, 'clarification_required', text);
    }
  });

  // --- 5. Mutation intent is never absorbed as framing ---------------------------------

  const MUTATIONS = [
    `${SEO_SUBJECT}, explain each issue and fix each issue.`,
    `${SEO_SUBJECT}, show me how to fix each issue.`,
    `${SEO_SUBJECT}, recommend the exact improvement and apply it.`,
    `${SEO_SUBJECT}, make changes.`,
  ];
  for (const objective of MUTATIONS) {
    test(`MUTATION is not absorbed as framing: ${JSON.stringify(objective)}`, () => {
      const result = plan(objective);
      assert.strictEqual(result.status, 'clarification_required', `planned ${ids(result).join(',')}`);
    });
  }

  test('MUTATION fragments classify as new actions, with the reason', () => {
    assert.strictEqual(contract.classifyObjectiveClause('fix each issue').fragments[0].reason, 'mutation_intent');
    assert.strictEqual(contract.classifyObjectiveClause('show me how to fix each issue').fragments[0].reason, 'mutation_intent');
    const apply = contract.classifyObjectiveClause('recommend the exact improvement and apply it').fragments[0];
    assert.strictEqual(apply.kind, 'new_action');
    assert.ok(apply.ungrounded.includes('apply'));
  });

  // --- 6. SEO request automatically receives Product data ------------------------------

  test('the only declared live-evidence provider is Product -> SEO quality check', () => {
    assert.deepStrictEqual(LIVE_EVIDENCE_PROVIDERS.map((p) => `${p.fromSpecialistId}:${p.fromToolId}->${p.toSpecialistId}:${p.toCapabilityId}`), [
      'product:product_data_retrieval->seo:seo_quality_check',
    ]);
  });

  await testAsync('SEO DEPENDENCY: the exact failure adds the Product read and SEO audits the real products, read-only', async () => {
    const readsBefore = READ_CALLS.length;
    const result = await contract.runOrchestratorContract(PRODUCTION_FAILURE);
    assert.strictEqual(result.routing.status, 'planned', result.routing.reason);
    assert.deepStrictEqual(specialists(result), ['product', 'seo']);

    const [product, seo] = result.routing.plan;
    assert.deepStrictEqual(product.tool_calls, ['product_data_retrieval']);
    assert.strictEqual(product.inputs.capability_id, 'product_discovery');
    assert.strictEqual(product.outputs.status, 'success');
    assert.deepStrictEqual(seo.tool_calls, ['seo_quality_check']);
    assert.strictEqual(seo.outputs.result.products_checked, FIXTURE_PRODUCTS.length);
    assert.deepStrictEqual(
      seo.outputs.result.checks.map((check) => check.result.specialized_records.listing_record.product_title),
      FIXTURE_PRODUCTS.map((p) => p.title)
    );
    assert.ok(result.audit_trail.some((event) => /live read/.test(event.summary || '')), 'the added step is not audited');

    assert.strictEqual(READ_CALLS.slice(readsBefore).filter((call) => call === 'getProducts').length, 1);
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.deepStrictEqual(FETCH_CALLS, []);
    assert.deepStrictEqual(describeChiefResultForOwner({ result, runId: 'parse' }).mutations, []);
  });

  await testAsync('SEO DEPENDENCY: no second Product read when the plan already has one', async () => {
    const readsBefore = READ_CALLS.length;
    const result = await contract.runOrchestratorContract(MULTI_PART[2][0]);
    assert.deepStrictEqual(specialists(result), ['product', 'seo', 'analytics_optimization']);
    assert.strictEqual(READ_CALLS.slice(readsBefore).filter((call) => call === 'getProducts').length, 1);
  });

  await testAsync('SEO DEPENDENCY respects the plan-size budget: over the limit, SEO stops clearly instead', async () => {
    const saved = process.env.MAX_PLAN_STEPS_PER_RUN;
    process.env.MAX_PLAN_STEPS_PER_RUN = '1';
    try {
      const result = await contract.runOrchestratorContract(PRODUCTION_FAILURE);
      assert.deepStrictEqual(specialists(result), ['seo']);
      const [seo] = result.routing.plan;
      assert.strictEqual(seo.outputs, null, 'no tool may run without evidence');
      assert.ok(seo.errors.some((error) => /needs real, structured input/.test(error.message || error)), JSON.stringify(seo.errors));
      assert.ok(!result.audit_trail.some((event) => /live read/.test(event.summary || '')), 'a provider step was added over budget');
    } finally {
      if (saved === undefined) delete process.env.MAX_PLAN_STEPS_PER_RUN; else process.env.MAX_PLAN_STEPS_PER_RUN = saved;
    }
  });

  // "SEO keyword research ..." shares the word "research" with the Product specialist's routing
  // text - the exact loose overlap that must NOT count as being about the store's products.
  for (const objective of ['SEO keyword research for insulated hiking jackets.', 'Find SEO keywords for insulated hiking jackets']) {
    await testAsync(`SEO DEPENDENCY never hijacks an SEO request unrelated to the store's products: ${JSON.stringify(objective)}`, async () => {
      const readsBefore = READ_CALLS.length;
      const result = await contract.runOrchestratorContract(objective);
      assert.deepStrictEqual(specialists(result), ['seo']);
      const [seo] = result.routing.plan;
      assert.notStrictEqual(seo.inputs && seo.inputs.capability_id, 'seo_quality_check', 'switched onto store listings');
      assert.strictEqual(READ_CALLS.slice(readsBefore).filter((call) => call === 'getProducts').length, 0, 'a Product read was added');
      assert.ok(!result.audit_trail.some((event) => /live read/.test(event.summary || '')));
    });
  }

  await testAsync('SEO DEPENDENCY switches capability only on real evidence, and says so in the audit trail', async () => {
    const result = await contract.runOrchestratorContract(PRODUCTION_FAILURE);
    const summaries = result.audit_trail.map((event) => event.summary || '');
    assert.ok(summaries.some((summary) => /has no source for its required evidence/.test(summary)), 'capability switch not audited');
    assert.strictEqual(result.routing.plan[1].inputs.capability_id, 'seo_quality_check');
  });

  // --- 6b. Coordinated framing lists and descriptive modifiers ------------------------
  //
  // THE SECOND PRODUCTION FAILURE (deployed 95d6b16):
  //   "... For each product, show the actual issue, why it matters, and the recommended
  //    improvement. Do not make any changes."
  //   -> No known capability matches "show the actual issue"
  // Three structural gaps, not a missing word: a descriptive modifier ("actual") was
  // rejected word-by-word; and the comma/"and" split cut the list items "why it matters" and
  // "the recommended improvement" off from the verb "show" that governs them. These tests pin
  // the STRUCTURE (modifier before a grounded head, list items under one directive, question
  // complements that refer back) with varied wording, so the next phrasing is not a new patch.

  const SECOND_FAILURE =
    "Analyse my Shopify store's SEO findings. Rank the 10 products with the most important SEO problems. For each product, show the actual issue, why it matters, and the recommended improvement. Do not make any changes.";
  const SEO_STORE_SUBJECT = "Analyse my Shopify store's SEO findings.";

  test('SECOND PRODUCTION FAILURE plans instead of "No known capability matches"', () => {
    const result = plan(SECOND_FAILURE);
    assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
    assert.ok(!/No known capability matches/.test(JSON.stringify(result)));
    assert.deepStrictEqual(ids(result), ['seo']);
  });

  test('SECOND PRODUCTION FAILURE: every list item is framing under "show", and the safety constraint stays', () => {
    const result = plan(SECOND_FAILURE);
    const framing = result.instructions.framing.join(' | ');
    assert.ok(/show the actual issue/.test(framing), framing);
    assert.ok(/why it matters/.test(framing), framing);
    assert.ok(/the recommended improvement/.test(framing), framing);
    assert.deepStrictEqual(result.instructions.safety, ['Do not make any changes']);
    assert.strictEqual(mutationIntent.maySelectMutationTool(SECOND_FAILURE), false);
  });

  await testAsync('SECOND PRODUCTION FAILURE: SEO still receives the real Product data, read-only', async () => {
    const readsBefore = READ_CALLS.length;
    const result = await contract.runOrchestratorContract(SECOND_FAILURE);
    assert.strictEqual(result.routing.status, 'planned', result.routing.reason);
    assert.deepStrictEqual(specialists(result), ['product', 'seo']);
    const seo = result.routing.plan[1];
    assert.strictEqual(seo.inputs.capability_id, 'seo_quality_check');
    assert.strictEqual(seo.outputs.result.products_checked, FIXTURE_PRODUCTS.length);
    assert.strictEqual(READ_CALLS.slice(readsBefore).filter((call) => call === 'getProducts').length, 1);
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
  });

  const COORDINATED_VARIATIONS = [
    'For each product, show the actual issue, why it matters, and the recommended improvement.',
    'For every product, describe the underlying problem, how it affects them, and the best next step.',
    'List the current problems, what they mean and the most useful recommendation.',
    'Explain the main reason, why it is important, and the expected result.',
    'Summarise the key findings, why they matter and the suggested improvement for each one.',
    'Show the underlying cause and how it affects each product.',
    'Rank the real issues, then give me the likely impact and the exact improvement.',
  ];
  const storeBaseTargets = ids(plan(SEO_STORE_SUBJECT));
  for (const variation of COORDINATED_VARIATIONS) {
    test(`VARIATION is framing on the established task: ${JSON.stringify(variation)}`, () => {
      const result = plan(`${SEO_STORE_SUBJECT} ${variation} Do not make any changes.`);
      assert.strictEqual(result.status, 'planned', `got ${result.status}: ${result.reason}`);
      assert.deepStrictEqual(ids(result), storeBaseTargets);
      assert.ok(result.instructions.framing.length >= 1, JSON.stringify(result.instructions));
      assert.deepStrictEqual(result.instructions.safety, ['Do not make any changes']);
    });
  }

  const STILL_NEW_ACTIONS = [
    [`${SEO_STORE_SUBJECT} Show the actual issue and book a photoshoot with a model.`, /photoshoot/],
    [`${SEO_STORE_SUBJECT} Show the Amazon pricing issue.`, /Amazon/],
    [`${SEO_STORE_SUBJECT} Explain the flibbertigibbet dance, why it matters.`, /flibbertigibbet/],
    [`${SEO_STORE_SUBJECT} Show the actual issue, what the flibbertigibbet dance is.`, /flibbertigibbet/],
    [`${SEO_STORE_SUBJECT} Show the actual issue, and we need help hiring a photographer.`, /photographer/],
  ];
  for (const [objective, segment] of STILL_NEW_ACTIONS) {
    test(`STILL A NEW ACTION (asks for clarification): ${JSON.stringify(objective.slice(SEO_STORE_SUBJECT.length + 1))}`, () => {
      const result = plan(objective);
      assert.strictEqual(result.status, 'clarification_required', `planned ${ids(result).join(',')} ${JSON.stringify(result.instructions)}`);
      assert.ok(segment.test(result.unmatched_segment || result.reason), result.reason);
    });
  }

  test('a descriptive phrase naming ANOTHER specialist\'s subject is routed as a task, never absorbed', () => {
    const result = plan(`${SEO_STORE_SUBJECT} Show the advertising issue.`);
    assert.strictEqual(result.status, 'planned');
    assert.ok(ids(result).includes('social_advertising'), ids(result).join(','));
  });

  const STILL_MUTATIONS = [
    `${SEO_STORE_SUBJECT} Show the actual issue, why it matters, and fix it.`,
    `${SEO_STORE_SUBJECT} Show the actual issue and apply the recommended improvement.`,
    `${SEO_STORE_SUBJECT} Show the actual issue, why it matters, and replace the current titles.`,
  ];
  for (const objective of STILL_MUTATIONS) {
    test(`STILL NOT FRAMING (change intent): ${JSON.stringify(objective.slice(SEO_STORE_SUBJECT.length + 1))}`, () => {
      const result = plan(objective);
      const framing = result.instructions ? result.instructions.framing.join(' | ') : '';
      assert.ok(!/\b(fix|apply|replace)\b/i.test(framing), `change intent absorbed as framing: ${framing}`);
      if (result.status === 'planned') {
        // Routed to a real capability instead: the mutation-intent gate then applies at tool level.
        assert.strictEqual(mutationIntent.classifyRequestIntent(objective) === 'read_only', false);
      }
    });
  }

  test('a weak generic match that names the owner\'s own data stays a task; one that refers back is framing', () => {
    // "show me my product data" matches Product only on generic words, but it asks for that data.
    assert.deepStrictEqual(ids(plan('show me my product data and improve my listing content')), ['product', 'listing']);
    assert.deepStrictEqual(ids(plan('Show me my product data.')), ['product']);
    // "for each product" refers back to the subject the SEO task established.
    const scoped = plan(`${SEO_STORE_SUBJECT} For each product, explain the actual issue.`);
    assert.deepStrictEqual(ids(scoped), storeBaseTargets);
    assert.ok(scoped.instructions.framing.includes('For each product'), JSON.stringify(scoped.instructions));
  });

  test('a sentence that only restates the objective\'s scope adds no infrastructure step', () => {
    const result = plan('Analyse my Shopify store using real Shopify data. Check products, inventory, orders.');
    assert.ok(!ids(result).includes('configuration'), ids(result).join(','));
    assert.deepStrictEqual(ids(plan('Show me my business configuration')), ['configuration']);
  });

  test('an inherited list item never crosses a sentence boundary', () => {
    const parsed = contract.classifyObjectiveClause('show the actual issue. The flibbertigibbet dance.', new Set(['seo', 'finding']));
    assert.strictEqual(parsed.kind, 'new_action');
  });

  // --- 7. No Shopify writes ------------------------------------------------------------

  test('NO SHOPIFY WRITE FUNCTION WAS CALLED ANYWHERE IN THIS FILE', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('chiefInstructionParsing.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
