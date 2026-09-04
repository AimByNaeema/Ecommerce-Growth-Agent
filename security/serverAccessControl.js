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
};
