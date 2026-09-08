'use strict';

// Tests for the three new integrations/adapters/shopifyClient.js write mutations
// (updateProductVendor, addProductsToCollection, adjustInventoryQuantities), the
// getInventoryItemsByIds() read added alongside them, and getOrders()'s additive
// test/inventoryItemId extension plus sumTestOrderQuantitiesByInventoryItem().
//
// Same convention as verification/testing/shopifyClient.test.js: global.fetch is
// mocked (save/restore in `finally`), no real network call is ever made, and every
// store/credential value below is an invented placeholder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const {
  updateProductVendor,
  addProductsToCollection,
  adjustInventoryQuantities,
  getInventoryItemsByIds,
  getOrders,
  sumTestOrderQuantitiesByInventoryItem,
  REQUIRED_PRODUCT_WRITE_SCOPE,
  REQUIRED_INVENTORY_WRITE_SCOPE,
  clearAccessScopesCache,
  loadEnvOnce,
} = shopifyClient;

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
  const savedClientId = process.env.SHOPIFY_CLIENT_ID;
  const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
  loadEnvOnce();
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
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
  return { ok: status >= 200 && status < 300, status, statusText: 'status text', json: async () => body };
}

// Routes a stubbed fetch by inspecting the GraphQL query text - the same convention
// shopifyBlogPublishing.test.js's withStubbedTransport() uses. `scopes` answers the
// access-scope preflight; each of the other handlers answers one specific operation.
function stubbedFetch({ scopes, onMutation, onNodes, onOrders }) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (typeof body.query === 'string' && /mutation/.test(body.query) && onMutation) {
      return onMutation(body);
    }
    if (typeof body.query === 'string' && body.query.includes('nodes(ids:') && onNodes) {
      return onNodes(body);
    }
    if (typeof body.query === 'string' && body.query.includes('orders(first') && onOrders) {
      return onOrders(body);
    }
    return jsonResponse(200, { data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } } });
  };
}

