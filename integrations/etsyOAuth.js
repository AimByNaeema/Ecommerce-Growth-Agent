'use strict';

// Etsy Open API v3 OAuth 2.0 - authorization code grant with PKCE.
//
// WHY THIS FILE EXISTS. This project had no authorization-code flow of any kind before
// it. integrations/adapters/shopifyClient.js implements OAuth, but the machine-to-machine
// CLIENT CREDENTIALS grant - no browser, no redirect, no user consent, no refresh token.
// Etsy's API cannot be reached that way: every private endpoint requires a token the
// SELLER granted through Etsy's own consent screen, and Etsy mandates PKCE. So this is a
// genuinely new mechanism, not a duplicate of an existing one (CLAUDE.md rules 3-4). It
// still reuses this project's existing pieces rather than growing its own: the shared
// retry/timeout layer (agent/core/networkRetry.js), the constant-time comparison from
// security/serverAccessControl.js, and the redaction helper from audit/auditTrail.js.
//
// SOURCED FROM ETSY'S OWN DOCUMENTATION, NOT FROM MEMORY.
// https://developer.etsy.com/documentation/essentials/authentication/
//   - authorize endpoint https://www.etsy.com/oauth/connect
//   - token endpoint    https://api.etsy.com/v3/public/oauth/token
//   - PKCE is REQUIRED, and the only accepted challenge method is S256
//   - access tokens live 1 hour; refresh tokens live 90 days
//   - the access token itself is shaped "<user_id>.<token>"
//
// PURE BY DESIGN. Everything except the two token calls is a pure function with no I/O,
// so every security rule this module enforces (PKCE correctness, state validation,
// exact redirect-URI matching, minimum scopes) is directly unit-testable without a
// network, a browser, or an Etsy account - which is what makes the mocked-only first
// phase (see verification/testing/etsyOAuth.test.js) meaningful rather than decorative.
//
// READ-ONLY BY CONSTRUCTION. ETSY_REQUIRED_SCOPES holds exactly two READ scopes, and
// buildAuthorizationUrl() REFUSES any scope outside it. There is no parameter, option or
// override that widens that set, so this module cannot be used to obtain a write-capable
// token even by mistake. Adding a write scope is a deliberate source edit here, in a
// later explicitly-approved phase - never a runtime argument.
//
// SECRETS NEVER SURFACE. No function here logs, prints, returns-in-an-error, or embeds a
// keystring, code verifier, access token or refresh token in a message. Token responses
// leave this module only through redactTokenResponse() when they are going anywhere a
// human or an audit record might see them.

const crypto = require('node:crypto');
const { RetryableError, retryAsync, withTimeout, parseRetryAfterMs } = require('../agent/core/networkRetry');
const { safeCompare } = require('../security/serverAccessControl');
const { redactSensitiveData } = require('../audit/auditTrail');

const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// Etsy accepts only S256. 'plain' is not offered here even as a fallback - a downgrade
// path is exactly how a PKCE implementation stops protecting anything.
const ETSY_CODE_CHALLENGE_METHOD = 'S256';

// The COMPLETE set of scopes this phase is permitted to request, and the reason each is
// needed. Phase 1 is read-only (no listing create/update/delete, no inventory or shop
// mutation, no messages, no refunds), so no write scope appears here.
//
// Deliberately absent: any receipts/orders scope. Etsy's Authentication page names that
// scope `transactions_r` while Etsy's own generated OpenAPI spec tags the same receipts
// endpoints `receipts_r`. Both cannot be correct, and CLAUDE.md rule 1 forbids guessing
// which. Buyer data is also the most sensitive surface Etsy exposes. Phase 1 therefore
// reads no orders at all, which removes the ambiguity instead of resolving it by
// assumption. Shop identity comes from the configured ETSY_SHOP_ID, so no user-profile
// scope (`email_r`/`users_r`, which the same two documents also disagree about) is
// needed either.
const ETSY_REQUIRED_SCOPES = [
  'shops_r', // Read this seller's own shop description, sections and details.
  'listings_r', // Read this seller's own listings, including inactive/draft ones.
];

// How early a cached access token is treated as expired, so a request is never sent with
// a token that expires in flight. Same 60s margin and same reasoning as
// integrations/adapters/shopifyClient.js's TOKEN_EXPIRY_SAFETY_MARGIN_MS.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60000;

