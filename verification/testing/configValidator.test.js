'use strict';

const assert = require('node:assert');
const path = require('path');
const {
  REQUIRED_FIELDS,
  ENABLED_PLATFORMS_FIELD,
  validateBusinessConfig,
  validateEnabledPlatforms,
  readEnabledPlatforms,
  AUTONOMY_FIELD,
  validateAutonomyConfig,
  readAutonomyConfig,
  loadBusinessConfig,
} = require('../../tools/configValidator');
const { CHANNELS } = require('../../agent/core/channelModel');

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

// ---------------------------------------------------------------------------------
// enabled_platforms - the only authority on platform enablement.
// ---------------------------------------------------------------------------------

test('enabled_platforms is OPTIONAL - it is deliberately not a required field', () => {
  assert.ok(
    !REQUIRED_FIELDS.includes(ENABLED_PLATFORMS_FIELD),
    'enabled_platforms must stay optional, like integrations - a config predating it stays valid'
  );
  // The complete fixture has no enabled_platforms and must still be fully valid.
  const result = validateBusinessConfig(completeFixture);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.missing, []);
});

test('an absent enabled_platforms reads as [] and validates - honest silence, not a permissive default', () => {
  assert.deepStrictEqual(readEnabledPlatforms(completeFixture), []);
  assert.deepStrictEqual(readEnabledPlatforms({}), []);
  assert.deepStrictEqual(readEnabledPlatforms(null), []);
  assert.deepStrictEqual(readEnabledPlatforms(undefined), []);
  assert.strictEqual(validateEnabledPlatforms(completeFixture).valid, true);
  assert.strictEqual(validateEnabledPlatforms({ enabled_platforms: null }).valid, true);
});

test('a well-formed enabled_platforms validates and reads back exactly', () => {
  for (const platforms of [['shopify'], ['etsy'], ['shopify', 'etsy'], ['etsy', 'shopify'], []]) {
    const config = { ...completeFixture, enabled_platforms: platforms };
    const result = validateEnabledPlatforms(config);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(readEnabledPlatforms(config), platforms);
  }
});

test('enabled_platforms entries are normalized case- and whitespace-insensitively when read', () => {
  assert.deepStrictEqual(readEnabledPlatforms({ enabled_platforms: ['Shopify', ' ETSY '] }), ['shopify', 'etsy']);
  // A duplicate after normalization is reported once, never twice.
  assert.deepStrictEqual(readEnabledPlatforms({ enabled_platforms: ['shopify', 'Shopify'] }), ['shopify']);
});

test('a non-array enabled_platforms is rejected, naming the valid platforms', () => {
  for (const value of ['shopify', 42, true, {}]) {
    const result = validateEnabledPlatforms({ enabled_platforms: value });
    assert.strictEqual(result.valid, false, `${JSON.stringify(value)} must be rejected`);
    assert.ok(/must be a list of platform ids/.test(result.errors[0]));
    assert.ok(result.errors[0].includes(CHANNELS.join(', ')));
    // The reader never throws for a malformed value - it reports nothing enabled.
    assert.deepStrictEqual(readEnabledPlatforms({ enabled_platforms: value }), []);
  }
});

test('a platform with no adapter is rejected by name, never silently dropped', () => {
  for (const platform of ['amazon', 'ebay', 'woocommerce', 'wordpress']) {
    const result = validateEnabledPlatforms({ enabled_platforms: [platform] });
    assert.strictEqual(result.valid, false, `${platform} must be rejected`);
    assert.ok(
      result.errors[0].includes(platform) && /is not a platform this project has an adapter for/.test(result.errors[0]),
      `the error must name '${platform}' and say why: got ${result.errors[0]}`
    );
  }
});

test('an unrecognized platform alongside a real one still fails validation, and reads as the real one only', () => {
  const config = { enabled_platforms: ['shopify', 'amazon'] };
  assert.strictEqual(validateEnabledPlatforms(config).valid, false);
  assert.deepStrictEqual(readEnabledPlatforms(config), ['shopify']);
});

test('a blank, null or non-string entry is rejected', () => {
  for (const entry of ['', '   ', null, undefined, 42, {}]) {
    const result = validateEnabledPlatforms({ enabled_platforms: [entry] });
    assert.strictEqual(result.valid, false, `${JSON.stringify(entry)} must be rejected`);
  }
});

test('a duplicated platform is reported rather than accepted quietly', () => {
  const result = validateEnabledPlatforms({ enabled_platforms: ['shopify', 'shopify'] });
  assert.strictEqual(result.valid, false);
  assert.ok(/more than once/.test(result.errors[0]));
});

