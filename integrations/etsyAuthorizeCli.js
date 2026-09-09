'use strict';

// `npm run integrations:etsy-authorize` - the one-time, operator-run Etsy authorization.
//
// WHY A CLI AND NOT A SERVER ROUTE. Etsy's authorization code flow needs a browser
// redirect to land somewhere. Adding a callback route to server.js would put an endpoint
// on the agent's network surface that, by the nature of an OAuth callback, cannot sit
// behind that server's own bearer-token middleware - a new permanently-exposed surface,
// for something that happens roughly once every 90 days. So the flow lives here instead:
// a short-lived listener bound to 127.0.0.1 that exists only for the seconds the operator
// is completing the consent screen, and then stops. server.js is not modified at all.
//
// WHAT IT DOES, IN ORDER:
//   1. Reads configuration. Refuses, naming the missing KEYS, if anything is absent.
//   2. Generates a PKCE pair and a single-use state (integrations/etsyOAuth.js).
//   3. Prints the authorization URL for the operator to open.
//   4. Listens on the loopback address, on the port of the REGISTERED redirect URI.
//   5. Validates the callback - state compared in constant time, redirect URI compared
//      exactly - and refuses to exchange anything if either fails.
//   6. Exchanges the code for tokens, confirms the granted scopes are read-only, and
//      writes ONLY the refresh token back to the git-ignored .env.
//
// NO SECRET IS EVER PRINTED. Not the keystring, not the code, not the verifier, not the
// access token, not the refresh token. The console reports names, lengths and scopes.
// The access token is deliberately NOT persisted at all - it lives an hour, and
// integrations/adapters/etsyReadClient.js re-derives it in memory from the refresh token.
//
// IT CANNOT OBTAIN A WRITE-CAPABLE TOKEN. The scopes come from
// etsyOAuth.ETSY_REQUIRED_SCOPES (shops_r, listings_r) and buildAuthorizationUrl() refuses
// anything else. There is no flag on this CLI that widens them.

const fs = require('fs');
const http = require('http');
const path = require('path');
const etsyOAuth = require('./etsyOAuth');
const etsyClient = require('./adapters/etsyClient');

const ENV_PATH = path.join(process.cwd(), '.env');
const REFRESH_TOKEN_KEY = 'ETSY_OAUTH_REFRESH_TOKEN';

// How long the operator has to complete the consent screen before the listener gives up.
// Bounded so a forgotten run cannot leave a socket open indefinitely.
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Reads the configuration this flow needs. Returns { config, missing } - key names only,
// never values, so the caller can report the gap safely.
function readAuthorizationConfig() {
  etsyClient.loadEnvOnce();
  const config = {
    keystring: process.env.ETSY_API_KEYSTRING,
    redirectUri: process.env.ETSY_OAUTH_REDIRECT_URI,
  };
  const missing = [];
  if (!isNonEmptyString(config.keystring)) missing.push('ETSY_API_KEYSTRING');
  if (!isNonEmptyString(config.redirectUri)) missing.push('ETSY_OAUTH_REDIRECT_URI');
  return { config, missing };
}

// Upserts one KEY=VALUE in the git-ignored .env, preserving every other line, comment and
// blank exactly as it was. Deliberately a targeted line edit rather than a rewrite: this
// file holds every credential the project has, and regenerating it from a parsed object
// would silently drop anything the parser did not model.
function writeEnvValue(key, value) {
  const line = `${key}=${value}`;
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    return 'created';
  }
  const existing = fs.readFileSync(ENV_PATH, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(existing)) {
    fs.writeFileSync(ENV_PATH, existing.replace(pattern, line), 'utf8');
    return 'updated';
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(ENV_PATH, `${existing}${separator}${line}\n`, 'utf8');
  return 'appended';
}

// The exact URI a callback request reconstructs to, so it can be compared against the
// registered redirect URI as a whole string rather than by parts. Query is deliberately
// excluded - the registered URI has none, and the callback's query is what carries the
// code and state.
function reconstructCallbackUri(req, expectedRedirectUri) {
  const expected = new URL(expectedRedirectUri);
  const received = new URL(req.url, `${expected.protocol}//${req.headers.host || expected.host}`);
  return { uri: `${received.origin}${received.pathname}`, params: received.searchParams };
}

