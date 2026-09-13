'use strict';

// tools/etsyShopDataTool.js - the etsy_shop_data_retrieval tool.
//
// Every Etsy response is mocked. The tool must never throw, and must never reach the
// network when it is not configured.

const assert = require('node:assert');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const { getToolById } = require('../../tools/toolRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');

// Load .env ONCE, before any test manipulates process.env - otherwise the lazy load
// inside credential resolution fires within the first withEnv() block and restores the
// operator's real ETSY_* values right after it deleted them, making this suite depend on
// how far through configuring Etsy the machine happens to be.
require('../../integrations/adapters/etsyClient').loadEnvOnce();

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

// ETSY_SHARED_SECRET must be in this list, not only in CONFIGURED: withEnv() deletes
// exactly these keys, so any key left out keeps the operator's real .env value for the
// whole run - passing here and failing on a clean checkout.
const ENV_KEYS = [
  'ETSY_API_KEYSTRING',
  'ETSY_SHARED_SECRET',
  'ETSY_SHOP_ID',
  'ETSY_OAUTH_REFRESH_TOKEN',
  'ETSY_OAUTH_ACCESS_TOKEN',
  'NETWORK_RETRY_BASE_DELAY_MS',
];

async function withEnv(values, run) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, values);
  etsyReadClient.clearEtsyReadCaches();
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    etsyReadClient.clearEtsyReadCaches();
  }
}

const CONFIGURED = {
  ETSY_API_KEYSTRING: '(placeholder)',
  ETSY_SHARED_SECRET: '(placeholder-secret)',
  ETSY_SHOP_ID: '99999999',
  ETSY_OAUTH_REFRESH_TOKEN: '(placeholder)',
  NETWORK_RETRY_BASE_DELAY_MS: '0',
};

function mockedEtsy(apiHandler) {
  return async (url) => {
    if (String(url).includes('/public/oauth/token')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'shops_r listings_r' }),
      };
    }
    return apiHandler(url);
  };
}

async function withMockedFetch(handler, run) {
  const saved = global.fetch;
  global.fetch = handler;
  try {
    return await run();
  } finally {
    global.fetch = saved;
  }
}

