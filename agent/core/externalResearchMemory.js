'use strict';

// EXTERNAL RESEARCH REUSE - live market research found again in a later run or session.
//
// NOT A SECOND MEMORY SYSTEM. Every Chief run is already persisted in full by agent/core/runHistoryStore.js
// (on the durable volume in production), including each tool's own result. A live research result stamped
// with a `research_memory` block (below) is therefore already stored; this module only FINDS it again, the
// same way agent/core/researchContext.js finds completed Shopify research. Nothing is copied elsewhere.
//
// WHAT MAY BE REUSED - all of it must hold, otherwise research runs fresh:
//   - the same research key: the same tool, business, store and research SCOPE (market, related markets,
//     geographies, requested markets, exclusions, limit). A changed scope or query is a different key, so old
//     research is never served for a different question;
//   - the same business, exactly - one business's research never reaches another;
//   - a successful result: status 'complete' and search_status 'SEARCH_OK'. A partial run, a provider
//     failure, or a run that found nothing is never reused as if it were evidence;
//   - fresh: produced within EXTERNAL_RESEARCH_MAX_AGE_HOURS (default 24) and not future-dated. Market
//     evidence is time-sensitive, so stale research is refreshed, never served.
// Reused research keeps its original provenance - every source, timestamp and the run it came from.

const crypto = require('node:crypto');
const runHistoryStore = require('./runHistoryStore');

const EXTERNAL_RESEARCH_MAX_AGE_ENV = 'EXTERNAL_RESEARCH_MAX_AGE_HOURS';
const DEFAULT_EXTERNAL_RESEARCH_MAX_AGE_HOURS = 24;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RETRIEVAL_SCAN_LIMIT = 50;

function getExternalResearchMaxAgeHours() {
  const hours = Number(process.env[EXTERNAL_RESEARCH_MAX_AGE_ENV]);
  return hours > 0 ? hours : DEFAULT_EXTERNAL_RESEARCH_MAX_AGE_HOURS;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedList(values) {
  return [...new Set(asArray(values).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().toLowerCase()))].sort();
}

function tenantOf(businessId) {
  return typeof businessId === 'string' && businessId.trim() ? businessId.trim() : null;
}

// A deterministic key for one research question. Anything that changes what would be researched changes it.
function buildResearchKey({ toolId, businessId = null, storeReference = null, scope = {}, requestedMarkets = [], excludedCategories = [], limit = null } = {}) {
  const basis = {
    tool: toolId || null,
    business: tenantOf(businessId),
    store: storeReference || null,
    primary_market: typeof scope.primary_market === 'string' ? scope.primary_market.trim().toLowerCase() : null,
    related_markets: normalizedList(scope.related_markets),
    geographies: normalizedList(scope.geographies),
    // The catalogue's recurring themes shape the discovery prompts, so a catalogue with different themes asks
    // a different question even when its declared markets are the same.
    buyer_intents: normalizedList(scope.buyer_intents),
    requested_markets: normalizedList(requestedMarkets),
    excluded_categories: normalizedList(excludedCategories),
    limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
  };
  return `rk_${crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 32)}`;
}

// The provenance block every live research result carries.
function describeResearchMemory({ researchKey, mode, reason, provider = null, producedAt = new Date().toISOString(), sourceRunId = null, maxAgeHours = getExternalResearchMaxAgeHours() }) {
  return {
    research_id: crypto.randomUUID(),
    research_key: researchKey,
    mode,
    reason,
    provider,
    produced_at: producedAt,
    max_age_hours: maxAgeHours,
    source_run_id: sourceRunId,
  };
}

// Every stored result of `toolId` for this business, newest first, with the run it belongs to.
function* storedResults({ toolId, businessId, storeDir, scanLimit }) {
  const tenant = tenantOf(businessId);
  const options = storeDir ? { storeDir } : undefined;
  for (const summary of runHistoryStore.listRunRecordSummaries({ limit: scanLimit, ...(options || {}) })) {
    if ((summary.business_id || null) !== tenant) continue;
    const record = runHistoryStore.getRunRecordById(summary.run_id, options);
    if (!record || (record.business_id || null) !== tenant) continue;
    const plan = asArray(record.result && record.result.routing && record.result.routing.plan);
    for (const step of plan) {
      if (!step || !step.inputs || step.inputs.tool_id !== toolId) continue;
      const result = step.outputs && step.outputs.result;
      if (result && typeof result === 'object') yield { runId: record.run_id, createdAt: record.created_at, result };
    }
  }
}

