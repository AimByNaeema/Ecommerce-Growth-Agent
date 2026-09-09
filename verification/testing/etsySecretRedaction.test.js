'use strict';

// Etsy credentials never surface - not in a log, an error, a tool result, or an audit
// record. Follows verification/testing/secretExposureAudit.test.js's pattern of asserting
// against the module SOURCE as well as its behavior.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { redactSensitiveData, createAuditTracker, appendAuditEvent } = require('../../audit/auditTrail');
const { CREDENTIAL_KEYS } = require('../../configuration/businessRegistry');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const etsyOAuth = require('../../integrations/etsyOAuth');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyAuthorizeCli = require('../../integrations/etsyAuthorizeCli');

// Load .env ONCE, before any test manipulates process.env - see the same note in
// etsyShopDataTool.test.js.
require('../../integrations/adapters/etsyClient').loadEnvOnce();

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

const SOURCE_ROOT = path.join(__dirname, '..', '..');
const ETSY_SOURCE_FILES = [
  'integrations/etsyOAuth.js',
  'integrations/etsyAuthorizeCli.js',
  'integrations/adapters/etsyReadClient.js',
  'tools/etsyShopDataTool.js',
  'tools/etsyListingDataTool.js',
];

const ETSY_SECRET_KEYS = [
  'ETSY_API_KEYSTRING',
  // Etsy requires the x-api-key header to carry `keystring:shared_secret`, so the shared
  // secret is now a live credential this project holds - and must be held to the same
  // never-logged, always-redacted standard as the tokens.
  'ETSY_SHARED_SECRET',
  'ETSY_OAUTH_ACCESS_TOKEN',
  'ETSY_OAUTH_REFRESH_TOKEN',
];

