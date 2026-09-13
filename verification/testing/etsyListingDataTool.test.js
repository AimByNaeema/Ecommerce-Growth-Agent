'use strict';

// tools/etsyListingDataTool.js - the etsy_listing_data_retrieval tool.
//
// The behaviour that matters most here: listing content never leaves this tool without a
// compliance verdict and without saying which product facts its data did NOT establish.

const assert = require('node:assert');
const etsyListingDataTool = require('../../tools/etsyListingDataTool');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const { NEEDS_INFORMATION } = require('../../compliance/etsyComplianceInput');
const { getToolById } = require('../../tools/toolRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');

// Load .env ONCE, before any test manipulates process.env - see the same note in
// etsyShopDataTool.test.js. Without it this suite would pass only on a machine where Etsy
// has not been configured yet.
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

// See the note in etsyShopDataTool.test.js: a key omitted here is NOT cleared by withEnv,
// so the operator's real .env value would leak into the run.
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

function listingsResponse(results) {
  return async (url) => {
    if (String(url).includes('/public/oauth/token')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'shops_r listings_r' }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ count: results.length, results }) };
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

const CLEAN_LISTING = {
  listing_id: 1,
  title: 'Floral Border Design',
  description: 'A hand drawn floral border in soft muted tones.',
  tags: ['floral', 'border'],
  listing_type: 'download',
};

