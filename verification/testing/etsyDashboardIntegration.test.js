'use strict';

// The Etsy dashboard integration - server.js's Connected Channels state for Etsy and the
// `etsy` block on GET /store/metrics.
//
// Follows verification/testing/dashboardOverviewEndpoint.test.js's harness exactly: real
// HTTP requests against a locally started createApp(), a throwaway RUN_HISTORY_STORE_DIR
// so this suite never touches this project's own memory/state/runs/, and monkey-patched
// MODULE functions rather than a global.fetch mock - a fetch mock would intercept this
// suite's own HTTP calls to its local server.
//
// NO REAL ETSY REQUEST IS EVER MADE HERE. Every Etsy read is stubbed at the tool boundary
// (tools/etsyShopDataTool.js, tools/etsyListingDataTool.js) and the credential check is
// stubbed at etsyReadClient.canRead(), so this suite spends no Etsy quota and its result
// does not depend on how far through configuring Etsy the machine happens to be.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-dashboard-test-'));

const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
// GET /store/metrics caches its whole payload per process. Pinned to 0 so each test in
// this file gets a genuinely fresh build rather than a neighbour's cached one - except the
// one test that deliberately asserts the cache, which sets its own TTL.
process.env.OVERVIEW_METRICS_TTL_MS = '1';

