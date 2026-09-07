'use strict';

// Wires agent/core/memoryStore.js's business-isolated Memory layer into the Chief
// Orchestrator's own run flow (agent/core/orchestratorExecutionContract.js's
// runOrchestratorContract/buildPlanStep) - the connection agent/core/memoryStore.js's
// own header explicitly deferred to "a later, separately-scoped change".
//
// SCOPE (explicit, per this build's own instructions):
//   - RETRIEVAL: before a run, fetch only this business's own already-verified/
//     approved memory records and hand them to buildPlanStep as one more additive,
//     read-only context source - exactly like agent/core/orchestratorExecutionContract.js's
//     existing deriveBusinessConfigContext/deriveCrossAgentContext. Never a required
//     field, never something a tool's own logic depends on existing.
//   - PERSISTENCE: after a specialist step completes with verification_status
//     'passed' (agent/core/stateModel.js's own enum - the exact bar every other
//     verified/approved gate in this project already uses), save a compact record of
//     it through agent/core/memoryStore.js's own saveMemoryRecord - never a second,
//     parallel writer, and never anything that can fail the run it's attached to.
//   - NO AGENT PROMPT CHANGES: nothing here touches agent/core/claudeClient.js or any
//     tool's own prompt-construction text. Retrieved memory is handed to tools as one
//     more plain data field (`relevant_memory`) on research_params - whether/how a
//     tool actually reads that field is separate, not-yet-scoped work.
//   - NO VECTOR/SEMANTIC SEARCH: retrieval is exact-match only - scoped to one
//     business and (when the caller knows it) to the current task's own capability id,
//     newest first, capped - reusing agent/core/memoryStore.js's listMemoryRecords()
//     and its plain string filters. No embedding, no similarity, no ranking model.
//   - NO NEW MEMORY CATEGORIES: every record still uses one of
//     agent/core/memoryRules.js's existing MEMORY_PRIORITIES ids
//     (agent/core/memoryRecordModel.js's own MEMORY_PRIORITY_IDS) - this file adds no
//     new vocabulary of its own.
//
// BUSINESS ISOLATION: every function below requires a real, valid businessId
// (configuration/businessRegistry.js's isValidBusinessId) and is a documented no-op
// otherwise. Omitting businessId reproduces today's exact single-business server.js
// behavior (no memory retrieval, no memory writes) - the same optional-businessId
// convention configuration/businessRegistry.js's own header already documents for
// every other business-scoped feature in this project. This is not a workaround: a
// null/invalid businessId has no business-isolated memory directory to read or write
// at all (see agent/core/memoryStore.js's getBusinessMemoryDir) - skipping is the only
// honest behavior, not a shortcut.

const { isValidBusinessId } = require('../../configuration/businessRegistry');
const { listMemoryRecords, saveMemoryRecord } = require('./memoryStore');
const { createMemoryRecord, validateMemoryRecord } = require('./memoryRecordModel');

// Bounds how much memory context one run ever carries - memoryRules.js's own
// "compact" quality, never a full dump of everything ever saved for this business.
// listMemoryRecords already returns newest-first, so the most recently confirmed
// facts are the ones that survive this cap.
const MAX_RELEVANT_MEMORY_RECORDS = 10;