// Etsy documents a 1-hour access token. Used only when a token response omits
// expires_in - a conservative floor, never an assertion about Etsy's policy.
const FALLBACK_ACCESS_TOKEN_TTL_SECONDS = 3600;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A fresh PKCE verifier/challenge pair. 32 random bytes base64url-encode to 43
// characters, which sits inside RFC 7636's required 43-128 character range at its
// minimum-entropy-safe end. The verifier is a secret: it is returned to the caller to
// hold for the single exchange that follows, and is never logged or embedded in a URL.
function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: ETSY_CODE_CHALLENGE_METHOD };
}

// A single-use CSRF token for one authorization attempt. The caller holds it and hands
// it back to validateCallback() - it is never persisted, so it cannot be replayed across
// processes.
function createAuthorizationState() {
  return base64Url(crypto.randomBytes(32));
}

// The mechanical minimum-scope guarantee. Returns the requested scopes when every one is
// inside ETSY_REQUIRED_SCOPES, and throws naming the offending scope otherwise. This is
// the only place scope breadth is decided, so "just this once, add a write scope" is not
// something a caller can do - it is a source change in this file, reviewed as one.
function assertMinimumScopes(scopes) {
  const requested = Array.isArray(scopes) && scopes.length > 0 ? scopes : ETSY_REQUIRED_SCOPES;
  const disallowed = requested.filter((scope) => !ETSY_REQUIRED_SCOPES.includes(scope));
  if (disallowed.length > 0) {
    throw new Error(
      `Etsy OAuth refuses the scope(s) ${disallowed.join(', ')}: this phase is read-only and may request only ` +
        `${ETSY_REQUIRED_SCOPES.join(', ')}. Widening the scope set is a deliberate, separately-approved change to ` +
        'ETSY_REQUIRED_SCOPES in integrations/etsyOAuth.js, not a runtime argument. No authorization URL was built.'
    );
  }
  return requested;
}

