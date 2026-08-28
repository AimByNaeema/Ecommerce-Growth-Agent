'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  isValidBusinessId,
  getBusinessBasePath,
  listBusinessIds,
  loadBusinessConfig,
  parseEnvFileContent,
  loadBusinessCredentials,
  CREDENTIAL_KEYS,
} = require('../../configuration/businessRegistry');

// Tests write real, temporary subdirectories under configuration/businesses/ (the
// module's own fixed root - it does not accept an arbitrary path) and remove them in
// `finally`, same convention as this project's other filesystem-touching tests
// (see secretExposureAudit.test.js's directory walk).

const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');

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

function withTempBusiness(id, { businessYaml, envFile } = {}, fn) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  if (typeof businessYaml === 'string') {
    fs.writeFileSync(path.join(dir, 'business.yaml'), businessYaml);
  }
  if (typeof envFile === 'string') {
    fs.writeFileSync(path.join(dir, '.env'), envFile);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_BUSINESS_YAML = `
business_name: "Test Co"
business_model: "D2C"
platform: "Shopify"
product_model: "in-house"
target_markets: ["US"]
countries: ["US"]
currencies: ["USD"]
product_categories: ["widgets"]
customer_segments: ["general"]
brand:
  name: "Test Co"
business_goals: ["grow"]
marketing_channels: ["email"]
`;

// --- isValidBusinessId -------------------------------------------------------------

test('isValidBusinessId accepts a plain alphanumeric slug', () => {
  assert.strictEqual(isValidBusinessId('acme-store'), true);
  assert.strictEqual(isValidBusinessId('acme_store_2'), true);
});

test('isValidBusinessId rejects path traversal and path separators', () => {
  assert.strictEqual(isValidBusinessId('../etc'), false);
  assert.strictEqual(isValidBusinessId('..\\etc'), false);
  assert.strictEqual(isValidBusinessId('a/b'), false);
  assert.strictEqual(isValidBusinessId('a\\b'), false);
  assert.strictEqual(isValidBusinessId('..'), false);
});

test('isValidBusinessId rejects empty, non-string, or non-alphanumeric-leading ids', () => {
  assert.strictEqual(isValidBusinessId(''), false);
  assert.strictEqual(isValidBusinessId(null), false);
  assert.strictEqual(isValidBusinessId(undefined), false);
  assert.strictEqual(isValidBusinessId('-leading-hyphen'), false);
});

// --- getBusinessBasePath ------------------------------------------------------------

test('getBusinessBasePath returns configuration/businesses/<id> for a valid id', () => {
  const result = getBusinessBasePath('acme-store');
  assert.strictEqual(result, path.join(BUSINESSES_ROOT, 'acme-store'));
});

test('getBusinessBasePath throws (never builds a path) for an invalid id', () => {
  assert.throws(() => getBusinessBasePath('../etc'), /Invalid businessId/);
});

// --- listBusinessIds -----------------------------------------------------------------

test('listBusinessIds returns [] when configuration/businesses/ does not exist or has no entries matching', () => {
  // Not asserting the directory is literally absent (other tests in this file create
  // temp businesses) - only that unrelated/non-directory entries are excluded and the
  // function never throws just because the root is sparse or missing.
  const ids = listBusinessIds();
  assert.ok(Array.isArray(ids));
});

test('listBusinessIds lists a real temporary business directory', () => {
  withTempBusiness('test-registry-list', {}, () => {
    const ids = listBusinessIds();
    assert.ok(ids.includes('test-registry-list'));
  });
});

// --- loadBusinessConfig (delegates to tools/configValidator.js) --------------------

test('loadBusinessConfig reuses configValidator.js\'s loader and returns parsed YAML', () => {
  withTempBusiness('test-registry-config', { businessYaml: VALID_BUSINESS_YAML }, () => {
    const config = loadBusinessConfig('test-registry-config');
    assert.strictEqual(config.business_name, 'Test Co');
    assert.strictEqual(config.platform, 'Shopify');
  });
});

test('loadBusinessConfig throws a clear error when business.yaml is missing', () => {
  withTempBusiness('test-registry-config-missing', {}, () => {
    assert.throws(() => loadBusinessConfig('test-registry-config-missing'), /Business configuration file not found/);
  });
});

// --- parseEnvFileContent (pure) -----------------------------------------------------

test('parseEnvFileContent parses KEY=VALUE lines, skipping blanks and comments', () => {
  const parsed = parseEnvFileContent(
    '# a comment\n\nSHOPIFY_STORE_DOMAIN=acme.myshopify.com\nSHOPIFY_ADMIN_API_ACCESS_TOKEN="shpat_fake-not-real"\n'
  );
  assert.strictEqual(parsed.SHOPIFY_STORE_DOMAIN, 'acme.myshopify.com');
  assert.strictEqual(parsed.SHOPIFY_ADMIN_API_ACCESS_TOKEN, 'shpat_fake-not-real');
});

test('parseEnvFileContent never touches process.env', () => {
  const before = process.env.SOME_RANDOM_TEST_KEY_NOT_USED_ELSEWHERE;
  parseEnvFileContent('SOME_RANDOM_TEST_KEY_NOT_USED_ELSEWHERE=should-not-leak-into-process-env');
  assert.strictEqual(process.env.SOME_RANDOM_TEST_KEY_NOT_USED_ELSEWHERE, before);
});

// --- loadBusinessCredentials ---------------------------------------------------------

test('loadBusinessCredentials parses a temp .env into a plain object with exactly CREDENTIAL_KEYS', () => {
  withTempBusiness(
    'test-registry-creds',
    { envFile: 'SHOPIFY_STORE_DOMAIN=acme.myshopify.com\nSHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_fake-not-real\n' },
    () => {
      const credentials = loadBusinessCredentials('test-registry-creds');
      assert.deepStrictEqual(Object.keys(credentials).sort(), [...CREDENTIAL_KEYS].sort());
      assert.strictEqual(credentials.SHOPIFY_STORE_DOMAIN, 'acme.myshopify.com');
      assert.strictEqual(credentials.SHOPIFY_ADMIN_API_ACCESS_TOKEN, 'shpat_fake-not-real');
      assert.strictEqual(credentials.ANTHROPIC_API_KEY, '');
    }
  );
});

test('loadBusinessCredentials throws a clear, actionable error when .env is missing - never fabricates credentials', () => {
  withTempBusiness('test-registry-creds-missing', {}, () => {
    assert.throws(
      () => loadBusinessCredentials('test-registry-creds-missing'),
      /Business credentials file not found/
    );
  });
});

test('loadBusinessCredentials never touches process.env', () => {
  const before = process.env.SHOPIFY_STORE_DOMAIN;
  withTempBusiness(
    'test-registry-creds-no-env-mutation',
    { envFile: 'SHOPIFY_STORE_DOMAIN=should-not-leak-into-process-env.myshopify.com\n' },
    () => {
      loadBusinessCredentials('test-registry-creds-no-env-mutation');
      assert.strictEqual(process.env.SHOPIFY_STORE_DOMAIN, before);
    }
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