(async () => {
  test('the tool is registered as a read, classified analysis_only', () => {
    const tool = getToolById('etsy_shop_data_retrieval');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.category, 'products');
    assert.strictEqual(tool.status, 'implemented');
    assert.strictEqual(TOOL_CLASSIFICATIONS.etsy_shop_data_retrieval, 'analysis_only');
  });

  test('PERMISSIONS: allowed for the Product specialist, denied for every other', () => {
    assert.strictEqual(checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval' }).decision, 'allowed');
    for (const specialistId of ['listing', 'marketing', 'seo', 'research', 'social_advertising', 'analytics_optimization']) {
      assert.strictEqual(
        checkToolAccess({ specialistId, toolId: 'etsy_shop_data_retrieval' }).decision,
        'denied',
        `${specialistId} must be denied`
      );
    }
  });

  await testAsync('an unconfigured tool reports failure by KEY NAME and makes NO request', async () => {
    await withEnv({}, async () => {
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls += 1;
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
        },
        async () => {
          const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
          assert.strictEqual(outcome.status, 'failed');
          assert.strictEqual(outcome.result, null);
          assert.ok(outcome.error.includes('ETSY_API_KEYSTRING'));
          assert.ok(outcome.error.includes('No Etsy request was attempted'));
        }
      );
      assert.strictEqual(calls, 0);
    });
  });

  await testAsync('a successful read returns the channel-stamped shop record', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ shop_id: 99999999, shop_name: 'PlaceholderShop', currency_code: 'GBP', listing_active_count: 47 }),
        })),
        async () => {
          const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
          assert.strictEqual(outcome.status, 'success');
          assert.strictEqual(outcome.error, null);
          assert.strictEqual(outcome.result.channel, 'etsy');
          assert.strictEqual(outcome.result.shop_id, 99999999);
          assert.strictEqual(outcome.result.listing_active_count, 47);
        }
      );
    });
  });

  await testAsync('THE TOOL NEVER THROWS: a network failure becomes status failed', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => {
          throw new Error('simulated network failure');
        }),
        async () => {
          const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
          assert.strictEqual(outcome.status, 'failed');
          assert.strictEqual(outcome.result, null);
          assert.ok(outcome.error.includes('Could not reach the Etsy API'));
        }
      );
    });
  });

  await testAsync('THE TOOL NEVER THROWS: an Etsy permission error becomes status failed', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => ({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          headers: { get: () => null },
          json: async () => ({ error: 'insufficient scope' }),
        })),
        async () => {
          const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
          assert.strictEqual(outcome.status, 'failed');
          assert.ok(outcome.error.includes('403'));
        }
      );
    });
  });

  await testAsync('a shop record Etsy did not really return is reported empty, never fabricated', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })),
        async () => {
          const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
          assert.strictEqual(outcome.status, 'empty');
          assert.strictEqual(outcome.result, null);
        }
      );
    });
  });

  await testAsync('the tool is dispatchable through the orchestrator executor map', async () => {
    const { runExecutor } = require('../../agent/core/orchestratorExecutionContract');
    await withEnv({}, async () => {
      const outcome = await runExecutor('etsy_shop_data_retrieval', { research_params: {}, business_id: null });
      assert.ok(outcome, 'the executor must be wired');
      assert.notStrictEqual(outcome.error, `No executor is wired for implemented tool 'etsy_shop_data_retrieval'.`);
      // runExecutor reports that the TOOL COMPLETED; the tool's own honest envelope is
      // carried in `data`, exactly as for every other never-throwing tool.
      assert.strictEqual(outcome.status, 'success');
      assert.strictEqual(outcome.data.status, 'failed', 'unconfigured, so the tool itself refuses');
      assert.ok(outcome.data.error.includes('ETSY_API_KEYSTRING'));
    });
  });

  test('BUDGET: the Etsy reads count against the per-run external-API ceiling', () => {
    // Etsy enforces its own per-application daily quota, so an uncounted Etsy read could
    // let one run consume the day's allowance.
    const { EXTERNAL_API_TOOL_IDS } = require('../../agent/core/usageLimits');
    assert.ok(EXTERNAL_API_TOOL_IDS.has('etsy_shop_data_retrieval'));
    assert.ok(EXTERNAL_API_TOOL_IDS.has('etsy_listing_data_retrieval'));
  });

  // ---------------------------------------------------------------------------------
  // RESOLVED THROUGH THE ADAPTER REGISTRY, not by requiring a concrete client.
  // ---------------------------------------------------------------------------------
  //
  // No Etsy request is made below: etsyReadClient.getEtsyShop is substituted, so the chain
  // tool -> adapterRegistry -> etsyReadAdapter -> (stub) runs entirely in process.

  await testAsync('the shop read goes through the registry-resolved adapter, preserving the native record', async () => {
    const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
    const { retrieveEtsyShopData } = require('../../tools/etsyShopDataTool');

    // The exact normalized record the read client produces, channel stamp included.
    const shopRecord = {
      shop_id: 4242,
      shop_name: 'Fixture Shop',
      title: 'A fixture',
      currency_code: 'GBP',
      url: 'https://www.etsy.com/shop/FixtureShop',
      listing_active_count: 3,
      channel: 'etsy',
    };

    let seen;
    const saved = etsyReadClient.getEtsyShop;
    etsyReadClient.getEtsyShop = async (args) => {
      seen = args;
      return shopRecord;
    };
    try {
      const result = await retrieveEtsyShopData({ businessId: 'biz-a' });
      // The tool still returns Etsy's OWN record shape - the shim's contract-shaped view is
      // unwrapped via .native, so every downstream reader of shop_id is unaffected.
      assert.deepStrictEqual(result, shopRecord);
      assert.strictEqual(result.channel, 'etsy', 'provenance survives the shim');
      assert.deepStrictEqual(seen, { businessId: 'biz-a' }, 'businessId reaches the client unchanged');
    } finally {
      etsyReadClient.getEtsyShop = saved;
    }
  });

  test('the tool resolves its adapter and no longer reads data through the concrete client', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'tools', 'etsyShopDataTool.js'),
      'utf8'
    );
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    // The platform is a named constant in the source, which is why this checks the call and
    // the constant separately rather than a string literal inside the call.
    assert.ok(code.includes('getReadAdapter(PLATFORM)'), 'the adapter must be resolved through the registry');
    assert.ok(/const PLATFORM = 'etsy';/.test(code), "the resolved platform must be 'etsy'");
    // No DATA call and no configured-check may go to the concrete client any more.
    for (const forbidden of ['etsyReadClient.getEtsyShop', 'etsyReadClient.getEtsyListings', 'etsyReadClient.canRead']) {
      assert.ok(!code.includes(forbidden), `${forbidden} must no longer be called directly`);
    }
    // The one surviving use is the non-contract diagnostic that names missing credential
    // KEYS - isConfigured() is a boolean and cannot report which ones.
    assert.ok(code.includes('etsyReadClient.missingReadCredentials'));
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyShopDataTool.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
