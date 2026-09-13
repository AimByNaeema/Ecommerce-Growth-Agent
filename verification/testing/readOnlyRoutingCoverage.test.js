'use strict';

// READ-ONLY ROUTING COVERAGE for vendor/inventory/product diagnostics.
//
// THE GAP THIS PINS. After the mutation-intent hardening, these plainly read-only
// requests were safe but USELESS - they ended at clarification_required instead of
// reaching a read capability, so the owner got no answer:
//
//   "Analyze my Shopify products for vendor and inventory"  -> clarification_required
//   "Show me Shopify vendor and inventory issues"           -> clarification_required
//   "Review my product vendors and inventory"               -> clarification_required
//   "Report inventory and vendor issues"                    -> clarification_required
//
// ROOT CAUSE (measured, see ROUTING_SYNONYMS in orchestratorExecutionContract.js): the
// words "vendor" and "inventory" appear in NO specialist's routing text, so they scored
// zero everywhere. Two ways that surfaced: a conjunction split left "inventory" as its
// own clause which matched nothing and failed the whole plan, and a request made only of
// that vocabulary ("Report inventory and vendor issues") scored zero on every clause.
//
// WHAT THESE TESTS ASSERT. The ACTUAL specialist and the ACTUAL tool selected - never
// merely that nothing bad happened. A test that only checked "no mutation" would have
// passed throughout the broken period, because clarification_required is also
// non-mutating. Each request must reach a real read capability AND stay non-mutating.
//
// NO NETWORK, NO MODEL CALL, NO LIVE DATA: global.fetch fails the run, the Shopify
// client's reads are in-memory fixtures, and every write path is a tripwire that
// records and throws.

const assert = require('node:assert');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

// --- Network ban + fixtures, installed before the orchestrator is required -----------
const originalFetch = global.fetch;
global.fetch = async (url) => { throw new Error('NETWORK CALL ATTEMPTED: ' + url); };

const FIXTURE_PRODUCTS = [
  { id: 'gid://fixture/Product/1', title: 'Fixture Bundle A', handle: 'a', status: 'ACTIVE', productType: 'Digital Design Bundle', vendor: 'Studio A', tags: ['png'], variants: [{ id: 'v1', price: '2.99', inventory_quantity: 0 }], collections: [], metafields: [] },
  { id: 'gid://fixture/Product/2', title: 'Fixture Bundle B', handle: 'b', status: 'DRAFT', productType: '', vendor: 'Studio b', tags: ['svg'], variants: [{ id: 'v2', price: '6.99', inventory_quantity: 3 }], collections: [], metafields: [] },
];