// Retrieves this business's own memory records and hands them back as one additive
// context object, shaped to merge via agent/core/crossAgentContext.js's mergeContext
// exactly like every other derive*Context helper in
// agent/core/orchestratorExecutionContract.js. Returns {} - the same "nothing to
// merge" shape those helpers already return - for a missing/invalid businessId or a
// business with nothing saved yet; never throws.
//
// Every record already passed agent/core/memoryRecordModel.js's verified/approved
// gate once, at save time (see agent/core/memoryStore.js's saveMemoryRecord) - but
// this re-validates each one anyway before it can reach a live run. That is
// deliberate defense in depth, the read-side counterpart to the write-side
// re-validation saveMemoryRecord already does: a hand-edited or otherwise corrupted
// record on disk must never be trusted into a run's context just because it was found
// in the right file.
//
// "Relevant" here means exactly what this schema supports without vector/semantic
// search or a new categorization rule, and it is scoped on BOTH axes the project's own
// requirements name:
//
//   BY BUSINESS - this one business only, never another's (agent/core/
//   contextBoundaries.js's memory_context boundary, agent/core/memoryRules.js's `safe`
//   quality). This has always been enforced here.
//
//   BY TASK - `capabilityId`, when supplied, is the current step's capability id, and
//   the records this exact capability produced before come FIRST. That is the other
//   half of memoryRules.js's `retrievable` quality ("looked up by business and task
//   without scanning everything") and of memory_context's own wording ("relevant to
//   the current task and business"), which business-only retrieval satisfied for the
//   business and not for the task: a run about listing content was handed whatever
//   happened to be this business's 10 newest memories, whichever capability produced
//   them. The match is an exact string comparison on the record's own already-persisted
//   source.capability_id (see memoryStore.js's listMemoryRecords) - no embedding, no
//   similarity scoring, no new categorization vocabulary.
//
// TASK-FIRST, NOT TASK-ONLY. The remaining budget is filled with this business's other
// newest records, de-duplicated by record id. A hard task filter was rejected on
// purpose: it would hand back nothing at all the first time a capability runs for a
// business (strictly worse than today), and it would drop exactly the cross-task
// patterns memoryRules.js's `useful_historical_context` priority exists to keep. So
// this never returns less than the business-only behavior did - it reorders what a run
// sees so the current task's own history is what survives the cap.
//
// Omitting capabilityId reproduces the previous behavior exactly: business-scoped,
// newest first, capped.
function getRelevantMemoryContext(businessId, { capabilityId = null, limit = MAX_RELEVANT_MEMORY_RECORDS } = {}) {
  if (!isValidBusinessId(businessId)) return {};

  const isUsable = (record) => validateMemoryRecord(record).valid;
  const taskScoped =
    typeof capabilityId === 'string' && capabilityId.trim()
      ? listMemoryRecords(businessId, { capabilityId: capabilityId.trim(), limit }).filter(isUsable)
      : [];

  const records = [...taskScoped];
  const seenIds = new Set(taskScoped.map((record) => record.id));
  if (records.length < limit) {
    for (const record of listMemoryRecords(businessId, { limit })) {
      if (records.length >= limit) break;
      if (seenIds.has(record.id) || !isUsable(record)) continue;
      seenIds.add(record.id);
      records.push(record);
    }
  }
  if (records.length === 0) return {};

  // Compact projection only (memoryRules.js's "compact" quality) - a summary, its
  // category/date, and the capability that produced it, never the record's full
  // internal shape (id/approval and the rest of `source` are this layer's own
  // bookkeeping, not something a tool needs to see). capability_id is included because
  // it is the task key this retrieval now scopes on: without it a memory from a
  // different capability would read as if it belonged to the current task, which is
  // exactly the kind of unstated assumption CLAUDE.md rule 8 forbids. It is null for a
  // record saved without a source.
  return {
    relevant_memory: records.map((record) => ({
      priority_id: record.priority_id,
      capability_id: (record.source && record.source.capability_id) || null,
      summary: record.summary,
      created_at: record.created_at,
    })),
  };
}

// Persists ONE specialist step's real, already-verified result as a reusable memory
// record - the write-side counterpart to getRelevantMemoryContext above. Silently
// does nothing (returns null) for anything that is not a valid, business-scoped,
// verified/approved candidate - this is a best-effort save, and must never be able to
// fail the run it's attached to, mirroring server.js's own
// runHistoryStore.saveRunRecord try/catch discipline (a memory save is never allowed
// to fail the real result the caller is waiting on).
function persistVerifiedFinding({
  businessId,
  id,
  priorityId,
  summary,
  source = null,
  verificationStatus = 'unverified',
  approval = null,
}) {
  if (!isValidBusinessId(businessId)) return null;
  if (typeof summary !== 'string' || !summary.trim()) return null;

  let record;
  try {
    record = createMemoryRecord({ id, businessId, priorityId, summary, source, verificationStatus, approval });
    return saveMemoryRecord(record);
  } catch (err) {
    // saveMemoryRecord re-validates the full record (schema + the verified/approved
    // gate) and throws with the specific reason on failure - a caller-side mistake
    // (e.g. summary too long, or this really wasn't verified/approved after all) is a
    // reason to skip saving, never a reason to fail the specialist step itself.
    console.error('Could not persist memory record:', err.message);
    return null;
  }
}

module.exports = {
  MAX_RELEVANT_MEMORY_RECORDS,
  getRelevantMemoryContext,
  persistVerifiedFinding,
};

if (require.main === module) {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  console.log('Smart E-Commerce Growth AI Agent - Memory <-> Chief Orchestrator context wiring:\n');

  const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-context-retrieval-demo-'));
  process.env.MEMORY_STORE_DIR = demoRoot;

  console.log('No businessId -> retrieval is a no-op:', JSON.stringify(getRelevantMemoryContext(null)));

  const saved = persistVerifiedFinding({
    businessId: 'demo-business',
    id: 'mem-demo-1',
    priorityId: 'reusable_findings',
    summary: 'Competitor "Acme Bundles" consistently prices SVG bundles 15-20% below us.',
    source: { run_id: 'run-demo-1', tool_id: 'live_competitor_research', capability_id: 'competitor_research' },
    verificationStatus: 'passed',
  });
  console.log('\nPersisted a verified finding:', JSON.stringify(saved, null, 2));

  console.log('\nA later run for the same business retrieves it as context:');
  console.log(JSON.stringify(getRelevantMemoryContext('demo-business'), null, 2));

  const skipped = persistVerifiedFinding({
    businessId: 'demo-business',
    id: 'mem-demo-2',
    priorityId: 'reusable_findings',
    summary: 'An unverified guess that must never become memory.',
    verificationStatus: 'unverified',
  });
  console.log('\nAn unverified finding is never persisted (returns null):', skipped);

  delete process.env.MEMORY_STORE_DIR;
  fs.rmSync(demoRoot, { recursive: true, force: true });
}
