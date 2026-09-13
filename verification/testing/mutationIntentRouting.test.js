'use strict';

// ROUTER + MUTATION SAFETY - the production-blocking defect found by read-only
// production validation, pinned permanently.
//
// THE DEFECT. This plainly read-only request:
//
//   "Analyze my Shopify products for vendor and inventory"
//
// selected shopify_vendor_correction, a MUTATION tool. The downstream gates held, so no
// live data changed - but the router had already chosen to change customer data in
// response to a request to look at it, and a wrong selection still creates a real
// pending human approval to mutate.
//
// WHY THESE TESTS ARE SHAPED LIKE THIS. Asserting only that execution was blocked would
// pass even with the router still broken - the approval gate blocks it either way. So
// every assertion below is on WHICH TOOL WAS SELECTED. If the router picks a mutation
// tool for a read-only or ambiguous request, these tests fail, regardless of what the
// gates downstream would have done about it.
//
// NO NETWORK, NO MODEL CALL, NO LIVE DATA. global.fetch is replaced with a function that
// fails the run if anything tries to reach the network, and the Shopify client's read
// functions are substituted with in-memory stubs for the duration. Nothing in this file
// can touch a real store.

const assert = require('node:assert');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const mutationIntent = require('../../agent/core/mutationIntent');
const { getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { getToolById } = require('../../tools/toolRegistry');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const fs = require('fs');
const path = require('path');

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

// --- Absolute network ban for this file ----------------------------------------------
const originalFetch = global.fetch;
global.fetch = async (url) => {
  throw new Error(`NETWORK CALL ATTEMPTED during a routing test: ${url}`);
};

// --- In-memory Shopify reads, so buildPlanStep can run a read tool without a store ----
const originalShopify = {
  getProducts: shopifyClient.getProducts,
  getCollections: shopifyClient.getCollections,
  getInventoryLevels: shopifyClient.getInventoryLevels,
  getOrders: shopifyClient.getOrders,
  getCustomers: shopifyClient.getCustomers,
  getShopInfo: shopifyClient.getShopInfo,
  isConfigured: shopifyClient.isConfigured,
};
shopifyClient.isConfigured = () => true;
shopifyClient.getShopInfo = async () => ({ name: 'Stub Store', domain: 'stub.example', email: null, apiVersion: 'stub' });
shopifyClient.getProducts = async () => [
  { id: 'gid://stub/Product/1', title: 'Stub bundle', handle: 'stub', status: 'ACTIVE', productType: '', vendor: 'Stub Vendor', tags: [], variants: [], collections: [], metafields: [] },
];
shopifyClient.getCollections = async () => [];
shopifyClient.getInventoryLevels = async () => [];
shopifyClient.getOrders = async () => [];
shopifyClient.getCustomers = async () => [];

function restore() {
  global.fetch = originalFetch;
  for (const [k, v] of Object.entries(originalShopify)) shopifyClient[k] = v;
}

const CORRECTION_TOOL_IDS = mutationIntent.CORRECTION_TOOL_IDS;

// THE EXACT REQUEST FROM PRODUCTION VALIDATION, first and by itself, plus the realistic
// adversarial variants. Every one of these names a mutable subject (vendor, inventory,
// mismatch, issue, problem) with no instruction to change it.
const READ_ONLY_OBJECTIVES = [
  'Analyze my Shopify products for vendor and inventory',
  'Check my Shopify products for vendor mismatches',
  'Show me Shopify vendor and inventory issues',
  'Review my product vendors and inventory',
  'Analyze vendor problems in my products',
  'Report inventory/vendor issues',
  'Investigate product vendor mismatches',
  // Extra adversarial shapes found while building the gate.
  'Show me the correct vendor names',
  'List products with the wrong vendor',
  'How many products have vendor mismatches?',
  'What are the inventory discrepancies on my products?',
  'Audit my Shopify catalogue for vendor and inventory errors',
  'Find products where the vendor is inconsistent',
  'Summarize vendor and inventory problems',
];

// Explicit instructions to change something. These MAY reach the mutation path - and are
// still subject to every existing downstream gate, which the tests below prove.
const MUTATION_OBJECTIVES = [
  'Fix the vendor mismatch on these Shopify products',
  'Correct the vendor for product X',
  'Update the vendor on product X',
];

function selectedByLegacyRouter(objective) {
  const capability = orchestratorExecutionContract.identifyRequiredCapability(
    orchestratorExecutionContract.understandObjective(objective)
  );
  return capability && capability.tool ? capability.tool.id : null;
}

(async () => {
  // ---------------------------------------------------------------------------------
  // 1. Intent classification itself
  // ---------------------------------------------------------------------------------

  test('read verbs classify as read_only, never mutation', () => {
    for (const objective of READ_ONLY_OBJECTIVES) {
      const intent = mutationIntent.classifyRequestIntent(objective);
      assert.notStrictEqual(intent, 'mutation', `${JSON.stringify(objective)} classified as mutation`);
      assert.strictEqual(
        mutationIntent.maySelectMutationTool(objective),
        false,
        `${JSON.stringify(objective)} was ruled eligible for a mutation tool`
      );
    }
  });

  test('explicit mutation verbs classify as mutation', () => {
    for (const objective of MUTATION_OBJECTIVES) {
      assert.strictEqual(
        mutationIntent.classifyRequestIntent(objective),
        'mutation',
        `${JSON.stringify(objective)} did not register explicit mutation intent`
      );
    }
  });

  test('a mutable SUBJECT is never mutation intent on its own', () => {
    // The nouns that caused the defect. None of them is an instruction.
    for (const noun of ['vendor', 'inventory', 'product', 'Shopify', 'correction', 'issue', 'mismatch', 'error']) {
      assert.strictEqual(
        mutationIntent.hasExplicitMutationIntent(`Something about the ${noun} here`),
        false,
        `the bare noun ${JSON.stringify(noun)} registered as mutation intent`
      );
    }
  });

  test('an adjectival "correct" is not the verb "correct"', () => {
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Show me the correct vendor names'), false);
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Tell me whether the vendor is correct'), false);
    // The verb form still registers.
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Correct the vendor on product X'), true);
  });

  test('PREDICATE ADJECTIVE: "is the vendor correct" is a question, not an instruction', () => {
    // A real false positive found by adversarial probing after the first version of this
    // gate: here "correct" follows a NOUN, so the determiner guard does not catch it.
    for (const question of [
      'Is the vendor correct on product X?',
      'Are these vendors correct?',
      'Do the vendor names look correct?',
      'Was the inventory correct last week?',
    ]) {
      assert.strictEqual(
        mutationIntent.hasExplicitMutationIntent(question),
        false,
        `${JSON.stringify(question)} registered as an instruction to change something`
      );
      assert.strictEqual(mutationIntent.maySelectMutationTool(question), false);
    }
  });

  test('NO FALSE NEGATIVES: ordinary ways of asking for a change still register', () => {
    for (const instruction of [
      'Fix the vendor mismatch on these Shopify products',
      'Correct the vendor for product X',
      'Update the vendor on product X',
      'Change the vendor to Digital Studio By Naeema',
      'Replace the vendor name on all draft products',
      'Modify the inventory for SKU CPM-001',
      'Repair the vendor spelling on product 123',
      'Edit the collection membership for this product',
      'Set the inventory to 0 for SKU CPM-002',
      'Please fix the vendor casing',
      'Can you fix the vendor?',
      'Correcting the vendor on product X',
    ]) {
      assert.strictEqual(
        mutationIntent.classifyRequestIntent(instruction),
        'mutation',
        `${JSON.stringify(instruction)} was not recognised as a request to change something`
      );
    }
  });

  test('past-tense description of a change is not a request to change', () => {
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('List the products that were updated last week'), false);
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Which vendors were changed?'), false);
  });

  test('"set" only counts in its unmistakable imperative shape', () => {
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Show me the set of designs in this bundle'), false);
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('How many products are in a set?'), false);
    assert.strictEqual(mutationIntent.hasExplicitMutationIntent('Set the vendor to Digital Studio'), true);
  });

  test('AMBIGUITY FAILS CLOSED: read intent plus mutation intent is never mutation', () => {
    const both = 'Analyze the catalogue and fix the vendor mismatches';
    assert.strictEqual(mutationIntent.classifyRequestIntent(both), 'ambiguous');
    assert.strictEqual(mutationIntent.maySelectMutationTool(both), false);
  });

  test('an objective stating no action at all is ambiguous, never mutation', () => {
    for (const objective of ['vendor', 'my Shopify products', 'inventory and vendor']) {
      assert.strictEqual(mutationIntent.classifyRequestIntent(objective), 'ambiguous');
      assert.strictEqual(mutationIntent.maySelectMutationTool(objective), false);
    }
  });

  // ---------------------------------------------------------------------------------
  // 2. THE REGRESSION CASE, on the router itself
  // ---------------------------------------------------------------------------------

  test('THE REPORTED DEFECT: "Analyze my Shopify products for vendor and inventory" does not select shopify_vendor_correction', () => {
    const selected = selectedByLegacyRouter('Analyze my Shopify products for vendor and inventory');
    assert.notStrictEqual(selected, 'shopify_vendor_correction', 'the reported defect has regressed');
    assert.ok(
      !CORRECTION_TOOL_IDS.includes(selected),
      `selected the mutation tool ${JSON.stringify(selected)}`
    );
  });

  for (const objective of READ_ONLY_OBJECTIVES) {
    test(`ROUTER (legacy): no mutation tool for ${JSON.stringify(objective)}`, () => {
      const selected = selectedByLegacyRouter(objective);
      assert.ok(
        selected === null || !CORRECTION_TOOL_IDS.includes(selected),
        `selected the mutation tool ${JSON.stringify(selected)}`
      );
    });
  }

  // ---------------------------------------------------------------------------------
  // 3. The path the live orchestrator actually uses (planRouting -> buildPlanStep)
  // ---------------------------------------------------------------------------------
  //
  // The Product specialist genuinely owns the three correction tools alongside its read
  // tools, so this list is where a read-only clause could pick one. Asserted on the tool
  // actually selected, not on what happened afterwards.

  const productTools = getSpecialistCapabilityById('product').required_tools;

  test('the Product specialist really does own the mutation tools (else this test proves nothing)', () => {
    for (const id of CORRECTION_TOOL_IDS) {
      assert.ok(productTools.includes(id), `${id} is not a Product candidate - re-check this test's premise`);
    }
  });

  test('CANDIDATE FILTER: a read-only clause removes every mutation tool from Product candidates', () => {
    for (const objective of READ_ONLY_OBJECTIVES) {
      const filtered = mutationIntent.filterToolCandidatesByIntent(productTools, objective);
      for (const id of CORRECTION_TOOL_IDS) {
        assert.ok(!filtered.includes(id), `${id} survived filtering for ${JSON.stringify(objective)}`);
      }
      // The read tools are untouched - this filter only ever removes mutation tools.
      assert.ok(filtered.includes('product_data_retrieval'), 'a read tool was wrongly removed');
    }
  });

  test('CANDIDATE FILTER: an explicit mutation clause keeps the mutation tools available', () => {
    for (const objective of MUTATION_OBJECTIVES) {
      const filtered = mutationIntent.filterToolCandidatesByIntent(productTools, objective);
      assert.deepStrictEqual(filtered, productTools, `mutation intent wrongly narrowed candidates for ${JSON.stringify(objective)}`);
    }
  });

  for (const objective of READ_ONLY_OBJECTIVES) {
    await testAsync(`ROUTER (live path): buildPlanStep selects no mutation tool for ${JSON.stringify(objective)}`, async () => {
      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget('product'),
        objective,
        objective
      );
      for (const id of CORRECTION_TOOL_IDS) {
        assert.ok(
          !(step.tool_calls || []).includes(id),
          `buildPlanStep selected ${id} for a read-only request (tool_calls: ${JSON.stringify(step.tool_calls)})`
        );
      }
    });
  }

  // ---------------------------------------------------------------------------------
  // 4. TOOL-LEVEL DEFENSE: the precondition that does not depend on the router
  // ---------------------------------------------------------------------------------

  await testAsync('READ intent cannot even QUEUE a mutation: no approval request is created', async () => {
    const tool = getToolById('shopify_vendor_correction');
    const request = orchestratorExecutionContract.createExecutionRequest(
      'Analyze my Shopify products for vendor and inventory',
      { tool, category: tool.category },
      null,
      null
    );
    const approvalTracker = { requests: [] };
    const outcome = await orchestratorExecutionContract.executeSelectedCapability(
      request,
      { tokensUsedThisRun: 0 },
      approvalTracker
    );
    assert.strictEqual(outcome.status, 'denied', `expected denied, got ${outcome.status}`);
    assert.strictEqual(outcome.mutation_intent, 'read_only');
    assert.ok(/does not state an explicit instruction to change anything/.test(outcome.error));
    // THE POINT: a read-only request must not leave a pending mutation for a human to
    // approve. Before this gate it created exactly that.
    assert.strictEqual(approvalTracker.requests.length, 0, 'a read-only request queued a mutation for approval');
  });

  await testAsync('AMBIGUOUS intent cannot queue a mutation either', async () => {
    const tool = getToolById('shopify_inventory_correction');
    const request = orchestratorExecutionContract.createExecutionRequest(
      'Analyze the catalogue and fix the inventory',
      { tool, category: tool.category },
      null,
      null
    );
    const approvalTracker = { requests: [] };
    const outcome = await orchestratorExecutionContract.executeSelectedCapability(
      request,
      { tokensUsedThisRun: 0 },
      approvalTracker
    );
    assert.strictEqual(outcome.status, 'denied');
    assert.strictEqual(outcome.mutation_intent, 'ambiguous');
    assert.strictEqual(approvalTracker.requests.length, 0);
  });

  // A correction approval now also carries the compliance input built from the parameters
  // the correction will actually write (integrations/approvedCorrectionDispatch.js's
  // buildCorrectionComplianceInput), so a request must state them to reach the approval
  // gate at all. These are the real per-tool parameters, not placeholders for the gate.
  const CORRECTION_PARAMS = {
    shopify_vendor_correction: { productId: 'gid://fixture/Product/1', newVendor: 'Fixture Vendor' },
    shopify_inventory_correction: { inventoryItemId: 'gid://fixture/InventoryItem/1', locationId: 'gid://fixture/Location/1', delta: 1, idempotencyKey: 'fixture-key' },
    shopify_collection_membership_update: { collectionId: 'gid://fixture/Collection/1', productId: 'gid://fixture/Product/1' },
  };

  await testAsync('EXPLICIT mutation intent still faces every existing gate - approval, never execution', async () => {
    for (const toolId of CORRECTION_TOOL_IDS) {
      const tool = getToolById(toolId);
      const request = orchestratorExecutionContract.createExecutionRequest(
        'Fix the vendor and inventory on these Shopify products',
        { tool, category: tool.category },
        CORRECTION_PARAMS[toolId],
        null
      );
      const approvalTracker = { requests: [] };
      const outcome = await orchestratorExecutionContract.executeSelectedCapability(
        request,
        { tokensUsedThisRun: 0 },
        approvalTracker
      );
      // The intent gate let it through; the APPROVAL gate still stops it dead.
      assert.strictEqual(outcome.status, 'approval_required', `${toolId} returned ${outcome.status}`);
      assert.strictEqual(outcome.data, null, `${toolId} produced data without an approval`);
      assert.strictEqual(approvalTracker.requests.length, 1, `${toolId} did not create a pending approval`);
      assert.strictEqual(outcome.classification, 'externally_executable');
    }
  });

  await testAsync('A CORRECTION THAT DOES NOT STATE WHAT IT WRITES NEVER BECOMES AN APPROVAL', async () => {
    // Stricter than before: without parameters, compliance cannot be evaluated for the
    // action, so no approval record is created for a human to approve.
    for (const toolId of CORRECTION_TOOL_IDS) {
      const tool = getToolById(toolId);
      const request = orchestratorExecutionContract.createExecutionRequest(
        'Fix the vendor and inventory on these Shopify products',
        { tool, category: tool.category },
        null,
        null
      );
      const approvalTracker = { requests: [] };
      const outcome = await orchestratorExecutionContract.executeSelectedCapability(
        request, { tokensUsedThisRun: 0 }, approvalTracker
      );
      assert.strictEqual(outcome.status, 'denied', `${toolId} returned ${outcome.status}`);
      assert.strictEqual(approvalTracker.requests.length, 0, `${toolId} queued an approval it could not compliance-check`);
    }
  });

  test('THE GATE GRANTS NOTHING: the corrections still have no ordinary executor', () => {
    // Preserved invariant - mutation tools remain unreachable through normal dispatch,
    // exactly as before this change. The intent gate narrows selection; it never opened
    // a new execution path.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'),
      'utf8'
    );
    const executorBlock = source.slice(source.indexOf('const TOOL_EXECUTORS = {'), source.indexOf('const STOPWORDS'));
    for (const id of CORRECTION_TOOL_IDS) {
      assert.ok(
        !new RegExp(`^\\s{2}${id}:`, 'm').test(executorBlock),
        `${id} gained a TOOL_EXECUTORS entry - ordinary dispatch must never reach a mutation`
      );
    }
  });

  // ---------------------------------------------------------------------------------
  // 5. The gate cannot be silently removed
  // ---------------------------------------------------------------------------------

  test('all three gates have a real live caller in the orchestrator', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'),
      'utf8'
    );
    assert.ok(source.includes("require('./mutationIntent')"), 'the orchestrator no longer imports the gate');
    // Gate 1: legacy single-tool selection.
    assert.ok(
      /selectableTools\s*=\s*maySelectMutationTool\(objective\)/.test(source),
      'gate 1 (identifyRequiredCapability) is missing'
    );
    // Gate 2: the live routing path.
    assert.ok(
      /candidateToolIds\s*=\s*filterToolCandidatesByIntent\(rawCandidateToolIds, currentTask\)/.test(source),
      'gate 2 (buildPlanStep candidates) is missing'
    );
    // Gate 3: the tool-level precondition.
    assert.ok(
      /isCorrectionTool\(access\.tool_id\)\s*&&\s*!maySelectMutationTool\(executionRequest\.objective\)/.test(source),
      'gate 3 (executeSelectedCapability precondition) is missing'
    );
  });

  test('the mutation tool list is derived from the dispatcher, never hand-maintained', () => {
    const dispatch = require('../../integrations/approvedCorrectionDispatch');
    assert.deepStrictEqual(
      mutationIntent.CORRECTION_TOOL_IDS,
      dispatch.CORRECTION_TOOL_IDS,
      'the gate has its own copy of the mutation tool list - it would drift'
    );
    assert.strictEqual(mutationIntent.isCorrectionTool, dispatch.isCorrectionTool);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('mutationIntentRouting.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
