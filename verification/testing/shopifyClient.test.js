'use strict';

const assert = require('node:assert');
const {
  getShopInfo,
  isConfigured,
  loadEnvOnce,
  DEFAULT_API_VERSION,
} = require('../../integrations/adapters/shopifyClient');

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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
