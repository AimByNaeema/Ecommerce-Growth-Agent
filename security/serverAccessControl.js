'use strict';

// The HTTP server's access-control boundary: authentication + rate limiting for
// server.js's endpoints. This is CLAUDE.md section 3's "Security" shared
// infrastructure component applied to the one place this project actually exposes a
// network surface - the Express app - so no endpoint can spend real Claude/Shopify
// budget or return real store data to an anonymous caller.
//
// WHY A SHARED SECRET: this project had no authentication mechanism of any kind
// before this module, so one had to be chosen. Every heavier option (user accounts,
// sessions, OAuth/SSO) requires a user store or an identity provider - a database or
// hosting-platform decision CLAUDE.md rule 15 explicitly reserves for a prompt that
// scopes it. A single env-configured shared secret is the smallest mechanism that
// closes the hole while introducing no new runtime, framework, database, or
// dependency, and it reuses the existing .env convention every other credential in
// this project already uses (see .env.example). It authenticates "whoever holds the
// key", not a named human - when real multi-user access is needed, that is a separate,
// explicitly-scoped decision, not something this module should quietly grow into.
//
// FAILS CLOSED: if AGENT_API_KEY is unset or empty, every protected endpoint is
// refused (503) rather than served. A missing key can therefore never silently
// reopen the endpoints it was added to protect - the insecure state is unreachable by
// misconfiguration, which is the whole point of CLAUDE.md rule 6's "safe defaults over
// convenient ones".
//
// NEVER LEAKS THE SECRET: no function here logs, echoes, or includes the configured
// key (or a caller's supplied key) in any response body or error message - the same
// discipline audit/auditTrail.js's redactSensitiveData() enforces for records, applied
// at the HTTP boundary. Comparison is timing-safe (see safeCompare) so a wrong key
// cannot be discovered a byte at a time.
//
// NO PERSISTENCE, NO NEW DEPENDENCY: the rate limiter's counters live in a plain
// in-process Map, matching the same deliberate "caller-held state, no storage engine
// chosen yet" stance approvals/approvalWorkflow.js, audit/auditTrail.js, and
// server.js's own orchestratorRuns Map already take. Counters reset on restart and are
// per-process - honest limitations, documented rather than hidden.

const crypto = require('node:crypto');
// The businessId format/path-traversal guard, reused rather than restated - the same
// validation configuration/businessRegistry.js already applies before an id can reach the
// filesystem. isValidBusinessId() is a pure regex test and performs no I/O.
const { isValidBusinessId } = require('../configuration/businessRegistry');

