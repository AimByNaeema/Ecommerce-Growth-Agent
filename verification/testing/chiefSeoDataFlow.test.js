'use strict';

// CHIEF -> SEO DATA FLOW - real production gap after the objective-routing fix.
//
// THE GAP. "Check products, inventory, orders, SEO/listing quality ..." routed to Product,
// SEO and Analytics. Product and Analytics read the real store; SEO stopped with
//   'SEO quality check' needs real, structured input ... listingRecord
// because its checker audits a listing record and nothing relayed the store's listings to it.
//
// THE FIX, AND WHAT THESE TESTS PIN:
//   1. The existing read-only getProducts() also reads description and seo {title description}.
//   2. product_data_retrieval relays each product's real listing fields (listing_sources)
//      beside its unchanged product records - no second Shopify call.
//   3. crossAgentContext's Product -> SEO flow turns each into one listing record, copying
//      only what the store holds, and names every field it could not supply.
//   4. seo_quality_check audits every record with the same checker; the stop-for-missing-
//      evidence gate still fires when no real listing data exists.
//   5. Nothing on this path can write to Shopify.
//
// NO NETWORK, NO MODEL CALL: global.fetch fails the run except inside the one mocked-fetch
// test of the read query itself, Shopify reads are fixtures, every write path is a tripwire.

const assert = require('node:assert');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

const originalFetch = global.fetch;
const FETCH_CALLS = [];
const bannedFetch = async (url) => { FETCH_CALLS.push(String(url)); throw new Error('NETWORK CALL ATTEMPTED: ' + url); };
global.fetch = bannedFetch;

const STUBBED = ['isConfigured', 'getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers', 'updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle'];
const originalShopify = {};
for (const fn of STUBBED) originalShopify[fn] = shopifyClient[fn];

