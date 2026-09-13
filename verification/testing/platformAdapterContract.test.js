'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_ADAPTER_CAPABILITIES,
  ADAPTER_CONTRACT_RULES,
  PUBLISHING_ADAPTER_CAPABILITIES,
  CONTENT_PUBLISHING_ADAPTER_CAPABILITIES,
  PUBLISHING_ADAPTER_KINDS,
  DEFAULT_PUBLISHING_KIND,
  validatePublishingAdapterShape,
  getPublishingKindById,
  getPublishingCapabilityById,
  getCapabilityById,
  getRuleById,
  validateAdapterShape,
  UNSUPPORTED_CAPABILITY_CODE,
  UNSUPPORTED_CAPABILITY_DECLARATION,
  createUnsupportedCapabilityError,
  isUnsupportedCapabilityError,
  getDeclaredUnsupportedCapabilities,
} = require('../../integrations/adapters/platformAdapterContract');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyClient = require('../../integrations/adapters/etsyClient');

const EXPECTED_CAPABILITY_IDS = [
  'isConfigured',
  'getShopInfo',
  'getProducts',
  'getOrders',
  'getCustomers',
  'getInventoryLevels',
  'getCollections',
];

const EXPECTED_RULE_IDS = [
  'read_only_only',
  'never_fabricate_a_result',
  'credentials_isolated_per_business',
  'no_sdk_required',
  // Added with the explicitly-unsupported-capability mechanism: a platform that cannot
  // serve a required capability declares it and refuses, rather than returning an
  // empty-but-successful value that would be indistinguishable from real data.
  'unsupported_is_declared_never_faked',
];

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

test('exactly the 7 required capabilities from the review exist, in the requested order', () => {
  assert.deepStrictEqual(
    REQUIRED_ADAPTER_CAPABILITIES.map((entry) => entry.id),
    EXPECTED_CAPABILITY_IDS
  );
});

test('the 5 required contract rules exist, in the requested order', () => {
  assert.deepStrictEqual(
    ADAPTER_CONTRACT_RULES.map((rule) => rule.id),
    EXPECTED_RULE_IDS
  );
});

test('every capability has a non-empty title, description, and normalized_shape', () => {
  for (const entry of REQUIRED_ADAPTER_CAPABILITIES) {
    assert.ok(entry.title && entry.title.trim() !== '', `${entry.id} is missing a title`);
    assert.ok(entry.description && entry.description.trim() !== '', `${entry.id} is missing a description`);
    assert.ok(entry.normalized_shape && entry.normalized_shape.trim() !== '', `${entry.id} is missing a normalized_shape`);
  }
});

test('every contract rule has a non-empty description', () => {
  for (const rule of ADAPTER_CONTRACT_RULES) {
    assert.ok(rule.description && rule.description.trim() !== '', `${rule.id} is missing a description`);
  }
});

test('ids are unique across capabilities and rules combined', () => {
  const ids = [...REQUIRED_ADAPTER_CAPABILITIES, ...ADAPTER_CONTRACT_RULES].map((entry) => entry.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('getCapabilityById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getCapabilityById('getOrders').title, 'Order retrieval');
  assert.strictEqual(getCapabilityById('does_not_exist'), undefined);
});

test('getRuleById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getRuleById('never_fabricate_a_result').id, 'never_fabricate_a_result');
  assert.strictEqual(getRuleById('does_not_exist'), undefined);
});

test('getOrders capability\'s normalized_shape references agent/core/orderModel.js\'s field ids', () => {
  const entry = getCapabilityById('getOrders');
  assert.ok(entry.normalized_shape.includes('order_reference'));
  assert.ok(entry.normalized_shape.includes('financial_status'));
});

test('validateAdapterShape rejects a non-object input without guessing', () => {
  assert.deepStrictEqual(validateAdapterShape(null), {
    valid: false,
    errors: ['adapter module must be an object'],
  });
  assert.deepStrictEqual(validateAdapterShape('not an object'), {
    valid: false,
    errors: ['adapter module must be an object'],
  });
});

test('validateAdapterShape reports every missing capability on an empty adapter', () => {
  const result = validateAdapterShape({});
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errors.length, EXPECTED_CAPABILITY_IDS.length);
  for (const id of EXPECTED_CAPABILITY_IDS) {
    assert.ok(result.errors.includes(`missing required capability: ${id} (must be a function)`));
  }
});