// Builds the URL the seller opens in a browser to grant access.
//
// redirectUri has NO default. Etsy matches the callback against the exact value
// registered on the application, and inventing one here would be a fabricated
// configuration value (CLAUDE.md rule 1) that fails at Etsy with a confusing error. It
// is configuration - see ETSY_OAUTH_REDIRECT_URI in .env.example.
function buildAuthorizationUrl({ keystring, redirectUri, scopes = ETSY_REQUIRED_SCOPES, state, codeChallenge } = {}) {
  if (!isNonEmptyString(keystring)) {
    throw new Error('buildAuthorizationUrl requires the Etsy application keystring (ETSY_API_KEYSTRING).');
  }
  if (!isNonEmptyString(redirectUri)) {
    throw new Error(
      'buildAuthorizationUrl requires the exact redirect URI registered on the Etsy application ' +
        '(ETSY_OAUTH_REDIRECT_URI). It is not defaulted here - Etsy matches it exactly against the registration.'
    );
  }
  if (!isNonEmptyString(state)) {
    throw new Error('buildAuthorizationUrl requires a state value from createAuthorizationState().');
  }
  if (!isNonEmptyString(codeChallenge)) {
    throw new Error('buildAuthorizationUrl requires a PKCE code challenge from createPkcePair().');
  }

  const permittedScopes = assertMinimumScopes(scopes);

  const url = new URL(ETSY_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', keystring);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', permittedScopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', ETSY_CODE_CHALLENGE_METHOD);
  return url.toString();
}

// Validates one authorization callback before any code is exchanged. Returns
// { valid, reason } and never throws, because a bad callback is an ordinary rejection,
// not a program error - and because a thrown error tends to get logged with its inputs.
//
// FAILS CLOSED, IN A FIXED ORDER:
//   1. Etsy reported an error -> reject (never fall through to an exchange).
//   2. Missing state/code     -> reject.
//   3. State mismatch         -> reject, compared in constant time via
//                                security/serverAccessControl.js's safeCompare so a
//                                valid state cannot be discovered a byte at a time.
//   4. Redirect URI mismatch  -> reject on EXACT string inequality. Deliberately not a
//                                prefix, host-only, or normalized comparison: an
//                                attacker-controlled path or query on the same host is
//                                precisely the open-redirect this check exists to stop.
function validateCallback({
  expectedState,
  expectedRedirectUri,
  receivedState,
  receivedRedirectUri,
  code,
  error = null,
  errorDescription = null,
} = {}) {
  if (isNonEmptyString(error)) {
    return {
      valid: false,
      reason: `Etsy returned an authorization error: ${error}${isNonEmptyString(errorDescription) ? ` (${errorDescription})` : ''}. No code was exchanged.`,
    };
  }
  if (!isNonEmptyString(expectedState) || !isNonEmptyString(expectedRedirectUri)) {
    return { valid: false, reason: 'validateCallback requires the expected state and redirect URI from this authorization attempt.' };
  }
  if (!isNonEmptyString(receivedState)) {
    return { valid: false, reason: 'The callback carried no state parameter, so it cannot be matched to this authorization attempt. No code was exchanged.' };
  }
  if (!isNonEmptyString(code)) {
    return { valid: false, reason: 'The callback carried no authorization code. No code was exchanged.' };
  }
  if (!safeCompare(receivedState, expectedState)) {
    return { valid: false, reason: 'The callback state did not match the state issued for this authorization attempt. No code was exchanged.' };
  }
  if (receivedRedirectUri !== expectedRedirectUri) {
    return {
      valid: false,
      reason:
        'The callback redirect URI did not exactly match the redirect URI this authorization attempt was started with. ' +
        'No code was exchanged.',
    };
  }
  return { valid: true, reason: null };
}

// Normalizes an Etsy token response into this project's own shape and computes a
// concrete expiry instant. Never invents a refresh token: a response without one comes
// back with refreshToken null, so a caller cannot mistake absence for a value.
function normalizeTokenResponse(raw) {
  const expiresInSeconds = typeof raw.expires_in === 'number' ? raw.expires_in : FALLBACK_ACCESS_TOKEN_TTL_SECONDS;
  return {
    accessToken: raw.access_token,
    refreshToken: isNonEmptyString(raw.refresh_token) ? raw.refresh_token : null,
    tokenType: isNonEmptyString(raw.token_type) ? raw.token_type : 'Bearer',
    expiresInSeconds,
    // The instant after which this token must not be used, already carrying the safety
    // margin so callers compare against it directly instead of re-deriving the margin.
    expiresAt: Date.now() + expiresInSeconds * 1000 - TOKEN_EXPIRY_SAFETY_MARGIN_MS,
    // Etsy returns the scopes it ACTUALLY granted, which can be narrower than what was
    // requested. Reported as granted, never as requested - see
    // integrations/adapters/etsyClient.js's getGrantedEtsyScopes().
    grantedScopes: isNonEmptyString(raw.scope) ? raw.scope.trim().split(/\s+/) : [],
  };
}

// The shared POST used by both grants. Mirrors integrations/adapters/shopifyClient.js's
// getClientCredentialsToken() error split exactly: a thrown fetch failure or an HTTP
// 429/5xx is a RetryableError (bounded, backed off, honoring Retry-After); any other
// non-ok status, or a response missing access_token, is a deterministic
// config/credential problem thrown as a plain Error that is never retried.
//
// The error message deliberately carries only Etsy's own status and message - never the
// request body, which holds the keystring, the code verifier, and the refresh token.
async function requestToken(body, fnName) {
  return retryAsync(async () => {
    let response;
    try {
      response = await withTimeout((signal) =>
        fetch(ETSY_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: body.toString(),
          signal,
        })
      );
    } catch (err) {
      throw new RetryableError(`Could not reach the Etsy OAuth token endpoint for ${fnName}: ${err.message}`);
    }

    const raw = await response.json().catch(() => null);

    if (!response.ok) {
      const apiMessage = raw && (raw.error_description || raw.error) ? raw.error_description || raw.error : response.statusText;
      const message = `Etsy OAuth token request failed for ${fnName} (${response.status}): ${apiMessage}`;
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(message, { retryAfterMs: parseRetryAfterMs(response) });
      }
      throw new Error(message);
    }

    if (!raw || !isNonEmptyString(raw.access_token)) {
      throw new Error(`Etsy OAuth token response for ${fnName} did not include an access_token. No token was stored.`);
    }

    return normalizeTokenResponse(raw);
  });
}