// Returns { research: { result, source_run_id, produced_at, age_hours } | null, considered }.
function findReusableExternalResearch({ toolId, researchKey, businessId = null, now = Date.now(), maxAgeHours = getExternalResearchMaxAgeHours(), storeDir = undefined, scanLimit = RETRIEVAL_SCAN_LIMIT } = {}) {
  const considered = { same_key: 0, not_successful: 0, stale: 0, newest_stale_produced_at: null, newest_failure: null };
  if (!toolId || !researchKey) return { research: null, considered };
  for (const { runId, result } of storedResults({ toolId, businessId, storeDir, scanLimit })) {
    const memory = result.research_memory;
    if (!memory || memory.research_key !== researchKey) continue;
    considered.same_key += 1;
    if (result.status !== 'complete' || result.search_status !== 'SEARCH_OK') {
      // The newest stored answer to this exact question failed: remembered for the failed-research cooldown.
      if (considered.same_key === 1) considered.newest_failure = { run_id: runId, result };
      considered.not_successful += 1;
      continue;
    }
    const producedMs = Date.parse(memory.produced_at);
    if (!Number.isFinite(producedMs) || producedMs - now > MAX_CLOCK_SKEW_MS) {
      considered.not_successful += 1;
      continue;
    }
    const ageHours = Math.max(0, now - producedMs) / (60 * 60 * 1000);
    if (ageHours > maxAgeHours) {
      considered.stale += 1;
      if (!considered.newest_stale_produced_at) considered.newest_stale_produced_at = memory.produced_at;
      continue;
    }
    return {
      research: { result, source_run_id: memory.source_run_id || runId, stored_in_run_id: runId, produced_at: memory.produced_at, age_hours: Math.round(ageHours * 100) / 100 },
      considered,
    };
  }
  return { research: null, considered };
}

// FAILED-RESEARCH COOLDOWN. When the newest stored answer to this exact research question failed OPERATIONALLY
// (allowance exhausted, rate limited, provider down, usage limit) a few minutes ago, asking the same providers the
// same question again would most likely fail the same way and spend calls doing it. Returns the failure to report
// instead, or null. Never applies when a provider that was not tried then is configured now, so a newly added
// fallback is used at once. RESEARCH_FAILURE_COOLDOWN_MINUTES (default 15; 0 disables).
const FAILURE_COOLDOWN_ENV = 'RESEARCH_FAILURE_COOLDOWN_MINUTES';
const DEFAULT_FAILURE_COOLDOWN_MINUTES = 15;

function getFailureCooldownMinutes() {
  const raw = process.env[FAILURE_COOLDOWN_ENV];
  if (raw !== undefined && raw.trim() === '0') return 0;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_FAILURE_COOLDOWN_MINUTES;
}

function findFailedResearchCooldown({ found, now = Date.now(), providerChain = [], isOperationalFailure, cooldownMinutes = getFailureCooldownMinutes() } = {}) {
  const failure = found && found.considered ? found.considered.newest_failure : null;
  if (!failure || cooldownMinutes <= 0 || typeof isOperationalFailure !== 'function') return null;
  const { result } = failure;
  if (!isOperationalFailure(result.search_status)) return null;
  const producedMs = Date.parse(result.research_memory && result.research_memory.produced_at);
  if (!Number.isFinite(producedMs) || producedMs - now > MAX_CLOCK_SKEW_MS) return null;
  const ageMinutes = Math.max(0, now - producedMs) / 60000;
  if (ageMinutes >= cooldownMinutes) return null;
  const search = result.research_summary && result.research_summary.search;
  const tried = new Set(asArray(search && search.attempts).map((attempt) => attempt && attempt.provider).filter(Boolean));
  if (asArray(providerChain).some((provider) => !tried.has(provider))) return null;
  return {
    result,
    run_id: failure.run_id,
    search_status: result.search_status,
    produced_at: result.research_memory.produced_at,
    age_minutes: Math.round(ageMinutes * 10) / 10,
    retry_after: new Date(producedMs + cooldownMinutes * 60000).toISOString(),
    cooldown_minutes: cooldownMinutes,
  };
}

// Dated observations of one product from earlier research runs, for trend reasoning over time
// (agent/core/trendEvidence.js). Only real recorded values: a trend observation a source stated, or a
// measured/observed signal value dated by when that research retrieved it. Nothing is interpolated.
function collectHistoricalObservations({ toolId, businessId = null, productKey, storeDir = undefined, scanLimit = RETRIEVAL_SCAN_LIMIT } = {}) {
  const key = typeof productKey === 'string' ? productKey.trim().toLowerCase() : '';
  if (!toolId || !key) return [];
  const observations = [];
  for (const { result } of storedResults({ toolId, businessId, storeDir, scanLimit })) {
    const provider = result.research_memory ? result.research_memory.provider : null;
    for (const opportunity of asArray(result.top_opportunities)) {
      const names = [opportunity.product].concat(asArray(opportunity.variant_names)).filter((n) => typeof n === 'string').map((n) => n.trim().toLowerCase());
      if (!names.includes(key)) continue;
      for (const observation of asArray(opportunity.trend && opportunity.trend.observations)) {
        observations.push({ ...observation, provider: observation.provider || provider });
      }
      for (const metric of ['demand', 'competition']) {
        const signal = opportunity[metric];
        if (!signal || signal.value === null || signal.value === undefined) continue;
        if (!['measured', 'observed'].includes(String(signal.grade).toLowerCase())) continue;
        observations.push({
          date: signal.retrieved_at,
          value: signal.value,
          unit: signal.unit || null,
          metric: `${metric}${signal.unit ? `:${signal.unit}` : ''}`,
          grade: String(signal.grade).toUpperCase(),
          source: signal.source_url || null,
          provider,
        });
      }
    }
  }
  return observations;
}

module.exports = {
  EXTERNAL_RESEARCH_MAX_AGE_ENV,
  DEFAULT_EXTERNAL_RESEARCH_MAX_AGE_HOURS,
  getExternalResearchMaxAgeHours,
  buildResearchKey,
  describeResearchMemory,
  findReusableExternalResearch,
  FAILURE_COOLDOWN_ENV,
  getFailureCooldownMinutes,
  findFailedResearchCooldown,
  collectHistoricalObservations,
};
