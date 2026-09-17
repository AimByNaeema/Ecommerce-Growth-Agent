'use strict';

// RESEARCH PROVIDER SPENDING GUARD - every real call to an external research provider (Tavily, Gemini Google
// Search grounding, Anthropic web search) is checked BEFORE it is made and counted AFTER, including fallbacks.
//
// WHY THIS EXISTS (API cost audit): per-run usage limits counted the whole live research tool as ONE call although
// it makes 3-6 provider calls; nothing limited a business's research per day outside the autonomous cycle; and an
// exhausted provider was called again on every request.
//
// WHAT IT ENFORCES, per business:
//   - MAX_RESEARCH_PROVIDER_ATTEMPTS_PER_RUN          provider attempts in one Chief run (default 12)
//   - DAILY_RESEARCH_PROVIDER_ATTEMPTS_PER_BUSINESS   provider attempts per UTC day (default 60)
//   - DAILY_LIVE_RESEARCH_RUNS_PER_BUSINESS           Chief runs that reach a provider per UTC day (default 20)
//   - RESEARCH_PROVIDER_QUOTA_COOLDOWN_MINUTES        a provider that reports its quota/credit exhausted is not
//                                                     called again for this long (default 60; 0 disables), through
//                                                     reliability/circuitBreaker.js - one failure opens it, and
//                                                     after the cooldown exactly one trial call is allowed.
// Every attempt is also added to the run's existing externalApiCalls count (agent/core/usageLimits.js), so the
// per-run external API ceiling sees provider calls, not just tool dispatches.
//
// ONLY SUBTRACTS PERMISSION. A refusal names its reason; nothing here can allow a call another gate refused.
// A day's counter that cannot be read or written fails CLOSED: no provider call is made.
//
// SCOPE. The Chief (agent/core/orchestratorExecutionContract.js's runExecutor) opens a context around every tool
// execution, so every production path - the dashboard, sessions, the autonomous cycle - is guarded. A research
// function called directly, outside any Chief run (a unit test, a CLI demo), has no business or run to count
// against and is not limited here.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');

const circuitBreaker = require('../../reliability/circuitBreaker');
const { isValidBusinessId } = require('../../configuration/businessRegistry');

const LIMITS = {
  attemptsPerRun: { env: 'MAX_RESEARCH_PROVIDER_ATTEMPTS_PER_RUN', fallback: 12 },
  dailyAttempts: { env: 'DAILY_RESEARCH_PROVIDER_ATTEMPTS_PER_BUSINESS', fallback: 60 },
  dailyRuns: { env: 'DAILY_LIVE_RESEARCH_RUNS_PER_BUSINESS', fallback: 20 },
};
const QUOTA_COOLDOWN_ENV = 'RESEARCH_PROVIDER_QUOTA_COOLDOWN_MINUTES';
const DEFAULT_QUOTA_COOLDOWN_MINUTES = 60;
const STORE_DIR_ENV = 'RESEARCH_USAGE_STORE_DIR';
const DEFAULT_BUSINESS_KEY = '_default';

// Attempts that never reached a provider: nothing was sent, so nothing is counted or charged.
const NOT_SENT_STATUSES = new Set(['SEARCH_UNSUPPORTED_CAPABILITY', 'SEARCH_PROVIDER_NOT_CONFIGURED', 'SEARCH_USAGE_LIMIT_REACHED', 'SEARCH_PROVIDER_COOLDOWN']);

const context = new AsyncLocalStorage();

