'use strict';

// Tests for the two new dashboard read-only endpoints (server.js: GET /overview,
// GET /store/metrics) - the backend surface behind the Overview control-center
// upgrade (public/index.html + dashboard.js). Follows verification/testing/server.test.js's
// harness exactly: real HTTP requests against a locally started createApp() instance,
// a throwaway RUN_HISTORY_STORE_DIR so this suite never touches this project's own
// memory/state/runs/, and monkey-patched module functions so neither suite ever makes
// a real network call to Shopify or a model provider.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-overview-test-'));

const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const { createApp } = require('../../server');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
// The READ client, not the publishing client: GET /overview reports whether this Etsy shop
// can be READ, which is the only Etsy capability this project has. See server.js's
// DASHBOARD_CHANNELS comment.
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const analyticsDataTool = require('../../tools/analyticsDataTool');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyListingDataTool = require('../../tools/etsyListingDataTool');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');

// THIS SUITE MUST NEVER TOUCH THE REAL ETSY API. GET /store/metrics reads Etsy whenever
// canRead() is true - and on the owner's own machine Etsy IS configured, so without this
// the suite would spend real Etsy quota and its results would depend on a live shop.
// Pinned false for the whole file; the tests that assert Etsy behavior re-mock it
// themselves, and verification/testing/etsyDashboardIntegration.test.js covers the
// connected path with the tools mocked at the module boundary.
etsyReadClient.canRead = () => false;

let passed = 0;
let failed = 0;

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

// Monkey-patches an adapter/tool's exported function for the duration of `fn`, the same
// convention verification/testing/server.test.js's withMockedSendMessage/
// withMockedBuildPlanStep already establish - restores the original unconditionally.
function withMocked(moduleObj, fnName, mockImpl, fn) {
  const saved = moduleObj[fnName];
  moduleObj[fnName] = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      moduleObj[fnName] = saved;
    });
}

function seedRunRecord(overrides) {
  const record = Object.assign(
    {
      run_id: `run-test-${Math.random().toString(36).slice(2, 10)}`,
      kind: 'run',
      status: 'success',
      summary: 'A test summary.',
      created_at: new Date().toISOString(),
      result: {},
    },
    overrides
  );
  runHistoryStore.saveRunRecord(record);
  return record;
}

