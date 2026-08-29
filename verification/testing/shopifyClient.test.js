'use strict';

const assert = require('node:assert');
const {
  getShopInfo,
  getProducts,
  getOrders,
  getCustomers,
  getInventoryLevels,
  getCollections,
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

// Zeroes retry backoff for every retry-scenario test below (agent/core/networkRetry.js)
// so they exercise attempt COUNT/gating, not real wall-clock delay.
function withZeroRetryDelay(fn) {
  const saved = process.env.NETWORK_RETRY_BASE_DELAY_MS;
  process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
      else process.env.NETWORK_RETRY_BASE_DELAY_MS = saved;
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
  assert.strictEqual(typeof getProducts, 'function');
  assert.strictEqual(typeof getOrders, 'function');
  assert.strictEqual(typeof getCustomers, 'function');
  assert.strictEqual(typeof getInventoryLevels, 'function');
  assert.strictEqual(typeof getCollections, 'function');
  assert.strictEqual(typeof isConfigured, 'function');
  assert.strictEqual(typeof loadEnvOnce, 'function');
  assert.strictEqual(typeof DEFAULT_API_VERSION, 'string');
  assert.ok(DEFAULT_API_VERSION.trim() !== '');
});

(async () => {
  await testAsync('isConfigured is false when SHOPIFY_STORE_DOMAIN is missing', async () => {
    // Force the one-time .env load to happen before the delete below - loadEnvOnce()
    // is a no-op on every later call (see integrations/adapters/shopifyClient.js's
    // envLoadAttempted guard), so without this, a real SHOPIFY_STORE_DOMAIN in the
    // local .env file would get (re-)populated by isConfigured()'s own internal
    // loadEnvOnce() call, right after the delete, making this test flake against real
    // local configuration.
    loadEnvOnce();
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

  // --- getOrders --------------------------------------------------------------------

  const SAMPLE_ORDER_GRAPHQL_NODE = {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2026-01-15T10:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
    lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
  };

  await testAsync('getOrders rejects clearly when not configured, without calling fetch', async () => {
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
        () => assert.rejects(() => getOrders(), /SHOPIFY_STORE_DOMAIN/)
      );
      assert.strictEqual(fetchCalled, false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('getOrders normalizes a successful mocked response (id/name/status/total/lineItems)', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { orders: { edges: [{ node: SAMPLE_ORDER_GRAPHQL_NODE }] } } }),
        async () => {
          const orders = await getOrders();
          assert.strictEqual(orders.length, 1);
          const [order] = orders;
          assert.strictEqual(order.id, 'gid://shopify/Order/1');
          assert.strictEqual(order.name, '#1001');
          assert.strictEqual(order.financialStatus, 'PAID');
          assert.strictEqual(order.fulfillmentStatus, 'FULFILLED');
          assert.strictEqual(order.totalPrice, '89.00');
          assert.strictEqual(order.currency, 'USD');
          assert.strictEqual(order.lineItems.length, 1);
          assert.strictEqual(order.lineItems[0].sku, 'JCK-001');
        }
      )
    );
  });

  await testAsync('getOrders throws when the mocked response carries GraphQL errors', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }),
        () => assert.rejects(() => getOrders(), /GraphQL errors/)
      )
    );
  });

  await testAsync('getOrders throws when the mocked response is missing order data', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: {} }),
        () => assert.rejects(() => getOrders(), /did not include order data/)
      )
    );
  });

  // --- getCustomers ------------------------------------------------------------------

  const SAMPLE_CUSTOMER_GRAPHQL_NODE = {
    id: 'gid://shopify/Customer/1',
    numberOfOrders: '3',
    amountSpent: { amount: '267.00', currencyCode: 'USD' },
    state: 'ENABLED',
    tags: ['vip'],
    createdAt: '2025-06-01T00:00:00Z',
  };

  await testAsync('getCustomers requests no PII fields (no name/email/phone/address in the query)', async () => {
    let capturedBody = null;
    await withEnvConfigured(() =>
      withMockedFetch(
        async (url, options) => {
          capturedBody = JSON.parse(options.body);
          return jsonResponse(200, { data: { customers: { edges: [] } } });
        },
        () => getCustomers()
      )
    );
    const query = capturedBody.query.toLowerCase();
    assert.ok(!query.includes('email'), 'query must not request email');
    assert.ok(!query.includes('phone'), 'query must not request phone');
    assert.ok(!query.includes('displayname'), 'query must not request displayName');
    assert.ok(!query.includes('address'), 'query must not request address');
  });

  await testAsync('getCustomers normalizes a successful mocked response into non-PII fields only', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { customers: { edges: [{ node: SAMPLE_CUSTOMER_GRAPHQL_NODE }] } } }),
        async () => {
          const customers = await getCustomers();
          assert.strictEqual(customers.length, 1);
          const [customer] = customers;
          assert.strictEqual(customer.id, 'gid://shopify/Customer/1');
          assert.strictEqual(customer.ordersCount, '3');
          assert.strictEqual(customer.amountSpent, '267.00');
          assert.strictEqual(customer.currency, 'USD');
          assert.strictEqual(customer.state, 'ENABLED');
          assert.deepStrictEqual(customer.tags, ['vip']);
          assert.deepStrictEqual(Object.keys(customer).sort(), ['amountSpent', 'createdAt', 'currency', 'id', 'ordersCount', 'state', 'tags'].sort());
        }
      )
    );
  });

  await testAsync('getCustomers throws (does not swallow) a GraphQL access-denied error - the caller decides how to degrade', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Access denied for customers field.' }] }),
        () => assert.rejects(() => getCustomers(), /GraphQL errors/)
      )
    );
  });

  // --- getInventoryLevels --------------------------------------------------------------

  const SAMPLE_INVENTORY_ITEM_GRAPHQL_NODE = {
    id: 'gid://shopify/InventoryItem/1',
    sku: 'JCK-001',
    tracked: true,
    inventoryLevels: {
      edges: [
        {
          node: {
            location: { id: 'gid://shopify/Location/1', name: 'Main Warehouse' },
            quantities: [{ name: 'available', quantity: 12 }],
          },
        },
      ],
    },
  };

  await testAsync('getInventoryLevels normalizes a successful mocked response (id/sku/tracked/levels)', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { inventoryItems: { edges: [{ node: SAMPLE_INVENTORY_ITEM_GRAPHQL_NODE }] } } }),
        async () => {
          const items = await getInventoryLevels();
          assert.strictEqual(items.length, 1);
          const [item] = items;
          assert.strictEqual(item.sku, 'JCK-001');
          assert.strictEqual(item.tracked, true);
          assert.strictEqual(item.levels.length, 1);
          assert.strictEqual(item.levels[0].locationName, 'Main Warehouse');
          assert.strictEqual(item.levels[0].available, 12);
        }
      )
    );
  });

  await testAsync('getInventoryLevels leaves available undefined (never fabricated) when the "available" quantity name is absent', async () => {
    const nodeWithoutAvailable = {
      ...SAMPLE_INVENTORY_ITEM_GRAPHQL_NODE,
      inventoryLevels: { edges: [{ node: { location: { id: 'l1', name: 'Main' }, quantities: [] } }] },
    };
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { inventoryItems: { edges: [{ node: nodeWithoutAvailable }] } } }),
        async () => {
          const items = await getInventoryLevels();
          assert.strictEqual(items[0].levels[0].available, undefined);
        }
      )
    );
  });

  await testAsync('getInventoryLevels throws when the mocked response is missing inventory data', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: {} }),
        () => assert.rejects(() => getInventoryLevels(), /did not include inventory data/)
      )
    );
  });

  // --- getCollections ----------------------------------------------------------------

  const SAMPLE_COLLECTION_GRAPHQL_NODE = {
    id: 'gid://shopify/Collection/1',
    title: 'Winter Wear',
    handle: 'winter-wear',
    description: 'Cold-weather gear.',
    image: { url: 'https://cdn.shopify.com/winter-wear.jpg' },
    productsCount: { count: 24 },
  };

  await testAsync('getCollections rejects clearly when not configured, without calling fetch', async () => {
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
        () => assert.rejects(() => getCollections(), /SHOPIFY_STORE_DOMAIN/)
      );
      assert.strictEqual(fetchCalled, false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('getCollections normalizes a successful mocked response (id/title/handle/description/image/productsCount)', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { collections: { edges: [{ node: SAMPLE_COLLECTION_GRAPHQL_NODE }] } } }),
        async () => {
          const collections = await getCollections();
          assert.strictEqual(collections.length, 1);
          const [collection] = collections;
          assert.strictEqual(collection.id, 'gid://shopify/Collection/1');
          assert.strictEqual(collection.title, 'Winter Wear');
          assert.strictEqual(collection.handle, 'winter-wear');
          assert.strictEqual(collection.description, 'Cold-weather gear.');
          assert.deepStrictEqual(collection.image, { url: 'https://cdn.shopify.com/winter-wear.jpg' });
          assert.strictEqual(collection.productsCount, 24);
        }
      )
    );
  });

  await testAsync('getCollections leaves image null (never fabricated) when the collection has no image', async () => {
    const nodeWithoutImage = { ...SAMPLE_COLLECTION_GRAPHQL_NODE, image: null };
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { collections: { edges: [{ node: nodeWithoutImage }] } } }),
        async () => {
          const collections = await getCollections();
          assert.strictEqual(collections[0].image, null);
        }
      )
    );
  });

  await testAsync('getCollections throws when the mocked response carries GraphQL errors', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }),
        () => assert.rejects(() => getCollections(), /GraphQL errors/)
      )
    );
  });

  await testAsync('getCollections throws when the mocked response is missing collection data', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: {} }),
        () => assert.rejects(() => getCollections(), /did not include collection data/)
      )
    );
  });

  // --- Controlled retries (agent/core/networkRetry.js) ------------------------------

  await testAsync('getProducts retries a transient 500-then-200 sequence and succeeds (fetch called twice)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withEnvConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            if (calls === 1) return jsonResponse(500, { errors: [{ message: 'Internal error' }] });
            return jsonResponse(200, { data: { products: { edges: [{ node: SAMPLE_PRODUCT_GRAPHQL_NODE }] } } });
          },
          async () => {
            const products = await getProducts();
            assert.strictEqual(products.length, 1);
          }
        )
      )
    );
    assert.strictEqual(calls, 2, 'a 500 followed by a 200 should be retried once, not more');
  });

  await testAsync('getProducts retries on HTTP 429 (rate limit)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withEnvConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            if (calls === 1) return jsonResponse(429, { errors: [{ message: 'Rate limited' }] });
            return jsonResponse(200, { data: { products: { edges: [] } } });
          },
          () => getProducts()
        )
      )
    );
    assert.strictEqual(calls, 2);
  });

  await testAsync('getProducts never retries a 4xx response (fetch called exactly once)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withEnvConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(401, { errors: [{ message: 'Unauthorized' }] });
          },
          () => assert.rejects(() => getProducts(), /request failed \(401\)/)
        )
      )
    );
    assert.strictEqual(calls, 1, 'a 4xx response will deterministically fail again - it must never be retried');
  });

  await testAsync('getProducts never retries a GraphQL-level error on an ok HTTP status (fetch called exactly once)', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withEnvConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(200, { errors: [{ message: 'Throttled' }] });
          },
          () => assert.rejects(() => getProducts(), /GraphQL errors/)
        )
      )
    );
    assert.strictEqual(calls, 1, 'a GraphQL-level error is a query/permission problem, not transient - it must never be retried');
  });

  await testAsync('getProducts exhausts retries and throws the last error when every attempt is a transient failure', async () => {
    let calls = 0;
    await withZeroRetryDelay(() =>
      withEnvConfigured(() =>
        withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse(503, { errors: [{ message: 'Service unavailable' }] });
          },
          () => assert.rejects(() => getProducts(), /request failed \(503\)/)
        )
      )
    );
    assert.strictEqual(calls, 3, 'should attempt exactly the default max (3), never more');
  });

  // --- Timeouts ------------------------------------------------------------------

  await testAsync('getProducts rejects with a clear timeout error when the request never resolves', async () => {
    const savedTimeout = process.env.NETWORK_REQUEST_TIMEOUT_MS;
    process.env.NETWORK_REQUEST_TIMEOUT_MS = '20';
    try {
      await withZeroRetryDelay(() =>
        withEnvConfigured(() =>
          withMockedFetch(
            () => new Promise(() => {}),
            () =>
              assert.rejects(
                () => getProducts(),
                /Could not reach the Shopify Admin API.*timed out after 20ms/
              )
          )
        )
      );
    } finally {
      if (savedTimeout === undefined) delete process.env.NETWORK_REQUEST_TIMEOUT_MS;
      else process.env.NETWORK_REQUEST_TIMEOUT_MS = savedTimeout;
    }
  });

  // --- Rate limits: Retry-After is honored, bounded -------------------------------

  await testAsync('getProducts honors a Retry-After header on a 429 instead of guessing via backoff', async () => {
    let calls = 0;
    const timestamps = [];
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => {
          calls += 1;
          timestamps.push(Date.now());
          if (calls === 1) {
            return {
              ok: false,
              status: 429,
              statusText: 'Too Many Requests',
              headers: { get: (name) => (name === 'retry-after' ? '0.05' : null) },
              json: async () => ({ errors: [{ message: 'Rate limited' }] }),
            };
          }
          return jsonResponse(200, { data: { products: { edges: [] } } });
        },
        () => getProducts()
      )
    );
    assert.strictEqual(calls, 2);
    assert.ok(timestamps[1] - timestamps[0] >= 40, 'should wait ~50ms per the Retry-After header, not a shorter guess');
  });

  // --- Invalid responses: an unexpected nested shape never becomes fabricated data --

  await testAsync('getProducts throws a clear "unexpected shape" error when a node is missing its variants field', async () => {
    const nodeWithoutVariants = { ...SAMPLE_PRODUCT_GRAPHQL_NODE };
    delete nodeWithoutVariants.variants;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { products: { edges: [{ node: nodeWithoutVariants }] } } }),
        () => assert.rejects(() => getProducts(), /getProducts had an unexpected shape/)
      )
    );
  });

  await testAsync('getOrders throws a clear "unexpected shape" error when a node is missing its lineItems field', async () => {
    const nodeWithoutLineItems = { ...SAMPLE_ORDER_GRAPHQL_NODE };
    delete nodeWithoutLineItems.lineItems;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { orders: { edges: [{ node: nodeWithoutLineItems }] } } }),
        () => assert.rejects(() => getOrders(), /getOrders had an unexpected shape/)
      )
    );
  });

  await testAsync('getCustomers throws a clear "unexpected shape" error when a node is missing its amountSpent field', async () => {
    const nodeWithoutAmountSpent = { ...SAMPLE_CUSTOMER_GRAPHQL_NODE };
    delete nodeWithoutAmountSpent.amountSpent;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { customers: { edges: [{ node: nodeWithoutAmountSpent }] } } }),
        () => assert.rejects(() => getCustomers(), /getCustomers had an unexpected shape/)
      )
    );
  });

  await testAsync('getInventoryLevels throws a clear "unexpected shape" error when a node is missing its inventoryLevels field', async () => {
    const nodeWithoutInventoryLevels = { ...SAMPLE_INVENTORY_ITEM_GRAPHQL_NODE };
    delete nodeWithoutInventoryLevels.inventoryLevels;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { inventoryItems: { edges: [{ node: nodeWithoutInventoryLevels }] } } }),
        () => assert.rejects(() => getInventoryLevels(), /getInventoryLevels had an unexpected shape/)
      )
    );
  });

  await testAsync('getCollections throws a clear "unexpected shape" error when an edge is missing its node entirely', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { data: { collections: { edges: [{}] } } }),
        () => assert.rejects(() => getCollections(), /getCollections had an unexpected shape/)
      )
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
