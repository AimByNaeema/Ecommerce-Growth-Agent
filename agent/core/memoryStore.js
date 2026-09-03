'use strict';

// Durable, business-isolated storage for agent/core/memoryRecordModel.js records - the
// storage mechanism agent/core/stateModel.js and memory/state/README.md have both been
// waiting on ("no storage mechanism (file format, database) has been chosen yet").
//
// SCOPE (explicit, per this build's own instructions): schema + storage + business
// isolation + read/write APIs ONLY.
//   - NO agent/specialist/orchestrator behavior change: this module is not required by
//     agent/core/orchestratorExecutionContract.js, is not wired into TOOL_EXECUTORS,
//     routing, or any specialist's decision path, and is not exposed through server.js.
//     A later, separately-scoped change would do that; today, saving/reading memory is
//     something a caller must explicitly choose to do, exactly like
//     agent/core/runHistoryStore.js was before it was wired into server.js.
//   - NO vector/semantic memory: every read below is exact-match only (businessId +
//     optional priority_id filter) - no embeddings, no similarity ranking, no search.
//
// STORAGE SHAPE: one JSON file per record, under
// memory/state/business/<businessId>/records/<recordId>.json - the same "one file per
// unit, one corrupt file can never take down the rest" pattern
// agent/core/runHistoryStore.js already established and this project's test suite
// already trusts, parameterized by business the exact way
// configuration/businessRegistry.js already parameterizes business.yaml/.env by
// businessId. isValidBusinessId() is reused unchanged from that module - the same
// path-traversal guard, never a second copy of it (CLAUDE.md rule 4).
//
// BUSINESS ISOLATION: every function below takes an explicit businessId and only ever
// reads/writes that one business's own subdirectory. There is deliberately no
// "list every business's memory" function anywhere in this module - matching
// agent/core/contextBoundaries.js's own memory_context description ("not all memory
// across every business or session").
//
// VERIFIED/APPROVED ONLY: saveMemoryRecord re-validates with
// agent/core/memoryRecordModel.js's validateMemoryRecord() immediately before ever
// writing to disk - an unverified/unapproved record is refused here too, not only at
// whatever call site constructed it, so this module itself can never become the weak
// link that lets an unverified guess become "memory".

const fs = require('fs');
const path = require('path');
const { isValidBusinessId } = require('../../configuration/businessRegistry');
const { validateMemoryRecord } = require('./memoryRecordModel');

// Overridable the same way agent/core/runHistoryStore.js's RUN_HISTORY_STORE_DIR is -
// read at call time (never memoized at module load), so a test can set it before its
// first call and never write into this project's own memory/state/business/.
function getDefaultMemoryRootDir() {
  return process.env.MEMORY_STORE_DIR
    ? path.resolve(process.env.MEMORY_STORE_DIR)
    : path.join(__dirname, '..', '..', 'memory', 'state', 'business');
}

