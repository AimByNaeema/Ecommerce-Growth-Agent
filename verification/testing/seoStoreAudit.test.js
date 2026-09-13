'use strict';

// SEO STORE AUDIT - the SEO specialist failure from the Dashboard Chief test.
//
// THE FAILURE. "Analyse my Shopify store using real Shopify data. Check products, inventory,
// orders, SEO/listing quality, and sales opportunities. ..." -> Product SUCCESS, Analytics
// SUCCESS, SEO FAILED ("Required information is missing or not yet available."), Chief PARTIAL.
//
// ROOT CAUSE. The SEO step did run over every real product - but:
//   1. seoQualityChecker.js reaches 'success' only when all 9 dimensions pass, and five of them
//      (keyword targeting, search intent, product accuracy, over-optimization, internal
//      linking), plus parts of content quality and missing information, need keyword
//      research, factual attributes, headings or links that NO store product carries. A real
//      store listing could never succeed, and "keywords is missing" was reported as a finding.
//   2. The batch tool returned that listing-quality verdict as its RUN status ('partial'),
//      which the orchestrator reads as "evidence missing" -> step blocked -> dashboard FAILED.
//   3. The Product -> SEO relay already declared the fields with no store source
//      (listingFieldGaps), but nothing downstream used the declaration.
//
// THE FIX, pinned here: the relay's declaration reaches the checker, which reports those checks
// as NOT ASSESSED with the reason (never as failed, never as invented data); the batch status
// reports the AUDIT (did every product get audited on its real data), and the verdict -
// listings passing / needing attention, findings, recommendations - lives in the result.
//
// Every request goes through the Dashboard's own path (POST /session + /session/:id/message on
// the real server and the real Chief). NO NETWORK, NO MODEL CALL, NO STORE WRITE.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const [env, name] of [
  ['RUN_HISTORY_STORE_DIR', 'runs'],
  ['APPROVAL_STORE_DIR', 'approvals'],
  ['VERIFICATION_STORE_DIR', 'verifications'],
  ['COMMAND_CENTER_SESSION_DIR', 'sessions'],
  ['SCHEDULE_STORE_DIR', 'schedules'],
  ['SNAPSHOT_STORE_DIR', 'snapshots'],
  ['CIRCUIT_BREAKER_STORE_DIR', 'circuits'],
  ['MEMORY_STORE_DIR', 'memory'],
]) {
  process.env[env] = fs.mkdtempSync(path.join(os.tmpdir(), `seo-store-audit-${name}-`));
}
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
delete process.env.VERCEL;
// Hermetic wherever it runs: the provider clients never overwrite an already-set variable when
// they load .env, so empty values keep every external provider unconfigured.
for (const key of [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY',
  'ETSY_API_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_OAUTH_REFRESH_TOKEN', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID',
  'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
]) {
  process.env[key] = '';
}

const FETCH_CALLS = [];
const originalFetch = global.fetch;
global.fetch = async (url) => {
  FETCH_CALLS.push(String(url));
  throw new Error(`NETWORK CALL ATTEMPTED: ${url}`);
};

const shopifyClient = require('../../integrations/adapters/shopifyClient');

