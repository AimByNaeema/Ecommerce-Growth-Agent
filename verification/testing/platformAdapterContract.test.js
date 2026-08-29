'use strict';

const assert = require('node:assert');
const {
  REQUIRED_ADAPTER_CAPABILITIES,
  ADAPTER_CONTRACT_RULES,
  getCapabilityById,
  getRuleById,
  validateAdapterShape,
} = require('../../integrations/adapters/platformAdapterContract');
const shopifyClient = require('../../integrations/adapters/shopifyClient');

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

test('the 4 required contract rules exist, in the requested order', () => {
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
  assert.deepStrictEqual(result, { valid: true, errors: [] });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
