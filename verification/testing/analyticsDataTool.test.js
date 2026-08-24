'use strict';

const assert = require('node:assert');
const { runAnalyticsDataTool } = require('../../tools/analyticsDataTool');

// runAnalyticsDataTool() tests mock global.fetch, same pattern as
// verification/testing/shopifyClient.test.js and
// verification/testing/productDataRetrievalTool.test.js - no real network call is
// ever made.

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

// Routes a mocked fetch by which GraphQL field the query asks for, so one mock can
// serve every source (orders/products/customers/inventoryItems) in a single test run.
function routedFetch(responsesByField) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    for (const [field, body_] of Object.entries(responsesByField)) {
      if (body.query.includes(`${field}(`)) return jsonResponse(200, body_);
    }
    throw new Error(`No mocked response registered for query: ${body.query}`);
  };
}

const SAMPLE_ORDERS_RESPONSE = {
  data: {
    orders: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Order/1',
            name: '#1001',
            createdAt: '2026-01-15T10:00:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'FULFILLED',
            currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
            lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
          },
        },
        {
          node: {
            id: 'gid://shopify/Order/2',
            name: '#1002',
            createdAt: '2026-01-16T10:00:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'FULFILLED',
            currentTotalPriceSet: { shopMoney: { amount: '64.00', currencyCode: 'USD' } },
            lineItems: { edges: [] },
          },
        },
      ],
    },
  },
};

const SAMPLE_PRODUCTS_RESPONSE = {
  data: {
    products: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Product/1',
            title: 'Insulated Jacket',
            handle: 'insulated-jacket',
            status: 'ACTIVE',
            productType: 'Outerwear',
            vendor: 'Acme',
            tags: ['winter'],
            variants: { edges: [{ node: { id: 'v1', title: 'Default', sku: 'JCK-001', price: '89.00', inventoryQuantity: 0, availableForSale: false } }] },
            collections: { edges: [] },
            metafields: { edges: [] },
          },
        },
      ],
    },
  },
};

const SAMPLE_CUSTOMERS_RESPONSE = {
  data: {
    customers: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Customer/1',
            numberOfOrders: '3',
            amountSpent: { amount: '267.00', currencyCode: 'USD' },
            state: 'ENABLED',
            tags: ['vip'],
            createdAt: '2025-06-01T00:00:00Z',
          },
        },
      ],
    },
  },
};

const SAMPLE_INVENTORY_RESPONSE = {
  data: {
    inventoryItems: {
      edges: [
        {
          node: {
            id: 'gid://shopify/InventoryItem/1',
            sku: 'JCK-001',
            tracked: true,
            inventoryLevels: {
              edges: [{ node: { location: { id: 'l1', name: 'Main Warehouse' }, quantities: [{ name: 'available', quantity: 12 }] } }],
            },
          },
        },
      ],
    },
  },
};

