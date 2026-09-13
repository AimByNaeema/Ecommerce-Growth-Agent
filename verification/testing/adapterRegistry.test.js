'use strict';

// Tests for integrations/adapters/adapterRegistry.js and its one shim,
// integrations/adapters/etsyReadAdapter.js.
//
// NO EXTERNAL API IS EVER CALLED HERE. Every test is either structural (typeof checks over
// already-loaded modules) or exercises a path that refuses BEFORE any request:
//   - the four Etsy unsupported capabilities throw without touching the network by
//     construction (they call nothing but createUnsupportedCapabilityError);
//   - the two supported Etsy reads are exercised against a STUBBED etsyReadClient function,
//     restored in a finally, so no Etsy request is attempted and no credential is read;
//   - no Shopify, Gemini or Tavily call is made anywhere in this file.

const assert = require('node:assert');
const {
  READ_ADAPTERS,
  REGISTERED_READ_PLATFORMS,
  hasReadAdapter,
  getReadAdapter,
  describeReadAdapter,
} = require('../../integrations/adapters/adapterRegistry');
const {
  validateAdapterShape,
  isUnsupportedCapabilityError,
  REQUIRED_ADAPTER_CAPABILITIES,
} = require('../../integrations/adapters/platformAdapterContract');
const etsyReadAdapter = require('../../integrations/adapters/etsyReadAdapter');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const { CHANNELS } = require('../../agent/core/channelModel');

const CAPABILITY_IDS = REQUIRED_ADAPTER_CAPABILITIES.map((capability) => capability.id);

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

// Replaces one etsyReadClient function for the duration of fn, then restores it. Property
// substitution on a required module is this project's established no-framework mocking
// convention (see tools/aiReasoningCompletion.js's header).
function withEtsyReadClientStub(name, implementation, fn) {
  const saved = etsyReadClient[name];
  etsyReadClient[name] = implementation;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      etsyReadClient[name] = saved;
    });
}

// ---------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------

test('the registry registers exactly the platforms that have a real adapter here', () => {
  assert.deepStrictEqual(REGISTERED_READ_PLATFORMS, ['shopify', 'etsy']);
  // Every registered platform must be a recognized channel - the registry never invents a
  // platform vocabulary of its own.
  for (const platform of REGISTERED_READ_PLATFORMS) {
    assert.ok(CHANNELS.includes(platform), `${platform} must be a recognized channel`);
  }
});

test('NO FAKE INTEGRATION: Amazon and eBay are not registered, because no adapter exists', () => {
  for (const platform of ['amazon', 'ebay', 'woocommerce']) {
    assert.strictEqual(hasReadAdapter(platform), false, `${platform} must not be registered`);
    assert.ok(!(platform in READ_ADAPTERS));
  }
});

test('getReadAdapter resolves Shopify to the real client module, not a wrapper', () => {
  const adapter = getReadAdapter('shopify');
  // Identity matters: this project mocks by property access and by global.fetch, and a
  // wrapper or proxy would silently break both while looking equivalent.
  assert.strictEqual(adapter, shopifyClient);
});

test('the resolved Shopify adapter conforms to the full read contract', () => {
  const result = validateAdapterShape(getReadAdapter('shopify'));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.supported, CAPABILITY_IDS);
  assert.deepStrictEqual(result.unsupported, []);
});

test('getReadAdapter resolves Etsy to the shim, never to the read client directly', () => {
  const adapter = getReadAdapter('etsy');
  assert.strictEqual(adapter, etsyReadAdapter);
  assert.notStrictEqual(adapter, etsyReadClient);
});

test('the resolved Etsy adapter conforms, declaring what it cannot serve', () => {
  const result = validateAdapterShape(getReadAdapter('etsy'));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.supported, ['isConfigured', 'getShopInfo', 'getProducts']);
  assert.deepStrictEqual(result.unsupported, ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections']);
});

test('every registered adapter exposes every required capability as a function', () => {
  for (const platform of REGISTERED_READ_PLATFORMS) {
    const adapter = getReadAdapter(platform);
    for (const id of CAPABILITY_IDS) {
      assert.strictEqual(typeof adapter[id], 'function', `${platform}.${id} must be a function`);
    }
  }
});

test('describeReadAdapter reports a platform read surface without resolving it for use', () => {
  assert.deepStrictEqual(describeReadAdapter('shopify'), {
    platform: 'shopify',
    supported: CAPABILITY_IDS,
    unsupported: [],
    declared_unsupported: [],
  });
  assert.deepStrictEqual(describeReadAdapter('etsy'), {
    platform: 'etsy',
    supported: ['isConfigured', 'getShopInfo', 'getProducts'],
    unsupported: ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections'],
    declared_unsupported: ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections'],
  });
});

