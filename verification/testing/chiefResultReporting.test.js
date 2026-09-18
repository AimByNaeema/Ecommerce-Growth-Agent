'use strict';

// THE CHIEF DID THE WORK AND TOLD THE OWNER NOTHING.
//
// THE PRODUCTION FAILURE. The combined Shopify + Etsy growth cycle ran correctly - Product and
// Analytics & Optimization both completed, both stores were read - and the final result the
// owner read was:
//
//   "Product completed this request successfully."
//   "Analytics & Optimization completed this request successfully."
//
// The findings, the evidence behind them, the sources and the limitations were all sitting in
// the run result. agent/core/resultSummary.js has no projection for the *AgentResultModel
// envelope, so every one of those steps fell through to its generic last line.
//
// WHAT THIS PINS. Six specialists (Research, SEO, Listing, Marketing, Social & Advertising,
// Analytics & Optimization) compose the SAME envelope - findings, evidence, source,
// limitations, recommendations - and product_discovery returns a plain array of productModel
// records. Both now reach the owner, per specialist and per platform, relayed verbatim.
//
// NOTHING IS COMPOSED. A specialist that recorded no findings is reported as having recorded
// none. No metric Etsy or Shopify did not return is invented. The Etsy reads keep their own
// more specific projections, and a step that wrote its own summary keeps it.
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. Both store reads are stubbed at their module seams
// before the orchestrator is required; a fetch tripwire and write tripwires are asserted empty.

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

const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return { isConfigured: () => true, getShopInfo: async () => ({ native: FIXTURE_SHOP }), getProducts: async () => [] };
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyClient = require('../../integrations/adapters/etsyClient');
const mutationIntent = require('../../agent/core/mutationIntent');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