// Reads the configured shared secret at call time (not module load) so a test can set
// it before createApp() runs - the same convention
// agent/core/runHistoryStore.js's getDefaultStoreDir() already uses.
function getConfiguredApiKey() {
  const value = process.env.AGENT_API_KEY;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Constant-time comparison of two secrets. Both sides are SHA-256 hashed first so the
// buffers are always the same length (crypto.timingSafeEqual throws on a length
// mismatch, and comparing raw lengths would itself leak the key's length).
function safeCompare(supplied, expected) {
  const suppliedHash = crypto.createHash('sha256').update(String(supplied)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(suppliedHash, expectedHash);
}

// Extracts the presented secret from an `Authorization: Bearer <key>` header. Returns
// null for a missing/malformed header rather than throwing - an absent credential is
// an ordinary 401, not a server error.
function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

// Express middleware: rejects any request that does not present the configured shared
// secret. Order matters - the not-configured case is checked first, so a deployment
// that forgot AGENT_API_KEY gets a clear 503 instead of a misleading 401 suggesting
// the caller's key was wrong.
function requireApiKey(req, res, next) {
  const configuredKey = getConfiguredApiKey();
  if (!configuredKey) {
    res.status(503).json({ error: 'This server is not configured to accept requests. Set AGENT_API_KEY.' });
    return;
  }

  const suppliedKey = extractBearerToken(req);
  if (!suppliedKey || !safeCompare(suppliedKey, configuredKey)) {
    res.status(401).json({ error: 'Valid credentials are required.' });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------------
// BUSINESS AUTHORIZATION - which businesses the authenticated credential may reach.
// ---------------------------------------------------------------------------------
//
// THE HOLE THIS CLOSES. requireApiKey above authenticates "whoever holds the key" and
// stops there. Several endpoints take a `business_id` straight from the request
// (/growth-workflow and /optimization-cycle in the body, /history in the query), and that
// id selects which business's configuration, credentials and saved runs are used. With one
// shared key and no further check, ANY authenticated caller could name ANY business and be
// served it. Authentication was being treated as authorization.
//
// CLIENT-SUPPLIED IDENTITY IS NEVER AUTHORITY. A business_id in a request says only which
// business is being ASKED for. Whether the credential may have it is decided here, against
// configuration the caller cannot influence.
//
// THE DEFAULT BUSINESS, AND WHY IT STAYS REACHABLE. A request that names no business_id
// means the server's own root-.env business - what every single-business deployment (and
// this project's own dashboard, which sends no business_id anywhere) has always used. That
// remains reachable by an authenticated key, so this boundary is purely additive: it
// constrains EXPLICIT business ids, which is exactly where the cross-customer risk is.
// Removing default access as well would be a separate, deliberate decision about how a
// multi-tenant deployment addresses its own root configuration.
//
// FAILS CLOSED WHEN UNCONFIGURED. With AGENT_API_KEY_BUSINESS_IDS unset, the authorized set
// is EMPTY and every explicit business_id is refused - a deployment that has not said which
// businesses its key may reach can reach none of them by name. The insecure state is
// unreachable by omission, the same discipline getConfiguredApiKey()'s 503 already applies.
const AUTHORIZED_BUSINESS_IDS_ENV = 'AGENT_API_KEY_BUSINESS_IDS';

// The businesses this credential may address by name. Comma- or whitespace-separated in the
// environment; read at call time (not module load) so a test can set it before createApp().
//
// An entry that is not a syntactically valid businessId is DROPPED rather than accepted -
// it could never name a real business anyway (configuration/businessRegistry.js would refuse
// it), and silently honouring a malformed entry is how a typo becomes an access grant.
// Duplicates collapse. Order is not significant.
function getAuthorizedBusinessIds() {
  const raw = process.env[AUTHORIZED_BUSINESS_IDS_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const authorized = [];
  for (const entry of raw.split(/[,\s]+/)) {
    const candidate = entry.trim();
    if (candidate === '') continue;
    if (!isValidBusinessId(candidate)) continue;
    if (!authorized.includes(candidate)) authorized.push(candidate);
  }
  return authorized;
}

// Whether the authenticated credential may access this business.
//
//   null / undefined / '' -> the default (root-.env) business: always authorized.
//   anything else         -> must be a valid businessId AND present in the authorized set.
//
// Pure: no I/O beyond reading its own env var, and it never consults credentials - holding
// a business's Shopify token has never been, and is not here, a reason to be allowed to
// address that business.
function isBusinessAuthorized(businessId) {
  if (businessId === null || businessId === undefined) return true;
  if (typeof businessId !== 'string' || businessId.trim() === '') return true;
  const candidate = businessId.trim();
  if (!isValidBusinessId(candidate)) return false;
  return getAuthorizedBusinessIds().includes(candidate);
}

// The business_id a request is asking for, from wherever the route carries it. Body first
// (the POST endpoints), then query (/history). Returns undefined when the request names
// none - which is the default business, not an error.
//
// Reads ONLY these two well-known locations: a header or a path segment is deliberately not
// consulted, so there is no second, quieter way to select a business.
function requestedBusinessId(req) {
  if (req.body && typeof req.body === 'object' && 'business_id' in req.body) return req.body.business_id;
  if (req.query && typeof req.query === 'object' && 'business_id' in req.query) return req.query.business_id;
  return undefined;
}

// Express middleware: refuses a request naming a business this credential may not reach.
// Applied to every protected endpoint (see server.js's `protect` chain), so a route cannot
// be business-scoped without passing this gate - a new endpoint is covered the day it is
// added rather than the day someone remembers to guard it.
//
// Runs AFTER requireApiKey: authenticate, then authorize. A request with no valid credential
// is refused before this is ever reached, so a 403 here always means "authenticated, but not
// for that business".
//
// THE ERROR NAMES NOTHING. It does not echo the requested id, does not list the authorized
// businesses, and carries no credential - a refusal must not become a way to discover which
// other businesses exist on this server.
function requireAuthorizedBusiness(req, res, next) {
  const requested = requestedBusinessId(req);

  if (requested === undefined || requested === null) {
    next();
    return;
  }

  if (typeof requested !== 'string') {
    res.status(400).json({ error: 'If provided, "business_id" must be a string.' });
    return;
  }

  // An empty/whitespace string is the default business, matching every existing route's own
  // `business_id || null` normalization - not a malformed id.
  if (requested.trim() === '') {
    next();
    return;
  }

  if (!isBusinessAuthorized(requested)) {
    res.status(403).json({ error: 'This credential is not authorized for the requested business.' });
    return;
  }

  next();
}

function positiveIntFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// The identity a rate-limit counter is keyed on: the presented credential when there
// is one (so one key's budget spend is counted together regardless of source address),
// otherwise the remote address (so unauthenticated attempts to guess the key are
// throttled too). The credential is hashed, never used raw as a Map key, so the secret
// itself never sits in memory as a plain lookup key or reaches a debug dump.
function rateLimitIdentity(req) {
  const token = extractBearerToken(req);
  if (token) return `key:${crypto.createHash('sha256').update(token).digest('hex')}`;
  return `ip:${(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown')}`;
}

// A fixed-window limiter: at most `max` requests per `windowMs` per identity. Fixed
// window (not sliding) is deliberate - it needs one integer and one timestamp per
// identity, where a sliding window needs a retained list of request times, and this
// boundary's job is to stop runaway budget spend and key guessing, not to shape
// precise traffic.
//
// Returns an Express middleware. Each caller (see server.js) creates its own limiter
// so limits can differ per endpoint group without sharing counters.
function createRateLimiter({ windowMs, max } = {}) {
  const effectiveWindowMs = windowMs || positiveIntFromEnv('RATE_LIMIT_WINDOW_MS', 60000);
  const effectiveMax = max || positiveIntFromEnv('RATE_LIMIT_MAX_REQUESTS', 30);
  const counters = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const identity = rateLimitIdentity(req);

    // Drop expired windows on each call. Bounded by how many distinct identities were
    // seen within one window, so this Map cannot grow without limit over time.
    for (const [key, entry] of counters) {
      if (entry.expiresAt <= now) counters.delete(key);
    }

    const existing = counters.get(identity);
    const entry = existing && existing.expiresAt > now ? existing : { count: 0, expiresAt: now + effectiveWindowMs };
    entry.count += 1;
    counters.set(identity, entry);

    if (entry.count > effectiveMax) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
      return;
    }

    next();
  };
}

module.exports = {
  getConfiguredApiKey,
  safeCompare,
  extractBearerToken,
  requireApiKey,
  createRateLimiter,
  AUTHORIZED_BUSINESS_IDS_ENV,
  getAuthorizedBusinessIds,
  isBusinessAuthorized,
  requestedBusinessId,
  requireAuthorizedBusiness,
};
