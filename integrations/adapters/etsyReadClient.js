'use strict';

// The READ-ONLY Etsy Open API v3 client - the owner's own Etsy shop, GET requests only.
//
// WHY THIS IS A SEPARATE FILE FROM etsyClient.js. Those two modules have genuinely
// different verification status, and merging them would hide that. Publishing to Etsy
// still has NO verified request mapping, so etsyClient.js deliberately contains no
// endpoint URL and no Etsy field name at all, and an existing test asserts that literally.
// Reading, by contrast, HAS a verified mapping - the endpoints below come from Etsy's own
// published API reference, cited per endpoint in ETSY_READ_ENDPOINTS. Keeping the two
// apart means adding reads could not relax the publishing gate even by accident, and the
// "nothing here is guessed" guarantee on the publish side stays independently checkable.
// This is not a second integration framework (CLAUDE.md rule 3-4 / the project's scope
// discipline): it reuses agent/core/networkRetry.js, configuration/businessRegistry.js,
// agent/core/channelModel.js, integrations/etsyOAuth.js and etsyClient.js's own credential
// resolution, exactly as integrations/shopifyBlogPublishing.js sits beside shopifyClient.js.
//
// ===================================================================================
// GET ONLY - A WRITE IS UNREACHABLE FROM THIS MODULE, NOT MERELY UNUSED.
// ===================================================================================
//   1. assertReadOnlyMethod() is the first statement of runEtsyRead(), and every read
//      goes through runEtsyRead(). It throws on anything but GET.
//   2. Every entry in ETSY_READ_ENDPOINTS declares method 'GET'. There is no parameter,
//      option, or override in this module's entire surface that can produce a POST, PUT,
//      PATCH or DELETE, and no caller can supply a raw path.
//   3. The OAuth token this client uses carries only shops_r and listings_r, because
//      integrations/etsyOAuth.js refuses to request anything else. Even a defect here
//      would hold a token Etsy itself will not accept for a write.
// verification/testing/etsyReadOnlyEnforcement.test.js asserts all three.
//
// ===================================================================================
// RATE LIMITS - THREE MECHANISMS, NO INVENTED NUMBERS, NO RETRY STORM.
// ===================================================================================
// Etsy enforces per-application QPS and QPD limits, returns 429 with a retry-after header
// when they are breached, and reports remaining quota on every response. The NUMBERS are
// specific to each registered application and visible only in the Developer Portal, so
// they are configuration here (ETSY_QPS_LIMIT / ETSY_QPD_LIMIT) and are NOT defaulted -
// an unset limit means no client-side spacing is applied, never a guessed ceiling.
//   a) Caching + in-flight deduplication: the same read is not requested twice.
//   b) Optional spacing: when ETSY_QPS_LIMIT is configured, requests are spaced.
//   c) Bounded reactive backoff: a 429 becomes a RetryableError carrying the server's own
//      Retry-After, retried at most MAX_NETWORK_RETRY_ATTEMPTS times by the shared layer.
// When Etsy reports zero daily quota remaining, this client STOPS with a plain
// (non-retryable) error rather than continuing to ask.
//
// ===================================================================================
// CACHING IS A REQUEST-REDUCTION MEASURE, NOT A DATA STORE.
// ===================================================================================
// Responses are held in memory only, for ETSY_CACHE_TTL_MS (default 60s - deliberately
// short). Nothing is written to disk. Etsy's API Terms of Use carry their own caching
// requirements which this project has not been able to verify mechanically, so no
// retention window is asserted here; a short in-memory TTL is the conservative choice
// that needs no such assertion.
//
// SECRETS NEVER SURFACE. No error message, log line or returned record here contains the
// keystring, the access token or the refresh token. Errors name the missing CONFIGURATION
// KEY, never its value - the same discipline etsyClient.missingCredentials() follows.

const { RetryableError, retryAsync, withTimeout, parseRetryAfterMs } = require('../../agent/core/networkRetry');
const businessRegistry = require('../../configuration/businessRegistry');
const { stampChannel } = require('../../agent/core/channelModel');
const etsyOAuth = require('../etsyOAuth');
const etsyClient = require('./etsyClient');

// This client's channel identity. Every record it returns is stamped with it, so an Etsy
// listing can never be mistaken for a Shopify product downstream.
const ETSY_CHANNEL = 'etsy';

const ETSY_API_BASE_URL = 'https://api.etsy.com/v3';