test('validateAdapterShape reports only the specific capabilities missing, not the ones present', () => {
  const partialAdapter = { getShopInfo: () => {}, isConfigured: () => true };
  const result = validateAdapterShape(partialAdapter);
  assert.strictEqual(result.valid, false);
  assert.ok(!result.errors.some((e) => e.includes('getShopInfo')));
  assert.ok(!result.errors.some((e) => e.includes('isConfigured')));
  assert.ok(result.errors.some((e) => e.includes('getProducts')));
  assert.ok(result.errors.some((e) => e.includes('getOrders')));
});

test('validateAdapterShape rejects a capability present but not a function', () => {
  const badAdapter = {
    isConfigured: () => true,
    getShopInfo: 'not a function',
    getProducts: () => {},
    getOrders: () => {},
    getCustomers: () => {},
    getInventoryLevels: () => {},
    getCollections: () => {},
  };
  const result = validateAdapterShape(badAdapter);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing required capability: getShopInfo (must be a function)'));
});

test('integrations/adapters/shopifyClient.js satisfies the full contract today (structural check, no network call)', () => {
  const result = validateAdapterShape(shopifyClient);
  assert.deepStrictEqual(result, {
    valid: true,
    errors: [],
    // Shopify declares nothing unsupported, so it serves the whole read surface - the
    // baseline the unsupported-capability mechanism must leave completely untouched.
    supported: EXPECTED_CAPABILITY_IDS,
    unsupported: [],
  });
});

// ---------------------------------------------------------------------------------
// PUBLISHING KINDS. The publishing contract originally described exactly one kind of
// publish - a marketplace listing - so the project's one adapter that actually reaches
// a real store (Shopify's blog article publishing) reported as non-conforming while the
// adapter with no transport reported as conforming. Both kinds below describe
// capabilities that already exist and are already exported; nothing was added to either
// adapter, and no endpoint, field, credential or publishing behavior is invented.
// ---------------------------------------------------------------------------------

test('both publishing kinds are declared, each naming the real adapter that implements it', () => {
  assert.deepStrictEqual(
    PUBLISHING_ADAPTER_KINDS.map((kind) => kind.id),
    ['marketplace_listing', 'store_content']
  );
  assert.strictEqual(getPublishingKindById('marketplace_listing').implemented_by, 'integrations/adapters/etsyClient.js');
  assert.strictEqual(getPublishingKindById('store_content').implemented_by, 'integrations/adapters/shopifyClient.js');
  assert.strictEqual(getPublishingKindById('not_a_real_kind'), undefined);

  // Every declared capability of every kind is a real function on that kind's own
  // adapter - a kind is never declared for a capability nothing implements.
  const adapterForKind = { marketplace_listing: etsyClient, store_content: shopifyClient };
  for (const kind of PUBLISHING_ADAPTER_KINDS) {
    for (const capability of kind.capabilities) {
      assert.strictEqual(
        typeof adapterForKind[kind.id][capability.id],
        'function',
        `${kind.id}: ${capability.id} is declared but not implemented`
      );
      assert.ok(capability.description && capability.description.trim() !== '');
      assert.ok(capability.normalized_shape && capability.normalized_shape.trim() !== '');
    }
  }
});

test('THE GAP THIS CLOSED: the real, working Shopify content publisher now satisfies a publishing contract', () => {
  const result = validatePublishingAdapterShape(shopifyClient, { kind: 'store_content' });
  assert.deepStrictEqual(result, { valid: true, errors: [] });
  assert.deepStrictEqual(
    CONTENT_PUBLISHING_ADAPTER_CAPABILITIES.map((capability) => capability.id),
    ['isConfigured', 'hasWriteContentScope', 'createBlogArticle']
  );
});

