'use strict';

// RESEARCH CONTEXT - lets the Chief continue research it already completed, across Dashboard
// sessions, without leaking one business's or one store's research into another's.
//
// SOURCE OF TRUTH: THE RUN HISTORY STORE. A completed Chief run is already persisted in full by
// agent/core/runHistoryStore.js (on the durable volume in production). Nothing is copied into a
// second memory system: each Chief run record gains one additive `research_context` block -
// provenance describing what that record holds - and retrieval reads records back through the
// same store. Sessions stay conversation state (commandCenterSessionModel.js); memoryStore.js
// stays verified business facts. A new session therefore finds research through the store, not
// through another session's messages.
//
// PROVENANCE (describeResearchProvenance), stamped when a run is saved:
//   what was analysed   - every step's specialist, capability and tool, its completion state,
//                         its tool status, and whether it was a real store read with records
//   platform / store    - the single platform the reads used (tools/toolRegistry.js), and an
//                         opaque store reference: a hash of that platform's connected store
//                         domain as configured for the run's business at save time
//   when                - produced_at: the OLDEST production time of any step, so research that
//                         was itself reused can never renew its own freshness
//   who                 - the specialists that produced it
//   outcome             - agent/core/ownerRunView.js's own status (success only when every step
//                         completed and verification passed), pending approvals, store changes
//   authoritative       - true only for a successful, single-platform, real-store-data run with no
//                         pending approval and no store change; otherwise the reasons are listed
//
// ISOLATION (findReusableResearch), checked in this order before any content is considered:
//   1. the record's business_id must equal the requester's (null matches only null - the
//      single-business default - and never a named business);
//   2. the stamp's store_reference must equal the store this process reads for that business
//      NOW, and its platform must match. A store that is not configured has no reference, so
//      nothing can match it;
//   3. authority is RE-DERIVED from the record's own saved result - a stamp is never trusted over
//      the content it describes;
//   4. the research must cover the requested basis, and be no older than the freshness limit.
// Records from another business or another store are skipped without being described to anyone.
//
// FRESHNESS. RESEARCH_CONTEXT_MAX_AGE_HOURS (default 6) bounds reuse. Store data - orders,
// inventory, listing fields - changes, so research older than the limit is reported as stale and
// never reused; the Chief runs fresh research instead.

const crypto = require('crypto');
const runHistoryStore = require('./runHistoryStore');
const { getToolById } = require('../../tools/toolRegistry');
const { hasExplicitMutationIntent } = require('./mutationIntent');
const { referencesPriorWork, isConnectedPlatformName, tokens } = require('./objectiveInterpretation');
const { BASIS_PLATFORM, STORE_RESEARCH_BASIS, coversResearchBasis } = require('./storeOpportunityPrioritization');

const RESEARCH_CONTEXT_VERSION = 1;
const DEFAULT_MAX_AGE_HOURS = 6;
// A future-dated stamp beyond this clock-skew allowance is not trusted.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RETRIEVAL_SCAN_LIMIT = 50;
// Interpretation acts (objectiveInterpretation.js) that must never be answered from prior research.
const CONTINUATION_BLOCKING_ACTS = new Set(['change', 'unsupported_action', 'unsupported_platform']);

function getResearchMaxAgeHours() {
  const hours = Number(process.env.RESEARCH_CONTEXT_MAX_AGE_HOURS);
  return hours > 0 ? hours : DEFAULT_MAX_AGE_HOURS;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tenantOf(businessId) {
  return typeof businessId === 'string' && businessId.trim() ? businessId.trim() : null;
}

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Opaque, stable reference to one connected store. The domain itself is not stored.
function storeReferenceFor(platform, domain) {
  const normalized = normalizeDomain(domain);
  if (typeof platform !== 'string' || !platform || !normalized) return null;
  const digest = crypto.createHash('sha256').update(`${platform}:${normalized}`).digest('hex').slice(0, 24);
  return `${platform}:${digest}`;
}

// The store this process reads for `businessId` right now, or null when none is configured.
// Only the domain is read; no credential leaves the adapter.
function currentStoreReference({ businessId = null, platform = BASIS_PLATFORM } = {}) {
  if (platform !== 'shopify') return null;
  try {
    // Required lazily so a caller that never asks for a store reference loads no adapter.
    const shopifyClient = require('../../integrations/adapters/shopifyClient');
    const { domain } = shopifyClient.resolveCredentials(tenantOf(businessId));
    return storeReferenceFor(platform, domain);
  } catch (err) {
    return null;
  }
}

function stepPlatform(step) {
  const toolId = step && step.inputs && typeof step.inputs.tool_id === 'string' ? step.inputs.tool_id : null;
  const tool = toolId ? getToolById(toolId) : null;
  return tool && tool.operation === 'read' && asArray(tool.platforms).length === 1 ? tool.platforms[0] : null;
}

function hasRecords(outputs) {
  if (!isPlainObject(outputs) || outputs.status !== 'success') return false;
  if (Array.isArray(outputs.result)) return outputs.result.length > 0;
  return isPlainObject(outputs.result) && Object.keys(outputs.result).length > 0;
}

function describeStep(step) {
  const safe = isPlainObject(step) ? step : {};
  const platform = stepPlatform(safe);
  const reused = isPlainObject(safe.reused_research) ? safe.reused_research : null;
  return {
    specialist_id: (safe.selected_specialist && safe.selected_specialist.id) || null,
    specialist_title: (safe.selected_specialist && safe.selected_specialist.title) || null,
    capability_id: (safe.inputs && safe.inputs.capability_id) || null,
    tool_id: (safe.inputs && safe.inputs.tool_id) || null,
    completion_state: safe.completion_state || null,
    tool_status: (isPlainObject(safe.outputs) && safe.outputs.status) || null,
    store_read_platform: platform,
    real_store_data: Boolean(platform) && hasRecords(safe.outputs),
    reused_from_run_id: reused ? reused.run_id || null : null,
    produced_at: reused && typeof reused.produced_at === 'string' ? reused.produced_at : null,
  };
}

function oldestTimestamp(values, fallback) {
  let oldest = fallback;
  for (const value of values) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) < Date.parse(oldest)) oldest = value;
  }
  return oldest;
}