(async () => {
  // --- updateProductVendor -----------------------------------------------------------

  await testAsync('updateProductVendor: missing productId/vendor -> throws before any fetch', async () => {
    let fetchCalls = 0;
    await withMockedFetch(async () => { fetchCalls += 1; return jsonResponse(200, {}); }, async () => {
      await assert.rejects(() => updateProductVendor({ productId: '', vendor: 'X' }), /non-empty productId/);
      await assert.rejects(() => updateProductVendor({ productId: 'gid://shopify/Product/1', vendor: '' }), /non-empty vendor/);
    });
    assert.strictEqual(fetchCalls, 0, 'zero fetch calls for missing required fields');
  });

  await testAsync('updateProductVendor: missing write_products scope -> zero mutation attempts', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutations = 0;
      await withMockedFetch(
        stubbedFetch({ scopes: ['read_products'], onMutation: () => { mutations += 1; return jsonResponse(200, {}); } }),
        async () => {
          await assert.rejects(
            () => updateProductVendor({ productId: 'gid://shopify/Product/1', vendor: 'New Vendor' }),
            new RegExp(REQUIRED_PRODUCT_WRITE_SCOPE)
          );
        }
      );
      assert.strictEqual(mutations, 0, 'no mutation may be attempted without the scope');
      clearAccessScopesCache();
    });
  });

  await testAsync('updateProductVendor: success sends ONLY id+vendor, returns Shopify\'s real product', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutationBody = null;
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_PRODUCT_WRITE_SCOPE],
          onMutation: (body) => {
            mutationBody = body;
            return jsonResponse(200, {
              data: { productUpdate: { product: { id: body.variables.input.id, vendor: body.variables.input.vendor }, userErrors: [] } },
            });
          },
        }),
        async () => {
          const result = await updateProductVendor({ productId: 'gid://shopify/Product/1', vendor: 'Digital Studio by Naeema' });
          assert.deepStrictEqual(result, { id: 'gid://shopify/Product/1', vendor: 'Digital Studio by Naeema' });
        }
      );
      assert.deepStrictEqual(mutationBody.variables.input, { id: 'gid://shopify/Product/1', vendor: 'Digital Studio by Naeema' });
      assert.ok(!('title' in mutationBody.variables.input), 'no other field is ever sent');
      clearAccessScopesCache();
    });
  });

  await testAsync('updateProductVendor: userErrors is a FAILURE, never a fabricated product', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_PRODUCT_WRITE_SCOPE],
          onMutation: () =>
            jsonResponse(200, { data: { productUpdate: { product: null, userErrors: [{ field: ['vendor'], message: 'Invalid vendor (placeholder)' }] } } }),
        }),
        async () => {
          await assert.rejects(
            () => updateProductVendor({ productId: 'gid://shopify/Product/1', vendor: 'X' }),
            /Invalid vendor \(placeholder\)/
          );
        }
      );
      clearAccessScopesCache();
    });
  });

  // --- addProductsToCollection --------------------------------------------------------

  await testAsync('addProductsToCollection: missing collectionId/productIds -> throws before any fetch', async () => {
    let fetchCalls = 0;
    await withMockedFetch(async () => { fetchCalls += 1; return jsonResponse(200, {}); }, async () => {
      await assert.rejects(() => addProductsToCollection({ collectionId: '', productIds: ['gid://shopify/Product/1'] }), /non-empty collectionId/);
      await assert.rejects(() => addProductsToCollection({ collectionId: 'gid://shopify/Collection/1', productIds: [] }), /non-empty array of non-empty productIds/);
    });
    assert.strictEqual(fetchCalls, 0);
  });

  await testAsync('addProductsToCollection: missing write_products scope -> zero mutation attempts', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutations = 0;
      await withMockedFetch(
        stubbedFetch({ scopes: ['read_products'], onMutation: () => { mutations += 1; return jsonResponse(200, {}); } }),
        async () => {
          await assert.rejects(
            () => addProductsToCollection({ collectionId: 'gid://shopify/Collection/1', productIds: ['gid://shopify/Product/1'] }),
            new RegExp(REQUIRED_PRODUCT_WRITE_SCOPE)
          );
        }
      );
      assert.strictEqual(mutations, 0);
      clearAccessScopesCache();
    });
  });

  await testAsync('addProductsToCollection: success sends exactly the given productIds array', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutationBody = null;
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_PRODUCT_WRITE_SCOPE],
          onMutation: (body) => {
            mutationBody = body;
            return jsonResponse(200, { data: { collectionAddProducts: { collection: { id: body.variables.id, title: 'Free Designs (placeholder)' }, userErrors: [] } } });
          },
        }),
        async () => {
          const result = await addProductsToCollection({ collectionId: 'gid://shopify/Collection/1', productIds: ['gid://shopify/Product/1'] });
          assert.deepStrictEqual(result, { id: 'gid://shopify/Collection/1', title: 'Free Designs (placeholder)' });
        }
      );
      assert.deepStrictEqual(mutationBody.variables.productIds, ['gid://shopify/Product/1']);
      clearAccessScopesCache();
    });
  });

  await testAsync('addProductsToCollection: userErrors is a FAILURE, never a fabricated collection', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_PRODUCT_WRITE_SCOPE],
          onMutation: () =>
            jsonResponse(200, { data: { collectionAddProducts: { collection: null, userErrors: [{ field: ['productIds'], message: 'Product not found (placeholder)' }] } } }),
        }),
        async () => {
          await assert.rejects(
            () => addProductsToCollection({ collectionId: 'gid://shopify/Collection/1', productIds: ['gid://shopify/Product/999'] }),
            /Product not found \(placeholder\)/
          );
        }
      );
      clearAccessScopesCache();
    });
  });

  // --- adjustInventoryQuantities -------------------------------------------------------

  await testAsync('adjustInventoryQuantities: invalid changes -> throws before any fetch', async () => {
    let fetchCalls = 0;
    await withMockedFetch(async () => { fetchCalls += 1; return jsonResponse(200, {}); }, async () => {
      const KEY = 'placeholder-idempotency-key';
      await assert.rejects(() => adjustInventoryQuantities({ changes: [], reason: 'correction', idempotencyKey: KEY }), /non-empty changes array/);
      await assert.rejects(() => adjustInventoryQuantities({ changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 0 }], reason: 'correction', idempotencyKey: KEY }), /non-zero integer delta/);
      await assert.rejects(() => adjustInventoryQuantities({ changes: [{ inventoryItemId: '', locationId: 'gid://shopify/Location/1', delta: 1 }], reason: 'correction', idempotencyKey: KEY }), /non-empty locationId/);
      await assert.rejects(() => adjustInventoryQuantities({ changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }], reason: '', idempotencyKey: KEY }), /non-empty reason/);
      // The @idempotent directive is mandatory on this mutation, so a missing or
      // whitespace-only key refuses before anything leaves the process.
      await assert.rejects(() => adjustInventoryQuantities({ changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }], reason: 'correction' }), /non-empty idempotencyKey/);
      await assert.rejects(() => adjustInventoryQuantities({ changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }], reason: 'correction', idempotencyKey: '   ' }), /non-empty idempotencyKey/);
    });
    assert.strictEqual(fetchCalls, 0);
  });

  await testAsync('adjustInventoryQuantities: missing write_inventory scope -> zero mutation attempts', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutations = 0;
      await withMockedFetch(
        stubbedFetch({ scopes: ['read_inventory'], onMutation: () => { mutations += 1; return jsonResponse(200, {}); } }),
        async () => {
          await assert.rejects(
            () =>
              adjustInventoryQuantities({
                changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }],
                reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
              }),
            new RegExp(REQUIRED_INVENTORY_WRITE_SCOPE)
          );
        }
      );
      assert.strictEqual(mutations, 0);
      clearAccessScopesCache();
    });
  });

  await testAsync('adjustInventoryQuantities: success sends the EXACT caller-supplied delta, never derived', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutationBody = null;
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_INVENTORY_WRITE_SCOPE],
          onMutation: (body) => {
            mutationBody = body;
            const change = body.variables.input.changes[0];
            return jsonResponse(200, {
              data: {
                inventoryAdjustQuantities: {
                  inventoryAdjustmentGroup: {
                    changes: [{ name: 'available', delta: change.delta, quantityAfterChange: 0, item: { id: change.inventoryItemId }, location: { id: change.locationId } }],
                  },
                  userErrors: [],
                },
              },
            });
          },
        }),
        async () => {
          const result = await adjustInventoryQuantities({
            changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }],
            reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
          });
          assert.strictEqual(result.changes[0].quantityAfterChange, 0);
        }
      );
      // This API version REFUSES inventoryAdjustQuantities outright without the
      // @idempotent directive ("The @idempotent directive is required for this mutation
      // but was not provided", BAD_REQUEST), so its presence is the property under test.
      assert.ok(
        /inventoryAdjustQuantities\(input: \$input\)\s*@idempotent\(key: \$idempotencyKey\)/.test(mutationBody.query),
        'the mandatory @idempotent directive must be on the mutation field'
      );
      assert.strictEqual(mutationBody.variables.idempotencyKey, 'placeholder-idempotency-key');
      assert.ok(!mutationBody.query.includes('placeholder-idempotency-key'), 'the key travels as a variable, never interpolated into the query');
      assert.strictEqual(mutationBody.variables.input.reason, 'correction');
      assert.strictEqual(mutationBody.variables.input.name, 'available');
      assert.deepStrictEqual(mutationBody.variables.input.changes, [
        { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 },
      ]);
      clearAccessScopesCache();
    });
  });

  await testAsync('adjustInventoryQuantities: changeFromQuantity is sent EXACTLY as supplied when given', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutationBody = null;
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_INVENTORY_WRITE_SCOPE],
          onMutation: (body) => {
            mutationBody = body;
            return jsonResponse(200, {
              data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { changes: [{ name: 'available', delta: 1, quantityAfterChange: 0, item: { id: 'gid://shopify/InventoryItem/1' }, location: { id: 'gid://shopify/Location/1' } }] }, userErrors: [] } },
            });
          },
        }),
        async () => {
          await adjustInventoryQuantities({
            // -1 is the live quantity the plan was computed from: a current quantity, not
            // a delta, so a negative value must survive untouched.
            changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1, changeFromQuantity: -1 }],
            reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
          });
        }
      );
      assert.deepStrictEqual(mutationBody.variables.input.changes, [
        { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1, changeFromQuantity: -1 },
      ]);
      clearAccessScopesCache();
    });
  });

  await testAsync('adjustInventoryQuantities: changeFromQuantity is ABSENT from the payload when not supplied', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      let mutationBody = null;
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_INVENTORY_WRITE_SCOPE],
          onMutation: (body) => {
            mutationBody = body;
            return jsonResponse(200, {
              data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { changes: [] }, userErrors: [] } },
            });
          },
        }),
        async () => {
          await adjustInventoryQuantities({
            changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }],
            reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
          });
        }
      );
      assert.ok(
        !('changeFromQuantity' in mutationBody.variables.input.changes[0]),
        'omitting it must send exactly the request this function sent before the field was supported'
      );
      clearAccessScopesCache();
    });
  });

  await testAsync('adjustInventoryQuantities: a non-integer changeFromQuantity -> throws before any fetch', async () => {
    let fetchCalls = 0;
    await withMockedFetch(async () => { fetchCalls += 1; return jsonResponse(200, {}); }, async () => {
      await assert.rejects(
        () =>
          adjustInventoryQuantities({
            changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1, changeFromQuantity: 1.5 }],
            reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
          }),
        /changeFromQuantity, when supplied, to be an integer/
      );
    });
    assert.strictEqual(fetchCalls, 0);
  });

  await testAsync('adjustInventoryQuantities: userErrors is a FAILURE, never a fabricated adjustment', async () => {
    await withEnvConfigured(async () => {
      clearAccessScopesCache();
      await withMockedFetch(
        stubbedFetch({
          scopes: [REQUIRED_INVENTORY_WRITE_SCOPE],
          onMutation: () =>
            jsonResponse(200, { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ['delta'], message: 'Invalid delta (placeholder)' }] } } }),
        }),
        async () => {
          await assert.rejects(
            () =>
              adjustInventoryQuantities({
                changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', delta: 1 }],
                reason: 'correction',
                idempotencyKey: 'placeholder-idempotency-key',
              }),
            /Invalid delta \(placeholder\)/
          );
        }
      );
      clearAccessScopesCache();
    });
  });

  // --- getInventoryItemsByIds ---------------------------------------------------------

  await testAsync('getInventoryItemsByIds: requires a non-empty array', async () => {
    await assert.rejects(() => getInventoryItemsByIds({ inventoryItemIds: [] }), /non-empty array/);
  });

  await testAsync('getInventoryItemsByIds: requests location.id only, never location.name', async () => {
    await withEnvConfigured(async () => {
      let queryText = null;
      await withMockedFetch(
        async (url, options) => {
          const body = JSON.parse(options.body);
          queryText = body.query;
          return jsonResponse(200, {
            data: {
              nodes: [
                {
                  id: 'gid://shopify/InventoryItem/1',
                  sku: 'SKU-1',
                  tracked: false,
                  inventoryLevels: { edges: [{ node: { location: { id: 'gid://shopify/Location/1' }, quantities: [{ name: 'available', quantity: -1 }] } }] },
                },
              ],
            },
          });
        },
        async () => {
          const result = await getInventoryItemsByIds({ inventoryItemIds: ['gid://shopify/InventoryItem/1'] });
          assert.deepStrictEqual(result, [
            { id: 'gid://shopify/InventoryItem/1', sku: 'SKU-1', tracked: false, levels: [{ locationId: 'gid://shopify/Location/1', available: -1 }] },
          ]);
        }
      );
      assert.ok(!/location\s*\{\s*id\s+name/.test(queryText), 'must never request location.name (requires read_locations scope this store lacks)');
      assert.ok(/location\s*\{\s*id\s*\}/.test(queryText), 'must request location.id');
    });
  });

  // --- getOrders extension: test field + inventoryItemId ------------------------------

  await testAsync('getOrders: reshapes the additive test field and lineItems[].inventoryItemId', async () => {
    await withEnvConfigured(async () => {
      await withMockedFetch(
        async () =>
          jsonResponse(200, {
            data: {
              orders: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Order/1',
                      name: '#1001',
                      createdAt: '2026-01-01T00:00:00Z',
                      displayFinancialStatus: 'PAID',
                      displayFulfillmentStatus: 'FULFILLED',
                      currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
                      test: true,
                      lineItems: {
                        edges: [
                          { node: { title: 'Widget', quantity: 2, sku: 'SKU-1', variant: { id: 'gid://shopify/ProductVariant/1', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } } } },
                          { node: { title: 'No variant', quantity: 1, sku: null, variant: null } },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          }),
        async () => {
          const orders = await getOrders({ limit: 1 });
          assert.strictEqual(orders.length, 1);
          assert.strictEqual(orders[0].test, true);
          assert.strictEqual(orders[0].lineItems[0].inventoryItemId, 'gid://shopify/InventoryItem/1');
          assert.strictEqual(orders[0].lineItems[1].inventoryItemId, null, 'a line item with no variant must never invent an inventory item id');
        }
      );
    });
  });

  // --- sumTestOrderQuantitiesByInventoryItem: pure, no I/O -----------------------------

  test('sumTestOrderQuantitiesByInventoryItem: sums ONLY test:true orders, per inventory item', () => {
    const orders = [
      { test: true, lineItems: [{ inventoryItemId: 'A', quantity: 1 }, { inventoryItemId: 'B', quantity: 2 }] },
      { test: false, lineItems: [{ inventoryItemId: 'A', quantity: 5 }] },
      { test: true, lineItems: [{ inventoryItemId: 'A', quantity: 3 }] },
      { test: true, lineItems: [{ inventoryItemId: null, quantity: 9 }] },
    ];
    const totals = sumTestOrderQuantitiesByInventoryItem(orders);
    assert.strictEqual(totals.get('A'), 4, 'A: 1 (test) + 3 (test) = 4, the non-test 5 must be excluded');
    assert.strictEqual(totals.get('B'), 2);
    assert.strictEqual(totals.has(null), false, 'a line item with no inventory item id must never be counted');
  });

  test('sumTestOrderQuantitiesByInventoryItem: empty/malformed input never throws', () => {
    assert.deepStrictEqual([...sumTestOrderQuantitiesByInventoryItem([]).entries()], []);
    assert.deepStrictEqual([...sumTestOrderQuantitiesByInventoryItem(undefined).entries()], []);
  });

  // --- Credential/hardcoding safety ----------------------------------------------------

  test('NO REAL STORE DOMAIN OR CREDENTIAL is hardcoded anywhere in the new code or this test', () => {
    for (const file of [
      'integrations/adapters/shopifyClient.js',
      'integrations/shopifyVendorCorrection.js',
      'integrations/shopifyInventoryCorrection.js',
      'integrations/shopifyCollectionMembership.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      assert.ok(!/[a-z0-9-]+\.myshopify\.com/i.test(source), `${file} must not hardcode a real store domain`);
      assert.ok(!/shpat_[a-z0-9]{20,}/i.test(source), `${file} must not hardcode a real access token`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('shopifyClientWriteMutations.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