// Three listings in the shapes a real store has: one complete, one with no custom SEO fields and
// thin content, one unpublished draft with no description.
const FIXTURE_PRODUCTS = [
  {
    id: 'gid://fixture/Product/1', title: 'Watercolor Clipart PNG Bundle', handle: 'watercolor-clipart-png-bundle',
    description: 'A bundle of 118 hand-painted watercolor clipart PNG files for crafts, invitations and print projects.',
    seo: { title: 'Watercolor Clipart PNG Bundle | Fixture Studio', description: 'Hand-painted watercolor clipart PNG files for crafts, invitations and print-on-demand projects.' },
    status: 'ACTIVE', productType: 'Clipart', vendor: 'Fixture Studio', tags: ['png', 'watercolor'],
    variants: [{ id: 'v1', price: '4.99', inventoryQuantity: 5 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/2', title: 'Halloween SVG Cut Files', handle: 'halloween-svg-cut-files',
    description: 'Spooky SVG cut files.', seo: { title: null, description: null },
    status: 'ACTIVE', productType: '', vendor: 'Fixture Studio', tags: [],
    variants: [{ id: 'v2', price: '2.99', inventoryQuantity: 3 }], collections: [], metafields: [],
  },
  {
    id: 'gid://fixture/Product/3', title: 'Christmas Invitation Template', handle: 'christmas-invitation-template',
    description: '', seo: null,
    status: 'DRAFT', productType: 'Template', vendor: 'Fixture Studio', tags: ['christmas'],
    variants: [{ id: 'v3', price: '6.99', inventoryQuantity: 12 }], collections: [], metafields: [],
  },
];
const FIXTURE_ORDERS = [
  { id: 'gid://fixture/Order/1', createdAt: '2026-09-01T00:00:00Z', totalPrice: '4.99', currency: 'USD', lineItems: [] },
  { id: 'gid://fixture/Order/2', createdAt: '2026-09-05T00:00:00Z', totalPrice: '9.98', currency: 'USD', lineItems: [] },
];

let productsToReturn = FIXTURE_PRODUCTS;
const READ_CALLS = [];
const WRITE_CALLS = [];
const originalShopify = {};
function substitute(name, fn) {
  originalShopify[name] = shopifyClient[name];
  shopifyClient[name] = fn;
}
substitute('isConfigured', () => true);
substitute('getShopInfo', async () => { READ_CALLS.push('getShopInfo'); return { name: 'Fixture Store', domain: 'fixture.example', email: null, apiVersion: 'fixture' }; });
substitute('getProducts', async () => { READ_CALLS.push('getProducts'); return productsToReturn; });
substitute('getCollections', async () => { READ_CALLS.push('getCollections'); return []; });
substitute('getInventoryLevels', async () => { READ_CALLS.push('getInventoryLevels'); return []; });
substitute('getOrders', async () => { READ_CALLS.push('getOrders'); return FIXTURE_ORDERS; });
substitute('getCustomers', async () => { READ_CALLS.push('getCustomers'); return []; });
for (const name of Object.keys(shopifyClient)) {
  if (typeof shopifyClient[name] !== 'function' || name in originalShopify) continue;
  if (/^(update|create|add|adjust|delete|remove|set|publish|write|mutate)/i.test(name)) {
    substitute(name, async () => {
      WRITE_CALLS.push(name);
      throw new Error(`STORE WRITE TRIPWIRE: ${name}`);
    });
  }
}

const { runProductDataRetrievalTool } = require('../../tools/productDataRetrievalTool');
const { runSeoQualityCheckTool } = require('../../tools/seoQualityCheckTool');
const { deriveLiveEvidenceContext } = require('../../agent/core/crossAgentContext');
const { checkSeoQualityOnAvailableData, checkSeoQuality } = require('../../agent/core/seoQualityChecker');
const { createEmptyListingOptimizationRecord } = require('../../agent/core/listingOptimizationModel');
const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
const { validateSeoQualityCheckShape } = require('../../agent/core/seoQualityCheckModel');
const contract = require('../../agent/core/orchestratorExecutionContract');
const { createApp } = require('../../server');

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

function request(port, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${TEST_API_KEY}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (err) { json = null; }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function askChief(port, message) {
  const created = await request(port, { method: 'POST', path: '/session', body: { goal: message } });
  assert.strictEqual(created.status, 200, created.raw.slice(0, 200));
  const turn = await request(port, { method: 'POST', path: `/session/${encodeURIComponent(created.body.session_id)}/message`, body: { message } });
  assert.strictEqual(turn.status, 200, turn.raw.slice(0, 300));
  const history = await request(port, { method: 'GET', path: `/history/${encodeURIComponent(turn.body.run_id)}` });
  assert.strictEqual(history.status, 200);
  const record = history.body.record || history.body;
  return { turn: turn.body, result: record.result, plan: record.result.routing.plan };
}

async function storeAuditParams() {
  const productStep = {
    selected_specialist: { type: 'specialist', id: 'product', title: 'Product' },
    inputs: { capability_id: 'product_discovery', tool_id: 'product_data_retrieval' },
    outputs: await runProductDataRetrievalTool(),
  };
  return deriveLiveEvidenceContext({ completedSteps: [productStep], toSpecialistId: 'seo', toCapabilityId: 'seo_quality_check' });
}

const EXACT_REQUEST =
  'Analyse my Shopify store using real Shopify data. Check products, inventory, orders, SEO/listing quality, and sales opportunities. Identify the 10 highest-priority opportunities and recommend what should be done first. Do not make any changes.';

// The dimensions whose inputs no Shopify product carries.
const NO_STORE_SOURCE_DIMENSIONS = ['keyword_targeting', 'search_intent', 'product_accuracy', 'over_optimization', 'internal_linking_opportunities'];
// Findings that would claim a listing lacks something no store product can have.
const FALSE_STORE_GAPS = /keywords is missing|headings is missing|No target keywords were supplied|No search intent is set|No internal links are suggested|No structure or headings are suggested|No supporting content ideas|No factual attributes were supplied/;

(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    // --- 1. The exact Dashboard request ------------------------------------------------------

    let dashboard = null;
    await testAsync('EXACT DASHBOARD REQUEST: Product, SEO and Analytics all complete - SEO no longer fails', async () => {
      dashboard = await askChief(port, EXACT_REQUEST);
      assert.deepStrictEqual(dashboard.plan.map((step) => step.selected_specialist.id), ['product', 'seo', 'analytics_optimization']);
      for (const step of dashboard.plan) {
        assert.strictEqual(step.completion_state, 'complete', `${step.selected_specialist.id} is ${step.completion_state}: ${JSON.stringify(step.errors)}`);
      }
      const seo = dashboard.plan[1];
      assert.deepStrictEqual(seo.tool_calls, ['seo_quality_check']);
      assert.strictEqual(seo.outputs.status, 'success');
      assert.ok(!/Required information is missing/.test(JSON.stringify(dashboard.turn)), 'the missing-data failure is still shown');
    });

    await testAsync('EXACT DASHBOARD REQUEST: the Chief produces the combined result, with no approval and no store write', async () => {
      assert.strictEqual(dashboard.turn.owner_view.status, 'success', dashboard.turn.owner_view.status);
      assert.deepStrictEqual(dashboard.turn.owner_view.specialists_used, ['Product', 'SEO', 'Analytics & Optimization']);
      assert.strictEqual((dashboard.result.pending_approvals || []).length, 0);
      assert.deepStrictEqual(dashboard.turn.owner_view.mutations, []);
      assert.deepStrictEqual(WRITE_CALLS, []);
      assert.ok(READ_CALLS.includes('getProducts') && READ_CALLS.includes('getOrders'));
    });

    test('EXACT DASHBOARD REQUEST: SEO audits every real product and says what it found and what it could not assess', () => {
      const result = dashboard.plan[1].outputs.result;
      assert.strictEqual(result.products_checked, FIXTURE_PRODUCTS.length);
      assert.strictEqual(result.listings_passing, 1);
      assert.strictEqual(result.listings_needing_attention, 2);
      assert.deepStrictEqual(result.not_assessed.map((entry) => entry.dimension).sort(), [...NO_STORE_SOURCE_DIMENSIONS].sort());
      for (const entry of result.not_assessed) assert.ok(entry.reason.length > 20 && entry.products === FIXTURE_PRODUCTS.length, JSON.stringify(entry));
      assert.ok(/Audited 3 of 3/.test(result.summary), result.summary);
      assert.ok(/Not assessed/.test(result.summary) && /Keyword targeting/.test(result.summary), result.summary);
      // The step's own plain-language summary is the audit, not "missing data".
      assert.ok(/Audited 3 of 3/.test(JSON.stringify(dashboard.turn.owner_view)), 'the owner view does not carry the SEO audit summary');
    });

    test('REAL FINDINGS ONLY: real gaps are reported, gaps no store product can fill are never claimed', () => {
      const { checks } = dashboard.plan[1].outputs.result;
      for (const check of checks) {
        assert.ok(validateSeoQualityCheckShape(check.result).valid, 'the check record changed shape');
        const claims = [...check.result.findings, ...check.result.recommendations].filter((text) => FALSE_STORE_GAPS.test(text));
        assert.deepStrictEqual(claims, [], `${check.subject_reference} claims a gap the store cannot have`);
      }
      const [complete, noSeo, draft] = checks;
      assert.strictEqual(complete.status, 'success');
      assert.ok(noSeo.result.recommendations.includes('[Metadata] Add a meta_title.'), 'a real missing SEO title was not reported');
      assert.ok(noSeo.result.recommendations.some((text) => /expanding the description/.test(text)), 'thin description not reported');
      assert.ok(noSeo.store_listing.recommendations.some((text) => /product type/.test(text)));
      assert.ok(noSeo.store_listing.recommendations.some((text) => /tags/.test(text)));
      assert.ok(draft.store_listing.findings.some((text) => /DRAFT - it is not published/.test(text)), 'an unpublished product was not reported');
      assert.ok(draft.result.recommendations.includes('[Content quality] Add a description.'));
    });

    // --- 2. Genuinely unavailable fields degrade to "not assessed", never to failure or a claim

    await testAsync('UNAVAILABLE: a field the store read did not return is not assessed for that product - not failed, not "missing"', async () => {
      productsToReturn = [{ id: 'gid://fixture/Product/9', title: 'Old Read Shape Product', handle: 'old-read-shape', status: 'ACTIVE', variants: [] }];
      try {
        const params = await storeAuditParams();
        const outcome = runSeoQualityCheckTool(params);
        assert.strictEqual(outcome.status, 'success');
        const [check] = outcome.result.checks;
        assert.ok(!check.result.recommendations.includes('[Metadata] Add a meta_title.'), 'an unread field was reported as missing');
        assert.ok(!check.result.recommendations.includes('[Content quality] Add a description.'), 'an unread description was reported as missing');
        assert.ok(check.result.findings.some((text) => /meta_title not assessed: The store read did not return this field/.test(text)));
        // Unread store fields are named, never guessed.
        assert.deepStrictEqual(check.store_listing.not_assessed.map((entry) => entry.field), ['product_type', 'vendor', 'tags']);
      } finally {
        productsToReturn = FIXTURE_PRODUCTS;
      }
    });

    await testAsync('UNAVAILABLE: image alt text is declared as not read, and appears in the summary', async () => {
      const params = await storeAuditParams();
      assert.deepStrictEqual(params.listingFieldGaps.not_requested_by_read.map((entry) => entry.field), ['metadata.alt_text']);
      assert.deepStrictEqual(params.listingFieldGaps.inputs_without_store_source.map((entry) => entry.field), ['keywordRecords', 'factualAttributes']);
      assert.ok(/Not read from the store: metadata\.alt_text/.test(runSeoQualityCheckTool(params).result.summary));
    });

    await testAsync('HONEST: a declaration can never hide data that WAS supplied - supplied keywords are always checked', async () => {
      const params = await storeAuditParams();
      const keyword = createEmptySeoResearchRecord('watercolor clipart');
      const outcome = runSeoQualityCheckTool({ ...params, keywordRecords: [keyword] });
      const [complete] = outcome.result.checks;
      assert.ok(!complete.not_assessed.some((entry) => entry.dimension === 'keyword_targeting'), 'supplied keywords were masked');
      assert.strictEqual(complete.result.dimension_status.keyword_targeting, 'success');
    });

    test('HONEST: without a declaration the checker behaves exactly as before', () => {
      const listingRecord = createEmptyListingOptimizationRecord('plain');
      listingRecord.product_title = 'Insulated Hiking Jacket For Cold Trails';
      const before = checkSeoQuality({ listingRecord, researchDate: '2026-09-14' });
      const after = checkSeoQualityOnAvailableData({ listingRecord, researchDate: '2026-09-14' });
      assert.deepStrictEqual(after.check, before);
      assert.deepStrictEqual(after.not_assessed, []);
    });

    test('HONEST: an unavailability declaration without a reason is refused', () => {
      assert.throws(
        () => checkSeoQualityOnAvailableData({ listingRecord: createEmptyListingOptimizationRecord('x'), unavailableInputs: [{ field: 'keywordRecords' }] }),
        /non-empty reason/
      );
    });

    // --- 3. The audit status still fails honestly when products genuinely cannot be audited ----

    test('AUDIT STATUS: one invalid record makes the audit partial; no auditable record makes it failed', () => {
      const good = createEmptyListingOptimizationRecord('good');
      good.product_title = 'Watercolor Clipart PNG Bundle';
      const mixed = runSeoQualityCheckTool({ listingRecords: [good, { not: 'a listing' }] });
      assert.strictEqual(mixed.status, 'partial');
      assert.strictEqual(mixed.result.checks[1].status, 'failed');
      assert.ok(/could not be audited/.test(mixed.result.summary));
      assert.strictEqual(runSeoQualityCheckTool({ listingRecords: [{ bad: 1 }, { bad: 2 }] }).status, 'failed');
      assert.strictEqual(contract.validateResult({ status: 'success', data: mixed }), 'unverified');
    });

    await testAsync('AUDIT STATUS: a completed store audit validates as passed in the orchestrator', async () => {
      const params = await storeAuditParams();
      assert.strictEqual(contract.validateResult({ status: 'success', data: runSeoQualityCheckTool(params) }), 'passed');
    });

    // --- 4. Global guarantees -------------------------------------------------------------------

    test('NO NETWORK CALL WAS MADE', () => {
      assert.deepStrictEqual(FETCH_CALLS, []);
    });

    test('NO SHOPIFY WRITE FUNCTION WAS CALLED', () => {
      assert.deepStrictEqual(WRITE_CALLS, []);
    });

    test('this test file is registered in the suite runner', () => {
      const { TEST_FILES } = require('./runAllTests');
      assert.ok(TEST_FILES.includes('seoStoreAudit.test.js'));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    for (const [name, fn] of Object.entries(originalShopify)) shopifyClient[name] = fn;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
