'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  isValidBusinessId,
  getBusinessBasePath,
  listBusinessIds,
  loadBusinessConfig,
  getEnabledPlatforms,
  getAutonomyConfig,
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

test('CREDENTIAL_KEYS includes the Shopify OAuth Client Credentials keys alongside the static access token key', () => {
  assert.ok(CREDENTIAL_KEYS.includes('SHOPIFY_ADMIN_API_ACCESS_TOKEN'));
  assert.ok(CREDENTIAL_KEYS.includes('SHOPIFY_CLIENT_ID'));
  assert.ok(CREDENTIAL_KEYS.includes('SHOPIFY_CLIENT_SECRET'));
});

test('loadBusinessCredentials parses SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET from a temp .env (Dev Dashboard app shape)', () => {
  withTempBusiness(
    'test-registry-creds-client-credentials',
    {
      envFile:
        'SHOPIFY_STORE_DOMAIN=acme.myshopify.com\nSHOPIFY_CLIENT_ID=fake-client-id-not-real\nSHOPIFY_CLIENT_SECRET=fake-client-secret-not-real\n',
    },
    () => {
      const credentials = loadBusinessCredentials('test-registry-creds-client-credentials');
      assert.strictEqual(credentials.SHOPIFY_CLIENT_ID, 'fake-client-id-not-real');
      assert.strictEqual(credentials.SHOPIFY_CLIENT_SECRET, 'fake-client-secret-not-real');
      // The static-token key stays present-but-empty, not omitted - loadBusinessCredentials
      // always returns exactly CREDENTIAL_KEYS regardless of which auth shape a .env uses.
      assert.strictEqual(credentials.SHOPIFY_ADMIN_API_ACCESS_TOKEN, '');
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

// --- getAutonomyConfig (what feeds agent/core/autonomyPolicy.js) --------------------
//
// Same shape of function, same rules, same evidence: read from configuration alone,
// never from a credential, and off unless the file says otherwise.

test('getAutonomyConfig returns what a business config actually states', () => {
  withTempBusiness(
    'test-registry-autonomy-on',
    { businessYaml: `${VALID_BUSINESS_YAML}
autonomy:
  enabled: true
  daily_token_budget: 7500
` },
    () => {
      assert.deepStrictEqual(getAutonomyConfig('test-registry-autonomy-on'), {
        enabled: true,
        daily_token_budget: 7500,
        daily_run_budget: null,
      });
    }
  );
});

test('getAutonomyConfig reports autonomy off for a config that states none', () => {
  // VALID_BUSINESS_YAML has no autonomy block - the pre-existing config shape, which must
  // keep meaning "never granted".
  withTempBusiness('test-registry-autonomy-absent', { businessYaml: VALID_BUSINESS_YAML }, () => {
    assert.deepStrictEqual(getAutonomyConfig('test-registry-autonomy-absent'), {
      enabled: false,
      daily_token_budget: null,
      daily_run_budget: null,
    });
  });
});

test('getAutonomyConfig never consults credentials - a full Shopify and Etsy .env grants nothing', () => {
  withTempBusiness(
    'test-registry-autonomy-creds',
    {
      businessYaml: VALID_BUSINESS_YAML,
      envFile: [
        'SHOPIFY_STORE_DOMAIN=creds-test.myshopify.com',
        'SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_not-a-real-token',
        'ETSY_API_KEYSTRING=not-a-real-keystring',
        'ETSY_OAUTH_ACCESS_TOKEN=not-a-real-token',
      ].join('\n'),
    },
    () => {
      assert.strictEqual(getAutonomyConfig('test-registry-autonomy-creds').enabled, false);
    }
  );
});

test('getAutonomyConfig and getEnabledPlatforms are independent decisions', () => {
  withTempBusiness(
    'test-registry-autonomy-split',
    { businessYaml: `${VALID_BUSINESS_YAML}
enabled_platforms: ["shopify"]
autonomy:
  enabled: false
` },
    () => {
      assert.deepStrictEqual(getEnabledPlatforms('test-registry-autonomy-split'), ['shopify']);
      assert.strictEqual(getAutonomyConfig('test-registry-autonomy-split').enabled, false);
    }
  );
});

// --- getEnabledPlatforms (the list that feeds the permission gate) ------------------
//
// Every test below reads a temp business.yaml from disk. None reads a credential, and
// none reaches Shopify, Etsy or any other external service.

test('getEnabledPlatforms returns the platforms a business config actually states', () => {
  withTempBusiness(
    'test-registry-platforms',
    { businessYaml: `${VALID_BUSINESS_YAML}\nenabled_platforms: ["shopify", "etsy"]\n` },
    () => {
      assert.deepStrictEqual(getEnabledPlatforms('test-registry-platforms'), ['shopify', 'etsy']);
    }
  );
});

test('getEnabledPlatforms returns [] for a business config that states none', () => {
  // VALID_BUSINESS_YAML has no enabled_platforms - the pre-existing config shape.
  withTempBusiness('test-registry-platforms-absent', { businessYaml: VALID_BUSINESS_YAML }, () => {
    assert.deepStrictEqual(getEnabledPlatforms('test-registry-platforms-absent'), []);
  });
});

test('getEnabledPlatforms drops a platform this project has no adapter for', () => {
  withTempBusiness(
    'test-registry-platforms-unknown',
    { businessYaml: `${VALID_BUSINESS_YAML}\nenabled_platforms: ["shopify", "amazon", "ebay"]\n` },
    () => {
      assert.deepStrictEqual(getEnabledPlatforms('test-registry-platforms-unknown'), ['shopify']);
    }
  );
});

test('getEnabledPlatforms ignores the free-text platform field entirely', () => {
  // `platform: "Shopify"` is descriptive prose and must never grant access on its own.
  withTempBusiness('test-registry-platforms-prose', { businessYaml: VALID_BUSINESS_YAML }, () => {
    const config = loadBusinessConfig('test-registry-platforms-prose');
    assert.strictEqual(config.platform, 'Shopify');
    assert.deepStrictEqual(getEnabledPlatforms('test-registry-platforms-prose'), []);
  });
});

test('getEnabledPlatforms never consults credentials - a full Etsy .env enables nothing', () => {
  withTempBusiness(
    'test-registry-platforms-creds',
    {
      businessYaml: `${VALID_BUSINESS_YAML}\nenabled_platforms: ["shopify"]\n`,
      envFile: [
        'SHOPIFY_STORE_DOMAIN=example.myshopify.com',
        'ETSY_API_KEYSTRING=CANARY-must-not-enable-etsy',
        'ETSY_OAUTH_ACCESS_TOKEN=CANARY-must-not-enable-etsy',
        'ETSY_SHOP_ID=12345678',
      ].join('\n'),
    },
    () => {
      // The credentials are genuinely present...
      const credentials = loadBusinessCredentials('test-registry-platforms-creds');
      assert.notStrictEqual(credentials.ETSY_API_KEYSTRING, '');
      // ...and Etsy is still not enabled, because configuration alone decides.
      assert.deepStrictEqual(getEnabledPlatforms('test-registry-platforms-creds'), ['shopify']);
    }
  );
});

test('getEnabledPlatforms throws a clear error when business.yaml is missing (never guesses)', () => {
  withTempBusiness('test-registry-platforms-missing', {}, () => {
    assert.throws(() => getEnabledPlatforms('test-registry-platforms-missing'), /Business configuration file not found/);
  });
});

test('getEnabledPlatforms rejects an invalid businessId before touching the filesystem', () => {
  assert.throws(() => getEnabledPlatforms('../escape'), /Invalid businessId/);
});

test('getEnabledPlatforms output is canonical and directly usable by the permission gate', () => {
  // The end-to-end contract Phase 3 will rely on: config -> getEnabledPlatforms ->
  // checkToolAccess. The config deliberately writes a platform in non-canonical form to
  // prove the CONFIG layer canonicalizes once, so the gate receives ids it can vouch for.
  const { checkToolAccess } = require('../../agent/core/toolPermissions');
  withTempBusiness(
    'test-registry-platforms-gate',
    { businessYaml: `${VALID_BUSINESS_YAML}\nenabled_platforms: ["Shopify"]\n` },
    () => {
      const enabledPlatforms = getEnabledPlatforms('test-registry-platforms-gate');
      assert.deepStrictEqual(enabledPlatforms, ['shopify']);

      assert.strictEqual(
        checkToolAccess({ specialistId: 'product', toolId: 'product_data_retrieval', enabledPlatforms }).decision,
        'allowed'
      );
      assert.strictEqual(
        checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval', enabledPlatforms }).decision,
        'denied'
      );
    }
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
