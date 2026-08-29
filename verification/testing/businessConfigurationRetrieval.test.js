'use strict';

const assert = require('node:assert');
const { retrieveBusinessConfiguration } = require('../../tools/businessConfigurationRetrieval');
const { loadEnvOnce } = require('../../integrations/adapters/shopifyClient');

// This test never makes a real network call - it only checks that the tool wrapper
// exports the expected function and correctly propagates shopifyClient.getShopInfo()'s
// own "not configured" error rather than swallowing or replacing it, matching the
// project's convention of never inventing a result. Whether
// SHOPIFY_STORE_DOMAIN/SHOPIFY_ADMIN_API_ACCESS_TOKEN are actually set is
// environment-dependent, so the env-var test below saves/restores them rather than
// assuming either state.

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

test('exports the expected function', () => {
  assert.strictEqual(typeof retrieveBusinessConfiguration, 'function');
});

(async () => {
  await testAsync('retrieveBusinessConfiguration rejects clearly when Shopify is not configured', async () => {
    // Force the one-time .env load to happen before the delete below - loadEnvOnce()
    // is a no-op on every later call (see integrations/adapters/shopifyClient.js's
    // envLoadAttempted guard), so without this, real Shopify credentials in the local
    // .env file would get (re-)populated by getShopInfo()'s own internal
    // loadEnvOnce() call right after the delete - making this test both flake against
    // real local configuration AND attempt a real network call instead of rejecting.
    loadEnvOnce();
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      await assert.rejects(() => retrieveBusinessConfiguration(), /SHOPIFY_STORE_DOMAIN/);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