// ---------------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------------

test('FAIL CLOSED: an unrecognized platform is refused, never resolved', () => {
  for (const platform of ['amazon', 'ebay', 'woocommerce', 'wordpress', 'Shopify', 'ETSY', '', null, undefined, 42, {}]) {
    assert.throws(
      () => getReadAdapter(platform),
      /is not a platform this project recognizes/,
      `${JSON.stringify(platform)} must be refused`
    );
  }
});

test('FAIL CLOSED: the refusal names the recognized platforms, so the "no" is actionable', () => {
  try {
    getReadAdapter('amazon');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('amazon'));
    assert.ok(err.message.includes('shopify'));
    assert.ok(err.message.includes('etsy'));
  }
});

test('FAIL CLOSED: a recognized platform with no registered adapter gets its own distinct error', () => {
  // 'etsy' and 'shopify' are the only channels today, so this branch is exercised directly
  // rather than by inventing a channel - the same reason toolPermissions.js exports
  // evaluateToolAccess separately from checkToolAccess.
  const savedEtsy = READ_ADAPTERS.etsy;
  delete READ_ADAPTERS.etsy;
  try {
    assert.throws(() => getReadAdapter('etsy'), /is recognized but has no read adapter registered/);
    assert.throws(() => getReadAdapter('etsy'), /no fallback adapter was substituted/);
  } finally {
    READ_ADAPTERS.etsy = savedEtsy;
  }
  // Restored - the rest of this suite must see the real registry again.
  assert.strictEqual(getReadAdapter('etsy'), etsyReadAdapter);
});

test('FAIL CLOSED: a registered adapter that stops conforming is refused, not used partially', () => {
  const savedEtsy = READ_ADAPTERS.etsy;
  READ_ADAPTERS.etsy = { isConfigured: () => true, getShopInfo: () => {} };
  try {
    assert.throws(() => getReadAdapter('etsy'), /does not conform to/);
    assert.throws(() => getReadAdapter('etsy'), /It was not returned/);
  } finally {
    READ_ADAPTERS.etsy = savedEtsy;
  }
  assert.strictEqual(getReadAdapter('etsy'), etsyReadAdapter);
});

// ---------------------------------------------------------------------------------
// The Etsy shim: supported reads map correctly
// ---------------------------------------------------------------------------------

test('isConfigured maps to the read client canRead(), and passes businessId through', () => {
  let seen;
  const saved = etsyReadClient.canRead;
  etsyReadClient.canRead = (args) => {
    seen = args;
    return true;
  };
  try {
    assert.strictEqual(etsyReadAdapter.isConfigured({ businessId: 'biz-a' }), true);
    assert.deepStrictEqual(seen, { businessId: 'biz-a' });
  } finally {
    etsyReadClient.canRead = saved;
  }
});

