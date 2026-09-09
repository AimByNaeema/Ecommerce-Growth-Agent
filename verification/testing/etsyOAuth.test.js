'use strict';

// integrations/etsyOAuth.js - the Etsy OAuth 2.0 authorization code + PKCE flow.
//
// Every Etsy call is mocked (global.fetch is substituted). No test here reaches Etsy, and
// the token endpoint is never contacted for real.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const etsyOAuth = require('../../integrations/etsyOAuth');

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

const KEYSTRING = '(placeholder-keystring)';
const REDIRECT_URI = 'https://example.invalid/etsy/callback';

// A mocked token endpoint response. Never a real Etsy call.
function tokenResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mocked',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

async function withMockedFetch(handler, run) {
  const saved = global.fetch;
  global.fetch = handler;
  try {
    return await run();
  } finally {
    global.fetch = saved;
  }
}

(async () => {
  // --- PKCE -------------------------------------------------------------------------

  test('createPkcePair produces an S256 challenge that is really SHA-256(verifier)', () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = etsyOAuth.createPkcePair();
    assert.strictEqual(codeChallengeMethod, 'S256');
    const expected = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.strictEqual(codeChallenge, expected, 'the challenge must be the base64url SHA-256 of the verifier');
  });

  test('the PKCE verifier is inside RFC 7636\'s 43-128 character range', () => {
    const { codeVerifier } = etsyOAuth.createPkcePair();
    assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128, `got ${codeVerifier.length}`);
    assert.ok(/^[A-Za-z0-9\-._~]+$/.test(codeVerifier), 'the verifier must be URL-safe');
  });

  test('every PKCE pair and state is fresh - nothing is reused across attempts', () => {
    const verifiers = new Set();
    const states = new Set();
    for (let i = 0; i < 50; i += 1) {
      verifiers.add(etsyOAuth.createPkcePair().codeVerifier);
      states.add(etsyOAuth.createAuthorizationState());
    }
    assert.strictEqual(verifiers.size, 50, 'a repeated verifier would defeat PKCE');
    assert.strictEqual(states.size, 50, 'a repeated state would defeat CSRF protection');
  });

  test("'plain' is not an accepted challenge method - no PKCE downgrade path exists", () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'etsyOAuth.js'), 'utf8');
    // Scan the MODULE'S CODE only: comments may legitimately explain why 'plain' is
    // refused, and the CLI demo block prints that explanation. Neither can set a method.
    const moduleCode = source.slice(0, source.indexOf('if (require.main === module)')).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/['"`]plain['"`]/.test(moduleCode), 'a plain-PKCE downgrade path must not exist');
    assert.strictEqual(etsyOAuth.ETSY_CODE_CHALLENGE_METHOD, 'S256');
    // And the method is not a parameter: no caller can ask for a different one.
    const url = new URL(
      etsyOAuth.buildAuthorizationUrl({
        keystring: KEYSTRING,
        redirectUri: REDIRECT_URI,
        state: 's',
        codeChallenge: 'c',
        codeChallengeMethod: 'plain',
      })
    );
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  });

  // --- MINIMUM SCOPES ---------------------------------------------------------------

  test('MINIMUM SCOPES: only the two read scopes are permitted', () => {
    assert.deepStrictEqual(etsyOAuth.ETSY_REQUIRED_SCOPES, ['shops_r', 'listings_r']);
  });

  test('MINIMUM SCOPES: every write/delete scope is refused, and no URL is built', () => {
    for (const scope of ['listings_w', 'listings_d', 'shops_w', 'transactions_w', 'profile_w', 'address_w']) {
      assert.throws(() => etsyOAuth.assertMinimumScopes([scope]), /refuses the scope/, `${scope} must be refused`);
      assert.throws(
        () =>
          etsyOAuth.buildAuthorizationUrl({
            keystring: KEYSTRING,
            redirectUri: REDIRECT_URI,
            scopes: [scope],
            state: 'state',
            codeChallenge: 'challenge',
          }),
        /refuses the scope/
      );
    }
  });

  test('MINIMUM SCOPES: a read scope this phase did not approve is also refused', () => {
    // transactions_r would reach buyer data, and Etsy's own documents disagree about its
    // name. It is not approved for this phase, so it must be refused like any write scope.
    assert.throws(() => etsyOAuth.assertMinimumScopes(['transactions_r']), /refuses the scope/);
    assert.throws(() => etsyOAuth.assertMinimumScopes(['shops_r', 'listings_w']), /listings_w/);
  });

  // --- AUTHORIZATION URL ------------------------------------------------------------

  test('buildAuthorizationUrl produces the documented Etsy authorization request', () => {
    const url = new URL(
      etsyOAuth.buildAuthorizationUrl({
        keystring: KEYSTRING,
        redirectUri: REDIRECT_URI,
        state: 'the-state',
        codeChallenge: 'the-challenge',
      })
    );
    assert.strictEqual(`${url.origin}${url.pathname}`, etsyOAuth.ETSY_AUTHORIZE_URL);
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('client_id'), KEYSTRING);
    assert.strictEqual(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.strictEqual(url.searchParams.get('scope'), 'shops_r listings_r');
    assert.strictEqual(url.searchParams.get('state'), 'the-state');
    assert.strictEqual(url.searchParams.get('code_challenge'), 'the-challenge');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  });

  test('the redirect URI is never defaulted - an absent one is refused', () => {
    assert.throws(
      () => etsyOAuth.buildAuthorizationUrl({ keystring: KEYSTRING, state: 's', codeChallenge: 'c' }),
      /redirect URI/
    );
  });

  // --- STATE VALIDATION -------------------------------------------------------------

  test('STATE: a matching callback validates', () => {
    const state = etsyOAuth.createAuthorizationState();
    const outcome = etsyOAuth.validateCallback({
      expectedState: state,
      expectedRedirectUri: REDIRECT_URI,
      receivedState: state,
      receivedRedirectUri: REDIRECT_URI,
      code: 'the-code',
    });
    assert.strictEqual(outcome.valid, true);
    assert.strictEqual(outcome.reason, null);
  });

  test('STATE: a mismatched state is rejected and nothing is exchanged', () => {
    const outcome = etsyOAuth.validateCallback({
      expectedState: etsyOAuth.createAuthorizationState(),
      expectedRedirectUri: REDIRECT_URI,
      receivedState: etsyOAuth.createAuthorizationState(),
      receivedRedirectUri: REDIRECT_URI,
      code: 'the-code',
    });
    assert.strictEqual(outcome.valid, false);
    assert.match(outcome.reason, /state did not match/);
    assert.match(outcome.reason, /No code was exchanged/);
  });

  test('STATE: an absent state is rejected - a missing check is never a passing one', () => {
    for (const receivedState of [undefined, null, '', '   ']) {
      const outcome = etsyOAuth.validateCallback({
        expectedState: 'expected',
        expectedRedirectUri: REDIRECT_URI,
        receivedState,
        receivedRedirectUri: REDIRECT_URI,
        code: 'the-code',
      });
      assert.strictEqual(outcome.valid, false, `state ${JSON.stringify(receivedState)} must be rejected`);
    }
  });

  test('STATE: an Etsy-reported error short-circuits before any other check', () => {
    const outcome = etsyOAuth.validateCallback({
      expectedState: 'expected',
      expectedRedirectUri: REDIRECT_URI,
      receivedState: 'expected',
      receivedRedirectUri: REDIRECT_URI,
      code: 'the-code',
      error: 'access_denied',
    });
    assert.strictEqual(outcome.valid, false);
    assert.match(outcome.reason, /access_denied/);
  });

  // --- REDIRECT URI VALIDATION ------------------------------------------------------

  test('REDIRECT URI: matched EXACTLY - a prefix, sibling path or extra segment is rejected', () => {
    const state = etsyOAuth.createAuthorizationState();
    const attackerVariants = [
      'https://example.invalid/etsy/callback/evil',
      'https://example.invalid/etsy/callbackevil',
      'https://example.invalid/etsy',
      'https://example.invalid/',
      'https://evil.invalid/etsy/callback',
      'http://example.invalid/etsy/callback',
      'https://example.invalid:8443/etsy/callback',
    ];
    for (const receivedRedirectUri of attackerVariants) {
      const outcome = etsyOAuth.validateCallback({
        expectedState: state,
        expectedRedirectUri: REDIRECT_URI,
        receivedState: state,
        receivedRedirectUri,
        code: 'the-code',
      });
      assert.strictEqual(outcome.valid, false, `${receivedRedirectUri} must be rejected`);
      assert.match(outcome.reason, /exactly match/);
    }
  });

  // --- TOKEN EXCHANGE AND REFRESH ---------------------------------------------------

  await testAsync('exchangeAuthorizationCode sends the documented PKCE grant body', async () => {
    let captured = null;
    await withMockedFetch(
      async (url, options) => {
        captured = { url, body: new URLSearchParams(options.body) };
        return tokenResponse({
          access_token: '12345.access',
          refresh_token: '12345.refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'shops_r listings_r',
        });
      },
      async () => {
        const tokens = await etsyOAuth.exchangeAuthorizationCode({
          keystring: KEYSTRING,
          redirectUri: REDIRECT_URI,
          code: 'the-code',
          codeVerifier: 'the-verifier',
        });
        assert.strictEqual(tokens.accessToken, '12345.access');
        assert.strictEqual(tokens.refreshToken, '12345.refresh');
        assert.deepStrictEqual(tokens.grantedScopes, ['shops_r', 'listings_r']);
        assert.ok(tokens.expiresAt <= Date.now() + 3600 * 1000, 'expiry must carry the safety margin');
      }
    );
    assert.strictEqual(captured.url, etsyOAuth.ETSY_TOKEN_URL);
    assert.strictEqual(captured.body.get('grant_type'), 'authorization_code');
    assert.strictEqual(captured.body.get('code_verifier'), 'the-verifier');
    assert.strictEqual(captured.body.get('client_id'), KEYSTRING);
    assert.strictEqual(captured.body.get('redirect_uri'), REDIRECT_URI);
  });

  await testAsync('refreshAccessToken sends the refresh_token grant', async () => {
    let captured = null;
    await withMockedFetch(
      async (_url, options) => {
        captured = new URLSearchParams(options.body);
        return tokenResponse({ access_token: '12345.new', refresh_token: '12345.refresh', expires_in: 3600, scope: 'shops_r' });
      },
      async () => {
        const tokens = await etsyOAuth.refreshAccessToken({ keystring: KEYSTRING, refreshToken: '12345.refresh' });
        assert.strictEqual(tokens.accessToken, '12345.new');
        assert.deepStrictEqual(tokens.grantedScopes, ['shops_r']);
      }
    );
    assert.strictEqual(captured.get('grant_type'), 'refresh_token');
    assert.strictEqual(captured.get('refresh_token'), '12345.refresh');
  });

  await testAsync('refreshAccessToken refuses without a refresh token and makes NO request', async () => {
    let calls = 0;
    await withMockedFetch(
      async () => {
        calls += 1;
        return tokenResponse({});
      },
      async () => {
        await assert.rejects(() => etsyOAuth.refreshAccessToken({ keystring: KEYSTRING }), /requires a refresh token/);
      }
    );
    assert.strictEqual(calls, 0, 'no token request may be made without a refresh token');
  });

  await testAsync('a token response without an access_token is an error, never a fabricated token', async () => {
    await withMockedFetch(
      async () => tokenResponse({ token_type: 'Bearer' }),
      async () => {
        await assert.rejects(
          () => etsyOAuth.refreshAccessToken({ keystring: KEYSTRING, refreshToken: 'r' }),
          /did not include an access_token/
        );
      }
    );
  });

  await testAsync('429 is retried with bounded attempts, then reported - never a storm', async () => {
    const savedAttempts = process.env.MAX_NETWORK_RETRY_ATTEMPTS;
    const savedDelay = process.env.NETWORK_RETRY_BASE_DELAY_MS;
    process.env.MAX_NETWORK_RETRY_ATTEMPTS = '3';
    process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
    let calls = 0;
    try {
      await withMockedFetch(
        async () => {
          calls += 1;
          return tokenResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } });
        },
        async () => {
          await assert.rejects(() => etsyOAuth.refreshAccessToken({ keystring: KEYSTRING, refreshToken: 'r' }), /429/);
        }
      );
      assert.strictEqual(calls, 3, 'exactly the bounded number of attempts, then stop');
    } finally {
      process.env.MAX_NETWORK_RETRY_ATTEMPTS = savedAttempts;
      process.env.NETWORK_RETRY_BASE_DELAY_MS = savedDelay;
    }
  });

  await testAsync('a 4xx credential error is NEVER retried - it would fail again identically', async () => {
    const savedDelay = process.env.NETWORK_RETRY_BASE_DELAY_MS;
    process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
    let calls = 0;
    try {
      await withMockedFetch(
        async () => {
          calls += 1;
          return tokenResponse({ error: 'invalid_grant' }, { status: 400 });
        },
        async () => {
          await assert.rejects(() => etsyOAuth.refreshAccessToken({ keystring: KEYSTRING, refreshToken: 'r' }), /400/);
        }
      );
      assert.strictEqual(calls, 1, 'a deterministic failure must be attempted exactly once');
    } finally {
      process.env.NETWORK_RETRY_BASE_DELAY_MS = savedDelay;
    }
  });

  // --- SECRETS ----------------------------------------------------------------------

  await testAsync('SECRETS: an error message never carries the keystring, code or refresh token', async () => {
    await withMockedFetch(
      async () => tokenResponse({ error: 'invalid_grant' }, { status: 400 }),
      async () => {
        try {
          await etsyOAuth.exchangeAuthorizationCode({
            keystring: 'SECRET_KEYSTRING_VALUE',
            redirectUri: REDIRECT_URI,
            code: 'SECRET_CODE_VALUE',
            codeVerifier: 'SECRET_VERIFIER_VALUE',
          });
          assert.fail('should have thrown');
        } catch (err) {
          for (const secret of ['SECRET_KEYSTRING_VALUE', 'SECRET_CODE_VALUE', 'SECRET_VERIFIER_VALUE']) {
            assert.ok(!err.message.includes(secret), `the error leaked ${secret}`);
          }
        }
      }
    );
  });

  test('SECRETS: redactTokenResponse masks the tokens but keeps the non-secret facts', () => {
    const redacted = etsyOAuth.redactTokenResponse({
      accessToken: 'SECRET_ACCESS',
      refreshToken: 'SECRET_REFRESH',
      tokenType: 'Bearer',
      expiresInSeconds: 3600,
      expiresAt: 123,
      grantedScopes: ['shops_r', 'listings_r'],
    });
    assert.strictEqual(redacted.accessToken, '[REDACTED]');
    assert.strictEqual(redacted.refreshToken, '[REDACTED]');
    // tokenType is ALSO redacted, because the shared redactor matches on the key name and
    // 'tokenType' contains 'token'. That over-redaction is the safe direction and is left
    // as-is deliberately: loosening the shared pattern to expose one cosmetic field would
    // weaken redaction for every other module that relies on it.
    assert.strictEqual(redacted.tokenType, '[REDACTED]');
    // The facts an audit record actually needs still survive.
    assert.deepStrictEqual(redacted.grantedScopes, ['shops_r', 'listings_r']);
    assert.strictEqual(redacted.expiresInSeconds, 3600);
    assert.ok(!JSON.stringify(redacted).includes('SECRET_'));
  });

  test('NO SECOND FRAMEWORK: the module reuses the shared layers and adds no dependency', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'etsyOAuth.js'), 'utf8');
    assert.ok(source.includes("require('../agent/core/networkRetry')"), 'must reuse the shared retry/timeout layer');
    assert.ok(source.includes("require('../security/serverAccessControl')"), 'must reuse the constant-time comparison');
    assert.ok(source.includes("require('../audit/auditTrail')"), 'must reuse the existing redaction helper');
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const dependency of requires) {
      assert.ok(
        dependency.startsWith('./') || dependency.startsWith('../') || dependency.startsWith('node:'),
        `unexpected dependency: ${dependency}`
      );
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyOAuth.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