test('the shipped template declares an empty enabled_platforms - no platform is enabled by default', () => {
  const templatePath = path.join(__dirname, '..', '..', 'configuration', 'business.example.yaml');
  const config = loadBusinessConfig(templatePath);
  assert.ok(ENABLED_PLATFORMS_FIELD in config, 'the template must document the field');
  assert.deepStrictEqual(readEnabledPlatforms(config), []);
  assert.strictEqual(validateEnabledPlatforms(config).valid, true);
});

// ---------------------------------------------------------------------------------
// autonomy - whether the business permits the agent to act on its own, and its daily
// budget. Same optional-but-strictly-validated treatment as enabled_platforms above.
// ---------------------------------------------------------------------------------

test('an absent autonomy block is valid, and means autonomy is off', () => {
  assert.strictEqual(validateAutonomyConfig(completeFixture).valid, true);
  assert.strictEqual(validateAutonomyConfig({}).valid, true);
  for (const config of [completeFixture, {}, null, undefined]) {
    assert.deepStrictEqual(readAutonomyConfig(config), { enabled: false, daily_token_budget: null, daily_run_budget: null });
  }
});

test('autonomy is granted only by a real boolean true', () => {
  assert.strictEqual(readAutonomyConfig({ autonomy: { enabled: true } }).enabled, true);
  // Every near-miss reads as off - a permission this consequential is never rescued by a
  // coercion rule nobody can see.
  for (const value of ['true', 'True', 1, 'yes', 'on', [], {}]) {
    assert.strictEqual(readAutonomyConfig({ autonomy: { enabled: value } }).enabled, false, 'must read as off: ' + JSON.stringify(value));
  }
});

test('a non-boolean enabled is reported as an error, not quietly read as off', () => {
  const result = validateAutonomyConfig({ autonomy: { enabled: 'true' } });
  assert.strictEqual(result.valid, false);
  assert.ok(/enabled must be true or false/.test(result.errors[0]));
  assert.ok(result.errors[0].includes("'true'"), 'the offending value must be named');
});

test('an autonomy block of the wrong shape is rejected', () => {
  for (const value of ['yes', 42, ['enabled']]) {
    const result = validateAutonomyConfig({ autonomy: value });
    assert.strictEqual(result.valid, false, 'must be rejected: ' + JSON.stringify(value));
  }
});

test('the daily budgets are optional whole numbers, and blank means "project default"', () => {
  const stated = readAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: 5000, daily_run_budget: '12' } });
  assert.strictEqual(stated.daily_token_budget, 5000);
  assert.strictEqual(stated.daily_run_budget, 12);

  const blank = readAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: null, daily_run_budget: '' } });
  assert.strictEqual(blank.daily_token_budget, null);
  assert.strictEqual(blank.daily_run_budget, null);
  assert.strictEqual(validateAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: null } }).valid, true);
});

test('a budget that is not a positive whole number is rejected with its value named', () => {
  for (const value of [0, -5, 1.5, 'lots', true]) {
    const result = validateAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: value } });
    assert.strictEqual(result.valid, false, 'must be rejected: ' + JSON.stringify(value));
    assert.ok(result.errors[0].includes(String(value)), 'the offending value must be named');
    // And the reader refuses to guess a replacement for it.
    assert.strictEqual(readAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: value } }).daily_token_budget, null);
  }
});

test('a budget is never money - the error says so', () => {
  const result = validateAutonomyConfig({ autonomy: { enabled: true, daily_token_budget: -1 } });
  assert.ok(/never money/.test(result.errors[0]));
});

test('the shipped template documents autonomy and ships it off', () => {
  const templatePath = path.join(__dirname, '..', '..', 'configuration', 'business.example.yaml');
  const config = loadBusinessConfig(templatePath);
  assert.ok(AUTONOMY_FIELD in config, 'the template must document the field');
  assert.strictEqual(validateAutonomyConfig(config).valid, true);
  assert.deepStrictEqual(readAutonomyConfig(config), { enabled: false, daily_token_budget: null, daily_run_budget: null });
});

test('autonomy and enabled_platforms are independent - neither implies the other', () => {
  const autonomousNoPlatforms = { autonomy: { enabled: true }, enabled_platforms: [] };
  assert.strictEqual(readAutonomyConfig(autonomousNoPlatforms).enabled, true);
  assert.deepStrictEqual(readEnabledPlatforms(autonomousNoPlatforms), []);

  const platformsNoAutonomy = { enabled_platforms: ['shopify', 'etsy'] };
  assert.strictEqual(readAutonomyConfig(platformsNoAutonomy).enabled, false);
  assert.deepStrictEqual(readEnabledPlatforms(platformsNoAutonomy), ['shopify', 'etsy']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