(async () => {
  // --- THE SHARED REDACTOR COVERS EVERY ETSY CREDENTIAL ------------------------------

  test('redactSensitiveData masks every Etsy credential key by name', () => {
    const record = {
      ETSY_API_KEYSTRING: 'SECRET_KEYSTRING',
      ETSY_OAUTH_ACCESS_TOKEN: 'SECRET_ACCESS',
      ETSY_OAUTH_REFRESH_TOKEN: 'SECRET_REFRESH',
      accessToken: 'SECRET_ACCESS',
      refreshToken: 'SECRET_REFRESH',
      keystring: 'SECRET_KEYSTRING',
      authorization: 'Bearer SECRET_ACCESS',
    };
    const redacted = redactSensitiveData(record);
    for (const key of ['ETSY_API_KEYSTRING', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_OAUTH_REFRESH_TOKEN', 'accessToken', 'refreshToken', 'authorization']) {
      assert.strictEqual(redacted[key], '[REDACTED]', `${key} must be redacted`);
    }
  });

  test('EVERY Etsy credential in the registry is matched by the shared redaction pattern', () => {
    const etsyKeys = CREDENTIAL_KEYS.filter((key) => key.startsWith('ETSY_'));
    assert.ok(etsyKeys.length > 0);
    const secretKeys = etsyKeys.filter((key) => /KEYSTRING|TOKEN|SECRET/.test(key));
    const redacted = redactSensitiveData(Object.fromEntries(secretKeys.map((key) => [key, 'SECRET_VALUE'])));
    for (const key of secretKeys) {
      assert.strictEqual(redacted[key], '[REDACTED]', `${key} must be redacted`);
    }
    // ETSY_SHOP_ID and ETSY_OAUTH_REDIRECT_URI are deliberately NOT secrets - the shop id
    // is public and the redirect URI is registered publicly with Etsy.
    assert.ok(!/KEYSTRING|TOKEN|SECRET/.test('ETSY_SHOP_ID'));
  });

  test('an audit record carrying Etsy credentials is redacted before it is stored', () => {
    const tracker = createAuditTracker('run-etsy-test');
    appendAuditEvent(tracker, {
      type: 'data_access',
      toolId: 'etsy_listing_data_retrieval',
      classification: 'analysis_only',
      status: 'success',
      summary: 'Read Etsy listings',
      detail: {
        channel: 'etsy',
        access: 'read',
        ETSY_API_KEYSTRING: 'SECRET_KEYSTRING',
        accessToken: 'SECRET_ACCESS',
        refreshToken: 'SECRET_REFRESH',
      },
    });
    const serialized = JSON.stringify(tracker.events);
    for (const secret of ['SECRET_KEYSTRING', 'SECRET_ACCESS', 'SECRET_REFRESH']) {
      assert.ok(!serialized.includes(secret), `the audit trail leaked ${secret}`);
    }
    assert.ok(serialized.includes('[REDACTED]'));
    // The non-secret facts an audit record exists to carry still survive.
    assert.ok(serialized.includes('"channel":"etsy"'));
    assert.ok(serialized.includes('"access":"read"'));
  });

  // --- BEHAVIOR: NOTHING LEAKS THROUGH AN ERROR OR A TOOL RESULT ---------------------

  await testAsync('a tool result reports missing credentials by KEY NAME, never by value', async () => {
    const saved = {};
    for (const key of ETSY_SECRET_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    etsyReadClient.clearEtsyReadCaches();
    try {
      const outcome = await etsyShopDataTool.runEtsyShopDataTool({});
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error.includes('ETSY_API_KEYSTRING'), 'the KEY NAME is what a caller needs');
      assert.strictEqual(outcome.result, null);
    } finally {
      for (const key of ETSY_SECRET_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      etsyReadClient.clearEtsyReadCaches();
    }
  });

  test('missingReadCredentials returns key NAMES only - never a value', () => {
    const missing = etsyReadClient.missingReadCredentials();
    for (const entry of missing) {
      assert.ok(typeof entry === 'string');
      assert.ok(/^ETSY_[A-Z_]+$/.test(entry), `'${entry}' must be a bare configuration key name`);
    }
  });

  test('redactTokenResponse is the only way a token response leaves the OAuth module', () => {
    const redacted = etsyOAuth.redactTokenResponse({
      accessToken: 'SECRET_ACCESS',
      refreshToken: 'SECRET_REFRESH',
      grantedScopes: ['shops_r'],
    });
    assert.ok(!JSON.stringify(redacted).includes('SECRET_'));
  });

  // --- SOURCE: NO SECRET IS EVER PRINTED --------------------------------------------

  test('no Etsy module ever prints a credential value', () => {
    for (const file of ETSY_SOURCE_FILES) {
      const source = fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8');
      const code = source.replace(/^\s*\/\/.*$/gm, '');
      const logLines = [...code.matchAll(/console\.(?:log|error|warn|info)\(([^\n]*)/g)].map((match) =>
        // Printing a secret's LENGTH is not printing the secret, and is how these modules
        // report that a value is present without revealing it. Drop `<secret>.length`
        // reads before checking, so only a real value interpolation can trip this.
        match[1].replace(/\b\w+\.length\b/g, 'LENGTH_ONLY')
      );
      for (const line of logLines) {
        for (const forbidden of ['accessToken', 'refreshToken', 'codeVerifier', 'keystring', 'sharedSecret', 'apiKeyHeader', 'ETSY_API_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_OAUTH_REFRESH_TOKEN']) {
          assert.ok(
            !line.includes(forbidden),
            `${file} prints ${forbidden}: ${line.slice(0, 120)}`
          );
        }
      }
    }
  });

  test('no Etsy module writes a credential anywhere except the git-ignored .env', () => {
    for (const file of ETSY_SOURCE_FILES) {
      const code = fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      // Only the authorization CLI writes anything at all, and only to .env.
      const writes = (code.match(/writeFileSync/g) || []).length;
      if (file === 'integrations/etsyAuthorizeCli.js') {
        assert.ok(code.includes('ENV_PATH'), 'the CLI must write only to the .env path constant');
      } else {
        assert.strictEqual(writes, 0, `${file} must not write to disk at all`);
      }
    }
    // And never into business memory (an explicit project rule).
    for (const file of ETSY_SOURCE_FILES) {
      const code = fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!code.includes('memoryStore'), `${file} must not put credentials into agent memory`);
      assert.ok(!code.includes('saveMemoryRecord'), `${file} must not put credentials into agent memory`);
    }
  });

  test('the authorization CLI targets the git-ignored .env, which is really git-ignored', () => {
    assert.strictEqual(etsyAuthorizeCli.REFRESH_TOKEN_KEY, 'ETSY_OAUTH_REFRESH_TOKEN');
    assert.ok(etsyAuthorizeCli.ENV_PATH.endsWith('.env'));
    const gitignore = fs.readFileSync(path.join(SOURCE_ROOT, '.gitignore'), 'utf8');
    assert.ok(
      gitignore.split(/\r?\n/).some((line) => line.trim() === '.env'),
      '.env must be git-ignored before any credential is written to it'
    );
  });

  test('the ETSY_* template block in .env.example is present and EMPTY', () => {
    const example = fs.readFileSync(path.join(SOURCE_ROOT, '.env.example'), 'utf8');
    for (const key of [...ETSY_SECRET_KEYS, 'ETSY_SHOP_ID', 'ETSY_OAUTH_REDIRECT_URI']) {
      assert.ok(example.includes(`${key}=`), `${key} must be documented in .env.example`);
      const value = new RegExp(`^${key}=(.*)$`, 'm').exec(example)[1];
      assert.strictEqual(value.trim(), '', `${key} must be blank in the committed template`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsySecretRedaction.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