const MUTATION_CALLS = [];
const SAVED_SHOPIFY = {};
const SHOPIFY_READS = {
  isConfigured: () => true,
  getShopInfo: async () => ({ name: 'Fixture Store', domain: 'fixture.myshopify.com', email: null }),
  getProducts: async () => [
    { id: 'gid://shopify/Product/1', title: 'Christmas Invite Bundle', vendor: '', variants: [{ price: '5.00' }], status: 'active' },
    { id: 'gid://shopify/Product/2', title: 'Baby Shower Bundle', vendor: 'Naeema', variants: [{ price: '9.00' }], status: 'active' },
  ],
  getOrders: async () => [{ id: 'o1', created_at: '2026-09-01', total_price: '25.00', line_items: [] }],
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

(async () => {
  const result = await runOrchestratorContract(GROWTH_CYCLE);
  const view = describeChiefResultForOwner({ result, runId: 'reporting', objective: GROWTH_CYCLE });
  const summaries = view.findings.map((finding) => finding.summary);
  const entries = view.specialist_results;

  // --- 1. The generic line is gone, and real output is in its place -----------------------

  test('NO step is reported with the generic "completed this request successfully" line', () => {
    for (const summary of summaries) {
      assert.ok(!/completed this request successfully/.test(summary), `still generic: ${summary}`);
    }
  });

  test('every completed step contributes a structured specialist result', () => {
    assert.strictEqual(result.routing.status, 'planned', `routing ${result.routing.status}`);
    assert.ok(entries.length >= 2, `only ${entries.length} specialist result(s)`);
    for (const entry of entries) {
      assert.ok(entry.specialist, 'a result has no specialist name');
      assert.ok(entry.capability, `${entry.specialist} has no capability id`);
      assert.strictEqual(typeof entry.requires_approval, 'boolean');
    }
  });

  test('the Analytics envelope reaches the owner - findings, evidence, source and limitations', () => {
    const analytics = entries.find((entry) => entry.capability === 'sales');
    assert.ok(analytics, `no analytics result: ${entries.map((e) => e.capability).join(', ')}`);
    assert.ok(analytics.findings.some((line) => /order\(s\) retrieved/.test(line)), JSON.stringify(analytics.findings));
    assert.ok(analytics.evidence.length > 0, 'the evidence behind the finding was dropped');
    assert.ok(analytics.sources.some((line) => /Shopify Admin API/.test(line)), JSON.stringify(analytics.sources));
    assert.ok(analytics.limitations.length > 0, 'the limitations on the finding were dropped');
    // ...and it is in the sentence the owner actually reads.
    const summary = summaries.find((line) => /order\(s\) retrieved/.test(line));
    assert.ok(summary, `the analytics finding is not in any summary: ${summaries.join(' | ')}`);
    assert.match(summary, /Evidence:/);
    assert.match(summary, /Source:/);
    assert.match(summary, /Limitations:/);
  });

  test('the Shopify product read reports what it actually retrieved, by name', () => {
    const product = entries.find((entry) => entry.capability === 'product_discovery');
    assert.ok(product, 'no product_discovery result');
    assert.strictEqual(product.record_count, 2);
    assert.deepStrictEqual(product.evidence, ['Christmas Invite Bundle', 'Baby Shower Bundle']);
    assert.ok(product.sources.length > 0, 'the records\' own source strings were dropped');
  });

  // --- 2. Shopify and Etsy stay distinguishable -------------------------------------------

  test('every specialist result names the platform it read', () => {
    for (const entry of entries) {
      assert.strictEqual(entry.platform, 'shopify', `${entry.capability} -> ${entry.platform}`);
    }
    // The Etsy step keeps its own, more specific projection rather than the generic envelope.
    assert.ok(view.store_connections.some((entry) => entry.platform === 'etsy'), 'the Etsy read is missing');
    assert.deepStrictEqual(view.platforms.slice().sort(), ['etsy', 'shopify']);
  });

  test('Shopify and Etsy findings are separately identifiable in the owner-facing summaries', () => {
    assert.ok(summaries.some((line) => /Etsy shop name: HappyInviteHouse/.test(line)), `no Etsy line: ${summaries.join(' | ')}`);
    assert.ok(summaries.some((line) => /^\[shopify\]/.test(line)), `no Shopify-tagged line: ${summaries.join(' | ')}`);
    // No summary mixes the two stores together.
    for (const line of summaries) {
      assert.ok(!(/\[shopify\]/.test(line) && /Etsy shop name/.test(line)), `one line mixes both stores: ${line}`);
    }
  });

  // --- 3. Nothing is invented --------------------------------------------------------------

  test('no unavailable metric is invented anywhere in the owner-facing result', () => {
    const answer = JSON.stringify(view);
    for (const pattern of [/"sales":\s*\d/, /"revenue":\s*\d/, /"conversion[_ ]?rate":\s*\d/, /"impressions":\s*\d/, /"search[_ ]?volume":\s*\d/, /"demand":\s*\d/]) {
      assert.ok(!pattern.test(answer), `an invented metric appeared: ${pattern}`);
    }
  });

  test('a specialist that recorded nothing is reported as having recorded nothing', () => {
    const empty = describeChiefResultForOwner({
      result: {
        routing: {
          status: 'planned',
          plan: [{
            completion_state: 'complete',
            selected_specialist: { id: 'analytics_optimization', title: 'Analytics & Optimization' },
            inputs: { tool_id: 'analytics_data_retrieval', capability_id: 'sales' },
            outputs: { status: 'success', result: { findings: [], evidence: [], source: [], limitations: [], recommendations: [] } },
            approvals: [{ classification: 'analysis_only', status: 'auto_approved' }],
          }],
        },
        pending_approvals: [],
      },
    });
    const [entry] = empty.specialist_results;
    assert.ok(entry.no_findings_reason, 'an empty result was not reported as empty');
    assert.match(empty.findings[0].summary, /recorded no findings/);
    assert.ok(!/completed this request successfully/.test(empty.findings[0].summary));
  });

  test('"what worked / what did not" is reported as unrecorded, never fabricated', () => {
    assert.strictEqual(view.cycle_learning.recorded, false);
    assert.match(view.cycle_learning.detail, /experimentLearningStore/);
  });

  // --- 4. Existing behaviour preserved -----------------------------------------------------

  test('a specialist that composes its OWN summary keeps it', () => {
    const own = describeChiefResultForOwner({
      result: {
        routing: {
          status: 'planned',
          plan: [{
            completion_state: 'complete',
            selected_specialist: { id: 'seo', title: 'SEO' },
            inputs: { tool_id: 'seo_analysis', capability_id: 'seo_store_audit' },
            outputs: { status: 'success', result: { summary: 'Audited 3 of 3 products.', findings: ['x'], evidence: ['y'] } },
          }],
        },
        pending_approvals: [],
      },
    });
    assert.strictEqual(own.findings[0].summary, 'Audited 3 of 3 products.');
  });

  test('the Etsy reads keep their own, more specific projections', () => {
    // They are described by store_connections / listing_opportunities, not by the generic
    // envelope relay - so the generic path must not have claimed them.
    assert.ok(!entries.some((entry) => entry.platform === 'etsy'), 'the Etsy read was taken over by the generic relay');
  });

  // --- 5. Safety model unchanged -----------------------------------------------------------

  test('ETSY REMAINS READ-ONLY', () => {
    const etsyTools = TOOL_REGISTRY.filter((tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy'));
    assert.ok(etsyTools.length > 0);
    assert.deepStrictEqual(etsyTools.filter((tool) => tool.operation !== 'read').map((tool) => tool.id), []);
    assert.strictEqual(etsyClient.canPublish(), false);
  });

  test('no mutation, no approval request, no approval bypass, no network', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(FETCH_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.deepStrictEqual(view.mutations, []);
    assert.strictEqual(view.approval_state, 'not_needed');
    // Reporting reads approvals, it never grants one: every entry here was auto-approved
    // analysis, so none claims to need the owner and none claims the owner gave it.
    for (const entry of entries) assert.strictEqual(entry.requires_approval, false);
    assert.strictEqual(mutationIntent.maySelectMutationTool(GROWTH_CYCLE), false);
  });

  test('a step still waiting on a real approval says so, from the run\'s own record', () => {
    const waiting = describeChiefResultForOwner({
      result: {
        routing: {
          status: 'planned',
          plan: [{
            completion_state: 'complete',
            selected_specialist: { id: 'product', title: 'Product' },
            inputs: { tool_id: 'shopify_vendor_correction', capability_id: 'vendor_correction' },
            outputs: { status: 'success', result: { findings: ['A vendor mismatch was found.'], evidence: ['product 1'] } },
            approvals: [{ classification: 'approval_required', status: 'pending' }],
          }],
        },
        pending_approvals: [{ status: 'pending', tool_id: 'shopify_vendor_correction', execution_request: { research_params: { productId: '1', newVendor: 'Naeema' } } }],
      },
    });
    const [entry] = waiting.specialist_results;
    assert.strictEqual(entry.requires_approval, true);
    assert.ok(entry.proposed_action, 'the real pending approval was not linked to its step');
    assert.strictEqual(entry.proposed_action.what_changes, 'Product vendor');
    assert.match(waiting.findings[0].summary, /needs your approval/);
    assert.strictEqual(waiting.status, 'waiting_for_approval');
    assert.deepStrictEqual(waiting.mutations, []);
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('chiefResultReporting.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
