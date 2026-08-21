'use strict';

const assert = require('node:assert');
const path = require('path');
const {
  REQUIRED_FIELDS,
  validateBusinessConfig,
  loadBusinessConfig,
} = require('../../tools/configValidator');

// Unlike configuration/business.yaml (real, git-ignored, may not exist), this sample
// is committed, fixed content - a legitimate deterministic test target, same as any
// other schema fixture in this project.
const samplePath = path.join(__dirname, '..', '..', 'configuration', 'business.sample.yaml');

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

test('business.sample.yaml loads and validates as a complete configuration', () => {
  const config = loadBusinessConfig(samplePath);
  const result = validateBusinessConfig(config);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.missing, []);
});

test('business.sample.yaml has every required field present and non-empty', () => {
  const config = loadBusinessConfig(samplePath);
  for (const field of REQUIRED_FIELDS) {
    const value = field.split('.').reduce((v, key) => (v ? v[key] : undefined), config);
    assert.notStrictEqual(value, undefined, `${field} should be present`);
    if (typeof value === 'string') {
      assert.notStrictEqual(value.trim(), '', `${field} should not be blank`);
    }
    if (Array.isArray(value)) {
      assert.ok(value.length > 0, `${field} should not be empty`);
    }
  }
});

test('business.sample.yaml demonstrates a non-hardcoded platform value', () => {
  const config = loadBusinessConfig(samplePath);
  assert.strictEqual(typeof config.platform, 'string');
  assert.notStrictEqual(config.platform.trim(), '');
});

test('business.sample.yaml demonstrates the optional integrations field populated', () => {
  const config = loadBusinessConfig(samplePath);
  assert.ok(Array.isArray(config.integrations));
  assert.ok(config.integrations.length > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