// Describes what one Chief run record holds. Never throws: an unreadable result is described as
// not authoritative, with the reason.
function describeResearchProvenance({
  runResult,
  runId = null,
  sessionId = null,
  businessId = null,
  storeReference = null,
  recordedAt = new Date().toISOString(),
} = {}) {
  // Required lazily: ownerRunView reaches the approval and verification layers, which a caller
  // that only needs continuity decisions never loads.
  const { describeChiefResultForOwner } = require('./ownerRunView');
  const result = isPlainObject(runResult) ? runResult : {};
  const plan = asArray(result.routing && result.routing.plan);
  const steps = plan.map(describeStep);
  let owner;
  try {
    owner = describeChiefResultForOwner({ result });
  } catch (err) {
    owner = { status: 'failed', mutations: [], specialists_used: [] };
  }
  const platforms = [...new Set(steps.map((step) => step.store_read_platform).filter(Boolean))];
  const pendingApprovals = asArray(result.pending_approvals).filter((request) => isPlainObject(request) && request.status === 'pending').length;
  const realStoreData = steps.some((step) => step.real_store_data);

  const reasons = [];
  if (owner.status !== 'success') reasons.push(`The run's outcome was '${owner.status}', not a completed success.`);
  if (!realStoreData) reasons.push('No step returned real store records.');
  if (platforms.length !== 1) reasons.push(platforms.length === 0 ? 'No store platform was read.' : 'More than one store platform was read.');
  if (!storeReference) reasons.push('The connected store could not be identified when this run was saved.');
  if (pendingApprovals > 0) reasons.push('Approvals were still pending.');
  if (asArray(owner.mutations).length > 0) reasons.push('The run changed store data.');

  const specialists = [];
  for (const step of steps) {
    if (step.specialist_id && !specialists.some((entry) => entry.id === step.specialist_id)) {
      specialists.push({ id: step.specialist_id, title: step.specialist_title });
    }
  }

  return {
    version: RESEARCH_CONTEXT_VERSION,
    run_id: runId,
    session_id: sessionId,
    business_id: tenantOf(businessId),
    platform: platforms.length === 1 ? platforms[0] : null,
    store_reference: storeReference || null,
    produced_at: oldestTimestamp(steps.map((step) => step.produced_at), recordedAt),
    recorded_at: recordedAt,
    outcome: owner.status,
    specialists,
    analysed: steps,
    real_store_data: realStoreData,
    pending_approvals: pendingApprovals,
    store_changes: asArray(owner.mutations).length,
    authoritative: reasons.length === 0,
    not_authoritative_reasons: reasons,
  };
}