// The endpoints this phase may call, as DATA - so the permitted surface is inspectable in
// one place rather than scattered through functions, and so a test can assert that every
// one of them is a GET. `scope` records which OAuth scope Etsy requires; `source` records
// where the mapping came from, because an unsourced endpoint is a guess.
const ETSY_READ_ENDPOINTS = [
  {
    id: 'getMe',
    method: 'GET',
    path: '/application/users/me',
    scope: 'shops_r',
    requiresShopId: false,
    description: "The authenticated seller's own user_id and shop_id - the identity endpoint.",
    // The scope here is NOT taken from the prose documentation, which is the same source
    // whose scope names this project already found to be in conflict elsewhere. It is read
    // from Etsy's own machine-generated OpenAPI specification
    // (https://www.etsy.com/openapi/generated/oas/3.0.0.json), where this operation's
    // security block is exactly {"api_key":[],"oauth2":["shops_r"]} - a scope this phase
    // already holds. No new scope is requested to reach it.
    source: "Etsy generated OpenAPI spec - getMe, security {api_key, oauth2:['shops_r']}",
  },
  {
    id: 'getShop',
    method: 'GET',
    path: '/application/shops/{shop_id}',
    scope: 'shops_r',
    requiresShopId: true,
    description: "The seller's own shop record: name, title, currency, counts.",
    source: 'Etsy Open API v3 reference - getShop',
  },
  {
    id: 'getListingsByShop',
    method: 'GET',
    path: '/application/shops/{shop_id}/listings',
    scope: 'listings_r',
    requiresShopId: true,
    description: "The seller's own listings, including non-public ones.",
    source: 'Etsy Open API v3 reference - getListingsByShop',
  },
  {
    id: 'getListing',
    method: 'GET',
    path: '/application/listings/{listing_id}',
    scope: null,
    requiresShopId: false,
    description: 'One listing record.',
    source: 'Etsy Open API v3 reference - getListing',
  },
  {
    id: 'getListingInventory',
    method: 'GET',
    path: '/application/listings/{listing_id}/inventory',
    scope: 'listings_r',
    requiresShopId: false,
    description: "One listing's inventory products/offerings.",
    source: 'Etsy Open API v3 reference - getListingInventory',
  },
  {
    id: 'getListingImages',
    method: 'GET',
    path: '/application/listings/{listing_id}/images',
    scope: null,
    requiresShopId: false,
    description: "One listing's images.",
    source: 'Etsy Open API v3 reference - getListingImages',
  },
];

// The additional configuration the READ surface needs, beyond the three keys
// etsyClient.ETSY_REQUIRED_CREDENTIALS already declares. Kept as a separate list so that
// existing list - and everything asserted about it - is unchanged.
const ETSY_READ_CREDENTIALS = [
  {
    key: 'ETSY_OAUTH_REFRESH_TOKEN',
    description: 'The OAuth 2.0 refresh token obtained by `npm run integrations:etsy-authorize`.',
  },
  {
    key: 'ETSY_SHARED_SECRET',
    description:
      "The application's shared secret. Etsy requires the x-api-key header to carry " +
      '`keystring:shared_secret`; the keystring alone is refused with 403.',
  },
  {
    key: 'ETSY_OAUTH_REDIRECT_URI',
    description: 'The exact HTTPS redirect URI registered on the Etsy application. Never defaulted.',
  },
];

// Token cache: cacheKey -> { accessToken, expiresAt, grantedScopes }. In memory only,
// never written to disk, mirroring shopifyClient.js's CLIENT_CREDENTIALS_TOKEN_CACHE.
const ETSY_ACCESS_TOKEN_CACHE = new Map();

// Response cache: cacheKey -> { expiresAt, payload }. Request-reduction only (see header).
const ETSY_RESPONSE_CACHE = new Map();

// In-flight deduplication: cacheKey -> Promise. Two concurrent identical reads share one
// network request instead of spending two of the second's quota on the same answer.
const ETSY_INFLIGHT_READS = new Map();

// Shop ids derived from getMe: businessId -> shop_id (a string). In memory only, and
// populated ONLY from what Etsy itself returned - never from a default. It exists so that
// running without a configured ETSY_SHOP_ID costs one identity request per process rather
// than one per read, which matters because Etsy's quota is a daily one.
const ETSY_DERIVED_SHOP_ID_CACHE = new Map();