async function main() {
  await testAsync('GET /overview requires the API key', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'GET', path: '/overview' });
      // AGENT_API_KEY IS set in this suite (see top of file) - an unauthenticated
      // request is refused with 401, not the 503 fail-closed status
      // security/serverAccessControl.test.js covers for an unset key entirely.
      assert.strictEqual(res.status, 401);
    });
  });

  await testAsync('GET /store/metrics requires the API key', async () => {
    await withServer(async (port) => {
      const res = await request(port, { method: 'GET', path: '/store/metrics' });
      assert.strictEqual(res.status, 401);
    });
  });

  await testAsync('GET /overview never calls Shopify, Etsy, or any live-data tool - local state only', async () => {
    let shopifyCalled = false;
    let etsyCalled = false;
    let analyticsCalled = false;
    let etsyShopToolCalled = false;
    let etsyListingToolCalled = false;
    await withMocked(
      shopifyClient,
      'isConfigured',
      () => {
        shopifyCalled = true;
        return true;
      },
      () =>
        withMocked(
          etsyReadClient,
          'canRead',
          () => {
            etsyCalled = true;
            return false;
          },
          () =>
            withMocked(
              analyticsDataTool,
              'runAnalyticsDataTool',
              async () => {
                analyticsCalled = true;
                return { status: 'failed', result: null, error: 'should not be called' };
              },
              () =>
                withMocked(
                  etsyShopDataTool,
                  'runEtsyShopDataTool',
                  async () => {
                    etsyShopToolCalled = true;
                    return { status: 'failed', result: null, error: 'should not be called' };
                  },
                  () =>
                    withMocked(
                      etsyListingDataTool,
                      'runEtsyListingDataTool',
                      async () => {
                        etsyListingToolCalled = true;
                        return { status: 'failed', result: null, error: 'should not be called' };
                      },
                      () =>
                        withServer(async (port) => {
                          const res = await authedGet(port, '/overview');
                          assert.strictEqual(res.status, 200);
                          // These ARE the local, zero-network credential-presence checks
                          // GET /overview is documented to use - they are expected to run.
                          assert.strictEqual(shopifyCalled, true);
                          assert.strictEqual(etsyCalled, true);
                          // No live-data tool, for EITHER channel, may be reached from this
                          // endpoint - that is what keeps it free to call on every page load.
                          assert.strictEqual(analyticsCalled, false);
                          assert.strictEqual(etsyShopToolCalled, false);
                          assert.strictEqual(etsyListingToolCalled, false);
                        })
                    )
                )
            )
        )
    );
  });

  await testAsync('GET /overview reports the AI provider from configuration only, never a key or raw value', async () => {
    await withMocked(aiProviderSelector, 'getActiveProvider', () => 'gemini', () =>
      withMocked(aiProviderSelector, 'isConfigured', () => true, () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/overview');
          assert.strictEqual(res.status, 200);
          assert.deepStrictEqual(JSON.parse(res.raw).ai_provider, { provider: 'gemini', configured: true, detail: null });
        })
      )
    );

    await withMocked(aiProviderSelector, 'getActiveProvider', () => 'claude', () =>
      withMocked(aiProviderSelector, 'isConfigured', () => false, () =>
        withServer(async (port) => {
          const payload = JSON.parse((await authedGet(port, '/overview')).raw);
          assert.strictEqual(payload.ai_provider.provider, 'claude');
          assert.strictEqual(payload.ai_provider.configured, false, 'a missing key must never read as configured');
        })
      )
    );

    await withMocked(
      aiProviderSelector,
      'getActiveProvider',
      () => {
        throw new Error("Unrecognized AI_PROVIDER value 'raw-provider-value'");
      },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/overview');
          assert.strictEqual(res.status, 200, 'a bad AI_PROVIDER must not take the whole overview down');
          const payload = JSON.parse(res.raw);
          assert.strictEqual(payload.ai_provider.provider, null);
          assert.strictEqual(payload.ai_provider.configured, false);
          assert.ok(!res.raw.includes('raw-provider-value'), 'the raw AI_PROVIDER value must not be echoed');
        })
    );

    // Whatever keys this machine really holds, none of them may appear in the payload.
    const realKeys = [process.env.GEMINI_API_KEY, process.env.ANTHROPIC_API_KEY].filter(
      (value) => typeof value === 'string' && value.trim().length >= 8
    );
    await withServer(async (port) => {
      const raw = (await authedGet(port, '/overview')).raw;
      for (const key of realKeys) assert.ok(!raw.includes(key), 'a provider API key must never appear in /overview');
    });

    // The status module is how server.js reports the provider WITHOUT reaching a model
    // (askOrchestrationRouting.test.js forbids server.js from requiring a model client or the
    // selector). So it must stay status-only: no sendMessage exported, and none called.
    const statusModule = require('../../agent/core/aiProviderStatus');
    assert.deepStrictEqual(Object.keys(statusModule), ['getAiProviderStatus']);
    const statusSource = fs.readFileSync(path.join(__dirname, '../../agent/core/aiProviderStatus.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(!/sendMessage|fetch\(/.test(statusSource), 'aiProviderStatus.js must never send a model call');
  });

  await testAsync('GET /overview reports Shopify connected and Etsy not connected from real adapter checks', async () => {
    await withMocked(
      shopifyClient,
      'isConfigured',
      () => true,
      () =>
        withMocked(etsyReadClient, 'canRead', () => false, () =>
          withServer(async (port) => {
            const res = await authedGet(port, '/overview');
            const data = JSON.parse(res.raw);
            const shopify = data.channels.find((c) => c.id === 'shopify');
            const etsy = data.channels.find((c) => c.id === 'etsy');
            const amazon = data.channels.find((c) => c.id === 'amazon');
            assert.strictEqual(shopify.configured, true);
            assert.strictEqual(shopify.adapter_exists, true);
            assert.strictEqual(etsy.configured, false);
            assert.strictEqual(etsy.adapter_exists, true);
            // A platform with no real adapter in this repo must never be reported as
            // connectable - adapter_exists false, configured false, always.
            assert.strictEqual(amazon.adapter_exists, false);
            assert.strictEqual(amazon.configured, false);
          })
        )
    );
  });

  await testAsync('GET /overview: a specialist with no saved run is reported as null, never a fabricated status', async () => {
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      // This suite's own throwaway RUN_HISTORY_STORE_DIR starts empty for this request
      // (no seed has run yet in this process at this point in file order... but other
      // tests above have already seeded nothing yet either - assert every specialist is
      // null OR, if a later test already seeded one, that a genuinely never-run one
      // (e.g. "marketing") stays null unless this test itself seeded it).
      assert.strictEqual(data.specialists.marketing, null);
    });
  });

  await testAsync('GET /overview: specialist rollup matches seeded run records exactly', async () => {
    const record = seedRunRecord({
      run_id: 'run-seed-product-1',
      kind: 'run',
      specialist_id: 'product',
      specialist_name: 'Product',
      status: 'success',
      summary: 'Product completed this request successfully.',
      created_at: '2026-01-01T00:00:00.000Z',
      result: { outputs: { status: 'success', result: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    });
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      const entry = data.specialists.product;
      assert.ok(entry, 'expected a rollup entry for product');
      assert.strictEqual(entry.last_run_id, record.run_id);
      assert.strictEqual(entry.last_status, 'success');
      assert.strictEqual(entry.last_summary, record.summary);
      assert.strictEqual(entry.last_run_at, record.created_at);
      // outputs.result is a real 3-element array on this seeded record - the record
      // count must be read from it exactly, never estimated.
      assert.strictEqual(entry.last_result_count, 3);
      assert.strictEqual(entry.run_count, 1);
    });
  });

  await testAsync('GET /overview: opportunities are relayed verbatim from growth_opportunity_drafts, never re-derived', async () => {
    seedRunRecord({
      run_id: 'run-seed-orch-opportunities',
      kind: 'orchestrate',
      status: 'success',
      summary: 'Research completed.',
      created_at: '2026-01-02T00:00:00.000Z',
      result: {
        growth_opportunity_drafts: [
          {
            opportunity: 'Bundle the top 3 Halloween SVGs at a 10% discount',
            category: 'pricing',
            reason: 'Segment: crafters',
            requiredAction: 'Create a bundle listing',
            verificationStatus: 'verified',
          },
        ],
      },
    });
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      const found = data.opportunities.find((o) => o.title === 'Bundle the top 3 Halloween SVGs at a 10% discount');
      assert.ok(found, 'expected the seeded opportunity draft to be relayed');
      assert.strictEqual(found.source_kind, 'growth_opportunity_draft');
      assert.strictEqual(found.verification_status, 'verified');
      assert.strictEqual(found.run_id, 'run-seed-orch-opportunities');
      // No scoring/ranking field is invented - only what the source record carried.
      assert.strictEqual(found.category, 'pricing');
    });
  });

  await testAsync('GET /overview: a business with no growth_opportunity_drafts and no recommendations yields no opportunities for it', async () => {
    const record = seedRunRecord({
      run_id: 'run-seed-no-opportunities',
      kind: 'run',
      specialist_id: 'listing',
      status: 'partial',
      summary: 'Listing needs more input.',
      created_at: '2026-01-03T00:00:00.000Z',
      result: { outputs: { status: 'failed', result: null, error: 'missing input' } },
    });
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      const fromThisRecord = data.opportunities.filter((o) => o.run_id === record.run_id);
      assert.deepStrictEqual(fromThisRecord, []);
    });
  });

  await testAsync('GET /overview: an unconfigured Shopify is reported honestly, never as a connected channel', async () => {
    await withMocked(shopifyClient, 'isConfigured', () => false, () =>
      withServer(async (port) => {
        const res = await authedGet(port, '/overview');
        const data = JSON.parse(res.raw);
        const shopify = data.channels.find((c) => c.id === 'shopify');
        assert.strictEqual(shopify.configured, false);
        const shopifyHealth = data.health.find((h) => h.id === 'shopify_connection');
        assert.strictEqual(shopifyHealth.status, 'warn');
      })
    );
  });

  await testAsync('GET /overview payload carries no token, key, or credential field', async () => {
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      assert.ok(!/accessToken|access_token|apiKey|api_key|password|secret/i.test(res.raw));
    });
  });

  await testAsync('GET /store/metrics: Shopify not configured yields the tool\'s own honest failure, not zeros', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) => ({
        status: 'failed',
        result: null,
        error: 'SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_API_ACCESS_TOKEN are not set.',
      }),
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          assert.strictEqual(res.status, 200);
          const data = JSON.parse(res.raw);
          assert.strictEqual(data.capabilities.sales.status, 'failed');
          assert.strictEqual(data.capabilities.sales.result, null);
          assert.ok(typeof data.capabilities.sales.error === 'string' && data.capabilities.sales.error.length > 0);
        })
    );
  });

  await testAsync('GET /store/metrics: a second call within the TTL is served from cache, never re-invoking the tool', async () => {
    let callCount = 0;
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) => {
        callCount += 1;
        return { status: 'success', result: { specialized_records: [{}] }, error: null };
      },
      () =>
        withServer(async (port) => {
          const first = await authedGet(port, '/store/metrics');
          const firstData = JSON.parse(first.raw);
          assert.strictEqual(firstData.cached, false);
          const callsAfterFirst = callCount;
          assert.strictEqual(callsAfterFirst, 4); // sales, products, inventory, customers

          const second = await authedGet(port, '/store/metrics');
          const secondData = JSON.parse(second.raw);
          assert.strictEqual(secondData.cached, true);
          assert.strictEqual(callCount, callsAfterFirst, 'the tool must not be re-invoked on a cached request');
        })
    );
  });

  await testAsync('GET /store/metrics payload carries no token, key, or credential field', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'success', result: { specialized_records: [{}] }, error: null }),
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          assert.ok(!/accessToken|access_token|apiKey|api_key|password|secret/i.test(res.raw));
        })
    );
  });


  // --- GET /store/metrics: the Performance charts' data layer --------------------------
  // Builds one fake `sales` outcome shaped exactly like tools/analyticsDataTool.js's real
  // return value, so these assertions pin the contract the dashboard's chart renderer
  // actually consumes.
  function salesOutcomeWithOrders(actualMetrics, limitations) {
    return {
      status: 'success',
      error: null,
      result: {
        limitations: limitations || [],
        specialized_records: [{ sales: { actual_metrics: actualMetrics } }],
      },
    };
  }

  await testAsync('GET /store/metrics builds trends from the SAME orders it already pulled - no extra Shopify call', async () => {
    let salesCalls = 0;
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) => {
        if (analyticsCapability !== 'sales') return { status: 'empty', result: null, error: null };
        salesCalls += 1;
        return salesOutcomeWithOrders([
          { label: 'order', value: '2.00', unit: 'USD', createdAt: '2026-03-01T09:00:00Z' },
          { label: 'order', value: '3.00', unit: 'USD', createdAt: '2026-03-01T18:00:00Z' },
          { label: 'order', value: '4.00', unit: 'USD', createdAt: '2026-03-03T10:00:00Z' },
        ]);
      },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          const { trends } = JSON.parse(res.raw);
          // The sales capability is requested exactly once for the whole response - the
          // trend is derived from that one pull, never from a second round trip.
          assert.strictEqual(salesCalls, 1);
          assert.strictEqual(trends.available, true);
          assert.strictEqual(trends.granularity, 'day');
          assert.strictEqual(trends.currency, 'USD');
          assert.strictEqual(trends.order_count, 3);

          const revenue = trends.metrics.find((m) => m.id === 'revenue');
          assert.strictEqual(revenue.available, true);
          assert.strictEqual(revenue.channels.length, 1);
          assert.strictEqual(revenue.channels[0].id, 'shopify');
          assert.deepStrictEqual(
            revenue.channels[0].points.map((p) => p.value),
            [5, 0, 4],
            'points must equal the supplied orders exactly, including the genuine zero day'
          );

          const orders = trends.metrics.find((m) => m.id === 'orders');
          assert.deepStrictEqual(orders.channels[0].points.map((p) => p.value), [2, 0, 1]);
        })
    );
  });

  await testAsync('GET /store/metrics reports sessions and conversion rate as unavailable with a real reason, never a zero series', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) =>
        analyticsCapability === 'sales'
          ? salesOutcomeWithOrders([{ label: 'order', value: '1.00', unit: 'USD', createdAt: '2026-03-01T09:00:00Z' }])
          : { status: 'empty', result: null, error: null },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          const { trends } = JSON.parse(res.raw);
          for (const id of ['sessions', 'conversion_rate']) {
            const metric = trends.metrics.find((m) => m.id === id);
            assert.strictEqual(metric.available, false, `${id} must never be reported as available`);
            // No series at all - an empty array a chart could draw as a flat zero line
            // would read as "we measured zero traffic", which is a fabricated claim.
            assert.deepStrictEqual(metric.channels, [], `${id} must carry no series`);
            assert.ok(
              typeof metric.reason === 'string' && metric.reason.length > 0,
              `${id} must state why it is unavailable`
            );
          }
        })
    );
  });

  await testAsync('GET /store/metrics: no usable orders yields available:false and a null range, never an invented one', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'empty', result: null, error: null }),
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          const { trends } = JSON.parse(res.raw);
          assert.strictEqual(trends.available, false);
          assert.strictEqual(trends.range, null);
          assert.strictEqual(trends.granularity, null);
          assert.strictEqual(trends.order_count, 0);
          for (const metric of trends.metrics) {
            assert.deepStrictEqual(metric.channels, [], `${metric.id} must carry no fabricated series`);
          }
        })
    );
  });

  await testAsync("GET /store/metrics passes the pull's own capped-read limitation through to the chart", async () => {
    const cap = 'Pulled 50 order(s) from Shopify (limit 50, most recent first) - a capped read, not necessarily every order in the reporting period.';
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) =>
        analyticsCapability === 'sales'
          ? salesOutcomeWithOrders(
              [{ label: 'order', value: '1.00', unit: 'USD', createdAt: '2026-03-01T09:00:00Z' }],
              [cap]
            )
          : { status: 'empty', result: null, error: null },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          const { trends } = JSON.parse(res.raw);
          // Verbatim, so the dashboard can never present a partial pull as a full history.
          assert.ok(trends.limitations.includes(cap));
        })
    );
  });

  await testAsync('GET /store/metrics: every trend metric exposes a channels array, so a future channel needs no restructuring', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async ({ analyticsCapability }) =>
        analyticsCapability === 'sales'
          ? salesOutcomeWithOrders([{ label: 'order', value: '1.00', unit: 'USD', createdAt: '2026-03-01T09:00:00Z' }])
          : { status: 'empty', result: null, error: null },
      () =>
        withServer(async (port) => {
          const res = await authedGet(port, '/store/metrics');
          const { trends } = JSON.parse(res.raw);
          assert.deepStrictEqual(
            trends.metrics.map((m) => m.id),
            ['revenue', 'orders', 'sessions', 'conversion_rate']
          );
          for (const metric of trends.metrics) {
            assert.ok(Array.isArray(metric.channels), `${metric.id}.channels must be an array`);
            for (const channel of metric.channels) {
              // Each series names the channel it came from - the property that lets a real
              // Etsy/eBay adapter append a second series later without a rebuild.
              assert.ok(typeof channel.id === 'string' && channel.id.length > 0);
              assert.ok(typeof channel.name === 'string' && channel.name.length > 0);
              assert.ok(Array.isArray(channel.points));
            }
          }
          // Only genuinely connected channels appear - today that is Shopify alone.
          const seriesChannels = trends.metrics.flatMap((m) => m.channels.map((c) => c.id));
          assert.deepStrictEqual([...new Set(seriesChannels)], ['shopify']);
        })
    );
  });


  // --- The business + AI visibility sections -------------------------------------------

  await testAsync('GET /overview: AI impact reports null - not 0 - for a metric with no basis yet', async () => {
    // A dedicated empty store dir: with no saved runs at all, "products analyzed" has no
    // basis, and 0 would falsely read as "we analyzed nothing".
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-empty-'));
    const savedDir = process.env.RUN_HISTORY_STORE_DIR;
    process.env.RUN_HISTORY_STORE_DIR = emptyDir;
    try {
      await withServer(async (port) => {
        const res = await authedGet(port, '/overview');
        const data = JSON.parse(res.raw);
        const products = data.ai_impact.find((m) => m.id === 'products_analyzed');
        assert.strictEqual(products.value, null, 'must be null, never 0, when no Product run exists');
        const tokens = data.ai_impact.find((m) => m.id === 'model_tokens');
        assert.strictEqual(tokens.value, null, 'token total must be null when no run recorded usage');
      });
    } finally {
      process.env.RUN_HISTORY_STORE_DIR = savedDir;
    }
  });

  await testAsync('GET /overview: AI impact counts come from real saved records, never invented', async () => {
    seedRunRecord({
      run_id: 'run-impact-product',
      kind: 'run',
      specialist_id: 'product',
      specialist_name: 'Product',
      status: 'success',
      summary: 'Product completed.',
      created_at: '2026-02-01T00:00:00.000Z',
      result: { outputs: { status: 'success', result: [{ a: 1 }, { a: 2 }] } },
    });
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      const products = data.ai_impact.find((m) => m.id === 'products_analyzed');
      // Exactly the array length the saved record carries - not a sum across runs, which
      // would double-count a re-read of the same catalog.
      assert.strictEqual(products.value, 2);
      const tasks = data.ai_impact.find((m) => m.id === 'tasks_completed');
      assert.strictEqual(typeof tasks.value, 'number');
    });
  });

  await testAsync('GET /overview: AI usage reports real tokens and NEVER a cost figure', async () => {
    seedRunRecord({
      run_id: 'run-usage-1',
      kind: 'orchestrate',
      status: 'success',
      summary: 'Orchestrated.',
      created_at: '2026-02-02T00:00:00.000Z',
      result: {
        usage_summary: {
          total_events: 2,
          by_category: { model_call: { count: 1, tokens_input: 100, tokens_output: 20, tokens_total: 120 }, tool_call: { count: 3 } },
        },
      },
    });
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const { ai_usage: usage } = JSON.parse(res.raw);
      assert.strictEqual(usage.available, true);
      assert.ok(usage.tokens_total >= 120, 'must include the seeded run\'s real token total');
      assert.ok(usage.runs_with_usage >= 1);
      // This project has no price table, so a currency figure would be fabricated.
      assert.strictEqual(usage.cost, null);
      assert.ok(typeof usage.cost_reason === 'string' && usage.cost_reason.length > 0);
    });
  });

  await testAsync('GET /overview: orchestrator status is read from saved runs and reports "ready" when none exist', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-orch-empty-'));
    const savedDir = process.env.RUN_HISTORY_STORE_DIR;
    process.env.RUN_HISTORY_STORE_DIR = emptyDir;
    try {
      await withServer(async (port) => {
        const res = await authedGet(port, '/overview');
        const { orchestrator } = JSON.parse(res.raw);
        assert.strictEqual(orchestrator.state, 'ready');
        assert.strictEqual(orchestrator.last_run, null);
        assert.strictEqual(orchestrator.paused_awaiting_approval, 0);
        // Says so plainly rather than leaving an unexplained empty panel.
        assert.ok(typeof orchestrator.detail === 'string' && orchestrator.detail.length > 0);
      });
    } finally {
      process.env.RUN_HISTORY_STORE_DIR = savedDir;
    }
  });

  await testAsync('GET /overview: next best actions route only to real pages, and never invent an action', async () => {
    const VALID_PAGES = ['overview', 'ask', 'specialists', 'orchestrator', 'approvals', 'history'];
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      const data = JSON.parse(res.raw);
      for (const action of data.next_actions) {
        assert.ok(VALID_PAGES.includes(action.page), `action "${action.id}" points at a real dashboard page`);
        assert.ok(typeof action.title === 'string' && action.title.length > 0);
        // Every card must name the fact that produced it - no opaque scores.
        assert.ok(typeof action.basis === 'string' && action.basis.length > 0, `action "${action.id}" must state its basis`);
        assert.ok(['high', 'normal'].includes(action.emphasis));
        if (action.page === 'history') assert.ok(action.run_id, 'a history action must carry a real run id');
      }
    });
  });

  await testAsync('GET /store/metrics: the funnel reports only stages a real source backs, and never computes drop-off', async () => {
    await withMocked(
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
                  {
                    sales: {
                      actual_metrics: [
                        { label: 'order', value: '1.00', unit: 'USD', createdAt: '2026-03-01T00:00:00Z' },
                        { label: 'order', value: '2.00', unit: 'USD', createdAt: '2026-03-02T00:00:00Z' },
                      ],
                    },
                  },
                ],
              },
            }
          : { status: 'empty', result: null, error: null },
      () =>
        withMocked(shopifyClient, 'getOrders', async () => [], () =>
          withServer(async (port) => {
            const res = await authedGet(port, '/store/metrics');
            const { funnel } = JSON.parse(res.raw);
            const byId = Object.fromEntries(funnel.stages.map((s) => [s.id, s]));

            // Orders is the ONE stage a read-only Admin API genuinely supports.
            assert.strictEqual(byId.orders.available, true);
            assert.strictEqual(byId.orders.value, 2);

            for (const id of ['sessions', 'product_views', 'add_to_cart', 'checkout']) {
              assert.strictEqual(byId[id].available, false, `${id} must not be reported as measured`);
              // null, never 0 - a 0 here would read as "nobody visited".
              assert.strictEqual(byId[id].value, null, `${id} must carry no fabricated number`);
              assert.ok(typeof byId[id].reason === 'string' && byId[id].reason.length > 0);
            }

            // A conversion percentage needs a denominator this system does not have.
            assert.strictEqual(funnel.drop_off_available, false);
            assert.ok(typeof funnel.drop_off_reason === 'string' && funnel.drop_off_reason.length > 0);
          })
        )
    );
  });

  await testAsync('GET /store/metrics: top products come from real line items, with revenue explicitly unavailable', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'empty', result: null, error: null }),
      () =>
        withMocked(
          shopifyClient,
          'getOrders',
          async () => [
            { test: false, lineItems: [{ title: 'Bundle A', quantity: 4, sku: 'A' }] },
            { test: false, lineItems: [{ title: 'Bundle B', quantity: 1, sku: 'B' }] },
            { test: true, lineItems: [{ title: 'Test Bundle', quantity: 50, sku: 'T' }] },
          ],
          () =>
            withServer(async (port) => {
              const res = await authedGet(port, '/store/metrics');
              const { top_products: top } = JSON.parse(res.raw);
              assert.strictEqual(top.available, true);
              assert.strictEqual(top.products[0].title, 'Bundle A');
              assert.strictEqual(top.products[0].units, 4);
              assert.ok(
                !top.products.some((p) => p.title === 'Test Bundle'),
                'a Shopify test order must never appear in a real sales ranking'
              );
              // Stated as unavailable with a reason rather than apportioned from order totals.
              assert.strictEqual(top.revenue_available, false);
              assert.ok(typeof top.revenue_reason === 'string' && top.revenue_reason.length > 0);
              assert.strictEqual(top.views_available, false);
            })
        )
    );
  });

  await testAsync('GET /store/metrics: a failed order read degrades Top Products alone, never the whole response', async () => {
    await withMocked(
      analyticsDataTool,
      'runAnalyticsDataTool',
      async () => ({ status: 'success', result: { specialized_records: [{}] }, error: null }),
      () =>
        withMocked(
          shopifyClient,
          'getOrders',
          async () => {
            throw new Error('simulated Shopify failure');
          },
          () =>
            withServer(async (port) => {
              const res = await authedGet(port, '/store/metrics');
              assert.strictEqual(res.status, 200, 'the rest of the response must still be served');
              const data = JSON.parse(res.raw);
              assert.strictEqual(data.top_products.available, false);
              assert.deepStrictEqual(data.top_products.products, []);
              assert.ok(data.capabilities, 'the capability results must still be present');
            })
        )
    );
  });

  await testAsync('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('dashboardOverviewEndpoint.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
