'use strict';

// THE OWNER-FACING ANSWER TO "IS ETSY CONNECTED AS READ-ONLY?"
//
// THE GAP THIS CLOSES. Routing already resolved this request to the Etsy shop read and ran it
// (see verification/testing/etsyShopInspectionRouting.test.js). But what came BACK to the owner
// was agent/core/resultSummary.js's generic fallback sentence - "Product completed this request
// successfully." - so the four things actually asked for:
//
//   "Chief, inspect my connected Etsy store and show me the current shop name, shop ID,
//    listing count, and whether Etsy is connected as read-only. Do not make any changes."
//
// never appeared in the answer at all. The shop record was in the raw run result and nowhere in
// agent/core/ownerRunView.js's owner_view, which is what every Chief response carries
// (server.js's /ask, /session, /orchestrate and History all build from it).
//
// WHERE THE READ-ONLY STATUS COMES FROM, AND WHY IT IS NOT A NEW FLAG. It is derived in
// ownerRunView.accessModeFor() from integrations/adapters/platformSupportRegistry.js's
// describePlatformSupport('etsy') - read_adapter_registered true, publishing_available false.
// Both of those are themselves derived, in that module, from the adapter registry and from the
// publishing paths that genuinely exist. So 'read_only' is a consequence of the code in this
// repository, and the test below proves it by recomputing it from those same two facts rather
// than comparing against a literal.
//
// WHAT THESE TESTS ASSERT: (1) the inspection returns the real shop fields, (2) the read-only
// status is explicitly surfaced to the owner, (3) a field Etsy did not return stays unavailable
// rather than being invented, and (4) no mutation capability is introduced by any of it.
//
// NO NETWORK, NO MODEL CALL, NO CREDENTIAL. The Etsy read is stubbed at
// integrations/adapters/adapterRegistry.js's getReadAdapter seam - before the orchestrator is
// required, because tools/etsyShopDataTool.js destructures that function at require time. A
// fetch tripwire and Shopify mutation tripwires are installed and asserted empty.

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

// A shop Etsy answered fully, and one where Etsy returned only an id and a name. Both are built
// through the read client's own normalizeEtsyShop(), so neither can describe a shape Etsy never
// produces - the sparse one is exactly what that function returns for a sparse response.
const FULL_SHOP = etsyReadClient.normalizeEtsyShop({
  shop_id: 90210,
  shop_name: 'FixtureInvites',
  title: 'Fixture digital invitations',
  currency_code: 'GBP',
  url: 'https://www.etsy.com/shop/FixtureInvites',
  listing_active_count: 42,
  digital_listing_count: 40,
  is_vacation: false,
});
const SPARSE_SHOP = etsyReadClient.normalizeEtsyShop({ shop_id: 90210, shop_name: 'FixtureInvites' });

let currentShop = FULL_SHOP;
const originalGetReadAdapter = adapterRegistry.getReadAdapter;
adapterRegistry.getReadAdapter = (platform) => {
  if (platform !== 'etsy') return originalGetReadAdapter(platform);
  return {
    isConfigured: () => true,
    getShopInfo: async () => ({
      name: currentShop.shop_name,
      domain: currentShop.url,
      email: null,
      channel: 'etsy',
      native: currentShop,
    }),
  };
};

const etsyClient = require('../../integrations/adapters/etsyClient');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { describePlatformSupport } = require('../../integrations/adapters/platformSupportRegistry');
const { describeChiefResultForOwner } = require('../../agent/core/ownerRunView');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

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
  'Chief, inspect my connected Etsy store and show me the current shop name, shop ID, listing count, and whether Etsy is connected as read-only. Do not make any changes.';

const ownerViewFor = async (objective) => {
  const result = await runOrchestratorContract(objective);
  return { result, view: describeChiefResultForOwner({ result, runId: 'etsy-read-only-status', objective }) };
};