const originalShopify = {};
for (const fn of ['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers', 'updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle']) {
  originalShopify[fn] = shopifyClient[fn];
}
shopifyClient.isConfigured = () => true;
shopifyClient.getShopInfo = async () => ({ name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' });
shopifyClient.getProducts = async () => FIXTURE_PRODUCTS;
shopifyClient.getCollections = async () => [];
shopifyClient.getInventoryLevels = async () => [{ id: 'ii1', sku: 'A-1', tracked: false, levels: [{ locationId: 'L1', available: 0 }] }];
shopifyClient.getOrders = async () => [];
shopifyClient.getCustomers = async () => [];

// Every write path records and refuses. MUTATION_CALLS must stay empty for the run.
const MUTATION_CALLS = [];
for (const fn of ['updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle']) {
  shopifyClient[fn] = async () => { MUTATION_CALLS.push(fn); throw new Error('MUTATION TRIPWIRE: ' + fn); };
}

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const mutationIntent = require('../../agent/core/mutationIntent');
const { getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { createAuditTracker } = require('../../audit/auditTrail');
const { getToolById } = require('../../tools/toolRegistry');

const CORRECTION_TOOL_IDS = mutationIntent.CORRECTION_TOOL_IDS;

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

// The exact six requests from real production validation.
const READ_ONLY_DIAGNOSTICS = [
  'Analyze my Shopify products for vendor and inventory',
  'Check my Shopify products for vendor mismatches',
  'Show me Shopify vendor and inventory issues',
  'Review my product vendors and inventory',
  'Analyze vendor problems in my products',
  'Report inventory and vendor issues',
];

// Read-only capabilities it is legitimate for these to land on. Product diagnostics
// belong to the Product specialist; the list is explicit so a future change that routed
// one of these to a DIFFERENT tool has to be a deliberate edit here, not a silent drift.
const ACCEPTABLE_READ_TOOLS = ['product_data_retrieval', 'collection_data_retrieval', 'analytics_data_retrieval'];

(async () => {
  let step = 0;

  // ---------------------------------------------------------------------------------
  // 1. Each request reaches a real specialist - not clarification_required
  // ---------------------------------------------------------------------------------

  for (const request of READ_ONLY_DIAGNOSTICS) {
    test(`ROUTES (not clarification): ${JSON.stringify(request)}`, () => {
      const objective = orchestratorExecutionContract.understandObjective(request);
      const plan = orchestratorExecutionContract.planRouting(objective);
      assert.strictEqual(
        plan.status, 'planned',
        `got ${plan.status}${plan.reason ? ' - ' + plan.reason : ''}`
      );
      const ids = plan.targets.map((t) => `${t.type}:${t.id}`);
      assert.ok(
        ids.includes('specialist:product'),
        `expected the Product specialist, got ${ids.join(',')}`
      );
    });
  }

  // ---------------------------------------------------------------------------------
  // 2. THE ACTUAL TOOL SELECTED is a read capability, and the run is clean
  // ---------------------------------------------------------------------------------

  for (const request of READ_ONLY_DIAGNOSTICS) {
    await testAsync(`SELECTS A READ TOOL and stays clean: ${JSON.stringify(request)}`, async () => {
      step += 1;
      const objective = orchestratorExecutionContract.understandObjective(request);
      const plan = orchestratorExecutionContract.planRouting(objective);
      assert.strictEqual(plan.status, 'planned');

      const target = plan.targets[0];
      const approvalTracker = { requests: [] };
      const mutationsBefore = MUTATION_CALLS.length;

      const built = await orchestratorExecutionContract.buildPlanStep(
        target, objective, objective,
        { tokensUsedThisRun: 0 }, null, [], approvalTracker, createAuditTracker(`coverage-${step}`)
      );

      const tools = built.tool_calls || [];
      assert.ok(tools.length > 0, 'no tool was selected at all');

      // The positive assertion: a real read capability ran.
      for (const id of tools) {
        assert.ok(
          ACCEPTABLE_READ_TOOLS.includes(id),
          `selected ${id}, which is not one of the expected read capabilities`
        );
        const tool = getToolById(id);
        assert.strictEqual(tool.operation, 'read', `${id} is not a read-operation tool`);
      }

      // And the safety assertions, all four.
      for (const id of CORRECTION_TOOL_IDS) {
        assert.ok(!tools.includes(id), `a mutation tool (${id}) was selected`);
      }
      assert.strictEqual(approvalTracker.requests.length, 0, 'an approval request was created');
      assert.strictEqual(MUTATION_CALLS.length - mutationsBefore, 0, 'a mutation function was called');

      // It actually produced a result from the fixture catalogue.
      assert.ok(built.outputs && built.outputs.status === 'success', `outputs.status=${built.outputs && built.outputs.status}`);
      assert.strictEqual(built.completion_state, 'complete');
    });
  }

  // ---------------------------------------------------------------------------------
  // 3. The mutation candidate list stays EMPTY for every one of them
  // ---------------------------------------------------------------------------------

  test('READ-ONLY REQUESTS HAVE AN EMPTY MUTATION CANDIDATE LIST', () => {
    const productTools = getSpecialistCapabilityById('product').required_tools;
    for (const request of READ_ONLY_DIAGNOSTICS) {
      assert.strictEqual(mutationIntent.classifyRequestIntent(request), 'read_only',
        `${JSON.stringify(request)} was not classified read_only`);
      const surviving = mutationIntent
        .filterToolCandidatesByIntent(productTools, request)
        .filter((id) => CORRECTION_TOOL_IDS.includes(id));
      assert.deepStrictEqual(surviving, [],
        `${JSON.stringify(request)} left mutation candidates: ${surviving.join(',')}`);
    }
  });

  // ---------------------------------------------------------------------------------
  // 4. ADVERSARIAL SAFETY - routing coverage must not have loosened the gate
  // ---------------------------------------------------------------------------------

  const ADVERSARIAL = [
    'Is the vendor correct on product X?',
    'Analyze my products for vendor issues.',
    'Check inventory problems.',
    'Review vendor mismatches.',
    'Tell me which products have inventory issues.',
  ];

  test('ADVERSARIAL: none of these may select a mutation tool', () => {
    const productTools = getSpecialistCapabilityById('product').required_tools;
    for (const request of ADVERSARIAL) {
      assert.notStrictEqual(mutationIntent.classifyRequestIntent(request), 'mutation',
        `${JSON.stringify(request)} was classified as mutation`);
      assert.strictEqual(mutationIntent.maySelectMutationTool(request), false);
      const surviving = mutationIntent
        .filterToolCandidatesByIntent(productTools, request)
        .filter((id) => CORRECTION_TOOL_IDS.includes(id));
      assert.deepStrictEqual(surviving, [], `${JSON.stringify(request)} kept mutation candidates`);
      // And the legacy single-tool router must not pick one either.
      const capability = orchestratorExecutionContract.identifyRequiredCapability(
        orchestratorExecutionContract.understandObjective(request)
      );
      const selected = capability && capability.tool ? capability.tool.id : null;
      assert.ok(selected === null || !CORRECTION_TOOL_IDS.includes(selected),
        `${JSON.stringify(request)} selected ${selected}`);
    }
  });

  test('THE NEW VOCABULARY IS NOT MUTATION INTENT: vendor/inventory stay subjects', () => {
    // The whole point of the routing fix is that these words say WHAT to look at. They
    // must remain incapable of saying "change it".
    for (const word of ['vendor', 'vendors', 'inventory']) {
      assert.strictEqual(mutationIntent.hasExplicitMutationIntent(`Something about ${word} here`), false);
    }
  });

  // ---------------------------------------------------------------------------------
  // 5. POSITIVE MUTATION REGRESSION - explicit instructions still reach the gate
  // ---------------------------------------------------------------------------------

  const MUTATION_REQUESTS = [
    'Fix the vendor mismatch on these Shopify products',
    'Correct the vendor for product X',
    'Update the vendor on product X',
  ];

  test('MUTATION REQUESTS ARE NOT SILENTLY MADE READ-ONLY', () => {
    const productTools = getSpecialistCapabilityById('product').required_tools;
    for (const request of MUTATION_REQUESTS) {
      assert.strictEqual(mutationIntent.classifyRequestIntent(request), 'mutation',
        `${JSON.stringify(request)} lost its mutation intent`);
      const surviving = mutationIntent
        .filterToolCandidatesByIntent(productTools, request)
        .filter((id) => CORRECTION_TOOL_IDS.includes(id));
      assert.deepStrictEqual(surviving, CORRECTION_TOOL_IDS,
        `${JSON.stringify(request)} lost its mutation candidates`);
    }
  });

  // A correction approval now also carries the compliance input derived from the
  // parameters the correction will write, so a request must state them to reach the
  // approval gate (integrations/approvedCorrectionDispatch.js's
  // buildCorrectionComplianceInput). Real per-tool parameters, not placeholders.
  const CORRECTION_PARAMS = {
    shopify_vendor_correction: { productId: 'gid://fixture/Product/1', newVendor: 'Fixture Vendor' },
    shopify_inventory_correction: { inventoryItemId: 'gid://fixture/InventoryItem/1', locationId: 'gid://fixture/Location/1', delta: 1, idempotencyKey: 'fixture-key' },
    shopify_collection_membership_update: { collectionId: 'gid://fixture/Collection/1', productId: 'gid://fixture/Product/1' },
  };

  await testAsync('MUTATION REQUESTS still stop at the approval gate, never execute', async () => {
    for (const toolId of CORRECTION_TOOL_IDS) {
      const tool = getToolById(toolId);
      const request = orchestratorExecutionContract.createExecutionRequest(
        'Fix the vendor and inventory on these Shopify products',
        { tool, category: tool.category }, CORRECTION_PARAMS[toolId], null
      );
      const approvalTracker = { requests: [] };
      const mutationsBefore = MUTATION_CALLS.length;
      const outcome = await orchestratorExecutionContract.executeSelectedCapability(
        request, { tokensUsedThisRun: 0 }, approvalTracker
      );
      assert.strictEqual(outcome.status, 'approval_required', `${toolId} returned ${outcome.status}`);
      assert.strictEqual(outcome.data, null);
      assert.strictEqual(approvalTracker.requests.length, 1);
      assert.strictEqual(MUTATION_CALLS.length - mutationsBefore, 0, 'a mutation actually executed');
    }
  });

  // ---------------------------------------------------------------------------------
  // 6. MIXED INTENT - clause behaviour preserved
  // ---------------------------------------------------------------------------------

  test('MIXED INTENT: the read clause stays read-only, the mutation clause keeps its intent', () => {
    const mixed = 'Analyze the catalogue and fix the vendor on product X.';
    const clauses = orchestratorExecutionContract.splitIntoClauses(mixed);
    const readClause = clauses.find((c) => /analy/i.test(c));
    const mutationClause = clauses.find((c) => /\bfix\b/i.test(c));
    assert.ok(readClause && mutationClause, `clauses were ${JSON.stringify(clauses)}`);
    assert.notStrictEqual(mutationIntent.classifyRequestIntent(readClause), 'mutation',
      'the analysis clause became a mutation');
    assert.strictEqual(mutationIntent.classifyRequestIntent(mutationClause), 'mutation',
      'the explicit fix clause lost its mutation intent');
    // Whole-objective reading still fails closed.
    assert.strictEqual(mutationIntent.maySelectMutationTool(mixed), false);
  });

  // ---------------------------------------------------------------------------------
  // 7. NO ROUTING REGRESSION for the other specialists
  // ---------------------------------------------------------------------------------

  const PINNED_ROUTES = [
    ['Run an SEO analysis on my product pages', 'specialist:seo'],
    ['Write new titles for our existing product listings.', 'specialist:listing'],
    ['Plan a social media content calendar', 'specialist:social_advertising'],
    ['Plan a paid advertising campaign', 'specialist:social_advertising'],
    ['Research my competitors', 'specialist:research'],
    ['Analyze my store sales performance', 'specialist:analytics_optimization'],
    ['How many orders have we had recently?', 'specialist:analytics_optimization'],
    ['Analyze my store traffic', 'specialist:analytics_optimization'],
    ['Create marketing offers', 'specialist:marketing'],
    ['Recommend a discount depth for our bundle', 'specialist:marketing'],
    ['Generate listing content for a product', 'specialist:listing'],
    ['Show me my business configuration', 'shared_infrastructure:configuration'],
    ['What should this store sell next?', 'specialist:product'],
    ['Analyze our existing catalogue and identify expansion opportunities.', 'specialist:product'],
  ];

  for (const [objective, expected] of PINNED_ROUTES) {
    test(`NO REGRESSION: ${JSON.stringify(objective)} still routes to ${expected}`, () => {
      const plan = orchestratorExecutionContract.planRouting(
        orchestratorExecutionContract.understandObjective(objective)
      );
      assert.strictEqual(plan.status, 'planned', `got ${plan.status}`);
      const ids = plan.targets.map((t) => `${t.type}:${t.id}`);
      assert.ok(ids.includes(expected), `routed to ${ids.join(',')} instead of ${expected}`);
    });
  }

  test('the added routing vocabulary is additive only - Product keeps its originals', () => {
    // 'shopify' and 'products' were already there and must stay; the new words are added
    // alongside, never replacing. Pinned so a future edit cannot quietly drop them.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'),
      'utf8'
    );
    const match = source.match(/product:\s*\[([^\]]*)\]/);
    assert.ok(match, 'ROUTING_SYNONYMS.product was not found');
    const entries = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    for (const required of ['shopify', 'products', 'vendor', 'vendors', 'inventory']) {
      assert.ok(entries.includes(required), `ROUTING_SYNONYMS.product lost ${JSON.stringify(required)}`);
    }
  });

  test('NO MUTATION FUNCTION WAS CALLED ANYWHERE IN THIS FILE', () => {
    assert.deepStrictEqual(MUTATION_CALLS, [], `mutation functions fired: ${MUTATION_CALLS.join(', ')}`);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('readOnlyRoutingCoverage.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