function positiveLimit({ env, fallback }) {
  const value = Number(process.env[env]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getLimits() {
  return {
    attempts_per_run: positiveLimit(LIMITS.attemptsPerRun),
    daily_attempts: positiveLimit(LIMITS.dailyAttempts),
    daily_runs: positiveLimit(LIMITS.dailyRuns),
    quota_cooldown_minutes: getQuotaCooldownMinutes(),
  };
}

function getQuotaCooldownMinutes() {
  const raw = process.env[QUOTA_COOLDOWN_ENV];
  if (raw !== undefined && raw.trim() === '0') return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_QUOTA_COOLDOWN_MINUTES;
}

function getStoreDir() {
  return process.env[STORE_DIR_ENV]
    ? path.resolve(process.env[STORE_DIR_ENV])
    : path.join(__dirname, '..', '..', 'memory', 'state', 'research-usage');
}

function businessKey(businessId) {
  return businessId === null || businessId === undefined || businessId === '' ? DEFAULT_BUSINESS_KEY : String(businessId);
}

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function dailyFile(key, now) {
  return path.join(getStoreDir(), 'daily', key, `${utcDay(now)}.json`);
}

// Throws when the day's record exists but cannot be read - the caller fails closed.
function readDaily(key, now) {
  const file = dailyFile(key, now);
  if (!fs.existsSync(file)) return { date: utcDay(now), business: key, provider_attempts: 0, live_research_runs: 0 };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Number.isInteger(parsed.provider_attempts) || !Number.isInteger(parsed.live_research_runs)) {
    throw new Error(`The research usage record ${file} is not in the expected shape.`);
  }
  return parsed;
}

function writeDaily(key, now, record) {
  const file = dailyFile(key, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...record, updated_at: now.toISOString() }, null, 2));
  fs.renameSync(temp, file);
}

function circuitScope(key, providerId) {
  return {
    businessId: key === DEFAULT_BUSINESS_KEY ? null : key,
    platform: 'search',
    action: `provider_${providerId}`,
    rootDir: path.join(getStoreDir(), 'circuits'),
  };
}

// Runs `fn` as one Chief tool execution: provider attempts inside it are counted against this business and run.
function runWithResearchUsageContext({ businessId = null, usageTracker = null } = {}, fn) {
  return context.run({ businessId, usageTracker, attempts: 0, runCounted: false, trials: new Set() }, fn);
}

function refusal(searchStatus, reasonCode, reason) {
  return { allowed: false, searchStatus, reason_code: reasonCode, reason };
}

// MAY THIS PROVIDER BE CALLED NOW? Returns { allowed: true } or { allowed: false, searchStatus, reason_code, reason }.
// searchStatus SEARCH_PROVIDER_COOLDOWN concerns this provider only (another provider may still be tried);
// SEARCH_USAGE_LIMIT_REACHED stops every provider.
function checkProviderAttempt(providerId, { now = new Date() } = {}) {
  const ctx = context.getStore();
  if (!ctx) return { allowed: true, guarded: false };
  const key = businessKey(ctx.businessId);
  if (key !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(key)) {
    return refusal('SEARCH_USAGE_LIMIT_REACHED', 'invalid_business', 'The business for this run is not valid, so research usage cannot be counted and no provider was called.');
  }
  const limits = getLimits();

  const attemptsThisRun = ctx.usageTracker && Number.isInteger(ctx.usageTracker.researchProviderAttempts) ? ctx.usageTracker.researchProviderAttempts : ctx.attempts;
  if (attemptsThisRun >= limits.attempts_per_run) {
    return refusal('SEARCH_USAGE_LIMIT_REACHED', 'run_attempts', `This run has already made ${attemptsThisRun} research provider call(s), its limit of ${limits.attempts_per_run} (${LIMITS.attemptsPerRun.env}). No further provider was called.`);
  }

  let daily;
  try {
    daily = readDaily(key, now);
  } catch (err) {
    return refusal('SEARCH_USAGE_LIMIT_REACHED', 'daily_unverifiable', `Today's research usage could not be read (${err.message}), so no provider was called.`);
  }
  if (daily.provider_attempts >= limits.daily_attempts) {
    return refusal('SEARCH_USAGE_LIMIT_REACHED', 'daily_attempts', `This business has made ${daily.provider_attempts} research provider call(s) today (UTC ${daily.date}), its daily limit of ${limits.daily_attempts} (${LIMITS.dailyAttempts.env}). Research resumes tomorrow.`);
  }
  if (!ctx.runCounted && daily.live_research_runs >= limits.daily_runs) {
    return refusal('SEARCH_USAGE_LIMIT_REACHED', 'daily_runs', `This business has run ${daily.live_research_runs} live research request(s) today (UTC ${daily.date}), its daily limit of ${limits.daily_runs} (${LIMITS.dailyRuns.env}). Research resumes tomorrow.`);
  }

  if (limits.quota_cooldown_minutes > 0) {
    const scope = circuitScope(key, providerId);
    const circuit = circuitBreaker.checkCircuit({ ...scope, now });
    if (!circuit.allowed) {
      const state = circuitBreaker.getCircuitState({ ...scope, now });
      const until = state && state.cooldown_until ? ` until ${state.cooldown_until}` : '';
      return refusal('SEARCH_PROVIDER_COOLDOWN', circuit.reason_code, `Search provider '${providerId}' reported its quota or credit exhausted, so it is not called again${until}.`);
    }
    if (circuit.trial) ctx.trials.add(providerId);
  }
  return { allowed: true, guarded: true };
}