// What Etsy last told us about our remaining quota. Populated from response headers only -
// every field starts null and stays null until Etsy actually reports a value, so an
// unknown quota is never mistaken for an ample one.
const ETSY_RATE_LIMIT_STATE = {
  limitPerSecond: null,
  remainingThisSecond: null,
  limitPerDay: null,
  remainingToday: null,
  observedAt: null,
  lastRequestAtMs: 0,
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A positive number from an env var, or null. Null means "not configured", never a
// guessed default - see this file's rate-limit header note.
function positiveNumberFromEnv(name) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredQpsLimit() {
  return positiveNumberFromEnv('ETSY_QPS_LIMIT');
}

function getConfiguredQpdLimit() {
  return positiveNumberFromEnv('ETSY_QPD_LIMIT');
}

// How long a response may be reused. Short by default (60s) because this is a
// request-reduction cache, not a data store.
function getCacheTtlMs() {
  const configured = Number(process.env.ETSY_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 60000;
}

// Resolves every credential a read needs. Reuses etsyClient.resolveCredentials() for the
// three keys it already owns rather than parsing them a second time, and adds only the
// two read-specific keys. Same two-mode behavior as every other adapter in this project:
// businessId omitted -> the root .env; businessId supplied -> that business's own file,
// which never touches process.env.
function resolveReadCredentials(businessId) {
  const base = etsyClient.resolveCredentials(businessId);
  if (!businessId) {
    etsyClient.loadEnvOnce();
    return {
      ...base,
      refreshToken: process.env.ETSY_OAUTH_REFRESH_TOKEN,
      redirectUri: process.env.ETSY_OAUTH_REDIRECT_URI,
      sharedSecret: process.env.ETSY_SHARED_SECRET,
    };
  }
  const credentials = businessRegistry.loadBusinessCredentials(businessId);
  return {
    ...base,
    refreshToken: credentials.ETSY_OAUTH_REFRESH_TOKEN,
    redirectUri: credentials.ETSY_OAUTH_REDIRECT_URI,
    sharedSecret: credentials.ETSY_SHARED_SECRET,
  };
}

// The value of the x-api-key header.
//
// SOURCED FROM ETSY, NOT ASSUMED. Etsy's own securitySchemes entry states that every v3
// request must carry this "in the format `keystring:shared_secret`", and a real request
// sending the keystring alone is refused with
// "403: Shared secret is required in x-api-key header." Both the specification and the
// live API agree, so this is a documented requirement rather than a guessed mapping.
//
// The result contains a SECRET and must never be logged, returned, or put in an error
// message. Nothing in this module does: errors carry Etsy's status and message only.
function buildApiKeyHeader({ keystring, sharedSecret }) {
  return `${keystring}:${sharedSecret}`;
}

// Which credentials a READ needs and does not have - KEY NAMES only, never values, so the
// result is safe to log, audit or return. A read needs a keystring and some way to obtain
// a bearer token (a refresh token, or a hand-supplied access token).
//
// ETSY_SHOP_ID IS DELIBERATELY NOT IN THIS LIST. It is not a credential that has to be
// supplied: Etsy's getMe endpoint returns the authenticated seller's own shop_id, and its
// generated OpenAPI spec requires only `shops_r` for it - a scope this phase already
// holds. So the shop id is DERIVED from the authenticated identity when it is not
// configured (see resolveShopIdForRead), rather than being demanded from the operator or,
// worse, guessed. When it IS configured it is used as-is and can be checked against Etsy
// with verifyEtsyShopId(). An account with no shop still fails loudly - see
// getEtsyAuthenticatedIdentity - because deriving nothing is reported, never defaulted.
function missingReadCredentials(businessId = null) {
  const resolved = resolveReadCredentials(businessId);
  const missing = [];
  if (!isNonEmptyString(resolved.keystring)) missing.push('ETSY_API_KEYSTRING');
  if (!isNonEmptyString(resolved.sharedSecret)) missing.push('ETSY_SHARED_SECRET');
  if (!isNonEmptyString(resolved.refreshToken) && !isNonEmptyString(resolved.accessToken)) {
    missing.push('ETSY_OAUTH_REFRESH_TOKEN');
  }
  return missing;
}

// True once this client could actually perform a read. Named distinctly from
// etsyClient.isConfigured()/canPublish() so "reads work" is never read as "publishing
// works" - those remain false and unaffected.
function canRead({ businessId = null } = {}) {
  return missingReadCredentials(businessId).length === 0;
}

function tokenCacheKey(businessId, keystring) {
  return businessId || keystring || '__default__';
}

// Returns a usable bearer token, refreshing it when needed.
//
// PREFERS THE REFRESH FLOW. A refresh token yields a token whose expiry AND granted
// scopes Etsy states explicitly, which is what makes getGrantedEtsyScopes() honest. A
// hand-pasted ETSY_OAUTH_ACCESS_TOKEN is still accepted (it is what this project
// supported before an OAuth flow existed) but it carries no expiry and no scope
// information, so it is used as-is and never cached with a fabricated lifetime.
async function getAccessToken({ businessId = null, refresh = false } = {}) {
  const resolved = resolveReadCredentials(businessId);
  const missing = missingReadCredentials(businessId);
  if (missing.length > 0) {
    throw new Error(
      `Etsy reading is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Add them to .env (see the ETSY_* block in .env.example) or run `npm run integrations:etsy-authorize`. ' +
        'No Etsy request was attempted.'
    );
  }

  const cacheKey = tokenCacheKey(businessId, resolved.keystring);
  if (!refresh) {
    const cached = ETSY_ACCESS_TOKEN_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
  }

  if (!isNonEmptyString(resolved.refreshToken)) {
    // A hand-supplied access token: usable, but its scopes are unknown to us. Recorded
    // with grantedScopes null - NOT [] - so getGrantedEtsyScopes() can tell the
    // difference between "no scopes" and "we cannot know".
    return resolved.accessToken;
  }

  const tokens = await etsyOAuth.refreshAccessToken({
    keystring: resolved.keystring,
    refreshToken: resolved.refreshToken,
  });
  ETSY_ACCESS_TOKEN_CACHE.set(cacheKey, {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    grantedScopes: tokens.grantedScopes,
  });
  return tokens.accessToken;
}

// The scopes Etsy actually granted this token. Mirrors
// shopifyClient.getGrantedAccessScopes()'s rule exactly: an answer we cannot read THROWS.
// It never returns [] to mean "unknown", because an empty list would read as "no scopes
// granted" and a caller checking `scopes.includes(...)` would then treat a missing grant
// and an unreadable grant identically - which is how a permission check silently stops
// checking anything.
async function getGrantedEtsyScopes({ businessId = null, refresh = false } = {}) {
  const resolved = resolveReadCredentials(businessId);
  if (!isNonEmptyString(resolved.refreshToken)) {
    throw new Error(
      'Granted Etsy scopes cannot be determined: this business is configured with a hand-supplied ' +
        'ETSY_OAUTH_ACCESS_TOKEN, and Etsy reports granted scopes only on a token it issues. Run ' +
        '`npm run integrations:etsy-authorize` so the scopes are known rather than assumed.'
    );
  }

  const cacheKey = tokenCacheKey(businessId, resolved.keystring);
  const cached = ETSY_ACCESS_TOKEN_CACHE.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now() && Array.isArray(cached.grantedScopes)) {
    return [...cached.grantedScopes];
  }

  await getAccessToken({ businessId, refresh: true });
  const fresh = ETSY_ACCESS_TOKEN_CACHE.get(cacheKey);
  if (!fresh || !Array.isArray(fresh.grantedScopes)) {
    throw new Error('Etsy did not report the granted scopes for this token, so they cannot be confirmed.');
  }
  return [...fresh.grantedScopes];
}

// The hard read-only guard. Every read passes through it before anything else happens.
function assertReadOnlyMethod(method, fnName) {
  if (method !== 'GET') {
    throw new Error(
      `${fnName} refuses the HTTP method '${method}': this Etsy client is read-only and may issue GET requests ` +
        'only. No Etsy request was attempted.'
    );
  }
  return method;
}

function getEndpointById(endpointId) {
  const endpoint = ETSY_READ_ENDPOINTS.find((entry) => entry.id === endpointId);
  if (!endpoint) {
    throw new Error(
      `Unknown Etsy read endpoint '${endpointId}'. Only these are permitted in this phase: ` +
        `${ETSY_READ_ENDPOINTS.map((entry) => entry.id).join(', ')}. No Etsy request was attempted.`
    );
  }
  return endpoint;
}

// Substitutes {placeholders} in an endpoint path. Every value is URL-encoded, and an
// absent value is an error rather than an empty segment - a path with a hole in it would
// silently address a different resource.
function buildEndpointPath(endpoint, params = {}) {
  return endpoint.path.replace(/\{(\w+)\}/g, (_match, name) => {
    const value = params[name];
    if (!isNonEmptyString(String(value === undefined || value === null ? '' : value))) {
      throw new Error(`Etsy endpoint '${endpoint.id}' requires the path parameter '${name}'. No Etsy request was attempted.`);
    }
    return encodeURIComponent(String(value));
  });
}

function buildCacheKey(businessId, endpointId, path, query) {
  const queryPart = query && Object.keys(query).length > 0 ? new URLSearchParams(query).toString() : '';
  return `${businessId || '__default__'}|${endpointId}|${path}|${queryPart}`;
}

// Reads Etsy's quota headers off a response. Only records what Etsy actually reported -
// an absent header leaves the previous value alone rather than resetting it to a guess.
function recordRateLimitHeaders(response) {
  const readHeader = (name) => {
    const raw = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
    const parsed = Number(raw);
    return raw !== null && Number.isFinite(parsed) ? parsed : null;
  };

  const limitPerSecond = readHeader('x-limit-per-second');
  const remainingThisSecond = readHeader('x-remaining-this-second');
  const limitPerDay = readHeader('x-limit-per-day');
  const remainingToday = readHeader('x-remaining-today');

  if (limitPerSecond !== null) ETSY_RATE_LIMIT_STATE.limitPerSecond = limitPerSecond;
  if (remainingThisSecond !== null) ETSY_RATE_LIMIT_STATE.remainingThisSecond = remainingThisSecond;
  if (limitPerDay !== null) ETSY_RATE_LIMIT_STATE.limitPerDay = limitPerDay;
  if (remainingToday !== null) ETSY_RATE_LIMIT_STATE.remainingToday = remainingToday;
  if ([limitPerSecond, remainingThisSecond, limitPerDay, remainingToday].some((value) => value !== null)) {
    ETSY_RATE_LIMIT_STATE.observedAt = new Date().toISOString();
  }
}

// A snapshot of what Etsy last reported. All-null until a real response has been seen.
function getRateLimitState() {
  return { ...ETSY_RATE_LIMIT_STATE };
}

// Waits for a slot before issuing a request, and refuses outright when Etsy has said the
// daily quota is exhausted.
//
// The spacing gate is applied ONLY when ETSY_QPS_LIMIT is configured. With no configured
// limit there is no spacing - inventing one would be asserting a rate limit this project
// has not verified, and the reactive 429 backoff still protects the API either way.
async function awaitRateLimitSlot() {
  if (ETSY_RATE_LIMIT_STATE.remainingToday === 0) {
    throw new Error(
      "Etsy reported no daily request quota remaining (x-remaining-today: 0). This client stops rather than " +
        'continuing to request. No Etsy request was attempted.'
    );
  }

  const qps = getConfiguredQpsLimit();
  if (!qps) return;

  const minSpacingMs = Math.ceil(1000 / qps);
  const waitMs = ETSY_RATE_LIMIT_STATE.lastRequestAtMs + minSpacingMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

// The single transport every read goes through. Mirrors
// shopifyClient.runAdminGraphqlQuery()'s error split exactly, so both adapters fail the
// same way: a thrown fetch failure or an HTTP 429/5xx is a RetryableError (bounded,
// backed off, honoring Retry-After); any other non-ok status is a deterministic
// query/permission/config problem thrown as a plain Error that is never retried.
//
// Never returns fabricated data: an unparseable body on a 2xx is an error, not an empty
// object.
async function runEtsyRead({ endpointId, params = {}, query = null, businessId = null } = {}) {
  const endpoint = getEndpointById(endpointId);
  assertReadOnlyMethod(endpoint.method, 'runEtsyRead');

  // Configuration is checked BEFORE the path is built. Several path parameters (the shop
  // id in particular) ARE credentials, so an unconfigured client would otherwise fail
  // with "missing path parameter 'shop_id'" - technically true, but it sends the reader
  // looking for a bug in the caller instead of at the .env key that is actually absent.
  const missing = missingReadCredentials(businessId);
  if (missing.length > 0) {
    throw new Error(
      `Etsy reading is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Add them to .env (see the ETSY_* block in .env.example) or run `npm run integrations:etsy-authorize`. ' +
        'No Etsy request was attempted.'
    );
  }

  const path = buildEndpointPath(endpoint, params);
  const cleanQuery = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') cleanQuery[key] = String(value);
  }

  const cacheKey = buildCacheKey(businessId, endpointId, path, cleanQuery);

  const cached = ETSY_RESPONSE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  // Deduplication: a second identical read arriving while the first is still in flight
  // waits on that same promise rather than spending another request.
  const inflight = ETSY_INFLIGHT_READS.get(cacheKey);
  if (inflight) return inflight;

  const requestPromise = (async () => {
    const accessToken = await getAccessToken({ businessId });
    const { keystring, sharedSecret } = resolveReadCredentials(businessId);
    const apiKeyHeader = buildApiKeyHeader({ keystring, sharedSecret });

    const url = new URL(`${ETSY_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(cleanQuery)) url.searchParams.set(key, value);

    const payload = await retryAsync(async () => {
      await awaitRateLimitSlot();
      ETSY_RATE_LIMIT_STATE.lastRequestAtMs = Date.now();

      let response;
      try {
        response = await withTimeout((signal) =>
          fetch(url.toString(), {
            method: endpoint.method,
            headers: {
              'x-api-key': apiKeyHeader,
              authorization: `Bearer ${accessToken}`,
              accept: 'application/json',
            },
            signal,
          })
        );
      } catch (err) {
        throw new RetryableError(`Could not reach the Etsy API for ${endpointId}: ${err.message}`);
      }

      recordRateLimitHeaders(response);

      const raw = await response.json().catch(() => null);

      if (!response.ok) {
        const apiMessage = raw && (raw.error_description || raw.error) ? raw.error_description || raw.error : response.statusText;
        const message = `Etsy API request failed for ${endpointId} (${response.status}): ${apiMessage}`;
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(message, { retryAfterMs: parseRetryAfterMs(response) });
        }
        throw new Error(message);
      }

      if (raw === null || typeof raw !== 'object') {
        throw new Error(`Etsy API response for ${endpointId} could not be parsed as JSON. No data is reported.`);
      }

      return raw;
    });

    const ttlMs = getCacheTtlMs();
    if (ttlMs > 0) ETSY_RESPONSE_CACHE.set(cacheKey, { expiresAt: Date.now() + ttlMs, payload });
    return payload;
  })();

  ETSY_INFLIGHT_READS.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    ETSY_INFLIGHT_READS.delete(cacheKey);
  }
}

// Reads one field, returning null when it is absent. Absent means absent: a missing field
// becomes null so downstream compliance can report NEEDS_INFORMATION, never a default
// that would be indistinguishable from a real value.
function field(raw, name) {
  return raw && Object.prototype.hasOwnProperty.call(raw, name) && raw[name] !== undefined ? raw[name] : null;
}

// Normalizes one Etsy shop record. Only Etsy's own fields are carried through, renamed to
// nothing - the names are Etsy's. Nothing is derived or inferred.
function normalizeEtsyShop(raw) {
  return stampChannel(
    {
      shop_id: field(raw, 'shop_id'),
      shop_name: field(raw, 'shop_name'),
      title: field(raw, 'title'),
      announcement: field(raw, 'announcement'),
      currency_code: field(raw, 'currency_code'),
      url: field(raw, 'url'),
      listing_active_count: field(raw, 'listing_active_count'),
      digital_listing_count: field(raw, 'digital_listing_count'),
      is_vacation: field(raw, 'is_vacation'),
    },
    ETSY_CHANNEL
  );
}

// Normalizes one Etsy listing record.
//
// is_digital_product is DERIVED ONLY FROM WHAT ETSY ACTUALLY SAID. Etsy reports both an
// `is_digital` boolean and a `listing_type`; when neither is present this stays null, and
// downstream treats null as NEEDS_INFORMATION. It is never defaulted to true just because
// this shop is known to sell digital invitations - that would be exactly the assumption
// that produces a listing describing a download as though it were a printed card.
function normalizeEtsyListing(raw) {
  const isDigital = field(raw, 'is_digital');
  const listingType = field(raw, 'listing_type');
  let isDigitalProduct = null;
  if (typeof isDigital === 'boolean') isDigitalProduct = isDigital;
  else if (listingType === 'download') isDigitalProduct = true;
  else if (listingType === 'physical') isDigitalProduct = false;

  return stampChannel(
    {
      listing_id: field(raw, 'listing_id'),
      shop_id: field(raw, 'shop_id'),
      title: field(raw, 'title'),
      description: field(raw, 'description'),
      state: field(raw, 'state'),
      url: field(raw, 'url'),
      tags: Array.isArray(field(raw, 'tags')) ? raw.tags : [],
      materials: Array.isArray(field(raw, 'materials')) ? raw.materials : [],
      price: field(raw, 'price'),
      quantity: field(raw, 'quantity'),
      taxonomy_id: field(raw, 'taxonomy_id'),
      listing_type: listingType,
      is_digital: isDigital,
      is_digital_product: isDigitalProduct,
      num_favorers: field(raw, 'num_favorers'),
      views: field(raw, 'views'),
    },
    ETSY_CHANNEL
  );
}

// Etsy returns collections as { count, results: [...] }. Reports an unexpected shape as an
// error rather than silently yielding zero results, which would look like an empty shop.
function readResults(raw, fnName) {
  if (!Array.isArray(raw.results)) {
    throw new Error(`Etsy API response for ${fnName} had an unexpected shape: no 'results' array was present.`);
  }
  return raw.results;
}

// --- Identity: whose token this is, and which shop it owns -------------------------

// An Etsy shop id is a positive integer - Etsy's own schema declares it
// `integer, minimum 1`. Anything else is refused before it can be substituted into a URL
// path.
//
// THIS EXISTS BECAUSE "SET" AND "USABLE" ARE NOT THE SAME THING. A half-finished .env
// commonly holds a placeholder such as `...`, `TBD` or `<your shop id>`, and a bare
// is-it-non-empty check reads all of those as configured. That would send a request to
// someone else's URL space and, worse, would make the operator believe the value they
// meant to fill in later had been accepted. An unusable value is therefore an error that
// names the key and says exactly how to fix it - never a silent fallback to derivation,
// because silently ignoring a value the operator deliberately typed is its own surprise.
function assertNumericShopId(value) {
  const trimmed = String(value).trim();
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new Error(
      `ETSY_SHOP_ID is set to a value that is not a numeric Etsy shop id. Etsy shop ids are positive whole ` +
        'numbers. Either set it to your shop\'s numeric id, or leave it BLANK - blank is fully supported, and the ' +
        'shop id is then read from Etsy itself via getMe under the shops_r scope. No Etsy request was attempted.'
    );
  }
  return trimmed;
}

// The authenticated seller's own identity, as Etsy itself reports it.
//
// WHY THIS EXISTS. ETSY_SHOP_ID is the one required value that is NOT on the Etsy
// Developer Portal application page - it belongs to the shop, not to the application - and
// CLAUDE.md rule 1 forbids inventing it. Etsy will simply state it: getMe returns the
// user_id and shop_id of whoever granted this token, and Etsy's own generated OpenAPI
// spec requires only `shops_r` for that call - a scope this phase already holds. So the
// shop id is obtained from the official API under the already-approved scopes, and no
// scope is widened, no endpoint is guessed, and no value is fabricated.
//
// DELIBERATELY NOT USED: the access-token prefix. Etsy's Authentication page documents
// that an access token is shaped `<user_id>.<token>`, so the user id could be read
// without any request at all. This module does not do that. Splitting a live credential
// to mine an identity out of it means handling a secret for something Etsy will answer
// directly, and it yields the USER id, which is not the SHOP id - Etsy's own Self schema
// carries the two as separate fields.
//
// Returns both ids as Etsy reported them, with shop_id null when the account owns no
// shop. Null is reported, never replaced by a fallback.
async function getEtsyAuthenticatedIdentity({ businessId = null } = {}) {
  const raw = await runEtsyRead({ endpointId: 'getMe', businessId });
  const userId = field(raw, 'user_id');
  const shopId = field(raw, 'shop_id');
  if (userId === null && shopId === null) {
    throw new Error(
      'Etsy getMe returned neither a user_id nor a shop_id, so the authenticated identity could not be established. ' +
        'No shop id is assumed.'
    );
  }
  return stampChannel(
    {
      user_id: userId,
      shop_id: shopId === null ? null : String(shopId),
    },
    ETSY_CHANNEL
  );
}

// The shop id every shop-scoped read is issued against, and where it came from.
//
// Configured wins and costs nothing: when ETSY_SHOP_ID is set it is used as-is, with NO
// verification request, because verifying on every read would spend a second request of a
// daily quota to re-learn a constant. Checking it against Etsy is an explicit, separate
// step - verifyEtsyShopId() - not a hidden per-read cost.
//
// Unconfigured falls back to the authenticated identity, once per process.
async function resolveShopIdForRead(businessId = null) {
  const { shopId: configured } = resolveReadCredentials(businessId);
  if (isNonEmptyString(configured)) {
    return { shopId: assertNumericShopId(configured), source: 'configured' };
  }

  const cacheKey = businessId || '__default__';
  const cached = ETSY_DERIVED_SHOP_ID_CACHE.get(cacheKey);
  if (isNonEmptyString(cached)) return { shopId: cached, source: 'derived_from_getMe' };

  const identity = await getEtsyAuthenticatedIdentity({ businessId });
  if (!isNonEmptyString(identity.shop_id)) {
    throw new Error(
      'ETSY_SHOP_ID is not configured and Etsy reported no shop for the account this token belongs to, so no shop ' +
        'id could be established. Set ETSY_SHOP_ID in .env to the numeric shop id, or re-authorize with the Etsy ' +
        'account that owns the shop. No shop id was assumed and no shop-scoped request was made.'
    );
  }
  ETSY_DERIVED_SHOP_ID_CACHE.set(cacheKey, identity.shop_id);
  return { shopId: identity.shop_id, source: 'derived_from_getMe' };
}

// Checks a CONFIGURED ETSY_SHOP_ID against the shop Etsy says this token actually owns.
//
// FAILS CLOSED ON A MISMATCH. A configured shop id that is not the token's own shop means
// every subsequent read would be aimed at someone else's shop - which is both wrong and
// exactly the kind of request this project must not make. So a mismatch throws rather than
// silently preferring either value; which of the two is correct is the operator's call.
//
// Shop and user ids are not secrets (they appear in public shop URLs), so this report may
// safely be printed - unlike anything else this module handles.
async function verifyEtsyShopId({ businessId = null } = {}) {
  const { shopId: configured } = resolveReadCredentials(businessId);
  const identity = await getEtsyAuthenticatedIdentity({ businessId });

  if (!isNonEmptyString(configured)) {
    return {
      status: 'derived',
      configured_shop_id: null,
      etsy_shop_id: identity.shop_id,
      user_id: identity.user_id,
      detail:
        'ETSY_SHOP_ID is not configured. The shop id above is the one Etsy reports for the account that granted ' +
        'this token, and is what shop-scoped reads will use.',
    };
  }

  const normalizedConfigured = assertNumericShopId(configured);
  if (isNonEmptyString(identity.shop_id) && normalizedConfigured !== identity.shop_id) {
    throw new Error(
      `The configured ETSY_SHOP_ID (${normalizedConfigured}) is not the shop Etsy reports for this token ` +
        `(${identity.shop_id}). Reads would be aimed at a shop this token does not own, so nothing further was ` +
        'requested. Correct ETSY_SHOP_ID in .env, or re-authorize with the account that owns that shop.'
    );
  }

  return {
    status: 'verified',
    configured_shop_id: normalizedConfigured,
    etsy_shop_id: identity.shop_id,
    user_id: identity.user_id,
    detail: 'The configured ETSY_SHOP_ID matches the shop Etsy reports for this token.',
  };
}

// --- The read surface -------------------------------------------------------------

// The seller's own shop record.
async function getEtsyShop({ businessId = null } = {}) {
  const { shopId } = await resolveShopIdForRead(businessId);
  const raw = await runEtsyRead({ endpointId: 'getShop', params: { shop_id: shopId }, businessId });
  return normalizeEtsyShop(raw);
}

// The seller's own listings. `state` and paging are passed through to Etsy; nothing is
// defaulted beyond a bounded page size, so a caller always knows what it asked for.
async function getEtsyListings({ businessId = null, limit = 25, offset = 0, state = null } = {}) {
  const { shopId } = await resolveShopIdForRead(businessId);
  const raw = await runEtsyRead({
    endpointId: 'getListingsByShop',
    params: { shop_id: shopId },
    query: { limit, offset, state },
    businessId,
  });
  return readResults(raw, 'getEtsyListings').map(normalizeEtsyListing);
}

async function getEtsyListing({ listingId, businessId = null } = {}) {
  const raw = await runEtsyRead({ endpointId: 'getListing', params: { listing_id: listingId }, businessId });
  return normalizeEtsyListing(raw);
}

// One listing's inventory. Returned as Etsy reported it, stamped with its channel - this
// client does not reshape inventory, because nothing in this phase consumes it in a
// reshaped form and inventing a shape now would be a guess.
async function getEtsyListingInventory({ listingId, businessId = null } = {}) {
  const raw = await runEtsyRead({ endpointId: 'getListingInventory', params: { listing_id: listingId }, businessId });
  return stampChannel({ listing_id: listingId, products: Array.isArray(raw.products) ? raw.products : [] }, ETSY_CHANNEL);
}

async function getEtsyListingImages({ listingId, businessId = null } = {}) {
  const raw = await runEtsyRead({ endpointId: 'getListingImages', params: { listing_id: listingId }, businessId });
  return readResults(raw, 'getEtsyListingImages').map((image) =>
    stampChannel(
      {
        listing_image_id: field(image, 'listing_image_id'),
        listing_id: field(image, 'listing_id'),
        url_fullxfull: field(image, 'url_fullxfull'),
        alt_text: field(image, 'alt_text'),
        rank: field(image, 'rank'),
      },
      ETSY_CHANNEL
    )
  );
}

// Clears every in-memory cache. Exists for tests and for an operator who has just
// re-authorized; it never deletes anything outside this process.
function clearEtsyReadCaches() {
  ETSY_ACCESS_TOKEN_CACHE.clear();
  ETSY_RESPONSE_CACHE.clear();
  ETSY_INFLIGHT_READS.clear();
  ETSY_DERIVED_SHOP_ID_CACHE.clear();
  ETSY_RATE_LIMIT_STATE.limitPerSecond = null;
  ETSY_RATE_LIMIT_STATE.remainingThisSecond = null;
  ETSY_RATE_LIMIT_STATE.limitPerDay = null;
  ETSY_RATE_LIMIT_STATE.remainingToday = null;
  ETSY_RATE_LIMIT_STATE.observedAt = null;
  ETSY_RATE_LIMIT_STATE.lastRequestAtMs = 0;
}

module.exports = {
  ETSY_CHANNEL,
  ETSY_API_BASE_URL,
  ETSY_READ_ENDPOINTS,
  ETSY_READ_CREDENTIALS,
  resolveReadCredentials,
  buildApiKeyHeader,
  missingReadCredentials,
  canRead,
  getAccessToken,
  getGrantedEtsyScopes,
  assertReadOnlyMethod,
  getEndpointById,
  buildEndpointPath,
  runEtsyRead,
  normalizeEtsyShop,
  normalizeEtsyListing,
  getEtsyAuthenticatedIdentity,
  assertNumericShopId,
  resolveShopIdForRead,
  verifyEtsyShopId,
  getEtsyShop,
  getEtsyListings,
  getEtsyListing,
  getEtsyListingInventory,
  getEtsyListingImages,
  getConfiguredQpsLimit,
  getConfiguredQpdLimit,
  getCacheTtlMs,
  getRateLimitState,
  clearEtsyReadCaches,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy read-only client (GET only):\n');
  console.log(`Base URL: ${ETSY_API_BASE_URL}`);
  console.log('Permitted endpoints - every one is a GET:');
  for (const endpoint of ETSY_READ_ENDPOINTS) {
    console.log(`  ${endpoint.method.padEnd(4)} ${endpoint.path}  [scope: ${endpoint.scope || 'api key only'}]`);
  }

  console.log('\nA non-GET method is refused mechanically:');
  try {
    assertReadOnlyMethod('POST', 'demo');
  } catch (err) {
    console.log(`  ${err.message}`);
  }

  console.log(`\nConfigured to read: ${canRead()}`);
  const missing = missingReadCredentials();
  if (missing.length > 0) {
    console.log('Missing read configuration (names only - no value is ever printed):');
    for (const key of missing) console.log(`  ${key}`);
  }

  // Reported, but not required: an unset shop id is derived from getMe at read time.
  const { shopId: configuredShopId } = resolveReadCredentials();
  if (!isNonEmptyString(configuredShopId)) {
    console.log('ETSY_SHOP_ID: not set - it will be DERIVED from getMe under the existing shops_r scope, never guessed');
  } else {
    try {
      assertNumericShopId(configuredShopId);
      console.log('ETSY_SHOP_ID: set to a numeric id (confirm it is really yours with verifyEtsyShopId)');
    } catch (err) {
      console.log(`ETSY_SHOP_ID: UNUSABLE - ${err.message}`);
    }
  }

  const qps = getConfiguredQpsLimit();
  const qpd = getConfiguredQpdLimit();
  console.log(`\nQPS limit: ${qps === null ? 'not configured (no client-side spacing is invented)' : qps}`);
  console.log(`QPD limit: ${qpd === null ? 'not configured (no client-side ceiling is invented)' : qpd}`);
  console.log(`Response cache TTL: ${getCacheTtlMs()}ms (in memory only - nothing is written to disk)`);
  console.log(`Quota last reported by Etsy: ${JSON.stringify(getRateLimitState())}`);
}
