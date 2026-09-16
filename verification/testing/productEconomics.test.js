'use strict';

// PRODUCT UNIT ECONOMICS - agent/core/productEconomics.js, the recorded unit-cost read
// (integrations/adapters/shopifyClient.js's getProductUnitCosts) and the Chief's product read
// (tools/productDataRetrievalTool.js's product_economics).
//
// PINS THE RULES: a selling price is not profit; a missing cost, fee, shipping cost or currency is UNKNOWN (never
// zero, never assumed); different currencies combine only with a supplied exchange rate; a failed cost read never
// fails the product read. NO NETWORK: fetch is mocked or a tripwire; Shopify reads are fixtures; writes are
// tripwires. Engineering verification only - no real store cost is claimed.

const assert = require('node:assert');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { computeUnitEconomics, hasEconomicsIntent } = require('../../agent/core/productEconomics');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

const usd = (amount) => ({ amount, currency: 'USD' });

(async () => {
  test('COMPLETE INPUTS: every figure is computed exactly', () => {
    const e = computeUnitEconomics({
      price: usd('40.00'),
      unitCost: usd('12.50'),
      inboundShipping: usd(2.5),
      outboundShipping: usd(5),
      fees: [{ name: 'payment processing', type: 'percent', value: 2.9 }, { name: 'per transaction', type: 'fixed', amount: '0.30', currency: 'USD' }],
    });
    assert.strictEqual(e.currency, 'USD');
    assert.strictEqual(e.gross_profit.value, 27.5);
    assert.strictEqual(e.gross_margin_percent.value, 68.75);
    assert.strictEqual(e.landed_cost.value, 15);
    assert.strictEqual(e.total_fees.value, 1.46);
    assert.strictEqual(e.contribution.value, 18.54);
    assert.strictEqual(e.contribution_margin_percent.value, 46.35);
    assert.strictEqual(e.roi_percent.value, 86.39); // 18.54 / (15 + 1.46 + 5)
    for (const key of ['gross_profit', 'landed_cost', 'total_fees', 'contribution', 'roi_percent']) assert.strictEqual(e[key].status, 'KNOWN', key);
  });

  test('SELLING PRICE IS NOT PROFIT: no cost -> gross profit, margin, landed cost, contribution and ROI are UNKNOWN', () => {
    const e = computeUnitEconomics({ price: usd('40.00'), unitCost: null, fees: [], feesConfirmedNone: true, inboundShippingConfirmedNone: true, outboundShippingConfirmedNone: true });
    assert.strictEqual(e.selling_price.value, 40);
    for (const key of ['unit_cost', 'gross_profit', 'gross_margin_percent', 'landed_cost', 'contribution', 'contribution_margin_percent', 'roi_percent']) {
      assert.strictEqual(e[key].status, 'UNKNOWN', key);
      assert.strictEqual(e[key].value, null, `${key} must be null, never 0 or the price`);
      assert.ok(e[key].missing_inputs.some((m) => /unit cost/.test(m)), `${key} names the missing cost`);
    }
  });

  test('MISSING FEE IS NOT ZERO FEE: gross figures known, contribution UNKNOWN; an empty fee list needs confirmation', () => {
    const noFees = computeUnitEconomics({ price: usd(20), unitCost: usd(8), inboundShippingConfirmedNone: true, outboundShippingConfirmedNone: true });
    assert.strictEqual(noFees.gross_profit.value, 12);
    assert.strictEqual(noFees.total_fees.status, 'UNKNOWN');
    assert.strictEqual(noFees.contribution.status, 'UNKNOWN');
    assert.ok(noFees.contribution.missing_inputs.some((m) => /selling fees/.test(m)));
    const emptyUnconfirmed = computeUnitEconomics({ price: usd(20), unitCost: usd(8), fees: [], inboundShippingConfirmedNone: true, outboundShippingConfirmedNone: true });
    assert.strictEqual(emptyUnconfirmed.contribution.status, 'UNKNOWN');
    const confirmed = computeUnitEconomics({ price: usd(20), unitCost: usd(8), fees: [], feesConfirmedNone: true, inboundShippingConfirmedNone: true, outboundShippingConfirmedNone: true });
    assert.strictEqual(confirmed.contribution.value, 12);
  });

  test('MISSING SHIPPING IS NOT FREE SHIPPING: landed cost and contribution UNKNOWN', () => {
    const e = computeUnitEconomics({ price: usd(20), unitCost: usd(8), fees: [], feesConfirmedNone: true });
    assert.strictEqual(e.landed_cost.status, 'UNKNOWN');
    assert.ok(e.landed_cost.missing_inputs.some((m) => /inbound shipping/.test(m)));
    assert.strictEqual(e.contribution.status, 'UNKNOWN');
    assert.ok(e.contribution.missing_inputs.some((m) => /outbound shipping/.test(m)));
  });

  test('MISSING CURRENCY IS NOT AN ASSUMED CURRENCY', () => {
    const noPriceCurrency = computeUnitEconomics({ price: { amount: '20.00', currency: null }, unitCost: usd(8) });
    assert.strictEqual(noPriceCurrency.currency, null);
    assert.strictEqual(noPriceCurrency.selling_price.status, 'UNKNOWN');
    assert.strictEqual(noPriceCurrency.gross_profit.status, 'UNKNOWN');
    const noCostCurrency = computeUnitEconomics({ price: usd(20), unitCost: { amount: '8.00' } });
    assert.strictEqual(noCostCurrency.gross_profit.status, 'UNKNOWN');
    assert.ok(noCostCurrency.gross_profit.missing_inputs.some((m) => /currency/.test(m)));
  });

  test('CURRENCY MISMATCH: never combined without a rate; converted with an explicit rate, and the conversion is recorded', () => {
    const mismatch = computeUnitEconomics({ price: usd(20), unitCost: { amount: 5, currency: 'EUR' } });
    assert.strictEqual(mismatch.gross_profit.status, 'UNKNOWN');
    assert.ok(mismatch.gross_profit.missing_inputs.some((m) => /EUR->USD exchange rate/.test(m)));
    const converted = computeUnitEconomics({ price: usd(20), unitCost: { amount: 5, currency: 'EUR' }, exchangeRates: { 'EUR->USD': 1.1 } });
    assert.strictEqual(converted.gross_profit.value, 14.5);
    assert.deepStrictEqual(converted.currency_conversions, [{ input: 'unit cost', from: 'EUR', to: 'USD', rate: 1.1 }]);
    const reverseOnly = computeUnitEconomics({ price: usd(20), unitCost: { amount: 5, currency: 'EUR' }, exchangeRates: { 'USD->EUR': 0.9 } });
    assert.strictEqual(reverseOnly.gross_profit.status, 'UNKNOWN', 'a rate for the other direction is not inverted by guesswork');
  });

  test('INVALID INPUTS: negative, non-numeric or zero price never produce a figure', () => {
    assert.strictEqual(computeUnitEconomics({ price: usd(-5), unitCost: usd(1) }).gross_profit.status, 'UNKNOWN');
    assert.strictEqual(computeUnitEconomics({ price: usd('free'), unitCost: usd(1) }).gross_profit.status, 'UNKNOWN');
    const zero = computeUnitEconomics({ price: usd(0), unitCost: usd(1) });
    assert.strictEqual(zero.gross_profit.value, -1);
    assert.strictEqual(zero.gross_margin_percent.status, 'UNKNOWN');
    assert.strictEqual(computeUnitEconomics({ price: usd(10), unitCost: usd(1), fees: [{ name: 'x', type: 'bogus' }] }).total_fees.status, 'UNKNOWN');
    assert.strictEqual(computeUnitEconomics().selling_price.status, 'UNKNOWN');
  });

  test('ECONOMICS INTENT: profit/margin/cost questions read costs; other product questions do not', () => {
    for (const text of ['What is my profit margin on my products?', 'Show unit costs and ROI', 'Which products are profitable?', 'landed cost per SKU', 'break-even price']) assert.ok(hasEconomicsIntent(text), text);
    for (const text of ['List my products', 'Review the SEO of my products', 'What is the price of my bundle?']) assert.ok(!hasEconomicsIntent(text), text);
  });

  await testAsync('SHOPIFY COST READ: one read-only query by product id; recorded cost relayed, unrecorded cost null', async () => {
    const saved = { fetch: global.fetch, domain: process.env.SHOPIFY_STORE_DOMAIN, token: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN, id: process.env.SHOPIFY_CLIENT_ID, secret: process.env.SHOPIFY_CLIENT_SECRET };
    shopifyClient.loadEnvOnce();
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      const data = {
        shop: { currencyCode: 'USD' },
        nodes: [
          { id: 'gid://shopify/Product/1', variants: { edges: [
            { node: { id: 'gid://shopify/ProductVariant/11', inventoryItem: { id: 'gid://shopify/InventoryItem/111', unitCost: { amount: '3.25', currencyCode: 'USD' } } } },
            { node: { id: 'gid://shopify/ProductVariant/12', inventoryItem: { id: 'gid://shopify/InventoryItem/112', unitCost: null } } },
          ] } },
          null,
        ],
      };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }), text: async () => JSON.stringify({ data }) };
    };
    try {
      const costs = await shopifyClient.getProductUnitCosts({ productIds: ['gid://shopify/Product/1', 'gid://shopify/Product/404'] });
      assert.strictEqual(costs.shopCurrency, 'USD');
      assert.deepStrictEqual(costs.variants, [
        { productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/11', inventoryItemId: 'gid://shopify/InventoryItem/111', unitCost: { amount: '3.25', currency: 'USD' } },
        { productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/12', inventoryItemId: 'gid://shopify/InventoryItem/112', unitCost: null },
      ]);
      assert.strictEqual(bodies.length, 1);
      assert.ok(!/mutation/i.test(bodies[0].query), 'read-only');
      assert.deepStrictEqual(bodies[0].variables, { ids: ['gid://shopify/Product/1', 'gid://shopify/Product/404'] });
      await assert.rejects(() => shopifyClient.getProductUnitCosts({ productIds: [] }), /non-empty/);
    } finally {
      global.fetch = saved.fetch;
      for (const [key, env] of [['domain', 'SHOPIFY_STORE_DOMAIN'], ['token', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN'], ['id', 'SHOPIFY_CLIENT_ID'], ['secret', 'SHOPIFY_CLIENT_SECRET']]) {
        if (saved[key] === undefined) delete process.env[env];
        else process.env[env] = saved[key];
      }
    }
  });

  // ---- The Chief's product read, end to end, with fixtures and tripwires ----
  const originalFetch = global.fetch;
  const FETCH_CALLS = [];
  global.fetch = async (url) => { FETCH_CALLS.push(String(url)); throw new Error(`NETWORK CALL ATTEMPTED: ${url}`); };
  const STUBBED = ['isConfigured', 'getProducts', 'getProductUnitCosts', 'updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle', 'updateProductSeo'];
  const originalShopify = {};
  for (const fn of STUBBED) originalShopify[fn] = shopifyClient[fn];
  const FIXTURE_PRODUCTS = [
    { id: 'gid://fixture/Product/1', title: 'Watercolor Clipart Bundle', handle: 'watercolor', description: 'd', seo: null, status: 'ACTIVE', productType: 'Clipart', vendor: 'V', tags: [], variants: [{ id: 'gid://fixture/ProductVariant/1', title: 'Default', sku: 'WC-1', price: '4.99' }], collections: [], metafields: [] },
    { id: 'gid://fixture/Product/2', title: 'Printed Tote', handle: 'tote', description: 'd', seo: null, status: 'ACTIVE', productType: 'Bags', vendor: 'V', tags: [], variants: [{ id: 'gid://fixture/ProductVariant/2', title: 'Default', sku: 'TT-1', price: '24.00' }], collections: [], metafields: [] },
  ];
  const READS = [];
  const MUTATIONS = [];
  let costRead = async () => ({ shopCurrency: 'USD', variants: [{ productId: 'gid://fixture/Product/2', variantId: 'gid://fixture/ProductVariant/2', inventoryItemId: 'i2', unitCost: { amount: '9.00', currency: 'USD' } }] });
  shopifyClient.isConfigured = () => true;
  shopifyClient.getProducts = async () => { READS.push('getProducts'); return FIXTURE_PRODUCTS; };
  shopifyClient.getProductUnitCosts = async (args) => { READS.push('getProductUnitCosts'); return costRead(args); };
  for (const fn of ['updateProductVendor', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle', 'updateProductSeo']) {
    shopifyClient[fn] = async () => { MUTATIONS.push(fn); throw new Error(`MUTATION TRIPWIRE: ${fn}`); };
  }
  const contract = require('../../agent/core/orchestratorExecutionContract');
  const { runProductDataRetrievalTool } = require('../../tools/productDataRetrievalTool');

  try {
    await testAsync('CHIEF: "What is my profit margin on my products?" -> Product reads costs; margin only where cost is recorded', async () => {
      const result = await contract.runOrchestratorContract('What is my profit margin on my products?');
      assert.strictEqual(result.routing.status, 'planned', result.routing.reason);
      const step = result.routing.plan.find((s) => (s.tool_calls || []).includes('product_data_retrieval'));
      assert.ok(step, 'the Product read ran');
      const economics = step.outputs.product_economics;
      assert.ok(economics, 'economics attached to the product read');
      assert.strictEqual(economics.currency, 'USD');
      assert.deepStrictEqual(economics.summary, { variants_total: 2, unit_cost_known: 1, unit_cost_unknown: 1, gross_profit_known: 1, contribution_known: 0 });
      const [clipart, tote] = economics.products.map((p) => p.variants[0].economics);
      assert.strictEqual(clipart.gross_profit.value, null, 'no recorded cost -> no margin, never the price');
      assert.strictEqual(clipart.gross_margin_percent.status, 'UNKNOWN');
      assert.strictEqual(tote.gross_profit.value, 15);
      assert.strictEqual(tote.gross_margin_percent.value, 62.5);
      assert.strictEqual(tote.contribution.status, 'UNKNOWN', 'fees and shipping are not in the store data');
      assert.deepStrictEqual(economics.not_supplied, ['selling fees', 'inbound shipping cost', 'outbound shipping cost']);
      assert.ok(READS.includes('getProductUnitCosts'));
      assert.deepStrictEqual(MUTATIONS, []);
      assert.strictEqual((result.pending_approvals || []).length, 0);
      assert.deepStrictEqual(FETCH_CALLS, []);
    });

    await testAsync('NON-ECONOMICS PRODUCT READ: no cost query is made and no economics are attached', async () => {
      const before = READS.length;
      const outcome = await runProductDataRetrievalTool({});
      assert.strictEqual(outcome.status, 'success');
      assert.strictEqual(outcome.product_economics, undefined);
      assert.deepStrictEqual(READS.slice(before), ['getProducts']);
    });

    await testAsync('COST READ FAILS (e.g. missing read_inventory scope): products still read; every cost UNKNOWN with the reason', async () => {
      costRead = async () => { throw new Error('Shopify Admin API returned GraphQL errors: [{"message":"Access denied for unitCost field."}]'); };
      const outcome = await runProductDataRetrievalTool({ unitEconomics: true });
      assert.strictEqual(outcome.status, 'success');
      assert.ok(Array.isArray(outcome.listing_sources) && outcome.listing_sources.length === 2);
      const economics = outcome.product_economics;
      assert.ok(/Access denied/.test(economics.cost_read_error));
      assert.strictEqual(economics.currency, null, 'the shop currency was not read, so it is not assumed');
      assert.strictEqual(economics.summary.unit_cost_known, 0);
      assert.ok(economics.products.every((p) => p.variants.every((v) => v.economics.gross_profit.value === null)));
    });

    await testAsync('CALLER INPUTS: fees and shipping may be supplied; price and unit cost can never be overridden by the caller', async () => {
      costRead = async () => ({ shopCurrency: 'USD', variants: [{ productId: 'gid://fixture/Product/2', variantId: 'gid://fixture/ProductVariant/2', inventoryItemId: 'i2', unitCost: { amount: '9.00', currency: 'USD' } }] });
      const outcome = await runProductDataRetrievalTool({
        unitEconomics: true,
        economicsInputs: {
          price: { amount: 1000, currency: 'USD' },
          unitCost: { amount: 0, currency: 'USD' },
          fees: [{ name: 'payments', type: 'percent', value: 10 }],
          inboundShippingConfirmedNone: true,
          outboundShipping: { amount: 3, currency: 'USD' },
        },
      });
      const tote = outcome.product_economics.products[1].variants[0].economics;
      assert.strictEqual(tote.selling_price.value, 24, 'price comes from the store');
      assert.strictEqual(tote.unit_cost.value, 9, 'cost comes from the store');
      assert.strictEqual(tote.contribution.value, 9.6);
      assert.deepStrictEqual(outcome.product_economics.not_supplied, ['inbound shipping cost']);
    });
  } finally {
    global.fetch = originalFetch;
    for (const fn of STUBBED) shopifyClient[fn] = originalShopify[fn];
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