// The newest completed, authoritative, fresh research for this business's connected store.
// `considered` counts only same-business, same-store records that were passed over, so the
// caller can say WHY nothing was reused without describing anyone else's data.
function findReusableResearch({
  businessId = null,
  storeReference = null,
  platform = BASIS_PLATFORM,
  now = Date.now(),
  maxAgeHours = getResearchMaxAgeHours(),
  storeDir = undefined,
  scanLimit = RETRIEVAL_SCAN_LIMIT,
} = {}) {
  const considered = { stale: 0, newest_stale_produced_at: null, not_authoritative: 0, incomplete: 0 };
  if (!storeReference) return { research: null, considered };
  const tenant = tenantOf(businessId);
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const storeOptions = storeDir ? { storeDir } : undefined;

  for (const summary of runHistoryStore.listRunRecordSummaries({ limit: scanLimit, ...(storeOptions || {}) })) {
    if (summary.kind !== 'orchestrate' || (summary.business_id || null) !== tenant) continue;
    const record = runHistoryStore.getRunRecordById(summary.run_id, storeOptions);
    if (!isPlainObject(record) || (record.business_id || null) !== tenant) continue;
    const stamp = isPlainObject(record.research_context) ? record.research_context : null;
    if (!stamp || stamp.version !== RESEARCH_CONTEXT_VERSION) continue;
    if (stamp.business_id !== tenant || stamp.store_reference !== storeReference || stamp.platform !== platform) continue;

    const verified = describeResearchProvenance({
      runResult: record.result,
      runId: record.run_id,
      sessionId: record.session_id || null,
      businessId: tenant,
      storeReference: stamp.store_reference,
      recordedAt: typeof stamp.recorded_at === 'string' ? stamp.recorded_at : record.created_at,
    });
    const producedMs = Date.parse(verified.produced_at);
    if (!verified.authoritative || verified.platform !== platform || !Number.isFinite(producedMs) || producedMs - now > MAX_CLOCK_SKEW_MS) {
      considered.not_authoritative += 1;
      continue;
    }
    const steps = asArray(record.result && record.result.routing && record.result.routing.plan);
    if (!coversResearchBasis(steps)) {
      considered.incomplete += 1;
      continue;
    }
    const ageMs = Math.max(0, now - producedMs);
    if (ageMs > maxAgeMs) {
      considered.stale += 1;
      if (!considered.newest_stale_produced_at) considered.newest_stale_produced_at = verified.produced_at;
      continue;
    }
    return {
      research: {
        run_id: record.run_id,
        session_id: record.session_id || null,
        produced_at: verified.produced_at,
        age_ms: ageMs,
        provenance: verified,
        steps,
      },
      considered,
    };
  }
  return { research: null, considered };
}

// What a session turn hands the Chief: the connected store's identity, the reusable research for
// it (or null), and why older research was passed over.
function lookupResearchContext({ businessId = null, now = Date.now(), storeDir = undefined } = {}) {
  const platform = BASIS_PLATFORM;
  const storeReference = currentStoreReference({ businessId, platform });
  const maxAgeHours = getResearchMaxAgeHours();
  const { research, considered } = findReusableResearch({ businessId, storeReference, platform, now, maxAgeHours, storeDir });
  return {
    business_id: tenantOf(businessId),
    platform,
    store_reference: storeReference,
    freshness_limit_hours: maxAgeHours,
    research,
    considered,
  };
}

// Whether an objective CONTINUES earlier research, decided by the Chief from what the objective
// asks - never from a session's numbering. It must refer to prior work (objectiveInterpretation.js
// referencesPriorWork - grammatical, not a subject list), request no change and no unsupported
// action or platform, and name no connected platform other than the research basis's own.
function decideResearchContinuity({ objective, routingResult = null, researchContext = null } = {}) {
  if (!isPlainObject(researchContext)) return { applies: false, reason: 'No research context was supplied for this run.' };
  const text = typeof objective === 'string' ? objective : '';
  if (!referencesPriorWork(text)) return { applies: false, reason: 'The objective does not refer to earlier research.' };
  if (hasExplicitMutationIntent(text)) return { applies: false, reason: 'The objective asks for a store change, which is never answered from prior research.' };
  const routing = isPlainObject(routingResult) ? routingResult : {};
  if (routing.interpretation_blocked) return { applies: false, reason: 'The objective contains a request this system does not support.' };
  if (routing.status === 'clarification_required' && routing.clarification_type !== 'unmatched') {
    return { applies: false, reason: 'The objective needs clarification before it can be answered.' };
  }
  if (asArray(routing.interpretation).some((entry) => isPlainObject(entry) && CONTINUATION_BLOCKING_ACTS.has(entry.act))) {
    return { applies: false, reason: 'The objective asks for a change or an unsupported action.' };
  }
  const platform = researchContext.platform || BASIS_PLATFORM;
  const otherPlatform = tokens(text).map((token) => token.lower).find((word) => isConnectedPlatformName(word) && word !== platform);
  if (otherPlatform) return { applies: false, reason: `The objective is about ${otherPlatform}, not the ${platform} research basis.` };
  return {
    applies: true,
    platform,
    research: isPlainObject(researchContext.research) && asArray(researchContext.research.steps).length > 0 ? researchContext.research : null,
    considered: isPlainObject(researchContext.considered) ? researchContext.considered : {},
    freshness_limit_hours: researchContext.freshness_limit_hours || getResearchMaxAgeHours(),
  };
}

module.exports = {
  RESEARCH_CONTEXT_VERSION,
  DEFAULT_MAX_AGE_HOURS,
  STORE_RESEARCH_BASIS,
  getResearchMaxAgeHours,
  storeReferenceFor,
  currentStoreReference,
  describeResearchProvenance,
  findReusableResearch,
  lookupResearchContext,
  decideResearchContinuity,
};
