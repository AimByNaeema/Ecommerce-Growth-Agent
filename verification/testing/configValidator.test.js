'use strict';

const assert = require('node:assert');
const path = require('path');
const {
  REQUIRED_FIELDS,
  validateBusinessConfig,
  loadBusinessConfig,
} = require('../../tools/configValidator');

// Dummy test fixtures - not real business data, only for exercising the validator.
const completeFixture = {
  business_name: 'Test Business',
  business_model: 'D2C',
  platform: 'Shopify',
  product_model: 'in-house',
  target_markets: ['Test Market'],
  countries: ['US'],
  currencies: ['USD'],
  product_categories: ['Test Category'],
  customer_segments: ['Test Segment'],
  brand: { name: 'Test Brand' },
  business_goals: ['Test Goal'],
  marketing_channels: ['Email'],
};

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

test('valid config: complete fixture reports valid with no missing fields', () => {
  const result = validateBusinessConfig(completeFixture);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.missing, []);
});

test('incomplete config: missing fields (including nested brand.name) are all reported', () => {
  const incomplete = {
    ...completeFixture,
    business_name: '',
    countries: [],
    brand: { name: '' },
  };
  delete incomplete.marketing_channels;

  const result = validateBusinessConfig(incomplete);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.missing.sort(),
    ['business_name', 'countries', 'brand.name', 'marketing_channels'].sort()
  );
});

test('incomplete config: does not guess or fill defaults for missing fields', () => {
  const result = validateBusinessConfig({});
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.missing.sort(), [...REQUIRED_FIELDS].sort());
});

test('real blank template (configuration/business.example.yaml) is correctly detected as incomplete', () => {
  const templatePath = path.join(__dirname, '..', '..', 'configuration', 'business.example.yaml');
  const config = loadBusinessConfig(templatePath);
  const result = validateBusinessConfig(config);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.missing.sort(), [...REQUIRED_FIELDS].sort());
});

test('loadBusinessConfig throws a clear error for a missing file (does not guess)', () => {
  assert.throws(
    () => loadBusinessConfig(path.join(__dirname, 'does-not-exist.yaml')),
    /Business configuration file not found/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