// Runs the loopback listener until one callback arrives, then resolves with its validated
// outcome. Always closes the server, on every path.
function awaitCallback(expectedRedirectUri, expectedState) {
  const redirect = new URL(expectedRedirectUri);
  const port = Number(redirect.port) || (redirect.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let outcome;
      try {
        const { uri, params } = reconstructCallbackUri(req, expectedRedirectUri);
        outcome = etsyOAuth.validateCallback({
          expectedState,
          expectedRedirectUri: `${redirect.origin}${redirect.pathname}`,
          receivedState: params.get('state'),
          receivedRedirectUri: uri,
          code: params.get('code'),
          error: params.get('error'),
          errorDescription: params.get('error_description'),
        });
        outcome = { ...outcome, code: outcome.valid ? params.get('code') : null };
      } catch (err) {
        outcome = { valid: false, reason: `The callback could not be parsed: ${err.message}`, code: null };
      }

      // The browser response never echoes the code or the state back.
      res.writeHead(outcome.valid ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        outcome.valid
          ? 'Etsy authorization received. You can close this tab and return to the terminal.'
          : `Etsy authorization refused: ${outcome.reason}`
      );

      server.close(() => (outcome.valid ? resolve(outcome) : reject(new Error(outcome.reason))));
    });

    const timer = setTimeout(() => {
      server.close(() =>
        reject(new Error(`No Etsy callback arrived within ${AUTHORIZATION_TIMEOUT_MS / 1000}s. Nothing was exchanged or stored.`))
      );
    }, AUTHORIZATION_TIMEOUT_MS);
    timer.unref();

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not listen on port ${port} for the Etsy callback: ${err.message}`));
    });

    // Loopback only: this listener is never reachable from outside this machine.
    server.listen(port, '127.0.0.1');
  });
}

async function authorize() {
  const { config, missing } = readAuthorizationConfig();
  if (missing.length > 0) {
    throw new Error(
      `Etsy authorization cannot start: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in .env. ` +
        'See the ETSY_* block in .env.example. The redirect URI must match your Etsy application registration ' +
        'exactly and is never defaulted. Nothing was requested.'
    );
  }

  const pkce = etsyOAuth.createPkcePair();
  const state = etsyOAuth.createAuthorizationState();
  const authorizationUrl = etsyOAuth.buildAuthorizationUrl({
    keystring: config.keystring,
    redirectUri: config.redirectUri,
    scopes: etsyOAuth.ETSY_REQUIRED_SCOPES,
    state,
    codeChallenge: pkce.codeChallenge,
  });

  console.log(`Requesting ONLY these read scopes: ${etsyOAuth.ETSY_REQUIRED_SCOPES.join(', ')}`);
  console.log(`PKCE method: ${pkce.codeChallengeMethod}\n`);
  console.log('Open this URL in a browser and approve access to your own shop:\n');
  console.log(`  ${authorizationUrl}\n`);
  console.log(`Waiting for the callback on ${config.redirectUri} (loopback only, up to ${AUTHORIZATION_TIMEOUT_MS / 1000}s)...\n`);

  const callback = await awaitCallback(config.redirectUri, state);

  const tokens = await etsyOAuth.exchangeAuthorizationCode({
    keystring: config.keystring,
    redirectUri: config.redirectUri,
    code: callback.code,
    codeVerifier: pkce.codeVerifier,
  });

  // Confirm Etsy granted what was asked for and nothing more. A grant wider than the
  // read scopes is reported rather than quietly accepted.
  const unexpected = tokens.grantedScopes.filter((scope) => !etsyOAuth.ETSY_REQUIRED_SCOPES.includes(scope));
  if (unexpected.length > 0) {
    throw new Error(
      `Etsy granted unexpected scope(s): ${unexpected.join(', ')}. Only ${etsyOAuth.ETSY_REQUIRED_SCOPES.join(', ')} ` +
        'were requested. No token was stored - check the application registration before continuing.'
    );
  }

  if (!isNonEmptyString(tokens.refreshToken)) {
    throw new Error('Etsy did not return a refresh token, so nothing durable can be stored. Re-run the authorization.');
  }

  const written = writeEnvValue(REFRESH_TOKEN_KEY, tokens.refreshToken);

  return { grantedScopes: tokens.grantedScopes, expiresInSeconds: tokens.expiresInSeconds, written };
}

module.exports = {
  ENV_PATH,
  REFRESH_TOKEN_KEY,
  AUTHORIZATION_TIMEOUT_MS,
  readAuthorizationConfig,
  writeEnvValue,
  reconstructCallbackUri,
  awaitCallback,
  authorize,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy authorization (read-only scopes, PKCE):\n');
  authorize()
    .then((outcome) => {
      console.log('Authorization complete.');
      console.log(`  Granted scopes: ${outcome.grantedScopes.join(', ')}`);
      console.log(`  Access token: held in memory only, valid ${outcome.expiresInSeconds}s - never written to disk.`);
      console.log(`  ${REFRESH_TOKEN_KEY}: ${outcome.written} in .env (git-ignored). Its value is not printed.`);
      console.log('\nThis grants READ access only. Publishing to Etsy remains closed.');
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