test('each adapter is checked only against the kind it actually claims - the wrong kind is refused, not excused', () => {
  // A blog article is not a marketplace listing, and Shopify never claimed to publish one.
  assert.strictEqual(validatePublishingAdapterShape(shopifyClient, { kind: 'marketplace_listing' }).valid, false);
  // Etsy has no store-content publishing either, and is not credited with any.
  assert.strictEqual(validatePublishingAdapterShape(etsyClient, { kind: 'store_content' }).valid, false);
  // Etsy still satisfies the kind it does claim.
  assert.strictEqual(validatePublishingAdapterShape(etsyClient, { kind: 'marketplace_listing' }).valid, true);
});

test('omitting the kind reproduces the previous behavior exactly - marketplace listing', () => {
  assert.strictEqual(DEFAULT_PUBLISHING_KIND, 'marketplace_listing');
  assert.deepStrictEqual(
    validatePublishingAdapterShape(etsyClient),
    validatePublishingAdapterShape(etsyClient, { kind: 'marketplace_listing' })
  );
  assert.deepStrictEqual(
    validatePublishingAdapterShape(shopifyClient),
    validatePublishingAdapterShape(shopifyClient, { kind: 'marketplace_listing' })
  );
  // The pre-existing export is still the marketplace-listing kind's own capability list.
  assert.strictEqual(getPublishingKindById('marketplace_listing').capabilities, PUBLISHING_ADAPTER_CAPABILITIES);
});

test('an unknown kind is an error, never a silent pass', () => {
  const result = validatePublishingAdapterShape(shopifyClient, { kind: 'amazon_listing' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors[0].includes('unknown publishing kind: amazon_listing'));
  // Not even an empty object slips through on an unknown kind.
  assert.strictEqual(validatePublishingAdapterShape({}, { kind: 'nope' }).valid, false);
});

test('getPublishingCapabilityById looks up within one kind, never across kinds', () => {
  // isConfigured is required by BOTH kinds, so an un-scoped lookup would be ambiguous.
  assert.strictEqual(
    getPublishingCapabilityById('isConfigured', { kind: 'store_content' }).normalized_shape,
    'boolean'
  );
  assert.ok(getPublishingCapabilityById('publishListing'));
  // A capability belonging to the other kind is not found in this one.
  assert.strictEqual(getPublishingCapabilityById('publishListing', { kind: 'store_content' }), undefined);
  assert.strictEqual(getPublishingCapabilityById('createBlogArticle'), undefined);
  assert.strictEqual(getPublishingCapabilityById('createBlogArticle', { kind: 'store_content' }).id, 'createBlogArticle');
  assert.strictEqual(getPublishingCapabilityById('isConfigured', { kind: 'not_a_kind' }), undefined);
});

test('NO FAKE INTEGRATION: no kind is declared for a platform that has no adapter here', () => {
  const declaredAdapters = PUBLISHING_ADAPTER_KINDS.map((kind) => kind.implemented_by);
  for (const adapterPath of declaredAdapters) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', '..', adapterPath)),
      `${adapterPath} is declared as an implementation but does not exist`
    );
  }
  const contractSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'integrations', 'adapters', 'platformAdapterContract.js'),
    'utf8'
  );
  // The header legitimately names these as examples of adapters NOT added; no KIND may
  // be declared for any of them.
  for (const platform of ['amazon', 'ebay', 'wooCommerce']) {
    assert.ok(
      !PUBLISHING_ADAPTER_KINDS.some((kind) => kind.implemented_by.toLowerCase().includes(platform.toLowerCase())),
      `a publishing kind was declared for ${platform}, which has no adapter`
    );
  }
  // And the contract still adds no transport of its own to any platform.
  assert.ok(!/https?:\/\//.test(contractSource.replace(/\/\/.*$/gm, '')), 'the contract must contain no endpoint URL');
});

// ---------------------------------------------------------------------------------
// EXPLICITLY UNSUPPORTED CAPABILITIES - declared, never faked.
// ---------------------------------------------------------------------------------

// A minimal adapter that declares two capabilities unsupported. Hand-built rather than
// reusing a real adapter, so these tests exercise the MECHANISM, not one platform's
// particular limits. No function here performs any I/O.
function buildDeclaringAdapter(declaration) {
  const adapter = {};
  for (const id of EXPECTED_CAPABILITY_IDS) adapter[id] = () => {};
  if (declaration !== undefined) adapter[UNSUPPORTED_CAPABILITY_DECLARATION] = declaration;
  return adapter;
}