// Two real-shaped products: one with a custom SEO title/description, one without (null is
// what Shopify returns when none is set).
const FIXTURE_PRODUCTS = [
  {
    id: 'gid://fixture/Product/1',
    title: 'Watercolor Clipart PNG Bundle',
    handle: 'watercolor-clipart-png-bundle',
    description: 'A bundle of 118 hand-painted watercolor clipart PNG files for crafts, invitations and print projects.',
    seo: { title: 'Watercolor Clipart PNG Bundle | Fixture Studio', description: 'Hand-painted watercolor clipart PNG files for crafts, invitations and print-on-demand projects.' },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['png'],
    variants: [{ id: 'v1', price: '4.99', inventoryQuantity: 0 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/2',
    title: 'Halloween SVG Cut Files',
    handle: 'halloween-svg-cut-files',
    description: 'Spooky SVG cut files.',
    seo: { title: null, description: null },
    status: 'DRAFT', productType: '', vendor: 'Fixture Studio', tags: ['svg'],
    variants: [{ id: 'v2', price: '2.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
];

let productsToReturn = FIXTURE_PRODUCTS;
const READ_CALLS = [];
shopifyClient.isConfigured = () => true;
shopifyClient.getShopInfo = async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' }; };
shopifyClient.getProducts = async () => { READ_CALLS.push('getProducts'); return productsToReturn; };
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

const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { runProductDataRetrievalTool } = require('../../tools/productDataRetrievalTool');
const { runSeoQualityCheckTool } = require('../../tools/seoQualityCheckTool');
const { deriveLiveEvidenceContext } = require('../../agent/core/crossAgentContext');
const { validateListingOptimizationShape, createEmptyListingOptimizationRecord } = require('../../agent/core/listingOptimizationModel');
const { validateProductRecordShape } = require('../../agent/core/productModel');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { getToolById } = require('../../tools/toolRegistry');
const mutationIntent = require('../../agent/core/mutationIntent');
const { createAuditTracker } = require('../../audit/auditTrail');
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

// A plan step exactly as buildPlanStep records a live product_discovery read.
async function productStep() {
  return {
    selected_specialist: { type: 'specialist', id: 'product', title: 'Product' },
    inputs: { capability_id: 'product_discovery', tool_id: 'product_data_retrieval' },
    outputs: await runProductDataRetrievalTool(),
  };
}

function fullyCoveredRecord(reference) {
  const record = createEmptyListingOptimizationRecord(reference);
  record.product_title = 'Insulated Hiking Jacket for Cold Weather Hikes';
  record.description = 'A warm, waterproof shell built for long days outdoors, with a fitted hood and reinforced seams.';
  record.keywords = ['insulated hiking jacket'];
  record.search_intent = 'commercial investigation';
  record.headings = [{ level: 'h1', text: 'Built for Cold-Weather Trails' }];
  record.metadata = {
    meta_title: 'Insulated Hiking Jacket | Store',
    meta_description: 'A warm, waterproof shell for cold-weather hikes, with a fitted hood and reinforced seams for long days outdoors.',
    url_slug: 'insulated-hiking-jacket',
    alt_text: '',
  };
  record.internal_links = [{ anchor_text: 'outdoor apparel collection', target: 'outdoor-apparel' }];
  record.supporting_content = ['Add a cold-weather layering buying guide.'];
  return record;
}
function keywordRecord() {
  const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
  const record = createEmptySeoResearchRecord('insulated hiking jacket');
  record.search_intent = 'commercial investigation';
  return record;
}

const PRODUCTION_REQUEST =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';

(async () => {
  // --- 1. The existing read also reads the real listing text, read-only ---------------

  await testAsync('getProducts reads description and seo {title description} in a read-only query', async () => {
    const saved = {
      domain: process.env.SHOPIFY_STORE_DOMAIN, token: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      id: process.env.SHOPIFY_CLIENT_ID, secret: process.env.SHOPIFY_CLIENT_SECRET,
    };
    shopifyClient.loadEnvOnce();
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push(String(init && init.body));
      const node = {
        id: 'gid://shopify/Product/9', title: 'T', handle: 'h', description: 'Plain text', seo: { title: null, description: 'Meta' },
        status: 'ACTIVE', productType: '', vendor: 'V', tags: [],
        variants: { edges: [] }, collections: { edges: [] }, metafields: { edges: [] },
      };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { products: { edges: [{ node }] } } }) };
    };
    try {
      const [product] = await originalShopify.getProducts();
      assert.strictEqual(product.description, 'Plain text');
      assert.deepStrictEqual(product.seo, { title: null, description: 'Meta' });
      const query = JSON.parse(bodies[0]).query;
      assert.ok(/\bdescription\b/.test(query) && /seo\s*\{\s*title\s+description\s*\}/.test(query), 'fields not queried');
      assert.ok(!/\bmutation\b/i.test(query), 'the read query must never contain a mutation');
    } finally {
      global.fetch = bannedFetch;
      for (const [key, name] of [['domain', 'SHOPIFY_STORE_DOMAIN'], ['token', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN'], ['id', 'SHOPIFY_CLIENT_ID'], ['secret', 'SHOPIFY_CLIENT_SECRET']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
      }
    }
  });

  // --- 2. product_data_retrieval relays real listing fields, records unchanged ---------

  await testAsync('product_data_retrieval relays each product\'s real listing fields beside unchanged product records', async () => {
    const outcome = await runProductDataRetrievalTool();
    assert.strictEqual(outcome.status, 'success');
    for (const record of outcome.result) assert.ok(validateProductRecordShape(record).valid, 'product record shape changed');
    assert.deepStrictEqual(outcome.listing_sources[0], {
      product_reference: 'Watercolor Clipart PNG Bundle',
      shopify_product_id: 'gid://fixture/Product/1',
      unavailable_fields: [],
      title: 'Watercolor Clipart PNG Bundle',
      handle: 'watercolor-clipart-png-bundle',
      description: FIXTURE_PRODUCTS[0].description,
      seo_title: 'Watercolor Clipart PNG Bundle | Fixture Studio',
      seo_description: FIXTURE_PRODUCTS[0].seo.description,
    });
    // No custom SEO value on the store is relayed as empty - what the store holds - not as unavailable.
    assert.strictEqual(outcome.listing_sources[1].seo_title, '');
    assert.deepStrictEqual(outcome.listing_sources[1].unavailable_fields, []);
  });

  await testAsync('a field the read did not return is named unavailable, never blanked silently', async () => {
    productsToReturn = [{ id: 'gid://fixture/Product/3', title: 'Old Read Shape', handle: 'old', status: 'ACTIVE', productType: '', variants: [] }];
    try {
      const outcome = await runProductDataRetrievalTool();
      assert.deepStrictEqual(outcome.listing_sources[0].unavailable_fields, ['description', 'seo_title', 'seo_description']);
    } finally {
      productsToReturn = FIXTURE_PRODUCTS;
    }
  });

  // --- 3. The Product -> SEO relay copies only real data ------------------------------

  await testAsync('RELAY: one listing record per real product, fields copied exactly as the store holds them', async () => {
    const context = deriveLiveEvidenceContext({
      completedSteps: [await productStep()], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check',
    });
    assert.strictEqual(context.listingRecords.length, FIXTURE_PRODUCTS.length);
    const [first, second] = context.listingRecords;
    for (const record of context.listingRecords) assert.ok(validateListingOptimizationShape(record).valid);
    assert.strictEqual(first.product_reference, 'Watercolor Clipart PNG Bundle');
    assert.strictEqual(first.product_title, 'Watercolor Clipart PNG Bundle');
    assert.strictEqual(first.description, FIXTURE_PRODUCTS[0].description);
    assert.deepStrictEqual(first.metadata, {
      meta_title: 'Watercolor Clipart PNG Bundle | Fixture Studio',
      meta_description: FIXTURE_PRODUCTS[0].seo.description,
      url_slug: 'watercolor-clipart-png-bundle',
      alt_text: '',
    });
    assert.strictEqual(second.metadata.meta_title, '');
    // Nothing invented for fields no store product carries.
    for (const record of context.listingRecords) {
      assert.deepStrictEqual(record.keywords, []);
      assert.deepStrictEqual(record.headings, []);
      assert.deepStrictEqual(record.internal_links, []);
      assert.strictEqual(record.search_intent, '');
    }
  });

  await testAsync('RELAY: every field it cannot supply is named with a reason', async () => {
    const context = deriveLiveEvidenceContext({
      completedSteps: [await productStep()], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check',
    });
    const fields = context.listingFieldGaps.not_on_store_product.map((entry) => entry.field);
    assert.deepStrictEqual(fields, ['keywords', 'keyword_usage', 'search_intent', 'structure', 'headings', 'internal_links', 'supporting_content']);
    for (const entry of context.listingFieldGaps.not_on_store_product) assert.ok(entry.reason && entry.reason.length > 10);
    assert.deepStrictEqual(context.listingFieldGaps.not_returned_by_read, []);
    assert.ok(context.listingFieldGaps.empty_means_not_set['metadata.meta_title']);

    productsToReturn = [{ id: 'gid://fixture/Product/3', title: 'Old Read Shape', handle: 'old', status: 'ACTIVE', productType: '', variants: [] }];
    try {
      const partial = deriveLiveEvidenceContext({
        completedSteps: [await productStep()], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check',
      });
      assert.deepStrictEqual(partial.listingFieldGaps.not_returned_by_read, [
        { product_reference: 'Old Read Shape', fields: ['description', 'metadata.meta_title', 'metadata.meta_description'] },
      ]);
    } finally {
      productsToReturn = FIXTURE_PRODUCTS;
    }
  });

  await testAsync('RELAY: nothing is relayed from a failed or empty read, to another capability, or over a caller record', async () => {
    const step = await productStep();
    const failedStep = { ...step, outputs: { status: 'failed', result: null, error: 'x', listing_sources: step.outputs.listing_sources } };
    assert.deepStrictEqual(deriveLiveEvidenceContext({ completedSteps: [failedStep], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check' }), {});
    assert.deepStrictEqual(deriveLiveEvidenceContext({ completedSteps: [], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check' }), {});
    assert.deepStrictEqual(deriveLiveEvidenceContext({ completedSteps: [step], toSpecialistId: 'seo', toCapabilityId: 'keyword_research' }), {});
    assert.deepStrictEqual(
      deriveLiveEvidenceContext({
        completedSteps: [step], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check',
        existingResearchParams: { listingRecord: createEmptyListingOptimizationRecord('caller') },
      }),
      {}
    );
  });

  // --- 4. The SEO tool audits every record with the same checker ---------------------

  test('TOOL: a batch where the required data exists succeeds', () => {
    const outcome = runSeoQualityCheckTool({
      listingRecords: [fullyCoveredRecord('a'), fullyCoveredRecord('b')],
      keywordRecords: [keywordRecord()],
      factualAttributes: ['waterproof'],
    });
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.result.products_checked, 2);
    assert.deepStrictEqual(outcome.result.status_counts, { success: 2, partial: 0, empty: 0, failed: 0 });
    assert.deepStrictEqual(outcome.result.checks.map((check) => check.subject_reference), ['a', 'b']);
  });

  test('TOOL: an invalid record fails only itself, clearly; an empty batch fails clearly', () => {
    const outcome = runSeoQualityCheckTool({ listingRecords: [fullyCoveredRecord('ok'), { not: 'a listing' }] });
    assert.strictEqual(outcome.status, 'partial');
    assert.strictEqual(outcome.result.checks[1].status, 'failed');
    assert.ok(/listingOptimizationModel\.js record/.test(outcome.result.checks[1].error));
    const empty = runSeoQualityCheckTool({ listingRecords: [] });
    assert.strictEqual(empty.status, 'failed');
    assert.ok(/empty/.test(empty.error));
  });

  test('TOOL: a single caller-supplied listingRecord keeps its exact existing behaviour', () => {
    const outcome = runSeoQualityCheckTool({ listingRecord: fullyCoveredRecord('single'), keywordRecords: [keywordRecord()], factualAttributes: ['waterproof'] });
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.result.subject_reference, 'single');
    assert.ok(!('products_checked' in outcome.result));
  });

  test('the capability declares the batch form; the single record stays the required field', () => {
    const contract = getCapabilityTask('seo', 'seo_quality_check').input_contract;
    assert.deepStrictEqual(contract.required, ['listingRecord']);
    assert.ok(contract.optional.includes('listingRecords'));
    assert.ok(contract.optional.includes('listingFieldGaps'));
  });

  // --- 5. Through the real Chief pipeline ---------------------------------------------

  await testAsync('CHIEF: real product data reaches the SEO step, which runs instead of stopping', async () => {
    const mutationsBefore = MUTATION_CALLS.length;
    const approvals = { requests: [] };
    const seo = await orchestratorExecutionContract.buildPlanStep(
      orchestratorExecutionContract.buildSpecialistTarget('seo'),
      PRODUCTION_REQUEST, 'SEO/listing quality', { tokensUsedThisRun: 0 }, null,
      [await productStep()], approvals, createAuditTracker('seo-flow')
    );
    assert.deepStrictEqual(seo.tool_calls, ['seo_quality_check']);
    assert.notStrictEqual(seo.outputs && seo.outputs.status, undefined, 'the tool never ran');
    assert.strictEqual(seo.outputs.result.products_checked, FIXTURE_PRODUCTS.length);
    const firstCheck = seo.outputs.result.checks[0];
    assert.strictEqual(firstCheck.subject_reference, 'Watercolor Clipart PNG Bundle');
    assert.ok(firstCheck.result.findings.some((finding) => /meta_title is present/.test(finding)), 'real SEO title was not audited');
    assert.strictEqual(approvals.requests.length, 0);
    assert.strictEqual(MUTATION_CALLS.length - mutationsBefore, 0);
  });

  await testAsync('CHIEF: with no real listing data the SEO step still stops clearly, naming listingRecord', async () => {
    const seo = await orchestratorExecutionContract.buildPlanStep(
      orchestratorExecutionContract.buildSpecialistTarget('seo'),
      PRODUCTION_REQUEST, 'SEO/listing quality', { tokensUsedThisRun: 0 }, null, [], { requests: [] }, createAuditTracker('seo-no-data')
    );
    assert.strictEqual(seo.outputs, null, 'the tool must not be dispatched without evidence');
    assert.ok(seo.errors.some((error) => /listingRecord/.test(error.message || error)), JSON.stringify(seo.errors));
  });

  await testAsync('CHIEF: the exact production request audits every real product, read-only', async () => {
    const readsBefore = READ_CALLS.length;
    const result = await orchestratorExecutionContract.runOrchestratorContract(PRODUCTION_REQUEST);
    assert.strictEqual(result.routing.status, 'planned');
    const steps = result.routing.plan;
    assert.deepStrictEqual(steps.map((step) => step.selected_specialist.id), ['product', 'seo', 'analytics_optimization']);
    const seo = steps.find((step) => step.selected_specialist.id === 'seo');
    assert.ok(!(seo.errors || []).some((error) => /needs real, structured input/.test(error.message || error)), 'SEO still blocked on missing input');
    assert.strictEqual(seo.outputs.result.products_checked, FIXTURE_PRODUCTS.length);
    assert.deepStrictEqual(
      seo.outputs.result.checks.map((check) => check.result.specialized_records.listing_record.product_title),
      FIXTURE_PRODUCTS.map((product) => product.title)
    );
    // One Shopify product read serves both Product and SEO.
    assert.strictEqual(READ_CALLS.slice(readsBefore).filter((call) => call === 'getProducts').length, 1);
    assert.deepStrictEqual(MUTATION_CALLS, []);
    assert.strictEqual((result.pending_approvals || []).length, 0);
    assert.deepStrictEqual(FETCH_CALLS, []);
    assert.deepStrictEqual(describeChiefResultForOwner({ result, runId: 'seo-flow' }).mutations, []);
  });

  // --- 6. No Shopify write is possible on the SEO path --------------------------------

  test('NO WRITE PATH: seo_quality_check is a read, analysis-only tool that reaches no store', () => {
    const tool = getToolById('seo_quality_check');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(TOOL_CLASSIFICATIONS.seo_quality_check, 'analysis_only');
    assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'seo_quality_check' }).approval_required, false);
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'tools', 'seoQualityCheckTool.js'), 'utf8');
    assert.ok(!/shopifyClient|integrations\//.test(source.split('if (require.main === module)')[0]), 'the SEO tool must not import a store client');
  });

  test('NO WRITE PATH: the SEO specialist is denied every Shopify correction tool', () => {
    for (const toolId of mutationIntent.CORRECTION_TOOL_IDS) {
      assert.notStrictEqual(checkToolAccess({ specialistId: 'seo', toolId }).decision, 'allowed', `seo may use ${toolId}`);
    }
  });

  test('NO WRITE FUNCTION WAS CALLED ANYWHERE IN THIS FILE', () => {
    assert.deepStrictEqual(MUTATION_CALLS, []);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('chiefSeoDataFlow.test.js'));
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  restore();
  console.error('Test harness error:', err);
  process.exit(1);
});
