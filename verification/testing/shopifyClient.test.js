'use strict';

const assert = require('node:assert');
const {
  getShopInfo,
  getProducts,
  isConfigured,
  loadEnvOnce,
  DEFAULT_API_VERSION,
} = require('../../integrations/adapters/shopifyClient');

// getProducts() tests below mock global.fetch (save/restore in `finally`, same
// convention as the env-var save/restore already used throughout this file) - no real
// network call is ever made. There is no existing example of this in the codebase
// yet, so these are the first; the pattern is intentionally minimal (no library, no
// new dependency).

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
  tags: ['winter', 'jackets'],
  variants: {
    edges: [
      {
        node: {
          id: 'gid://shopify/ProductVariant/1',
          title: 'Default',
          sku: 'JCK-001',
          price: '89.00',
          inventoryQuantity: 12,
          availableForSale: true,
        },
      },
    ],
  },
  collections: { edges: [{ node: { id: 'gid://shopify/Collection/1', title: 'Winter Wear' } }] },
  metafields: { edges: [{ node: { namespace: 'custom', key: 'material', value: 'recycled polyester' } }] },
};

// This test never makes a real network call - it only checks the connection
// layer's structure and its error handling, matching the project's convention of
// never inventing a result. Whether SHOPIFY_STORE_DOMAIN/SHOPIFY_ADMIN_API_ACCESS_TOKEN
// are actually set is environment-dependent, so every env-var test below
// saves/restores them rather than assuming either state.

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

test('exports the expected connection-layer functions and constants', () => {
  assert.strictEqual(typeof getShopInfo, 'function');
  assert.strictEqual(typeof isConfigured, 'function');
  assert.strictEqual(typeof loadEnvOnce, 'function');
  assert.strictEqual(typeof DEFAULT_API_VERSION, 'string');
  assert.ok(DEFAULT_API_VERSION.trim() !== '');
});

(async () => {
  await testAsync('isConfigured is false when SHOPIFY_STORE_DOMAIN is missing', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    try {
      assert.strictEqual(isConfigured(), false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('isConfigured is false when SHOPIFY_ADMIN_API_ACCESS_TOKEN is missing', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      assert.strictEqual(isConfigured(), false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('isConfigured is true when both env vars are set', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    try {
      assert.strictEqual(isConfigured(), true);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('getShopInfo rejects clearly when not configured', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      assert.strictEqual(isConfigured(), false);
      await assert.rejects(() => getShopInfo(), /SHOPIFY_STORE_DOMAIN/);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('getProducts rejects clearly when not configured, without calling fetch', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    let fetchCalled = false;
    try {
      await withMockedFetch(
        async () => {
          fetchCalled = true;
          throw new Error('fetch should never be called when not configured');
        },
        () => assert.rejects(() => getProducts(), /SHOPIFY_STORE_DOMAIN/)
      );
      assert.strictEqual(fetchCalled, false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('getProducts normalizes a successful mocked response (products/variants/collections/metafields)', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { products: { edges: [{ node: SAMPLE_PRODUCT_GRAPHQL_NODE }] } } }),
        async () => {
          const products = await getProducts();
          assert.strictEqual(products.length, 1);
          const [product] = products;
          assert.strictEqual(product.id, 'gid://shopify/Product/1');
          assert.strictEqual(product.title, 'Insulated Jacket');
          assert.strictEqual(product.status, 'ACTIVE');
          assert.deepStrictEqual(product.tags, ['winter', 'jackets']);
          assert.strictEqual(product.variants.length, 1);
          assert.strictEqual(product.variants[0].sku, 'JCK-001');
          assert.strictEqual(product.variants[0].price, '89.00');
          assert.strictEqual(product.variants[0].inventoryQuantity, 12);
          assert.strictEqual(product.collections.length, 1);
          assert.strictEqual(product.collections[0].title, 'Winter Wear');
          assert.strictEqual(product.metafields.length, 1);
          assert.strictEqual(product.metafields[0].key, 'material');
        }
      )
    );
  });

  await testAsync('getProducts throws when the mocked response carries GraphQL errors', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }),
        () => assert.rejects(() => getProducts(), /GraphQL errors/)
      )
    );
  });

  await testAsync('getProducts throws when the mocked response is a non-ok HTTP status', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(500, { errors: [{ message: 'Internal error' }] }),
        () => assert.rejects(() => getProducts(), /request failed \(500\)/)
      )
    );
  });

  await testAsync('getProducts throws when the mocked response is missing product data', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: {} }),
        () => assert.rejects(() => getProducts(), /did not include product data/)
      )
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
