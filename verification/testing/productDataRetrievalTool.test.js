'use strict';

const assert = require('node:assert');
const { retrieveProductData, mapShopifyProductToCandidate } = require('../../tools/productDataRetrievalTool');
const { discoverProducts } = require('../../agent/core/productAgent');

// retrieveProductData() tests mock global.fetch, same pattern as
// verification/testing/shopifyClient.test.js - no real network call is ever made.

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

function withEnvConfigured(fn) {
  const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    });
}

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
    });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status text',
    json: async () => body,
  };
}

const SAMPLE_PRODUCT_GRAPHQL_NODE = {
  id: 'gid://shopify/Product/1',
  title: 'Insulated Jacket',
  handle: 'insulated-jacket',
  status: 'ACTIVE',
  productType: 'Outerwear',
  vendor: 'Acme',
  tags: ['winter'],
  variants: { edges: [{ node: { id: 'v1', title: 'Default', sku: 'JCK-001', price: '89.00', inventoryQuantity: 12, availableForSale: true } }] },
  collections: { edges: [{ node: { id: 'c1', title: 'Winter Wear' } }] },
  metafields: { edges: [{ node: { namespace: 'custom', key: 'material', value: 'recycled polyester' } }] },
};

(async () => {
  await testAsync('retrieveProductData passes through a mocked getProducts result unchanged', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { products: { edges: [{ node: SAMPLE_PRODUCT_GRAPHQL_NODE }] } } }),
        async () => {
          const products = await retrieveProductData();
          assert.strictEqual(products.length, 1);
          assert.strictEqual(products[0].title, 'Insulated Jacket');
          assert.strictEqual(products[0].variants[0].sku, 'JCK-001');
        }
      )
    );
  });

  await testAsync('retrieveProductData throws exactly what getProducts throws when not configured', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      await assert.rejects(() => retrieveProductData(), /SHOPIFY_STORE_DOMAIN/);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  test('mapShopifyProductToCandidate maps title/category/price/status/source correctly', () => {
    const shopifyProduct = {
      id: 'gid://shopify/Product/1',
      title: 'Insulated Jacket',
      handle: 'insulated-jacket',
      status: 'ACTIVE',
      productType: 'Outerwear',
      variants: [{ sku: 'JCK-001', price: '89.00' }],
    };
    const candidate = mapShopifyProductToCandidate(shopifyProduct);
    assert.deepStrictEqual(candidate, {
      productIdentity: 'Insulated Jacket',
      category: 'Outerwear',
      pricing: { currency: '', cost: '', price: '89.00' },
      availability: 'available',
      source: ['Shopify product gid://shopify/Product/1 (insulated-jacket)'],
      researchStatus: 'researched',
    });
  });

  test('mapShopifyProductToCandidate maps ARCHIVED/DRAFT status honestly, never guessing an unrecognized one', () => {
    const archived = mapShopifyProductToCandidate({ id: 'p2', title: 'B', handle: 'b', status: 'ARCHIVED', productType: '', variants: [] });
    assert.strictEqual(archived.availability, 'discontinued');

    const draft = mapShopifyProductToCandidate({ id: 'p3', title: 'C', handle: 'c', status: 'DRAFT', productType: '', variants: [] });
    assert.strictEqual(draft.availability, 'planned');

    const unknownStatus = mapShopifyProductToCandidate({ id: 'p4', title: 'D', handle: 'd', status: 'SOMETHING_NEW', productType: '', variants: [] });
    assert.strictEqual(unknownStatus.availability, 'unknown');
  });

  test('mapShopifyProductToCandidate handles a product with no variants without inventing a price', () => {
    const candidate = mapShopifyProductToCandidate({ id: 'p5', title: 'E', handle: 'e', status: 'ACTIVE', productType: '', variants: [] });
    assert.strictEqual(candidate.pricing.price, '');
  });

  test('mapShopifyProductToCandidate output passes discoverProducts() end-to-end', () => {
    const candidate = mapShopifyProductToCandidate({
      id: 'gid://shopify/Product/1',
      title: 'Insulated Jacket',
      handle: 'insulated-jacket',
      status: 'ACTIVE',
      productType: 'Outerwear',
      variants: [{ sku: 'JCK-001', price: '89.00' }],
    });
    const [record] = discoverProducts([candidate]);
    assert.strictEqual(record.product_identity, 'Insulated Jacket');
    assert.strictEqual(record.category, 'Outerwear');
    assert.strictEqual(record.pricing.price, '89.00');
    assert.strictEqual(record.availability, 'available');
    assert.deepStrictEqual(record.source, ['Shopify product gid://shopify/Product/1 (insulated-jacket)']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