(async () => {
  currentShop = FULL_SHOP;
  const full = await ownerViewFor(PRODUCTION_REQUEST);
  const connection = (full.view.store_connections || [])[0] || null;
  const fieldsById = {};
  for (const field of (connection && connection.fields) || []) fieldsById[field.id] = field;

  // --- 1. The inspection returns the real shop fields --------------------------------

  test('the run succeeded and reported one Etsy store connection', () => {
    assert.strictEqual(full.view.status, 'success');
    assert.strictEqual(full.view.platform, 'etsy');
    assert.strictEqual((full.view.store_connections || []).length, 1);
    assert.strictEqual(connection.platform, 'etsy');
    assert.strictEqual(connection.connected, true);
  });

  test('shop name, shop ID and listing count are the values Etsy actually returned', () => {
    assert.deepStrictEqual(
      { shop_name: fieldsById.shop_name.value, shop_id: fieldsById.shop_id.value, active: fieldsById.listing_active_count.value, digital: fieldsById.digital_listing_count.value },
      { shop_name: FULL_SHOP.shop_name, shop_id: FULL_SHOP.shop_id, active: FULL_SHOP.listing_active_count, digital: FULL_SHOP.digital_listing_count }
    );
    for (const field of connection.fields) assert.strictEqual(field.available, true);
    assert.deepStrictEqual(connection.unavailable_fields, []);
  });

  test('the owner-facing finding states all four things outright, not a generic success line', () => {
    const [finding] = full.view.findings;
    assert.strictEqual(finding.state, 'complete');
    // The sentence the owner reads. Before this change it was "Product completed this request
    // successfully." and carried none of what was asked for.
    assert.ok(!/completed this request successfully/.test(finding.summary), finding.summary);
    assert.match(finding.summary, /Etsy shop name: FixtureInvites/);
    assert.match(finding.summary, /Etsy shop ID: 90210/);
    assert.match(finding.summary, /Active listing count: 42/);
    assert.match(finding.summary, /Connection: read-only/);
  });

  // --- 2. The read-only status is explicitly surfaced, and is derived ------------------

  test('the connection is reported as read-only, in both the structured field and the text', () => {
    assert.strictEqual(connection.access_mode, 'read_only');
    assert.strictEqual(connection.publishing_available, false);
    assert.match(connection.access_text, /^Read-only\./);
  });

  test('read-only is DERIVED from platformSupportRegistry, not written down anywhere', () => {
    // Recomputed here from the same two derived facts the owner view reads. If a real Etsy
    // publishing path ever lands, describePlatformSupport() reports it and this expectation
    // becomes 'read_write' by itself - a literal 'read_only' in ownerRunView would fail here.
    const support = describePlatformSupport('etsy');
    const expected = !support.read_adapter_registered ? 'no_access' : support.publishing_available ? 'read_write' : 'read_only';
    assert.strictEqual(connection.access_mode, expected);
    assert.strictEqual(support.read_adapter_registered, true, 'Etsy must have a registered read adapter for this to mean anything');
    assert.strictEqual(support.publishing_available, false);
  });

  // --- 3. A field Etsy did not return stays unavailable -------------------------------

  currentShop = SPARSE_SHOP;
  const sparse = await ownerViewFor(PRODUCTION_REQUEST);
  const sparseConnection = (sparse.view.store_connections || [])[0] || null;
  const sparseFields = {};
  for (const field of (sparseConnection && sparseConnection.fields) || []) sparseFields[field.id] = field;

  test('a listing count Etsy did not return is unavailable and null - never 0, never invented', () => {
    assert.strictEqual(sparseConnection.connected, true);
    assert.strictEqual(sparseFields.listing_active_count.value, null);
    assert.strictEqual(sparseFields.listing_active_count.available, false);
    assert.strictEqual(sparseFields.digital_listing_count.value, null);
    assert.strictEqual(sparseFields.digital_listing_count.available, false);
    assert.deepStrictEqual(sparseConnection.unavailable_fields, ['listing_active_count', 'digital_listing_count']);
  });

  test('the fields Etsy DID return are still reported in the same answer', () => {
    assert.strictEqual(sparseFields.shop_name.value, 'FixtureInvites');
    assert.strictEqual(sparseFields.shop_id.value, 90210);
  });

  test('an unavailable field says so in the owner-facing sentence rather than being omitted', () => {
    const [finding] = sparse.view.findings;
    assert.match(finding.summary, /Active listing count: unavailable/);
    assert.match(finding.summary, /Etsy shop name: FixtureInvites/);
    // Still answered - the access mode does not depend on what the shop record contained.
    assert.match(finding.summary, /Connection: read-only/);
  });

  test('an unavailable field never becomes a number anywhere in the answer', () => {
    assert.ok(!/Active listing count: \d/.test(sparse.view.findings[0].summary));
    assert.ok(!/Digital listing count: \d/.test(sparse.view.findings[0].summary));
  });

  // --- 4. No mutation capability is introduced ---------------------------------------

  test('no Etsy-bound tool in the registry is anything but a read', () => {
    const nonRead = TOOL_REGISTRY.filter(
      (tool) => Array.isArray(tool.platforms) && tool.platforms.includes('etsy') && tool.operation !== 'read'
    );
    assert.deepStrictEqual(nonRead.map((tool) => tool.id), []);
  });

  test('the Etsy publish adapter is still unreachable by configuration', () => {
    assert.strictEqual(etsyClient.canPublish(), false);
  });

  test('neither run mutated anything, requested an approval, or touched the network', () => {
    for (const run of [full, sparse]) {
      assert.deepStrictEqual(run.view.mutations, []);
      assert.strictEqual(run.view.approval_state, 'not_needed');
      assert.strictEqual((run.result.pending_approvals || []).length, 0);
    }
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.deepStrictEqual(FETCH_CALLS, []);
  });

  test('reporting the access mode grants nothing - it is a description, not a permission', () => {
    // The owner view is an allow-listed, read-only projection (its own header): it exposes no
    // execution path at all, so nothing here can be acted on.
    assert.strictEqual(typeof describeChiefResultForOwner, 'function');
    assert.ok(!Object.keys(full.view).some((key) => /execute|publish|write|mutate/i.test(key)), Object.keys(full.view).join(','));
  });

  // --- Unchanged for every other run -------------------------------------------------

  test('a run that read no described platform reports no store connection', () => {
    const view = describeChiefResultForOwner({
      result: { routing: { status: 'planned', plan: [{ completion_state: 'complete', selected_specialist: { id: 'seo', title: 'SEO' }, inputs: { tool_id: 'seo_analysis' }, outputs: { status: 'success', result: { summary: 'Found 3 keyword gaps.' } } }] }, pending_approvals: [] },
    });
    assert.deepStrictEqual(view.store_connections, []);
    // ...and its finding keeps the summary it always had.
    assert.strictEqual(view.findings[0].summary, 'Found 3 keyword gaps.');
  });

  test('a FAILED Etsy read keeps its own honest error sentence, never a shop line', () => {
    const view = describeChiefResultForOwner({
      result: {
        routing: {
          status: 'planned',
          plan: [{
            completion_state: 'failed',
            selected_specialist: { id: 'product', title: 'Product' },
            inputs: { tool_id: 'etsy_shop_data_retrieval' },
            outputs: { status: 'failed', result: null, error: 'Etsy reading is not configured: ETSY_SHARED_SECRET not set. No Etsy request was attempted.' },
            errors: ['Etsy reading is not configured: ETSY_SHARED_SECRET not set. No Etsy request was attempted.'],
          }],
        },
        pending_approvals: [],
      },
    });
    assert.match(view.findings[0].summary, /could not complete this request/);
    assert.ok(!/Connection: read-only/.test(view.findings[0].summary));
    // The connection is still reported, and it is honest about not having reached the store.
    assert.strictEqual(view.store_connections[0].connected, false);
    assert.strictEqual(view.store_connections[0].access_mode, 'read_only');
    assert.deepStrictEqual(
      view.store_connections[0].unavailable_fields,
      ['shop_name', 'shop_id', 'listing_active_count', 'digital_listing_count']
    );
  });

  test('this test file is registered with the runner', () => {
    assert.ok(require('./runAllTests').TEST_FILES.includes('etsyOwnerReadOnlyStatus.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
