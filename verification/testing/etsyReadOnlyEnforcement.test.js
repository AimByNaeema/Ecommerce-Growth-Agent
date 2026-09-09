'use strict';

// THE KEY SECURITY TEST FOR THE READ-ONLY ETSY PHASE.
//
// Following verification/testing/etsyPublishing.test.js's pattern, the dominant assertion
// here is a CALL COUNT OF EXACTLY ZERO: adding a read surface must not have made any write
// path reachable, and the proof is that the publish adapter is never called and no
// mutating request is ever issued - not that a result was discarded afterwards.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const etsyClient = require('../../integrations/adapters/etsyClient');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const etsyOAuth = require('../../integrations/etsyOAuth');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyListingDataTool = require('../../tools/etsyListingDataTool');
const { TOOL_REGISTRY, getToolById } = require('../../tools/toolRegistry');
const { TOOL_CLASSIFICATIONS, checkToolAccess } = require('../../agent/core/toolPermissions');

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

const ETSY_TOOL_IDS = ['etsy_shop_data_retrieval', 'etsy_listing_data_retrieval'];
const SOURCE_ROOT = path.join(__dirname, '..', '..');

function readCode(relativePath) {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8').replace(/^\s*\/\/.*$/gm, '');
}

(async () => {
  // --- THE PUBLISH GATE IS STILL SHUT -----------------------------------------------

  test('THE PUBLISH PATH IS UNCHANGED: publishing is still not available', () => {
    // Asserted with the publishing credentials forced ABSENT and then forced PRESENT, so
    // this says something about the gate rather than about the operator's current .env.
    // Adding the read surface must not have moved either answer.
    const keys = ['ETSY_API_KEYSTRING', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID'];
    etsyClient.loadEnvOnce(); // Before the deletions, or the lazy load undoes them.
    const saved = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      assert.strictEqual(etsyClient.ETSY_PUBLISHING_STATUS, 'awaiting_verified_api_mapping');
      assert.strictEqual(etsyClient.canPublish(), false);
      assert.deepStrictEqual(etsyClient.missingCredentials(), keys);

      for (const key of keys) process.env[key] = key === 'ETSY_SHOP_ID' ? '99999999' : '(placeholder)';
      assert.deepStrictEqual(etsyClient.missingCredentials(), []);
      assert.strictEqual(etsyClient.canPublish(), false, 'fully configured must STILL not publish');
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  await testAsync('publishListing STILL THROWS and still reaches no network', async () => {
    const savedFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('no test may make a real network call');
    };
    try {
      await assert.rejects(
        () => etsyClient.publishListing({ listing: { marketplace: 'etsy', product_reference: '(placeholder)' } }),
        /not configured|not available/
      );
      assert.strictEqual(fetchCalls, 0);
    } finally {
      global.fetch = savedFetch;
    }
  });

  // --- ZERO ADAPTER CALLS FROM THE READ SURFACE -------------------------------------

  await testAsync('ZERO PUBLISH CALLS: neither read tool ever calls the publish adapter', async () => {
    const savedPublish = etsyClient.publishListing;
    let publishCalls = 0;
    etsyClient.publishListing = async () => {
      publishCalls += 1;
      throw new Error('the read surface must never reach publishListing');
    };
    try {
      // Unconfigured, so both tools refuse - and refuse without touching publishing.
      await etsyShopDataTool.runEtsyShopDataTool({});
      await etsyListingDataTool.runEtsyListingDataTool({});
      assert.strictEqual(publishCalls, 0, 'the publish adapter must be unreachable from the read tools');
    } finally {
      etsyClient.publishListing = savedPublish;
    }
  });

  await testAsync('ZERO MUTATING REQUESTS: every fetch the read path makes is a GET', async () => {
    const savedFetch = global.fetch;
    const savedEnv = {
      ETSY_API_KEYSTRING: process.env.ETSY_API_KEYSTRING,
      ETSY_SHARED_SECRET: process.env.ETSY_SHARED_SECRET,
      ETSY_SHOP_ID: process.env.ETSY_SHOP_ID,
      ETSY_OAUTH_REFRESH_TOKEN: process.env.ETSY_OAUTH_REFRESH_TOKEN,
    };
    process.env.ETSY_API_KEYSTRING = '(placeholder)';
    process.env.ETSY_SHARED_SECRET = '(placeholder)';
    process.env.ETSY_SHOP_ID = '1';
    process.env.ETSY_OAUTH_REFRESH_TOKEN = '(placeholder)';
    etsyReadClient.clearEtsyReadCaches();

    const methods = [];
    global.fetch = async (url, options) => {
      methods.push({ url: String(url), method: (options && options.method) || 'GET' });
      if (String(url).includes('/public/oauth/token')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'shops_r listings_r' }),
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ shop_id: 1, count: 0, results: [] }) };
    };

    try {
      await etsyReadClient.getEtsyShop();
      await etsyReadClient.getEtsyListings();
      await etsyReadClient.getEtsyListing({ listingId: 7 });
      await etsyReadClient.getEtsyListingImages({ listingId: 7 });

      const apiCalls = methods.filter((call) => !call.url.includes('/public/oauth/token'));
      assert.ok(apiCalls.length > 0, 'the reads must actually have issued requests');
      for (const call of apiCalls) {
        assert.strictEqual(call.method, 'GET', `${call.url} was issued as ${call.method}`);
      }
      // The token exchange is the one POST, and it goes to Etsy's OAuth endpoint only.
      for (const call of methods.filter((entry) => entry.method === 'POST')) {
        assert.ok(call.url.includes('/public/oauth/token'), `unexpected POST to ${call.url}`);
      }
    } finally {
      global.fetch = savedFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      etsyReadClient.clearEtsyReadCaches();
    }
  });

  // --- THE SCOPES CANNOT REACH A WRITE ----------------------------------------------

  test('THE TOKEN ITSELF CANNOT WRITE: only read scopes can ever be requested', () => {
    assert.deepStrictEqual(etsyOAuth.ETSY_REQUIRED_SCOPES, ['shops_r', 'listings_r']);
    for (const writeScope of ['listings_w', 'listings_d', 'shops_w', 'transactions_w']) {
      assert.throws(() => etsyOAuth.assertMinimumScopes([writeScope]), /refuses the scope/);
    }
  });

  // --- REGISTRATION -----------------------------------------------------------------

  test('both Etsy tools are registered as READ operations, classified analysis_only', () => {
    for (const toolId of ETSY_TOOL_IDS) {
      const tool = getToolById(toolId);
      assert.ok(tool, `${toolId} must be in the registry`);
      assert.strictEqual(tool.operation, 'read', `${toolId} must be a read`);
      assert.strictEqual(tool.category, 'products');
      assert.strictEqual(tool.status, 'implemented');
      assert.strictEqual(TOOL_CLASSIFICATIONS[toolId], 'analysis_only', `${toolId} must be analysis_only`);
    }
  });

  test('NO ETSY WRITE TOOL EXISTS in the registry', () => {
    for (const tool of TOOL_REGISTRY) {
      if (!tool.id.startsWith('etsy_')) continue;
      assert.strictEqual(tool.operation, 'read', `${tool.id} must not be a write or execute tool in this phase`);
    }
  });

  test('PERMISSIONS: the Product specialist may read Etsy; other specialists may not', () => {
    for (const toolId of ETSY_TOOL_IDS) {
      const allowed = checkToolAccess({ specialistId: 'product', toolId });
      assert.strictEqual(allowed.decision, 'allowed', `product must be allowed ${toolId}: ${allowed.reason}`);
      assert.strictEqual(allowed.approval_required, false, 'a read-only analysis_only tool needs no approval');

      for (const specialistId of ['listing', 'marketing', 'seo', 'research', 'social_advertising', 'analytics_optimization']) {
        const denied = checkToolAccess({ specialistId, toolId });
        assert.strictEqual(denied.decision, 'denied', `${specialistId} must not reach ${toolId}`);
      }
    }
  });

  // --- SOURCE-LEVEL GUARANTEES ------------------------------------------------------

  test('NO ETSY WRITE VERB appears anywhere in the read-phase source', () => {
    const files = [
      'integrations/adapters/etsyReadClient.js',
      'integrations/etsyOAuth.js',
      'tools/etsyShopDataTool.js',
      'tools/etsyListingDataTool.js',
    ];
    for (const file of files) {
      const code = readCode(file);
      for (const forbidden of ['createDraftListing', 'updateListing', 'deleteListing', 'uploadListingImage', 'updateShop', 'createReceiptShipment']) {
        assert.ok(!code.includes(forbidden), `${file} must not reference the Etsy write operation ${forbidden}`);
      }
    }
  });

  test('the read tools never import the publish adapter or the publish workflow', () => {
    for (const file of ['tools/etsyShopDataTool.js', 'tools/etsyListingDataTool.js']) {
      const code = readCode(file);
      assert.ok(!code.includes('etsyPublishing'), `${file} must not reach the publish workflow`);
      assert.ok(!code.includes('publishListing'), `${file} must not reference publishListing`);
    }
  });

  test('the Etsy read surface makes no AI call', () => {
    for (const file of [
      'integrations/adapters/etsyReadClient.js',
      'integrations/etsyOAuth.js',
      'compliance/etsyIpRiskDetector.js',
      'compliance/etsyPolicyRules.js',
      'compliance/etsyComplianceInput.js',
    ]) {
      const code = readCode(file);
      for (const forbidden of ['aiReasoningCompletion', 'claudeClient', 'geminiClient', 'aiProviderSelector']) {
        assert.ok(!code.includes(forbidden), `${file} must not reference ${forbidden}`);
      }
    }
  });

  test('NO OTHER MARKETPLACE was implemented in this phase', () => {
    for (const file of ['integrations/adapters/etsyReadClient.js', 'integrations/etsyOAuth.js', 'tools/etsyListingDataTool.js']) {
      const source = fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8').toLowerCase();
      for (const forbidden of ['amazon', 'ebay', 'woocommerce']) {
        assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`);
      }
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyReadOnlyEnforcement.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