// Validates businessId and returns <rootDir>/<businessId>/records - never returns a
// path built from an invalid id (mirrors
// configuration/businessRegistry.js's getBusinessBasePath's own guard exactly).
function getBusinessMemoryDir(businessId, { rootDir = getDefaultMemoryRootDir() } = {}) {
  if (!isValidBusinessId(businessId)) {
    throw new Error(
      `Invalid businessId '${businessId}'. A businessId must start with a letter or digit and contain only ` +
        'letters, digits, hyphens, or underscores (see configuration/businessRegistry.js).'
    );
  }
  return path.join(rootDir, businessId, 'records');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// recordId always originates from a caller-generated id (mirroring
// agent/core/runHistoryStore.js's own run ids / approvals/approvalWorkflow.js's
// apr-<n> ids), never raw user text - but this is still defensive: strips anything
// that isn't a safe filename character so a record id can never read/write outside
// its own business's directory (no path traversal via '..' or '/').
function safeRecordId(id) {
  return typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

function recordFilePath(dir, id) {
  return path.join(dir, `${safeRecordId(id)}.json`);
}

// Saves one memory record. Re-validates the FULL record (schema + the
// verified/approved gate) before ever writing - throws with the specific reasons on
// failure (CLAUDE.md rule 8: never guess or silently drop). A later save with the same
// id overwrites the prior file, mirroring runHistoryStore.saveRunRecord's own
// overwrite-by-id semantics - a record always reflects its latest known state, never
// two conflicting copies.
function saveMemoryRecord(record, opts = {}) {
  const { valid, errors } = validateMemoryRecord(record);
  if (!valid) {
    throw new Error(`Cannot save memory record: ${errors.join('; ')}`);
  }
  const dir = getBusinessMemoryDir(record.business_id, opts);
  ensureDir(dir);
  fs.writeFileSync(recordFilePath(dir, record.id), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

// Reads one business's one record. Returns null - never throws - for a missing file, a
// corrupt/unparsable file, an invalid businessId, or an invalid recordId: this is a
// read path, and "not found", "unreadable", and "not a valid business" are all equally
// honest nulls, never a fabricated result or an uncaught exception.
function getMemoryRecordById(businessId, recordId, opts = {}) {
  let dir;
  try {
    dir = getBusinessMemoryDir(businessId, opts);
  } catch (err) {
    return null;
  }
  const id = safeRecordId(recordId);
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(recordFilePath(dir, id), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Lists ONE business's own records only - always scoped to a single, explicit
// businessId (see this module's own header on why there is no cross-business list).
// Optional priorityId filters to one agent/core/memoryRules.js MEMORY_PRIORITIES
// category. Newest first, capped at `limit`. A business with nothing saved yet (or an
// invalid businessId) is an empty list, not an error - matches
// agent/core/runHistoryStore.js's own "genuinely nothing here yet" convention. One
// corrupt record file is skipped, never breaking the rest of that business's own list.
function listMemoryRecords(businessId, { priorityId = null, limit = 100, ...opts } = {}) {
  let dir;
  try {
    dir = getBusinessMemoryDir(businessId, opts);
  } catch (err) {
    return [];
  }

  let fileNames;
  try {
    fileNames = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }

  const records = [];
  for (const fileName of fileNames) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (priorityId && record.priority_id !== priorityId) continue;
    records.push(record);
  }

  records.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  return records.slice(0, Math.max(0, limit));
}

// Removes one business's one record, if it exists. Returns true when a file was
// actually removed, false otherwise (missing file, invalid business/record id) - never
// throws for "already gone", the same honest-null convention as the read functions
// above.
function deleteMemoryRecord(businessId, recordId, opts = {}) {
  let dir;
  try {
    dir = getBusinessMemoryDir(businessId, opts);
  } catch (err) {
    return false;
  }
  const id = safeRecordId(recordId);
  if (!id) return false;
  try {
    fs.unlinkSync(recordFilePath(dir, id));
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  getDefaultMemoryRootDir,
  getBusinessMemoryDir,
  saveMemoryRecord,
  getMemoryRecordById,
  listMemoryRecords,
  deleteMemoryRecord,
};

if (require.main === module) {
  const os = require('os');
  const { createMemoryRecord } = require('./memoryRecordModel');
  console.log('Smart E-Commerce Growth AI Agent - business-isolated memory store:\n');
  const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-demo-'));

  const businessAFinding = createMemoryRecord({
    id: 'mem-1',
    businessId: 'business-a',
    priorityId: 'reusable_findings',
    summary: 'Competitor "Acme Bundles" consistently prices SVG bundles 15-20% below us.',
    verificationStatus: 'passed',
  });
  const businessBFinding = createMemoryRecord({
    id: 'mem-1',
    businessId: 'business-b',
    priorityId: 'reusable_findings',
    summary: "Business B's own, completely unrelated finding.",
    verificationStatus: 'passed',
  });

  saveMemoryRecord(businessAFinding, { rootDir: demoRoot });
  saveMemoryRecord(businessBFinding, { rootDir: demoRoot });

  console.log('business-a records:', listMemoryRecords('business-a', { rootDir: demoRoot }).map((r) => r.summary));
  console.log('business-b records:', listMemoryRecords('business-b', { rootDir: demoRoot }).map((r) => r.summary));
  console.log(
    '\nSame record id ("mem-1") in each business never collides - isolation confirmed by the two different summaries above.'
  );
}
