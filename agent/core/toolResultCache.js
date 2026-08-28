'use strict';

// Per-run tool-result cache. This is part of CLAUDE.md section 3's "Cost/token
// controls" shared infrastructure, but scoped to a different concern than
// agent/core/tokenControls.js (which only budgets Claude output tokens): this module
// memoizes an already-executed tool call within one agent/core/orchestratorExecutionContract.js
// run, so an identical second call (same tool id + same research_params) reuses the
// first result instead of re-executing the tool and re-embedding a duplicate result
// in the audit trail - a direct, mechanical answer to "reduce repeated tool results"
// and "reduce repeated business information" (see
// tools/businessConfigurationRetrieval.js, which takes no params and therefore
// always resolves to one stable cache key).
//
// Standalone deliverable, following the exact caller-held-tracker convention
// audit/auditTrail.js and approvals/approvalWorkflow.js already established: no
// module-level state, no persistence layer (in-memory, per-run only - see CLAUDE.md
// rule 15 and memory/state/README.md, which confirms no storage mechanism has been
// chosen yet). agent/core/orchestratorExecutionContract.js creates one cache per run
// via createToolResultCache() and threads it through every step, exactly like
// runTokenTracker/runApprovalTracker/runAuditTracker.
//
// getCachedResult()/setCachedResult() no-op safely on a falsy `cache` argument -
// the same backward-compatible convention audit/auditTrail.js's appendAuditEvent()
// already uses - so every call site can pass undefined/null without special-casing.

function createToolResultCache() {
  return { entries: new Map() };
}

// Recursively sorts object keys before stringifying, so two logically-identical
// research_params objects built with keys in a different order (e.g. {a:1,b:2} vs
// {b:2,a:1}) produce the same cache key - plain JSON.stringify does not sort keys.
// Array order is preserved (never sorted) since it is semantically meaningful for
// params like `keywords: [...]`. In practice this matters less than it sounds: every
// real caller in this codebase builds research_params via one fixed code path per
// run (the caller's own literal object, or buildPlanStep's effectiveResearchParams
// spread sequence), so insertion order is already consistent within a run - this is
// implemented for correctness, not because an observed bug required it.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function isEmptyParams(value) {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

// Deterministic cache key: toolId + a stable-order representation of researchParams.
// researchParams may be null/undefined/{} - all three collapse to the same key
// component (an empty object is truthy in JS, so a plain `|| null` alone would not
// catch it), so a no-params tool (e.g. business_configuration_retrieval) always
// resolves to one stable key regardless of how the caller expressed "no params".
function buildCacheKey(toolId, researchParams) {
  return `${toolId}::${stableStringify(isEmptyParams(researchParams) ? null : researchParams)}`;
}

// Returns the cached outcome for this toolId+researchParams, or undefined on a miss.
// No-ops (returns undefined) when `cache` is falsy. Never mutates the cache.
function getCachedResult(cache, toolId, researchParams) {
  if (!cache) return undefined;
  return cache.entries.get(buildCacheKey(toolId, researchParams));
}

// Stores `result` under this toolId+researchParams key. No-ops silently when `cache`
// is falsy.
function setCachedResult(cache, toolId, researchParams, result) {
  if (!cache) return;
  cache.entries.set(buildCacheKey(toolId, researchParams), result);
}

module.exports = {
  createToolResultCache,
  buildCacheKey,
  getCachedResult,
  setCachedResult,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - per-run tool-result cache (in-memory, caller-held state only):\n');

  const cache = createToolResultCache();
  console.log('Miss before any call:', getCachedResult(cache, 'market_research', { market: 'EU' }));

  setCachedResult(cache, 'market_research', { market: 'EU' }, { status: 'success', data: { findings: ['placeholder'] } });
  console.log('Hit after caching (same key order):', getCachedResult(cache, 'market_research', { market: 'EU' }));

  setCachedResult(cache, 'competitor_research', { market: 'EU', category: 'apparel' }, { status: 'success', data: { findings: [] } });
  console.log(
    'Hit with reordered keys (key-order-independent):',
    getCachedResult(cache, 'competitor_research', { category: 'apparel', market: 'EU' })
  );

  setCachedResult(cache, 'business_configuration_retrieval', undefined, { status: 'success', data: { name: '(placeholder shop)' } });
  console.log(
    'business_configuration_retrieval (no params) hit:',
    getCachedResult(cache, 'business_configuration_retrieval', undefined)
  );
}
