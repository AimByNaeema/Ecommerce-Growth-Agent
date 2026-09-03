'use strict';

// Persisted run history: the first real storage mechanism this project has ever
// written to disk (memory/state/README.md and data/README.md both previously said
// "no storage mechanism (file format, database) has been chosen yet" - this module is
// that explicit, user-requested decision, scoped narrowly to one concern: let a
// dashboard result (public/index.html's "Run a Specialist" and "Chief Orchestrator"
// pages, via server.js's /run and /orchestrate) survive a page refresh or a server
// restart, instead of living only in the browser tab's in-memory JS state as it did
// before. This does NOT touch or replace agent/core/toolResultCache.js (a per-run,
// in-memory cache of tool calls WITHIN a single run - a completely different concern)
// or agent/core/stateModel.js/memoryRules.js (the shape/rules for a future richer
// agent memory - still not built).
//
// Deliberately the smallest sufficient storage mechanism (CLAUDE.md rule 15: no
// premature technical decisions) - one JSON file per run under memory/state/runs/,
// no new npm dependency, no database engine. This project is a single local Node
// process serving one dashboard for one business today; a real DB/engine can replace
// this module later (same three exported functions, same call sites in server.js)
// without that later decision being forced now. One file per run also means a single
// corrupt/unreadable file can never take down reading every other run (see
// listRunRecordSummaries below) - each record is independent.
//
// Every record is real, user-triggered run output (server.js builds it from an actual
// buildPlanStep/runOrchestratorContract result) - this module itself never invents,
// summarizes, or alters a record's content; it only writes/reads exactly what it was
// given. Business data (objectives, competitor/product/analytics findings) belongs
// here the same way memory/state/README.md already reserves this folder for - never
// committed (see .gitignore's memory/state/runs/ rule, added alongside this module).

const fs = require('fs');
const path = require('path');

// Overridable so tests (verification/testing/runHistoryStore.test.js,
// verification/testing/server.test.js, verification/testing/orchestratorEndpoints.test.js)
// never write real files into this project's own memory/state/runs/ folder - the same
// env-override convention agent/core/tokenControls.js and agent/core/networkRetry.js
// already use, read at call time (never memoized at module load) so a test can set it
// before its first request. Real server.js usage never sets this - it always gets the
// real, documented location.
function getDefaultStoreDir() {
  return process.env.RUN_HISTORY_STORE_DIR
    ? path.resolve(process.env.RUN_HISTORY_STORE_DIR)
    : path.join(__dirname, '..', '..', 'memory', 'state', 'runs');
}

function ensureStoreDir(storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
}

// runId always originates from a server-generated id (server.js's own `orch-...`/
// specialist-run ids) or a test's literal string - never raw user text - but this is
// still defensive: strips anything that isn't a safe filename character so a record id
// can never be read/written outside storeDir (no path traversal via '..' or '/').
function safeRunId(runId) {
  return typeof runId === 'string' ? runId.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

function runRecordFilePath(storeDir, runId) {
  return path.join(storeDir, `${safeRunId(runId)}.json`);
}

// Writes one run record, keyed by its own run_id - a later save with the same run_id
// (e.g. /orchestrate/approve revising a step after a human decision) overwrites the
// prior file, so a run's saved record always reflects its latest known state, never
// two conflicting copies. Throws only for genuinely invalid input (CLAUDE.md rule 8 -
// never guess); a filesystem-level failure (disk full, permissions) is also allowed to
// throw rather than silently pretending the save succeeded - callers (server.js) are
// expected to catch this the same way they already catch every other tool/executor
// error, never let it crash the request.
function saveRunRecord(record, { storeDir = getDefaultStoreDir() } = {}) {
  if (!record || typeof record !== 'object') {
    throw new Error('saveRunRecord requires a record object.');
  }
  const id = safeRunId(record.run_id);
  if (!id) {
    throw new Error('saveRunRecord requires a non-empty, filename-safe run_id.');
  }
  ensureStoreDir(storeDir);
  fs.writeFileSync(runRecordFilePath(storeDir, id), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

// Reads back exactly what was saved for one run id. Returns null - never throws - for
// a missing file, a corrupt/unparsable file, or an invalid id: this is a read path a
// dashboard calls with a user-supplied id from a URL, so "not found" and "unreadable"
// are both just as honest returned as null, never surfaced as a 500 from a corrupt
// single file.
function getRunRecordById(runId, { storeDir = getDefaultStoreDir() } = {}) {
  const id = safeRunId(runId);
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(runRecordFilePath(storeDir, id), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Lists every saved run as a small summary (never the full record - a dashboard list
// view needs only enough to render one row per run, not every step's full technical
// detail), newest first, capped at `limit`. A missing store directory (nothing saved
// yet) is an empty list, not an error - matches every other "genuinely nothing here
// yet" case in this codebase (e.g. agent/core/resultSummary.js's "empty" status).
// One unreadable/corrupt record file is skipped, never allowed to break the whole
// listing - see this module's own header comment on why one file per run.
function listRunRecordSummaries({ limit = 50, storeDir = getDefaultStoreDir() } = {}) {
  let fileNames;
  try {
    fileNames = fs.readdirSync(storeDir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }

  const summaries = [];
  for (const fileName of fileNames) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(storeDir, fileName), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    summaries.push({
      run_id: record.run_id || null,
      kind: record.kind || null,
      objective: record.objective || null,
      specialist_id: record.specialist_id || null,
      specialist_name: record.specialist_name || null,
      status: record.status || null,
      summary: record.summary || null,
      created_at: record.created_at || null,
      updated_at: record.updated_at || record.created_at || null,
    });
  }

  summaries.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  return summaries.slice(0, Math.max(0, limit));
}

module.exports = {
  getDefaultStoreDir,
  saveRunRecord,
  getRunRecordById,
  listRunRecordSummaries,
};

if (require.main === module) {
  const os = require('os');
  console.log('Smart E-Commerce Growth AI Agent - persisted run history store:\n');
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-demo-'));

  saveRunRecord(
    {
      run_id: 'demo-1',
      kind: 'run',
      objective: 'Summarize real research evidence on file.',
      specialist_id: 'research',
      specialist_name: 'Research',
      status: 'success',
      summary: 'Research found no evidence on file yet.',
      created_at: new Date().toISOString(),
      result: { example: true },
    },
    { storeDir: demoDir }
  );

  console.log('Saved and read back:', getRunRecordById('demo-1', { storeDir: demoDir }));
  console.log('Listing:', listRunRecordSummaries({ storeDir: demoDir }));
  console.log('Unknown id reads back null:', getRunRecordById('does-not-exist', { storeDir: demoDir }));
}
