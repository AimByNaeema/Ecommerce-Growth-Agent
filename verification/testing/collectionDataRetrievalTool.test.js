'use strict';

const assert = require('node:assert');
const { retrieveCollectionData } = require('../../tools/collectionDataRetrievalTool');

// This test never makes a real network call - it only checks that the tool wrapper
// exports the expected function and correctly propagates shopifyClient.getCollections()'s
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
  assert.strictEqual(typeof retrieveCollectionData, 'function');
});

(async () => {
  await testAsync('retrieveCollectionData rejects clearly when Shopify is not configured', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      await assert.rejects(() => retrieveCollectionData(), /SHOPIFY_STORE_DOMAIN/);
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