(async () => {
  test('the tool is registered as a read, classified analysis_only', () => {
    const tool = getToolById('etsy_listing_data_retrieval');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.category, 'products');
    assert.strictEqual(TOOL_CLASSIFICATIONS.etsy_listing_data_retrieval, 'analysis_only');
  });

  test('PERMISSIONS: allowed for the Product specialist, denied for every other', () => {
    assert.strictEqual(checkToolAccess({ specialistId: 'product', toolId: 'etsy_listing_data_retrieval' }).decision, 'allowed');
    for (const specialistId of ['listing', 'marketing', 'seo', 'research', 'social_advertising', 'analytics_optimization']) {
      assert.strictEqual(checkToolAccess({ specialistId, toolId: 'etsy_listing_data_retrieval' }).decision, 'denied');
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
          const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
          assert.strictEqual(outcome.status, 'failed');
          assert.ok(outcome.error.includes('ETSY_API_KEYSTRING'));
        }
      );
      assert.strictEqual(calls, 0);
    });
  });

  await testAsync('COMPLIANCE TRAVELS WITH THE DATA: every listing carries a verdict', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(listingsResponse([CLEAN_LISTING]), async () => {
        const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
        const [entry] = outcome.result.listings;
        assert.ok(entry.compliance, 'listing content must never be returned without a verdict');
        assert.ok(['PASS', 'REVIEW', 'BLOCK'].includes(entry.compliance.status));
        assert.ok(Array.isArray(entry.compliance.findings));
        assert.ok(entry.compliance.limitations.length > 0, 'the standing limitations must travel with it');
        assert.strictEqual(entry.listing.channel, 'etsy');
      });
    });
  });

  await testAsync('NEEDS_INFORMATION: unestablished product facts are reported per listing', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(listingsResponse([CLEAN_LISTING]), async () => {
        const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
        const [entry] = outcome.result.listings;
        assert.ok(entry.missing_facts.includes('file_formats'));
        assert.ok(entry.missing_facts.includes('licence'));
        assert.strictEqual(entry.facts.file_formats, NEEDS_INFORMATION);
        assert.strictEqual(entry.facts.delivery_method, NEEDS_INFORMATION);
      });
    });
  });

  await testAsync('a digital listing claiming shipping makes the tool status blocked', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        listingsResponse([{ ...CLEAN_LISTING, description: 'Your order ships in 3 business days.' }]),
        async () => {
          const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
          assert.strictEqual(outcome.result.aggregate_compliance_status, 'BLOCK');
          assert.strictEqual(outcome.status, 'blocked');
        }
      );
    });
  });

  await testAsync('a protected mark makes the tool status partial (REVIEW)', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(listingsResponse([{ ...CLEAN_LISTING, title: 'Bluey Party Design' }]), async () => {
        const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
        assert.strictEqual(outcome.result.aggregate_compliance_status, 'REVIEW');
        assert.strictEqual(outcome.status, 'partial');
      });
    });
  });

  await testAsync('WORST WINS: one blocked listing is never averaged away by clean ones', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        listingsResponse([
          { ...CLEAN_LISTING, listing_id: 1 },
          { ...CLEAN_LISTING, listing_id: 2 },
          { ...CLEAN_LISTING, listing_id: 3, description: 'Printed on cardstock, envelopes included.' },
        ]),
        async () => {
          const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
          assert.strictEqual(outcome.result.listing_count, 3);
          assert.strictEqual(outcome.result.aggregate_compliance_status, 'BLOCK');
        }
      );
    });
  });

  test('aggregateVerdict is worst-wins', () => {
    assert.strictEqual(etsyListingDataTool.aggregateVerdict(['PASS', 'PASS']), 'PASS');
    assert.strictEqual(etsyListingDataTool.aggregateVerdict(['PASS', 'REVIEW']), 'REVIEW');
    assert.strictEqual(etsyListingDataTool.aggregateVerdict(['PASS', 'REVIEW', 'BLOCK']), 'BLOCK');
  });

  await testAsync('an empty shop is reported empty, never fabricated', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(listingsResponse([]), async () => {
        const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
        assert.strictEqual(outcome.status, 'empty');
        assert.strictEqual(outcome.result, null);
      });
    });
  });

  await testAsync('THE TOOL NEVER THROWS: a network failure becomes status failed', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        async (url) => {
          if (String(url).includes('/public/oauth/token')) {
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'shops_r' }),
            };
          }
          throw new Error('simulated network failure');
        },
        async () => {
          const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
          assert.strictEqual(outcome.status, 'failed');
          assert.strictEqual(outcome.result, null);
        }
      );
    });
  });

  await testAsync('the page is bounded by default, and the bound is reported', async () => {
    await withEnv(CONFIGURED, async () => {
      let requestedUrl = null;
      await withMockedFetch(
        async (url) => {
          if (String(url).includes('/public/oauth/token')) {
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'shops_r listings_r' }),
            };
          }
          requestedUrl = String(url);
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ count: 1, results: [CLEAN_LISTING] }) };
        },
        async () => {
          const outcome = await etsyListingDataTool.runEtsyListingDataTool({});
          assert.strictEqual(outcome.result.pagination.limit, etsyListingDataTool.DEFAULT_LISTING_LIMIT);
          assert.ok(requestedUrl.includes(`limit=${etsyListingDataTool.DEFAULT_LISTING_LIMIT}`));
        }
      );
    });
  });

  await testAsync('the tool is dispatchable through the orchestrator executor map', async () => {
    const { runExecutor } = require('../../agent/core/orchestratorExecutionContract');
    await withEnv({}, async () => {
      const outcome = await runExecutor('etsy_listing_data_retrieval', { research_params: {}, business_id: null });
      assert.notStrictEqual(outcome.error, `No executor is wired for implemented tool 'etsy_listing_data_retrieval'.`);
      assert.strictEqual(outcome.data.status, 'failed', 'unconfigured, so the tool itself refuses');
    });
  });

  // ---------------------------------------------------------------------------------
  // RESOLVED THROUGH THE ADAPTER REGISTRY, not by requiring a concrete client.
  // ---------------------------------------------------------------------------------
  //
  // No Etsy request is made below: etsyReadClient.getEtsyListings is substituted, so the
  // chain tool -> adapterRegistry -> etsyReadAdapter -> (stub) runs entirely in process.

  await testAsync('the listing read goes through the registry-resolved adapter, preserving native records', async () => {
    const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
    const { retrieveEtsyListingData } = require('../../tools/etsyListingDataTool');

    // The exact normalized records the read client produces - the shape
    // compliance/etsyComplianceInput.js reads.
    const listingRecords = [
      {
        listing_id: 900,
        shop_id: 4242,
        title: 'Fixture Listing',
        description: 'A fixture.',
        state: 'active',
        url: 'https://www.etsy.com/listing/900',
        tags: ['fixture'],
        materials: [],
        price: { amount: 500, divisor: 100, currency_code: 'GBP' },
        quantity: 10,
        taxonomy_id: 1,
        listing_type: 'download',
        is_digital: true,
        is_digital_product: true,
        num_favorers: 0,
        views: 1,
        channel: 'etsy',
      },
    ];

    let seen;
    const saved = etsyReadClient.getEtsyListings;
    etsyReadClient.getEtsyListings = async (args) => {
      seen = args;
      return listingRecords;
    };
    try {
      const result = await retrieveEtsyListingData({ businessId: null, limit: 3, offset: 6, state: 'active' });
      // Etsy's OWN record shape is preserved exactly - .native unwrapped from the shim.
      assert.deepStrictEqual(result, listingRecords);
      assert.strictEqual(result[0].channel, 'etsy', 'provenance survives the shim');
      // Paging reaches the client unchanged; the shim invents none of its own.
      assert.deepStrictEqual(seen, { businessId: null, limit: 3, offset: 6, state: 'active' });
    } finally {
      etsyReadClient.getEtsyListings = saved;
    }
  });

  test('the tool resolves its adapter and no longer reads data through the concrete client', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'tools', 'etsyListingDataTool.js'),
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
    for (const forbidden of ['etsyReadClient.getEtsyListings', 'etsyReadClient.getEtsyShop', 'etsyReadClient.canRead']) {
      assert.ok(!code.includes(forbidden), `${forbidden} must no longer be called directly`);
    }
    // The two surviving uses are both non-contract and Etsy-specific: the missing-credential
    // KEY names, and this channel's own provenance constant.
    assert.ok(code.includes('etsyReadClient.missingReadCredentials'));
    assert.ok(code.includes('etsyReadClient.ETSY_CHANNEL'));
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyListingDataTool.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