// Exchanges a validated authorization code for tokens. The caller must have run
// validateCallback() first - this function cannot re-check state, because state is a
// property of the callback, not of the exchange.
async function exchangeAuthorizationCode({ keystring, redirectUri, code, codeVerifier } = {}) {
  if (!isNonEmptyString(keystring)) throw new Error('exchangeAuthorizationCode requires the Etsy application keystring.');
  if (!isNonEmptyString(redirectUri)) throw new Error('exchangeAuthorizationCode requires the exact registered redirect URI.');
  if (!isNonEmptyString(code)) throw new Error('exchangeAuthorizationCode requires the authorization code from a validated callback.');
  if (!isNonEmptyString(codeVerifier)) throw new Error('exchangeAuthorizationCode requires the PKCE code verifier from createPkcePair().');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: keystring,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  return requestToken(body, 'exchangeAuthorizationCode');
}

// Exchanges a refresh token for a fresh access token. Etsy's refresh tokens last 90
// days; when this throws non-retryably the seller must re-authorize, which is reported
// rather than worked around.
async function refreshAccessToken({ keystring, refreshToken } = {}) {
  if (!isNonEmptyString(keystring)) throw new Error('refreshAccessToken requires the Etsy application keystring.');
  if (!isNonEmptyString(refreshToken)) {
    throw new Error(
      'refreshAccessToken requires a refresh token (ETSY_OAUTH_REFRESH_TOKEN). Run `npm run integrations:etsy-authorize` ' +
        'to obtain one. No token request was made.'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: keystring,
    refresh_token: refreshToken,
  });
  return requestToken(body, 'refreshAccessToken');
}

// The ONLY safe way a token response leaves this module toward a log, a console, or an
// audit record. Delegates to audit/auditTrail.js's redactSensitiveData rather than
// reimplementing redaction (CLAUDE.md rules 3-4) - its key pattern already matches
// accessToken/refreshToken/token/secret. The non-secret fields are kept so an audit
// record can still say what was granted and for how long.
function redactTokenResponse(tokenResponse) {
  if (!tokenResponse || typeof tokenResponse !== 'object') return null;
  return redactSensitiveData({
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    tokenType: tokenResponse.tokenType,
    expiresInSeconds: tokenResponse.expiresInSeconds,
    expiresAt: tokenResponse.expiresAt,
    grantedScopes: tokenResponse.grantedScopes,
  });
}

module.exports = {
  ETSY_AUTHORIZE_URL,
  ETSY_TOKEN_URL,
  ETSY_REQUIRED_SCOPES,
  ETSY_CODE_CHALLENGE_METHOD,
  TOKEN_EXPIRY_SAFETY_MARGIN_MS,
  createPkcePair,
  createAuthorizationState,
  assertMinimumScopes,
  buildAuthorizationUrl,
  validateCallback,
  normalizeTokenResponse,
  exchangeAuthorizationCode,
  refreshAccessToken,
  redactTokenResponse,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy OAuth 2.0 (authorization code + PKCE, read-only scopes):\n');
  console.log(`Authorize endpoint: ${ETSY_AUTHORIZE_URL}`);
  console.log(`Token endpoint:     ${ETSY_TOKEN_URL}`);
  console.log(`Challenge method:   ${ETSY_CODE_CHALLENGE_METHOD} (Etsy requires PKCE; 'plain' is not offered here)`);
  console.log(`Permitted scopes:   ${ETSY_REQUIRED_SCOPES.join(', ')} - read-only, and any other scope is refused\n`);

  const pkce = createPkcePair();
  const state = createAuthorizationState();
  console.log(`PKCE verifier length: ${pkce.codeVerifier.length} characters (secret - the value itself is never printed)`);
  console.log(`PKCE challenge length: ${pkce.codeChallenge.length} characters`);
  console.log(`State length: ${state.length} characters (secret - the value itself is never printed)\n`);

  try {
    assertMinimumScopes(['listings_w']);
  } catch (err) {
    console.log('A write scope is refused mechanically:');
    console.log(`  ${err.message}\n`);
  }

  const mismatch = validateCallback({
    expectedState: state,
    expectedRedirectUri: 'https://example.invalid/callback',
    receivedState: createAuthorizationState(),
    receivedRedirectUri: 'https://example.invalid/callback',
    code: '(placeholder)',
  });
  console.log(`A mismatched state is rejected: ${mismatch.valid === false}`);
  console.log(`  ${mismatch.reason}`);
}