// Counts one provider attempt that was actually sent, and updates that provider's quota circuit from its outcome.
// Throws only if today's counter cannot be written; the attempt itself has already happened.
function recordProviderAttempt(providerId, searchStatus, { now = new Date() } = {}) {
  const ctx = context.getStore();
  if (!ctx) return;
  const key = businessKey(ctx.businessId);
  if (NOT_SENT_STATUSES.has(searchStatus)) {
    // A recovery trial that never reached the provider proves nothing: the circuit reopens for another cooldown
    // rather than staying half-open with its single trial used up.
    if (ctx.trials.has(providerId)) {
      circuitBreaker.recordFailure({ ...circuitScope(key, providerId), now, failureThreshold: 1, cooldownMinutes: getQuotaCooldownMinutes() || DEFAULT_QUOTA_COOLDOWN_MINUTES });
      ctx.trials.delete(providerId);
    }
    return;
  }

  ctx.attempts += 1;
  if (ctx.usageTracker) {
    ctx.usageTracker.researchProviderAttempts = (ctx.usageTracker.researchProviderAttempts || 0) + 1;
    ctx.usageTracker.externalApiCalls = (ctx.usageTracker.externalApiCalls || 0) + 1;
  }

  const daily = readDaily(key, now);
  daily.provider_attempts += 1;
  if (!ctx.runCounted) daily.live_research_runs += 1;
  ctx.runCounted = true;
  writeDaily(key, now, daily);

  const cooldownMinutes = getQuotaCooldownMinutes();
  if (cooldownMinutes === 0) return;
  const scope = circuitScope(key, providerId);
  if (searchStatus === 'SEARCH_QUOTA_EXCEEDED') {
    circuitBreaker.recordFailure({ ...scope, now, failureThreshold: 1, cooldownMinutes });
  } else if (ctx.trials.has(providerId)) {
    // The one trial after a cooldown reached the provider without a quota refusal: the quota is back.
    circuitBreaker.recordSuccess({ ...scope, now });
  }
  ctx.trials.delete(providerId);
}

// Today's counts and limits for one business, for reporting.
function describeResearchUsage({ businessId = null, now = new Date() } = {}) {
  const key = businessKey(businessId);
  let daily = null;
  try {
    daily = readDaily(key, now);
  } catch (err) {
    daily = null;
  }
  return { business: key, date: utcDay(now), provider_attempts: daily ? daily.provider_attempts : null, live_research_runs: daily ? daily.live_research_runs : null, limits: getLimits() };
}

module.exports = {
  LIMITS,
  QUOTA_COOLDOWN_ENV,
  STORE_DIR_ENV,
  getLimits,
  runWithResearchUsageContext,
  checkProviderAttempt,
  recordProviderAttempt,
  describeResearchUsage,
};