(async () => {
  await testAsync('getShopInfo maps the Etsy shop record onto the contract shape', async () => {
    const shopRecord = {
      shop_id: 123,
      shop_name: 'Test Shop',
      title: 'A test shop',
      currency_code: 'USD',
      url: 'https://www.etsy.com/shop/TestShop',
      listing_active_count: 7,
      channel: 'etsy',
    };

    await withEtsyReadClientStub('getEtsyShop', async () => shopRecord, async () => {
      const shop = await etsyReadAdapter.getShopInfo({ businessId: null });
      assert.strictEqual(shop.name, 'Test Shop');
      assert.strictEqual(shop.domain, 'https://www.etsy.com/shop/TestShop');
      // Etsy reports no contact email and no email scope is requested - null, never ''.
      assert.strictEqual(shop.email, null);
      // Provenance survives the shim.
      assert.strictEqual(shop.channel, 'etsy');
      // Nothing the shim did not map is lost.
      assert.deepStrictEqual(shop.native, shopRecord);
    });
  });

  await testAsync('getProducts maps Etsy listings onto the contract product shape', async () => {
    const listing = {
      listing_id: 555,
      shop_id: 123,
      title: 'Cute Ghost SVG',
      description: 'A digital download.',
      state: 'active',
      url: 'https://www.etsy.com/listing/555',
      tags: ['svg', 'halloween'],
      materials: ['digital'],
      price: { amount: 300, divisor: 100, currency_code: 'USD' },
      quantity: 999,
      taxonomy_id: 68,
      listing_type: 'download',
      is_digital: true,
      is_digital_product: true,
      num_favorers: 12,
      views: 340,
      channel: 'etsy',
    };

    await withEtsyReadClientStub('getEtsyListings', async () => [listing], async () => {
      const products = await etsyReadAdapter.getProducts({ limit: 1 });
      assert.strictEqual(products.length, 1);
      const product = products[0];

      // Mapped from real Etsy fields.
      assert.strictEqual(product.id, 555);
      assert.strictEqual(product.title, 'Cute Ghost SVG');
      assert.strictEqual(product.status, 'active');
      assert.deepStrictEqual(product.tags, ['svg', 'halloween']);
      assert.strictEqual(product.channel, 'etsy');

      // A listing carries exactly one price and one quantity - one variant, real values.
      assert.strictEqual(product.variants.length, 1);
      assert.deepStrictEqual(product.variants[0].price, listing.price);
      assert.strictEqual(product.variants[0].inventory_quantity, 999);

      // NOT INVENTED: no slug manufactured from the url, no category from taxonomy_id, no
      // brand, no collections, no sku, and availability not inferred from state.
      assert.strictEqual(product.slug, null);
      assert.strictEqual(product.category, null);
      assert.strictEqual(product.brand, null);
      assert.deepStrictEqual(product.collections, []);
      assert.strictEqual(product.variants[0].sku, null);
      assert.strictEqual(product.variants[0].available, null);

      // Etsy-only reals are relayed, not dropped.
      const metadataKeys = product.metadata.map((entry) => entry.key);
      assert.ok(metadataKeys.includes('taxonomy_id'));
      assert.ok(metadataKeys.includes('url'));
      assert.ok(metadataKeys.includes('is_digital_product'));
      for (const entry of product.metadata) {
        assert.strictEqual(entry.namespace, 'etsy');
      }
    });
  });

  await testAsync('getProducts passes paging straight through and invents no paging of its own', async () => {
    let seen;
    await withEtsyReadClientStub(
      'getEtsyListings',
      async (args) => {
        seen = args;
        return [];
      },
      async () => {
        await etsyReadAdapter.getProducts({ businessId: 'biz-a', limit: 5, offset: 10, state: 'active' });
        assert.deepStrictEqual(seen, { businessId: 'biz-a', limit: 5, offset: 10, state: 'active' });
      }
    );
  });

  await testAsync('a genuinely empty Etsy shop returns [] - distinct from an unsupported capability', async () => {
    await withEtsyReadClientStub('getEtsyListings', async () => [], async () => {
      assert.deepStrictEqual(await etsyReadAdapter.getProducts(), []);
    });
  });

  // ---------------------------------------------------------------------------------
  // The Etsy shim: unsupported reads fail explicitly
  // ---------------------------------------------------------------------------------

  for (const capability of ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections']) {
    await testAsync(`${capability} refuses explicitly - it never returns an empty success`, async () => {
      let thrown = null;
      try {
        await etsyReadAdapter[capability]();
        assert.fail(`${capability} must not resolve`);
      } catch (err) {
        thrown = err;
      }

      assert.ok(isUnsupportedCapabilityError(thrown), `${capability} must reject with an unsupported-capability error`);
      assert.strictEqual(thrown.platform, 'etsy');
      assert.strictEqual(thrown.capability, capability);
      // A stated, specific reason - never a bare "not supported".
      assert.ok(thrown.reason && thrown.reason.trim() !== '');
      assert.ok(thrown.message.includes(capability));
    });
  }

  test('every declared-unsupported capability has a real stated reason', () => {
    for (const capability of etsyReadAdapter.UNSUPPORTED_READ_CAPABILITIES) {
      const reason = etsyReadAdapter.UNSUPPORTED_REASONS[capability];
      assert.ok(reason && reason.trim() !== '', `${capability} must state why it is unsupported`);
      assert.ok(reason.length > 40, `${capability}'s reason must be specific, not a placeholder`);
    }
  });

  test('the shim adds no write or publish capability of any kind', () => {
    const exported = Object.keys(etsyReadAdapter);
    for (const name of exported) {
      assert.ok(
        !/publish|create|update|delete|write|post/i.test(name),
        `etsyReadAdapter must expose no mutating capability, found '${name}'`
      );
    }
    // And it must not reach the publish adapter at all.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyReadAdapter.js'),
      'utf8'
    );
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(!code.includes("require('./etsyClient')"), 'the read shim must not require the publish adapter');
    assert.ok(!/fetch\(/.test(code), 'the shim must add no transport of its own');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('adapterRegistry.test.js'));
  });

  console.log(`
${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
