'use strict';

// The schema for ONE durable memory record - the persisted, cross-run counterpart to
// agent/core/stateModel.js's per-task state and agent/core/memoryRules.js's rules for
// what's worth saving. This is not a new vocabulary: a record's `priority_id` is
// exactly one of agent/core/memoryRules.js's MEMORY_PRIORITIES ids (reused, never
// duplicated - CLAUDE.md rule 4), and its verification gate reuses
// agent/core/stateModel.js's own VERIFICATION_STATUSES enum plus
// approvals/approvalWorkflow.js's existing 'approved' decision outcome - no new
// pass/fail vocabulary is invented here.
//
// SCOPE (explicitly bounded for this build): schema + validation only, pure functions
// with no side effects - exactly like agent/core/stateModel.js's own
// createEmptyState()/validateStateShape(). Storage and business isolation live in
// agent/core/memoryStore.js. Nothing here is wired into any specialist's or the
// orchestrator's decision path - agent behavior is unchanged by this file existing.
// No vector/semantic retrieval - this is a structured record shape only.

const { VERIFICATION_STATUSES } = require('./stateModel');
const { MEMORY_PRIORITIES } = require('./memoryRules');
const { isValidBusinessId } = require('../../configuration/businessRegistry');

const MEMORY_PRIORITY_IDS = MEMORY_PRIORITIES.map((priority) => priority.id);

// Enforces memoryRules.js's "compact" quality - "a summary or reference, never a
// raw/verbatim dump" - with a concrete ceiling instead of leaving that as a
// documentation-only intent. In the same range as this project's other real brevity
// ceilings (e.g. tools/webCompetitorResearchTool.js's own per-field limits).
const MAX_SUMMARY_LENGTH = 600;

// Looks up the agent/core/stateModel.js field a given memory priority maps to (or
// undefined for an unknown priority, null for 'useful_historical_context' - which
// memoryRules.js itself documents as spanning no single field). Reused directly from
// MEMORY_PRIORITIES, never a second copy of this mapping.
function stateFieldForPriority(priorityId) {
  const priority = MEMORY_PRIORITIES.find((entry) => entry.id === priorityId);
  return priority ? priority.stateField : undefined;
}

// Builds one memory record from caller-supplied fields. Fills in only what's purely
// mechanical (state_field lookup, a created_at default) - business_id, summary,
// verification, and approval must always come from the caller's own real,
// already-produced result. This function never guesses or fabricates any of those; a
// caller with nothing verified yet should not call this at all.
function createMemoryRecord({
  id,
  businessId,
  priorityId,
  summary,
  source = null,
  verificationStatus = 'unverified',
  approval = null,
  createdAt = new Date().toISOString(),
}) {
  return {
    id: id || null,
    business_id: businessId || null,
    priority_id: priorityId || null,
    state_field: stateFieldForPriority(priorityId),
    summary: summary === undefined ? null : summary,
    source,
    verification_status: verificationStatus,
    approval,
    created_at: createdAt,
  };
}

// Returns { valid, errors } - never throws, never guesses a fix, mirroring
// agent/core/stateModel.js's validateStateShape's own report-only convention.
//
// THE VERIFIED/APPROVED GATE: a record is only valid when EITHER its
// verification_status is 'passed' (agent/core/stateModel.js's own
// VERIFICATION_STATUSES - the same bar agent/core/executionState.js already holds a
// tool result to) OR it carries a real approval reference whose status is 'approved'
// (approvals/approvalWorkflow.js's own decision lifecycle). Never on the strength of
// an 'unverified'/'failed' state or a 'pending'/'rejected' approval. This is the
// concrete mechanism behind "save only verified/approved reusable facts and findings" -
// enforced at the schema boundary, not left as a documentation-only convention. See
// agent/core/memoryStore.js's saveMemoryRecord, which re-checks this same gate again
// immediately before ever writing to disk.
function validateMemoryRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  if (typeof record.id !== 'string' || !record.id.trim()) {
    errors.push('id must be a non-empty string');
  }

  if (!isValidBusinessId(record.business_id)) {
    errors.push('business_id must be a valid business id (see configuration/businessRegistry.js)');
  }

  if (!MEMORY_PRIORITY_IDS.includes(record.priority_id)) {
    errors.push(`priority_id must be one of: ${MEMORY_PRIORITY_IDS.join(', ')} (see agent/core/memoryRules.js)`);
  }

  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string (a compact summary, never a raw dump)');
  } else if (record.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push(`summary must be at most ${MAX_SUMMARY_LENGTH} characters (memoryRules.js's "compact" quality)`);
  }

  if (record.source !== null && record.source !== undefined && (typeof record.source !== 'object' || Array.isArray(record.source))) {
    errors.push('source must be null or a plain object reference (e.g. { run_id, tool_id }) - never a raw dump');
  }

  if (record.verification_status !== undefined && !VERIFICATION_STATUSES.includes(record.verification_status)) {
    errors.push(`verification_status must be one of: ${VERIFICATION_STATUSES.join(', ')}`);
  }

  const hasPassedVerification = record.verification_status === 'passed';
  const hasApproval =
    !!record.approval && typeof record.approval === 'object' && record.approval.status === 'approved';

  if (!hasPassedVerification && !hasApproval) {
    errors.push(
      "a memory record must be either verified (verification_status: 'passed') or approved " +
        "(approval.status: 'approved') - unverified findings are never saved to durable memory"
    );
  }

  if (typeof record.created_at !== 'string' || Number.isNaN(Date.parse(record.created_at))) {
    errors.push('created_at must be a valid ISO date string');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  MEMORY_PRIORITY_IDS,
  MAX_SUMMARY_LENGTH,
  stateFieldForPriority,
  createMemoryRecord,
  validateMemoryRecord,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - memory record schema (schema + validation only):\n');

  const verified = createMemoryRecord({
    id: 'mem-1',
    businessId: 'demo-business',
    priorityId: 'reusable_findings',
    summary: 'Competitor "Acme Bundles" consistently prices SVG bundles 15-20% below us.',
    source: { run_id: 'orch-demo', tool_id: 'live_competitor_research', capability_id: 'competitor_research' },
    verificationStatus: 'passed',
  });
  console.log('Verified finding:', JSON.stringify(verified, null, 2));
  console.log('Validates:', JSON.stringify(validateMemoryRecord(verified)));

  const unverified = createMemoryRecord({
    id: 'mem-2',
    businessId: 'demo-business',
    priorityId: 'reusable_findings',
    summary: 'An unverified guess that must never become memory.',
  });
  console.log('\nUnverified record is rejected:', JSON.stringify(validateMemoryRecord(unverified)));
}