test('createUnsupportedCapabilityError builds an identifiable, attributable refusal', () => {
  const error = createUnsupportedCapabilityError({
    platform: 'example',
    capability: 'getOrders',
    reason: 'the example platform exposes no order endpoint.',
  });
  assert.ok(error instanceof Error);
  assert.strictEqual(error.code, UNSUPPORTED_CAPABILITY_CODE);
  assert.strictEqual(error.platform, 'example');
  assert.strictEqual(error.capability, 'getOrders');
  assert.ok(error.message.includes('getOrders'));
  assert.ok(error.message.includes('the example platform exposes no order endpoint.'));
  // It must say that nothing happened, so a caller cannot read it as a partial success.
  assert.ok(/No request was attempted/.test(error.message));
});

test('createUnsupportedCapabilityError refuses to build a refusal with no stated reason', () => {
  assert.throws(
    () => createUnsupportedCapabilityError({ platform: 'example', capability: 'getOrders' }),
    /requires a non-empty `reason`/
  );
  assert.throws(() => createUnsupportedCapabilityError({ capability: 'getOrders', reason: 'x' }), /non-empty `platform`/);
  assert.throws(() => createUnsupportedCapabilityError({ platform: 'example', reason: 'x' }), /non-empty `capability`/);
});

test('isUnsupportedCapabilityError distinguishes a platform limit from any other failure', () => {
  const unsupported = createUnsupportedCapabilityError({
    platform: 'example',
    capability: 'getOrders',
    reason: 'no order endpoint.',
  });
  assert.strictEqual(isUnsupportedCapabilityError(unsupported), true);
  // A network failure, a missing credential, and a platform error must never be mistaken
  // for "this platform cannot answer that".
  assert.strictEqual(isUnsupportedCapabilityError(new Error('fetch failed')), false);
  assert.strictEqual(isUnsupportedCapabilityError(null), false);
  assert.strictEqual(isUnsupportedCapabilityError(undefined), false);
});

test('an adapter declaring nothing is completely unaffected - it supports everything', () => {
  const result = validateAdapterShape(buildDeclaringAdapter());
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.supported, EXPECTED_CAPABILITY_IDS);
  assert.deepStrictEqual(result.unsupported, []);
  assert.deepStrictEqual(getDeclaredUnsupportedCapabilities(buildDeclaringAdapter()), []);
});

test('a declared capability is reported as unsupported, and the rest stay supported', () => {
  const result = validateAdapterShape(buildDeclaringAdapter(['getOrders', 'getCustomers']));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.unsupported, ['getOrders', 'getCustomers']);
  assert.deepStrictEqual(
    result.supported,
    EXPECTED_CAPABILITY_IDS.filter((id) => id !== 'getOrders' && id !== 'getCustomers')
  );
});

test('A DECLARATION IS NOT A WAIVER: a declared capability must still be present as a function', () => {
  const adapter = buildDeclaringAdapter(['getOrders']);
  delete adapter.getOrders;
  const result = validateAdapterShape(adapter);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing required capability: getOrders (must be a function)'));
});

test('a declaration naming something that is not a capability is a mis-declaration, never ignored', () => {
  const result = validateAdapterShape(buildDeclaringAdapter(['getOrders', 'getRefunds']));
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("names 'getRefunds', which is not a required capability")));
  // The valid half is still classified correctly - one bad entry does not corrupt the rest.
  assert.deepStrictEqual(result.unsupported, ['getOrders']);
});

test('a duplicated declaration is reported rather than silently collapsed', () => {
  const result = validateAdapterShape(buildDeclaringAdapter(['getOrders', 'getOrders']));
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("names 'getOrders' more than once")));
});

test('a non-array declaration is rejected', () => {
  const result = validateAdapterShape(buildDeclaringAdapter('getOrders'));
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be an array of required capability ids')));
});

test("the contract rule forbidding faked results names the empty-value trap explicitly", () => {
  const rule = getRuleById('unsupported_is_declared_never_faked');
  assert.ok(rule, 'the rule must exist');
  assert.ok(/empty array/.test(rule.description));
  assert.ok(/never/i.test(rule.description));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