(async () => {
  await testAsync('runAnalyticsDataTool returns failed status when researchParams is missing', async () => {
    const outcome = await runAnalyticsDataTool(undefined);
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.result, null);
    assert.ok(outcome.error.includes('No structured research input was supplied'));
  });

  await testAsync('runAnalyticsDataTool returns failed status for an unsupported analyticsCapability', async () => {
    const outcome = await runAnalyticsDataTool({ analyticsCapability: 'growth_opportunities' });
    assert.strictEqual(outcome.status, 'failed');
    assert.ok(outcome.error.includes('Unknown or unsupported analyticsCapability'));
  });

  await testAsync('runAnalyticsDataTool returns failed status when Shopify is not configured, without calling fetch', async () => {
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
        async () => {
          const outcome = await runAnalyticsDataTool({ analyticsCapability: 'sales' });
          assert.strictEqual(outcome.status, 'failed');
          assert.ok(outcome.error.includes('SHOPIFY_STORE_DOMAIN'));
        }
      );
      assert.strictEqual(fetchCalled, false);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('runAnalyticsDataTool (sales, default capability) pulls live orders and separates actual/calculated/estimated', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ orders: SAMPLE_ORDERS_RESPONSE }), async () => {
        const outcome = await runAnalyticsDataTool({ limit: 10, periodDays: 7 });
        assert.strictEqual(outcome.status, 'success');
        assert.strictEqual(outcome.result.capability, 'sales');
        const record = outcome.result.specialized_records[0];
        assert.strictEqual(record.sales.actual_metrics.length, 2);
        assert.ok(record.sales.actual_metrics.every((m) => m.label === 'order'));
        const totalRevenue = record.sales.calculated_metrics.find((m) => m.label === 'total_revenue');
        assert.strictEqual(totalRevenue.value, 153);
        const projected = record.sales.estimated_metrics.find((m) => m.label === 'projected_monthly_revenue');
        assert.ok(projected, 'expected a projected_monthly_revenue estimate when periodDays is supplied');
        assert.ok(typeof projected.assumption === 'string' && projected.assumption.length > 0);
        // Live-pull evidence was auto-attached since no caller evidence was supplied.
        assert.ok(outcome.result.evidence.some((e) => e.includes('retrieved live')));
      })
    );
  });

  await testAsync('runAnalyticsDataTool (sales) omits estimated_metrics when periodDays is not supplied', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ orders: SAMPLE_ORDERS_RESPONSE }), async () => {
        const outcome = await runAnalyticsDataTool({ analyticsCapability: 'sales' });
        const record = outcome.result.specialized_records[0];
        assert.deepStrictEqual(record.sales.estimated_metrics, []);
      })
    );
  });

  await testAsync('runAnalyticsDataTool (products) pulls live products and computes calculated_metrics', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ products: SAMPLE_PRODUCTS_RESPONSE }), async () => {
        const outcome = await runAnalyticsDataTool({ analyticsCapability: 'products' });
        assert.strictEqual(outcome.status, 'success');
        const record = outcome.result.specialized_records[0];
        assert.strictEqual(record.product_performance.actual_metrics.length, 1);
        const outOfStock = record.product_performance.calculated_metrics.find((m) => m.label === 'out_of_stock_variants_count');
        assert.strictEqual(outOfStock.value, 1);
      })
    );
  });

  await testAsync('runAnalyticsDataTool (inventory) pulls live inventory and only estimates days remaining when averageDailyUnitsSold is supplied', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ inventoryItems: SAMPLE_INVENTORY_RESPONSE }), async () => {
        const withoutAssumption = await runAnalyticsDataTool({ analyticsCapability: 'inventory' });
        assert.deepStrictEqual(withoutAssumption.result.specialized_records[0].inventory.estimated_metrics, []);

        const withAssumption = await runAnalyticsDataTool({ analyticsCapability: 'inventory', averageDailyUnitsSold: 3 });
        const estimate = withAssumption.result.specialized_records[0].inventory.estimated_metrics.find(
          (m) => m.label === 'estimated_days_of_inventory_remaining'
        );
        assert.ok(estimate);
        assert.strictEqual(estimate.value, 4);
      })
    );
  });

  await testAsync('runAnalyticsDataTool (customers) pulls only non-PII fields on success', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ customers: SAMPLE_CUSTOMERS_RESPONSE }), async () => {
        const outcome = await runAnalyticsDataTool({ analyticsCapability: 'customers' });
        assert.strictEqual(outcome.status, 'success');
        const record = outcome.result.specialized_records[0];
        assert.strictEqual(record.customer_behavior.actual_metrics.length, 1);
        assert.strictEqual(record.customer_behavior.actual_metrics[0].label, 'customer');
      })
    );
  });

  await testAsync('runAnalyticsDataTool (customers) degrades to partial status honestly when the store denies access, instead of failing the whole call', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => jsonResponse(200, { errors: [{ message: 'Access denied for customers field.' }] }),
        async () => {
          const outcome = await runAnalyticsDataTool({ analyticsCapability: 'customers' });
          assert.strictEqual(outcome.status, 'partial');
          assert.ok(outcome.result.limitations.some((l) => l.includes('not permitted or unavailable')));
          assert.deepStrictEqual(outcome.result.specialized_records[0].customer_behavior.actual_metrics, []);
        }
      )
    );
  });

  await testAsync('runAnalyticsDataTool returns empty status when the live pull returns zero records', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(routedFetch({ orders: { data: { orders: { edges: [] } } } }), async () => {
        const outcome = await runAnalyticsDataTool({ analyticsCapability: 'sales' });
        assert.strictEqual(outcome.status, 'empty');
      })
    );
  });

  await testAsync('runAnalyticsDataTool never throws - a network-level failure is reported as failed status', async () => {
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => {
          throw new Error('simulated network failure');
        },
        async () => {
          const outcome = await runAnalyticsDataTool({ analyticsCapability: 'sales' });
          assert.strictEqual(outcome.status, 'failed');
          assert.ok(outcome.error.includes('Could not reach the Shopify Admin API'));
        }
      )
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