const { createApp } = require('../../server');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const etsyClient = require('../../integrations/adapters/etsyClient');
const analyticsDataTool = require('../../tools/analyticsDataTool');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyListingDataTool = require('../../tools/etsyListingDataTool');
const { getToolById, TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const channelModel = require('../../agent/core/channelModel');

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

function request(port, { method, path: reqPath, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method: method || 'GET', headers: headers || {} },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function authedGet(port, reqPath) {
  return request(port, { method: 'GET', path: reqPath, headers: { Authorization: `Bearer ${TEST_API_KEY}` } });
}

function authedPost(port, reqPath, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Same convention as dashboardOverviewEndpoint.test.js - restores unconditionally.
function withMocked(moduleObj, fnName, mockImpl, fn) {
  const saved = moduleObj[fnName];
  moduleObj[fnName] = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      moduleObj[fnName] = saved;
    });
}

// --- Fixtures, shaped EXACTLY like the real tools' return values --------------------
//
// The shop figures below are this project's real verified shop (HappyInviteHouse, 75
// active / 65 digital), so a change that quietly reshapes the payload fails against the
// numbers the owner actually sees rather than against invented ones.

const ETSY_SHOP_RESULT = {
  shop_id: 62500594,
  shop_name: 'HappyInviteHouse',
  title: 'Digital invitation templates',
  announcement: null,
  currency_code: 'USD',
  url: 'https://www.etsy.com/shop/HappyInviteHouse',
  listing_active_count: 75,
  digital_listing_count: 65,
  is_vacation: false,
  channel: 'etsy',
};

function etsyListingEntry(overrides) {
  const listing = Object.assign(
    {
      listing_id: 4568436794,
      shop_id: 62500594,
      title: 'Birthday Invitation Template',
      description: 'A long seller-written description that must not be relayed to the dashboard.',
      state: 'active',
      url: 'https://www.etsy.com/listing/4568436794',
      tags: ['invitation', 'birthday'],
      materials: [],
      price: null,
      quantity: 999,
      taxonomy_id: 2078,
      listing_type: 'download',
      is_digital: null,
      is_digital_product: true,
      num_favorers: 12,
      views: 340,
      channel: 'etsy',
    },
    (overrides && overrides.listing) || {}
  );
  return {
    listing,
    facts: {},
    missing_facts: (overrides && overrides.missing_facts) || ['file_formats', 'dimensions'],
    compliance: Object.assign(
      { status: 'REVIEW', review_reasons: [], findings: [], checked_at: null, checker_version: '1', limitations: [] },
      (overrides && overrides.compliance) || {}
    ),
  };
}

function etsyShopOk() {
  return { status: 'success', result: ETSY_SHOP_RESULT, error: null };
}

function etsyListingsOk(entries) {
  const list = entries || [etsyListingEntry()];
  return {
    status: 'partial',
    result: {
      channel: 'etsy',
      listing_count: list.length,
      aggregate_compliance_status: 'REVIEW',
      listings: list,
      pagination: { limit: 25, offset: 0 },
    },
    error: null,
  };
}

// Shopify stubbed to a fixed, honest "no data" so every Etsy assertion below is about
// Etsy alone and never perturbed by a live Shopify connection.
function quietShopify(fn) {
  return withMocked(analyticsDataTool, 'runAnalyticsDataTool', async () => ({ status: 'empty', result: null, error: null }), () =>
    withMocked(shopifyClient, 'getOrders', async () => [], fn)
  );
}

// Runs `fn(port)` with Etsy connected and both read tools stubbed.
function withEtsyConnected({ shop, listings, onShopCall, onListingCall }, fn) {
  return withMocked(etsyReadClient, 'canRead', () => true, () =>
    withMocked(
      etsyShopDataTool,
      'runEtsyShopDataTool',
      async (params) => {
        if (onShopCall) onShopCall(params);
        return shop === undefined ? etsyShopOk() : shop;
      },
      () =>
        withMocked(
          etsyListingDataTool,
          'runEtsyListingDataTool',
          async (params) => {
            if (onListingCall) onListingCall(params);
            return listings === undefined ? etsyListingsOk() : listings;
          },
          () => quietShopify(fn)
        )
    )
  );
}

async function main() {
  // --- 1 + 2. Connected Channels reflects the READ client, and says "read only" --------

  await testAsync('CONNECTED CHANNEL: Etsy is reported from canRead(), not from publish credentials', async () => {
    await withMocked(etsyReadClient, 'canRead', () => true, () =>
      // etsyClient.isConfigured() is the PUBLISH check. Forced false to prove the channel
      // row does not consult it: reads work, publishing does not, and the dashboard must
      // report the former.
      withMocked(etsyClient, 'isConfigured', () => false, () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/overview');
          const data = JSON.parse(res.raw);
          const etsy = data.channels.find((c) => c.id === 'etsy');
          assert.strictEqual(etsy.adapter_exists, true);
          assert.strictEqual(etsy.configured, true, 'a readable Etsy shop must report as connected');
        })
      )
    );
  });

  await testAsync('READ ONLY: the Etsy channel carries access "read_only", and Shopify does not', async () => {
    await withMocked(etsyReadClient, 'canRead', () => true, () =>
      withMocked(shopifyClient, 'isConfigured', () => true, () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/overview');
          const data = JSON.parse(res.raw);
          assert.strictEqual(data.channels.find((c) => c.id === 'etsy').access, 'read_only');
          // Shopify's own capability is unchanged by this phase - it must NOT be relabelled.
          assert.strictEqual(data.channels.find((c) => c.id === 'shopify').access, null);
        })
      )
    );
  });

  await testAsync('READ ONLY: the health check describes Etsy as a READ connection, never a publish one', async () => {
    await withMocked(etsyReadClient, 'canRead', () => true, () =>
      withServer(async (port) => {
        const res = await authedGet(port, '/overview');
        const data = JSON.parse(res.raw);
        const check = data.health.find((h) => h.id === 'etsy_read_connection');
        assert.ok(check, 'an Etsy read-connection health line must exist');
        assert.strictEqual(check.status, 'ok');
        assert.ok(/read/i.test(check.label + ' ' + (check.detail || '')), 'the line must say it is read-only');
      })
    );
  });

  await testAsync('An unconfigured Etsy is reported honestly, and NO Etsy request is attempted', async () => {
    let shopToolCalls = 0;
    let listingToolCalls = 0;
    await withMocked(etsyReadClient, 'canRead', () => false, () =>
      withMocked(
        etsyShopDataTool,
        'runEtsyShopDataTool',
        async () => {
          shopToolCalls += 1;
          return etsyShopOk();
        },
        () =>
          withMocked(
            etsyListingDataTool,
            'runEtsyListingDataTool',
            async () => {
              listingToolCalls += 1;
              return etsyListingsOk();
            },
            () =>
              quietShopify(() =>
                withServer(async (port) => {
                  const overview = JSON.parse((await authedGet(port, '/overview')).raw);
                  assert.strictEqual(overview.channels.find((c) => c.id === 'etsy').configured, false);

                  const metrics = JSON.parse((await authedGet(port, '/store/metrics')).raw);
                  assert.strictEqual(metrics.etsy.connected, false);
                  // Firing a request that can only fail would spend quota to learn what
                  // the local credential check already knew.
                  assert.strictEqual(shopToolCalls, 0, 'no Etsy shop read may be attempted');
                  assert.strictEqual(listingToolCalls, 0, 'no Etsy listing read may be attempted');
                })
              )
          )
      )
    );
  });

  // --- 3. Real returned values, relayed exactly ---------------------------------------

  await testAsync('METRICS ARE THE REAL RETURNED VALUES, relayed exactly', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
        const byId = Object.fromEntries(data.etsy.metrics.map((m) => [m.id, m]));

        assert.strictEqual(byId.active_listings.value, 75);
        assert.strictEqual(byId.active_listings.available, true);
        assert.strictEqual(byId.digital_listings.value, 65);
        assert.strictEqual(byId.digital_listings.available, true);
        assert.strictEqual(byId.currency.value, 'USD');
        // is_vacation:false is a REAL fact, so the status is known - not unavailable.
        assert.strictEqual(byId.shop_status.value, 'Open');
        assert.strictEqual(byId.shop_status.available, true);

        assert.strictEqual(data.etsy.shop.shop_id, 62500594);
        assert.strictEqual(data.etsy.shop.shop_name, 'HappyInviteHouse');
      })
    );
  });

  await testAsync('A metric Etsy did not report stays unavailable rather than defaulting', async () => {
    // A shop record with is_vacation and the counts genuinely absent.
    const sparse = {
      status: 'success',
      result: Object.assign({}, ETSY_SHOP_RESULT, {
        listing_active_count: null,
        digital_listing_count: null,
        is_vacation: null,
      }),
      error: null,
    };
    await withEtsyConnected({ shop: sparse }, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
        const byId = Object.fromEntries(data.etsy.metrics.map((m) => [m.id, m]));
        for (const id of ['active_listings', 'digital_listings', 'shop_status']) {
          assert.strictEqual(byId[id].available, false, `${id} must not be reported as known`);
          assert.strictEqual(byId[id].value, null, `${id} must carry no substituted value`);
        }
        // Crucially, "Open" must not be assumed from a null is_vacation.
        assert.notStrictEqual(byId.shop_status.value, 'Open');
      })
    );
  });

  // --- 4. Unavailable is never a fake zero --------------------------------------------

  await testAsync('NEVER A FAKE ZERO: scope-limited metrics are null + available:false + a real reason', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
        const byId = Object.fromEntries(data.etsy.metrics.map((m) => [m.id, m]));
        for (const id of ['orders', 'revenue', 'customers', 'sessions', 'conversion_rate']) {
          const metric = byId[id];
          assert.ok(metric, `${id} must be reported, not silently omitted`);
          assert.strictEqual(metric.available, false, `${id} must not be claimed as measured`);
          // 0 would read as "your Etsy shop sold nothing" - a fabricated claim about a
          // real business. null is the only honest value.
          assert.strictEqual(metric.value, null, `${id} must be null, never 0`);
          assert.notStrictEqual(metric.value, 0);
          assert.ok(
            typeof metric.reason === 'string' && metric.reason.length > 0,
            `${id} must state WHY it is unavailable`
          );
        }
        // The reason must name the real cause - the scopes this integration holds.
        assert.ok(/scope/i.test(byId.orders.reason));
      })
    );
  });

  await testAsync('Inventory and images are declared unavailable WITH the reason, not silently skipped', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const { catalog } = JSON.parse((await authedGet(port, '/store/metrics')).raw).etsy;
        assert.strictEqual(catalog.inventory_available, false);
        assert.strictEqual(catalog.images_available, false);
        assert.ok(/per listing/i.test(catalog.inventory_reason));
        assert.ok(/per listing/i.test(catalog.images_reason));
      })
    );
  });

  // --- 5 + 6 + 7. Channel isolation ----------------------------------------------------

  await testAsync('EVERY Etsy listing record reaching the dashboard carries channel:"etsy"', async () => {
    await withEtsyConnected(
      { listings: etsyListingsOk([etsyListingEntry(), etsyListingEntry({ listing: { listing_id: 2, title: 'Second' } })]) },
      () =>
        withServer(async (port) => {
          const { catalog } = JSON.parse((await authedGet(port, '/store/metrics')).raw).etsy;
          assert.strictEqual(catalog.listings.length, 2);
          for (const listing of catalog.listings) {
            assert.strictEqual(listing.channel, 'etsy', 'a listing must never lose its channel stamp');
          }
        })
    );
  });

  await testAsync('Shopify data is never stamped etsy, and never appears inside the etsy block', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'success', result: { specialized_records: [{ sales: { actual_metrics: [] } }] }, error: null }),
      () =>
        withMocked(shopifyClient, 'getOrders', async () => [{ test: false, lineItems: [{ title: 'Shopify Bundle', quantity: 3 }] }], () =>
          withMocked(etsyReadClient, 'canRead', () => true, () =>
            withMocked(etsyShopDataTool, 'runEtsyShopDataTool', async () => etsyShopOk(), () =>
              withMocked(etsyListingDataTool, 'runEtsyListingDataTool', async () => etsyListingsOk(), () =>
                withServer(async (port) => {
                  const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
                  // The Shopify product exists in top_products and NOWHERE in the etsy block.
                  assert.ok(data.top_products.products.some((p) => p.title === 'Shopify Bundle'));
                  assert.ok(
                    !JSON.stringify(data.etsy).includes('Shopify Bundle'),
                    'a Shopify product must never appear inside the Etsy block'
                  );
                  // And no Shopify-sourced structure acquires an etsy channel stamp.
                  assert.ok(!JSON.stringify(data.top_products).includes('etsy'));
                  assert.ok(!JSON.stringify(data.capabilities).includes('"channel":"etsy"'));
                })
              )
            )
          )
        )
    );
  });

  await testAsync('NO MERGE: identically-titled Shopify and Etsy records stay two separate records', async () => {
    const sameTitle = 'Birthday Invitation Template';
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'empty', result: null, error: null }),
      () =>
        withMocked(shopifyClient, 'getOrders', async () => [{ test: false, lineItems: [{ title: sameTitle, quantity: 9 }] }], () =>
          withMocked(etsyReadClient, 'canRead', () => true, () =>
            withMocked(etsyShopDataTool, 'runEtsyShopDataTool', async () => etsyShopOk(), () =>
              withMocked(
                etsyListingDataTool,
                'runEtsyListingDataTool',
                async () => etsyListingsOk([etsyListingEntry({ listing: { title: sameTitle } })]),
                () =>
                  withServer(async (port) => {
                    const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
                    const shopifyRow = data.top_products.products.find((p) => p.title === sameTitle);
                    const etsyRow = data.etsy.catalog.listings.find((l) => l.title === sameTitle);
                    // Both exist, independently. A matching title is not an identity claim -
                    // two stores can sell a similarly-named product without it being one item.
                    assert.ok(shopifyRow, 'the Shopify record must survive');
                    assert.ok(etsyRow, 'the Etsy record must survive');
                    assert.strictEqual(etsyRow.channel, 'etsy');
                    assert.strictEqual(shopifyRow.units, 9, 'the Shopify figure must be untouched by the Etsy record');
                  })
              )
            )
          )
        )
    );
  });

  test('THE MERGE PRIMITIVE DOES NOT EXIST: channelModel exports only narrowing', () => {
    // The structural guarantee behind the test above. If a merge/join/id-equivalence
    // helper is ever added, this fails and the isolation claim gets re-examined.
    for (const name of Object.keys(channelModel)) {
      assert.ok(
        !/merge|join|combine|unify|match|equivalen|dedup|reconcile/i.test(name),
        `channelModel must export no cross-channel identity function - found "${name}"`
      );
    }
    // recordsForChannel narrows and only narrows.
    const mixed = [
      { channel: 'shopify', title: 'A' },
      { channel: 'etsy', title: 'A' },
    ];
    assert.strictEqual(channelModel.recordsForChannel(mixed, 'etsy').length, 1);
    assert.strictEqual(channelModel.recordsForChannel(mixed, 'shopify').length, 1);
  });

  // --- 8. No credential reaches the frontend -------------------------------------------

  await testAsync('SECURITY: the /store/metrics payload carries no Etsy credential of any kind', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const res = await authedGet(port, '/store/metrics');
        // Key NAMES and secret VALUES alike - neither belongs in a browser payload.
        assert.ok(
          !/accessToken|access_token|refresh_token|refreshToken|apiKey|api_key|keystring|shared_secret|sharedSecret|x-api-key|password|secret|bearer/i.test(
            res.raw
          ),
          'no credential-shaped field may appear in the dashboard payload'
        );
        assert.ok(!res.raw.includes(TEST_API_KEY), 'the server API key must never be echoed');
        // The raw seller description is dropped too - it is not a secret, but relaying it
        // would bloat every response for a field no dashboard row shows.
        assert.ok(!res.raw.includes('must not be relayed to the dashboard'));
      })
    );
  });

  await testAsync('SECURITY: the /overview payload carries no Etsy credential either', async () => {
    await withMocked(etsyReadClient, 'canRead', () => true, () =>
      withServer(async (port) => {
        const res = await authedGet(port, '/overview');
        assert.ok(
          !/accessToken|access_token|refresh_token|apiKey|api_key|keystring|shared_secret|x-api-key|password|secret/i.test(res.raw)
        );
        assert.ok(!res.raw.includes(TEST_API_KEY));
      })
    );
  });

  // --- 9. No Etsy write is registered or reachable ---------------------------------------

  test('NO ETSY WRITE: no publish/write Etsy tool exists in the registry', () => {
    const etsyTools = TOOL_REGISTRY.filter((tool) => /etsy/i.test(tool.id));
    assert.ok(etsyTools.length > 0, 'the read tools must be registered');
    for (const tool of etsyTools) {
      assert.strictEqual(tool.operation, 'read', `${tool.id} must be a read operation`);
      assert.strictEqual(TOOL_CLASSIFICATIONS[tool.id], 'analysis_only', `${tool.id} must be analysis_only`);
      assert.ok(!/publish|create|update|delete|write|renew/i.test(tool.id), `${tool.id} must not name a write action`);
    }
    assert.strictEqual(getToolById('etsy_shop_data_retrieval').status, 'implemented');
    assert.strictEqual(getToolById('etsy_listing_data_retrieval').status, 'implemented');
  });

  test('NO ETSY WRITE: publishing stays closed, and the payload says so', () => {
    // The publish gate is independent of this phase's work - asserted here so a dashboard
    // change can never be the thing that opens it.
    assert.strictEqual(etsyClient.canPublish(), false);
  });

  await testAsync('NO ETSY WRITE: the dashboard payload declares publishing disabled', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
        assert.strictEqual(data.etsy.access, 'read_only');
        assert.strictEqual(data.etsy.publishing_enabled, false);
        assert.ok(typeof data.etsy.publishing_note === 'string' && data.etsy.publishing_note.length > 0);
      })
    );
  });

  test('NO ETSY WRITE: server.js requires no Etsy write path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    // The publishing modules are referenced in prose only, never required.
    assert.ok(!/require\([^)]*etsyPublishing/.test(source), 'server.js must not require the Etsy publishing module');
    assert.ok(!/require\([^)]*adapters\/etsyClient/.test(source), 'server.js must not require the Etsy publish client');
  });

  // --- 10. The existing Shopify dashboard is untouched -----------------------------------

  await testAsync('SHOPIFY UNCHANGED: the Shopify blocks are identical with Etsy connected and disconnected', async () => {
    const shopifyOnly = (fn) =>
      withMocked(
        analyticsDataTool,
        'runAnalyticsDataTool',
        async ({ analyticsCapability }) =>
          analyticsCapability === 'sales'
            ? {
                status: 'success',
                error: null,
                result: {
                  limitations: [],
                  specialized_records: [
                    { sales: { actual_metrics: [{ label: 'order', value: '5.00', unit: 'USD', createdAt: '2026-03-01T09:00:00Z' }] } },
                  ],
                },
              }
            : { status: 'empty', result: null, error: null },
        () => withMocked(shopifyClient, 'getOrders', async () => [{ test: false, lineItems: [{ title: 'A', quantity: 1 }] }], fn)
      );

    let withoutEtsy = null;
    let withEtsy = null;

    await shopifyOnly(() =>
      withMocked(etsyReadClient, 'canRead', () => false, () =>
        withServer(async (port) => {
          const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
          withoutEtsy = JSON.stringify([data.capabilities, data.trends, data.funnel, data.top_products]);
        })
      )
    );

    await shopifyOnly(() =>
      withMocked(etsyReadClient, 'canRead', () => true, () =>
        withMocked(etsyShopDataTool, 'runEtsyShopDataTool', async () => etsyShopOk(), () =>
          withMocked(etsyListingDataTool, 'runEtsyListingDataTool', async () => etsyListingsOk(), () =>
            withServer(async (port) => {
              const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
              withEtsy = JSON.stringify([data.capabilities, data.trends, data.funnel, data.top_products]);
            })
          )
        )
      )
    );

    // Byte-identical: connecting Etsy must not move a single Shopify number.
    assert.strictEqual(withEtsy, withoutEtsy, 'the Shopify sections must be unaffected by Etsy');
    // And the Shopify trend still names only its own channel.
    const parsed = JSON.parse(withEtsy)[1];
    const seriesChannels = parsed.metrics.flatMap((m) => m.channels.map((c) => c.id));
    assert.deepStrictEqual([...new Set(seriesChannels)], ['shopify'], 'Etsy must not be injected into the Shopify trend series');
  });

  // --- 11. No API-call storm --------------------------------------------------------------

  await testAsync('NO CALL STORM: each Etsy tool is called at most once per /store/metrics build', async () => {
    let shopCalls = 0;
    let listingCalls = 0;
    await withEtsyConnected(
      {
        onShopCall: () => {
          shopCalls += 1;
        },
        onListingCall: () => {
          listingCalls += 1;
        },
      },
      () =>
        withServer(async (port) => {
          await authedGet(port, '/store/metrics');
          assert.strictEqual(shopCalls, 1, 'the shop must be read exactly once');
          assert.strictEqual(listingCalls, 1, 'listings must be read exactly once');
        })
    );
  });

  await testAsync('NO CALL STORM: a cached /store/metrics response re-reads nothing from Etsy', async () => {
    const savedTtl = process.env.OVERVIEW_METRICS_TTL_MS;
    process.env.OVERVIEW_METRICS_TTL_MS = String(5 * 60 * 1000);
    let shopCalls = 0;
    let listingCalls = 0;
    try {
      await withEtsyConnected(
        {
          onShopCall: () => {
            shopCalls += 1;
          },
          onListingCall: () => {
            listingCalls += 1;
          },
        },
        () =>
          withServer(async (port) => {
            const first = JSON.parse((await authedGet(port, '/store/metrics')).raw);
            assert.strictEqual(first.cached, false);
            const second = JSON.parse((await authedGet(port, '/store/metrics')).raw);
            assert.strictEqual(second.cached, true);
            const third = JSON.parse((await authedGet(port, '/store/metrics')).raw);
            assert.strictEqual(third.cached, true);
            // Three dashboard loads, one Etsy read each - this is what stops a dashboard
            // refresh from becoming an Etsy request storm.
            assert.strictEqual(shopCalls, 1);
            assert.strictEqual(listingCalls, 1);
            // The cached response still carries the full Etsy block.
            assert.strictEqual(third.etsy.shop.shop_id, 62500594);
          })
      );
    } finally {
      process.env.OVERVIEW_METRICS_TTL_MS = savedTtl;
    }
  });

  await testAsync('NO CALL STORM: the listing read is bounded, and never walks the catalogue', async () => {
    let requestedLimit = null;
    await withEtsyConnected(
      {
        onListingCall: (params) => {
          requestedLimit = params && params.limit;
        },
      },
      () =>
        withServer(async (port) => {
          const data = JSON.parse((await authedGet(port, '/store/metrics')).raw);
          assert.strictEqual(requestedLimit, 25, 'the read must be explicitly bounded');
          // The catalogue TOTAL comes from the shop record, not from counting this page -
          // so a bounded read can never understate the shop.
          const active = data.etsy.metrics.find((m) => m.id === 'active_listings');
          assert.strictEqual(active.value, 75);
          assert.strictEqual(data.etsy.catalog.listing_count, 1);
          assert.deepStrictEqual(data.etsy.catalog.pagination, { limit: 25, offset: 0 });
        })
    );
  });

  // --- Degradation ------------------------------------------------------------------------

  await testAsync('A failed Etsy read degrades the Etsy block alone, never the Shopify response', async () => {
    await withEtsyConnected(
      {
        shop: { status: 'failed', result: null, error: 'Etsy returned 503.' },
        listings: { status: 'failed', result: null, error: 'Etsy returned 503.' },
      },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          assert.strictEqual(res.status, 200, 'the rest of the response must still be served');
          const data = JSON.parse(res.raw);
          assert.ok(data.capabilities, 'the Shopify capabilities must still be present');
          assert.strictEqual(data.etsy.shop, null);
          assert.strictEqual(data.etsy.shop_status, 'failed');
          // The tool's own message is relayed - the dashboard never invents a cause.
          assert.strictEqual(data.etsy.shop_error, 'Etsy returned 503.');
          const active = data.etsy.metrics.find((m) => m.id === 'active_listings');
          assert.strictEqual(active.available, false);
          assert.strictEqual(active.value, null, 'a failed read must not become 0 listings');
          assert.ok(active.reason.includes('503'), 'the real reason must reach the reader');
        })
    );
  });

  /* ================================================================================
     POST /etsy/analyze - the read-only SEO / Listing triggers
     ================================================================================ */

  const ETSY_LISTING_ID = 4568436794;

  await testAsync('TRIGGER: an Etsy SEO analysis runs on the real Etsy listing data', async () => {
    let listingReads = 0;
    await withEtsyConnected(
      {
        onListingCall: () => {
          listingReads += 1;
        },
      },
      () =>
        withServer(async (port) => {
          const res = await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' });
          assert.strictEqual(res.status, 200);
          const data = JSON.parse(res.raw);
          assert.strictEqual(data.channel, 'etsy');
          assert.strictEqual(data.analysis, 'seo');
          assert.strictEqual(data.listing.listing_id, ETSY_LISTING_ID);
          assert.strictEqual(data.listing.channel, 'etsy');
          // The SEO specialist actually ran, through the existing execution path - this
          // is not a stub response, and the tool was the pinned read-only one.
          assert.strictEqual(data.selected_specialist.id, 'seo');
          assert.deepStrictEqual(data.tool_calls, ['seo_analysis']);
          // The Etsy data came from the existing read tool, not from a second fetch path.
          assert.strictEqual(listingReads, 1);
        })
    );
  });

  await testAsync('TRIGGER: an Etsy Listing analysis is draft-only and says so in the payload', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const res = await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'listing' });
        assert.strictEqual(res.status, 200);
        const data = JSON.parse(res.raw);
        assert.strictEqual(data.channel, 'etsy');
        assert.strictEqual(data.analysis, 'listing');
        assert.strictEqual(data.selected_specialist.id, 'listing');
        assert.deepStrictEqual(data.tool_calls, ['listing_content_generation']);
        // The two facts that make "draft only" machine-checkable rather than a promise
        // made in a comment.
        assert.strictEqual(data.applied_to_etsy, false);
        assert.strictEqual(data.etsy_write_attempted, false);
      })
    );
  });

  await testAsync('TRIGGER: provenance names the real endpoint and the real listing, never a placeholder', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        for (const analysis of ['seo', 'listing']) {
          const data = JSON.parse((await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis })).raw);
          assert.strictEqual(data.provenance.endpoint, 'getListingsByShop');
          assert.strictEqual(data.provenance.listing_id, ETSY_LISTING_ID);
          const source = data.provenance.source[0];
          assert.ok(source.includes('Etsy Open API v3'), 'the source must name the real API');
          assert.ok(source.includes(String(ETSY_LISTING_ID)), 'the source must name the real listing');
          assert.ok(!/placeholder|example|sample|TODO/i.test(source), 'no placeholder source may be recorded');
        }
      })
    );
  });

  await testAsync('TRIGGER: unknown facts stay NEEDS_INFORMATION and are never asserted', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' })).raw);
        assert.deepStrictEqual(data.compliance.needs_information, ['file_formats', 'dimensions']);
        // The whole response must not assert any of the facts the listing does not
        // establish. These are the exact inventions this integration exists to prevent.
        const body = JSON.stringify(data);
        for (const invented of ['300 dpi', 'PDF', 'JPEG', 'Canva', 'commercial use', 'instant download', 'ships in']) {
          assert.ok(!new RegExp(invented, 'i').test(body), `the analysis must not assert "${invented}"`);
        }
      })
    );
  });

  await testAsync('TRIGGER: no invented SEO claim - no search volume, ranking, or competitor data', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const body = (await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' })).raw;
        for (const claim of ['search volume', 'high volume', 'monthly searches', 'ranks #', 'competitor listing']) {
          assert.ok(!new RegExp(claim, 'i').test(body), `the analysis must not claim "${claim}"`);
        }
        // Etsy's own spec declares no title/tag ceiling, so no such number may be asserted
        // as a platform limit. "13 tag slots" was exactly that kind of unsourced claim.
        assert.ok(!/13 (tag )?slots|of the 13|140 characters/i.test(body), 'no unsourced Etsy ceiling may be asserted');
      })
    );
  });

  await testAsync('TRIGGER: the saved run record carries EXPLICIT channel metadata', async () => {
    const runHistoryStore = require('../../agent/core/runHistoryStore');
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const data = JSON.parse((await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' })).raw);
        const saved = runHistoryStore.getRunRecordById(data.run_id);
        assert.strictEqual(saved.channel, 'etsy');
        assert.strictEqual(saved.channel_reference, String(ETSY_LISTING_ID));
        assert.strictEqual(saved.specialist_id, 'seo');
        // And it surfaces through the listing summary Activity/History actually renders.
        const summary = runHistoryStore.listRunRecordSummaries({ limit: 50 }).find((s) => s.run_id === data.run_id);
        assert.strictEqual(summary.channel, 'etsy');
        assert.strictEqual(summary.channel_reference, String(ETSY_LISTING_ID));
      })
    );
  });

  test('ACTIVITY: a run with no channel keeps its existing shape - channel is never inferred', () => {
    const runHistoryStore = require('../../agent/core/runHistoryStore');
    const runId = 'run-no-channel-' + Math.random().toString(36).slice(2, 8);
    runHistoryStore.saveRunRecord({
      run_id: runId,
      kind: 'run',
      // An objective that MENTIONS Etsy. A channel must still not be inferred from text.
      objective: 'Analyse my Etsy invitation listings and my Shopify products.',
      specialist_id: 'research',
      specialist_name: 'Research',
      status: 'success',
      summary: 'Done.',
      created_at: new Date().toISOString(),
      result: {},
    });
    const summary = runHistoryStore.listRunRecordSummaries({ limit: 50 }).find((s) => s.run_id === runId);
    assert.strictEqual(summary.channel, null, 'a channel must never be guessed from an objective');
    assert.strictEqual(summary.channel_reference, null);
  });

  await testAsync('TRIGGER: fails closed when Etsy is not connected, attempting no Etsy request', async () => {
    let reads = 0;
    await withMocked(etsyReadClient, 'canRead', () => false, () =>
      withMocked(
        etsyListingDataTool,
        'runEtsyListingDataTool',
        async () => {
          reads += 1;
          return etsyListingsOk();
        },
        () =>
          withServer(async (port) => {
            const res = await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(reads, 0, 'no Etsy read may be attempted when reading is not configured');
          })
      )
    );
  });

  await testAsync('TRIGGER: refuses an unknown analysis, a bad listing id, and a listing not in this shop', async () => {
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        // Only the two read-only analyses exist - nothing that could name a write action.
        for (const analysis of ['publish', 'update', 'delete', 'renew', '']) {
          const res = await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis });
          assert.strictEqual(res.status, 400, `"${analysis}" must be refused`);
        }
        // A non-numeric id is refused before it can reach anything.
        for (const badId of ['../../etc/passwd', 'abc', '', null]) {
          const res = await authedPost(port, '/etsy/analyze', { listing_id: badId, analysis: 'seo' });
          assert.strictEqual(res.status, 400);
        }
        // A real-looking id that is not in THIS shop's listings is a 404, never an
        // analysis of some other seller's listing.
        const notMine = await authedPost(port, '/etsy/analyze', { listing_id: 999999999, analysis: 'seo' });
        assert.strictEqual(notMine.status, 404);
      })
    );
  });

  await testAsync('TRIGGER: requires the API key, like every other route', async () => {
    await withServer(async (port) => {
      const res = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ listing_id: ETSY_LISTING_ID, analysis: 'seo' });
        const r = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/etsy/analyze',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode }));
          }
        );
        r.on('error', reject);
        r.write(payload);
        r.end();
      });
      assert.strictEqual(res.status, 401);
    });
  });

  await testAsync('TRIGGER: no credential reaches the analysis payload or the saved record', async () => {
    const runHistoryStore = require('../../agent/core/runHistoryStore');
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const res = await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' });
        const pattern = /accessToken|access_token|refresh_token|refreshToken|keystring|shared_secret|sharedSecret|x-api-key|oauth_code/i;
        assert.ok(!pattern.test(res.raw), 'no credential-shaped field may appear in the analysis response');
        assert.ok(!res.raw.includes(TEST_API_KEY));
        const saved = runHistoryStore.getRunRecordById(JSON.parse(res.raw).run_id);
        assert.ok(!pattern.test(JSON.stringify(saved)), 'no credential may be persisted into a run record');
      })
    );
  });

  await testAsync('TRIGGER: an Etsy analysis never becomes a Shopify one, and vice versa', async () => {
    const runHistoryStore = require('../../agent/core/runHistoryStore');
    await withEtsyConnected({}, () =>
      withServer(async (port) => {
        const etsyRun = JSON.parse((await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' })).raw);
        // A Shopify-side run through the untouched /run path carries no channel at all.
        const shopifyRunId = 'run-shopify-' + Math.random().toString(36).slice(2, 8);
        runHistoryStore.saveRunRecord({
          run_id: shopifyRunId,
          kind: 'run',
          objective: 'Shopify product analysis.',
          specialist_id: 'product',
          specialist_name: 'Product',
          status: 'success',
          summary: 'Done.',
          created_at: new Date().toISOString(),
          result: {},
        });
        const summaries = runHistoryStore.listRunRecordSummaries({ limit: 50 });
        assert.strictEqual(summaries.find((s) => s.run_id === etsyRun.run_id).channel, 'etsy');
        assert.strictEqual(summaries.find((s) => s.run_id === shopifyRunId).channel, null);
        // The Etsy run's own payload never claims a Shopify identity.
        assert.ok(!/"channel":"shopify"/.test(JSON.stringify(etsyRun)));
      })
    );
  });

  await testAsync('TRIGGER: reuses the cached Etsy read - an analysis costs no extra Etsy request', async () => {
    // The read tool is called once per analysis, and etsyReadClient's own 60s response
    // cache plus in-flight de-duplication mean those calls do not each become HTTP
    // traffic. This asserts the layer this server controls: no per-listing GET, no
    // inventory read, no images read is ever issued for an analysis.
    let shopReads = 0;
    await withEtsyConnected(
      {
        onShopCall: () => {
          shopReads += 1;
        },
      },
      () =>
        withServer(async (port) => {
          await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'seo' });
          await authedPost(port, '/etsy/analyze', { listing_id: ETSY_LISTING_ID, analysis: 'listing' });
          assert.strictEqual(shopReads, 0, 'an analysis must not trigger a shop read');
        })
    );
  });

  test('TRIGGER: the analysis route can only reach read-only, analysis_only tools', () => {
    // Structural: the route pins its tool explicitly, and both pinned tools are
    // analysis_only reads owned by their specialist. No Etsy write tool exists to pin.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const block = source.slice(source.indexOf('const ETSY_ANALYSES'), source.indexOf('const ETSY_ANALYSES') + 700);
    assert.ok(block.includes("toolId: 'seo_analysis'"));
    assert.ok(block.includes("toolId: 'listing_content_generation'"));
    for (const toolId of ['seo_analysis', 'listing_content_generation']) {
      assert.strictEqual(TOOL_CLASSIFICATIONS[toolId], 'analysis_only', `${toolId} must be analysis_only`);
    }
  });

  test('NO NEW SCOPES: the OAuth layer still requests exactly shops_r and listings_r', () => {
    const etsyOAuth = require('../../integrations/etsyOAuth');
    assert.deepStrictEqual(
      [...etsyOAuth.ETSY_REQUIRED_SCOPES].sort(),
      ['listings_r', 'shops_r'],
      'no scope may be added by this phase'
    );
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    // No WRITE or destructive scope name appears anywhere in the server route file. These
    // never occur in explanatory prose, so any occurrence would be a real request.
    for (const scope of ['listings_w', 'listings_d', 'shops_w', 'listings_d', 'feedback_r', 'billing_r']) {
      assert.ok(!source.includes(scope), `server.js must not reference the ${scope} scope`);
    }
    // transactions_r / receipts_r DO appear - but only inside the sentence explaining why
    // order and buyer metrics are unavailable. They must be named as NOT requested, and
    // must never be passed to the OAuth layer: server.js does not require it at all, so
    // it has no way to request a scope in the first place.
    assert.ok(/transactions_r\/receipts_r, which are deliberately not requested/.test(source));
    assert.ok(!/require\([^)]*etsyOAuth/.test(source), 'server.js must not reach the OAuth layer to widen a scope');
    // The scope list itself is a frozen, read-only pair the OAuth module owns.
    assert.ok(etsyOAuth.ETSY_REQUIRED_SCOPES.every((s) => s.endsWith('_r')), 'every granted scope must be a read scope');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyDashboardIntegration.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
