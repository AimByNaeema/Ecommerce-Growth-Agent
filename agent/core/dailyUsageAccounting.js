'use strict';

// The cross-run half of the budget question: how much has ONE business already spent
// TODAY, across every run it has made? agent/core/usageLimits.js and
// agent/core/tokenControls.js both answer only "how much has THIS run spent", and a
// per-run ceiling cannot bound a day - an agent free to start runs could spend the
// per-run budget again on every one of them and never trip a single check.
//
// NOT A SECOND ACCOUNTING SYSTEM - THIS IS A READ. Nothing here counts, meters, or
// records anything: usage/usageTracker.js already writes a real usage ledger per run and
// agent/core/runHistoryStore.js already persists its summary into the saved run record.
// This module sums what those two already produced, from the same `result.usage_summary`
// field path server.js's buildAiUsage() reads, using runHistoryStore's own two reader
// functions rather than reimplementing them. No new store, no new file format, no
// database, no new dependency.
//
// NOTHING IS ESTIMATED, AND NO COST IS PRODUCED. Every number returned was written by a
// real model call. This project has no price table anywhere (see usage/usageRecordModel.js
// and server.js's buildAiUsage, which refuses to invent one), so the budget this feeds is
// denominated in tokens and run counts - never money.
//
// THE TOTAL IS A FLOOR, NOT A COMPLETE ACCOUNTING - AND SAYS SO. Only the orchestration
// endpoints thread a usage ledger into what they save today, so a run that recorded no
// usage contributes zero and the real day's spend can exceed the measured one. That is
// reported honestly in `runs_counted` vs `runs_with_usage` (and in `scan_limit_reached`)
// rather than hidden behind a confident-looking number. A floor is still load-bearing:
// it can only ever under-report, so a budget it says is exhausted genuinely is.
//
// BUSINESS ISOLATION IS ENFORCED TWICE. listRunRecordSummaries already filters by
// business_id, and every summary is filtered again here against the exact requested id.
// The second filter is not redundant: the store applies no filter at all for the default
// (null) business, so without it a single-business deployment would sum every business's
// runs. One business can never consume another's budget, and can never even observe it.
//
// FAIL-CLOSED ON AN UNREADABLE STORE. "No runs yet" (the directory does not exist) is a
// legitimate measurement of zero. A directory that exists but cannot be listed is NOT -
// it is missing policy data, so `available` is false and agent/core/autonomyPolicy.js
// turns that into a BLOCK rather than reading it as a free budget.

const fs = require('fs');
const runHistoryStore = require('./runHistoryStore');

// How many saved runs are examined before the day is summed. Deliberately well above
// server.js's own HISTORY_SCAN_LIMIT of 500: this feeds a spend decision, so truncating
// the scan silently would under-report the day. When the scan does hit this cap the
// result says so (`scan_limit_reached`), so the number is known to be a floor.
const DEFAULT_SCAN_LIMIT = 1000;

// The UTC calendar day a timestamp falls in, as 'YYYY-MM-DD'. UTC, not local time, so a
// budget window never shifts with the host's timezone or with daylight saving - the same
// run belongs to the same day whichever machine reads it. Returns null for a missing or
// unparseable timestamp; such a record is counted as undated rather than silently
// assigned to today or to no day at all.
function utcDayKey(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// Normalizes a business id to exactly the value a saved run record carries in its own
// business_id field: a real trimmed id, or null for the default single-business case.
// Both the request and every record go through this, so the comparison below is exact
// and an empty string can never match a real business.
function normalizeBusinessId(businessId) {
  return typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
}

// Whether the run store can be read at all. A missing directory is genuinely "nothing
// saved yet" and reads as available-with-zero (the same treatment
// listRunRecordSummaries already gives it). Anything else - a permissions failure, a
// path that is a file, an I/O error - is an unreadable store, which must not be mistaken
// for an empty one.
function checkStoreReadable(storeDir) {
  let stats;
  try {
    stats = fs.statSync(storeDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { readable: true, empty: true, reason: null };
    return { readable: false, empty: false, reason: 'run_store_unreadable' };
  }
  if (!stats.isDirectory()) return { readable: false, empty: false, reason: 'run_store_not_a_directory' };
  try {
    fs.readdirSync(storeDir);
  } catch (err) {
    return { readable: false, empty: false, reason: 'run_store_unreadable' };
  }
  return { readable: true, empty: false, reason: null };
}

// Sums one business's usage for the UTC day containing `now`.
//
// `storeDir` is threaded through to both runHistoryStore readers rather than defaulted
// here, so a test points this at a temp directory the same way every other suite in this
// project does (RUN_HISTORY_STORE_DIR), and real usage always gets the real location.
function readDailyUsage({
  businessId = null,
  now = new Date(),
  storeDir = runHistoryStore.getDefaultStoreDir(),
  scanLimit = DEFAULT_SCAN_LIMIT,
} = {}) {
  const targetBusinessId = normalizeBusinessId(businessId);
  const day = utcDayKey(now);

  const empty = {
    available: false,
    unavailable_reason: null,
    day,
    business_id: targetBusinessId,
    runs_counted: 0,
    runs_with_usage: 0,
    runs_undated: 0,
    runs_missing_usage: 0,
    tokens_total: 0,
    model_calls: 0,
    tool_calls: 0,
    scan_limit_reached: false,
    // Whether every run counted for the day actually carried a usage ledger. When false,
    // tokens_total is a FLOOR and the true spend is unknown - see this file's header and
    // agent/core/autonomyPolicy.js's daily gate, which refuses to treat an unknown
    // remainder as available budget.
    coverage_complete: false,
  };

  // A caller with no usable clock has no day to sum, which is missing policy data - not
  // a zero-spend day. Fails closed.
  if (day === null) {
    return { ...empty, unavailable_reason: 'invalid_evaluation_time' };
  }

  const store = checkStoreReadable(storeDir);
  if (!store.readable) {
    return { ...empty, unavailable_reason: store.reason };
  }
  if (store.empty) {
    // No runs at all is complete coverage of nothing: the day's spend is genuinely zero,
    // and that is a measurement rather than an absence of one.
    return { ...empty, available: true, coverage_complete: true };
  }

  let summaries;
  try {
    summaries = runHistoryStore.listRunRecordSummaries({ limit: scanLimit, businessId: targetBusinessId, storeDir });
  } catch (err) {
    return { ...empty, unavailable_reason: 'run_store_unreadable' };
  }

  let runsCounted = 0;
  let runsWithUsage = 0;
  let runsMissingUsage = 0;
  let runsUndated = 0;
  let tokensTotal = 0;
  let modelCalls = 0;
  let toolCalls = 0;

  for (const summary of summaries) {
    if (!summary) continue;

    // The second, exact business filter - see this file's header. Applied before the day
    // filter so another business's record is never even dated, let alone summed.
    const recordBusinessId = normalizeBusinessId(summary.business_id);
    if (recordBusinessId !== targetBusinessId) continue;

    const recordDay = utcDayKey(summary.created_at);
    if (recordDay === null) {
      runsUndated += 1;
      continue;
    }
    if (recordDay !== day) continue;

    runsCounted += 1;

    // The full record carries the usage ledger summary; the list summary deliberately
    // does not (it is a dashboard row). Same two-step read server.js already performs.
    const record = runHistoryStore.getRunRecordById(summary.run_id, { storeDir });
    const usageSummary = record && record.result && record.result.usage_summary;
    if (!usageSummary || typeof usageSummary !== 'object' || !usageSummary.by_category) {
      // COUNTED, AND COUNTED AS UNKNOWN. A run that recorded no usage ledger contributes no
      // tokens - but it is never silently treated as a run that cost nothing. It is tallied
      // here so coverage_complete below can report that the day's total is a floor.
      runsMissingUsage += 1;
      continue;
    }

    runsWithUsage += 1;

    // A usage_summary that is PRESENT but whose model_call totals are malformed is not a
    // zero-cost run either - it is a run whose cost cannot be read. Counted as missing so
    // it lowers coverage rather than quietly contributing nothing.
    const model = usageSummary.by_category.model_call;
    const modelTokensReadable = model && typeof model === 'object' && Number.isFinite(model.tokens_total);
    if (modelTokensReadable) {
      tokensTotal += model.tokens_total;
      if (Number.isFinite(model.count)) modelCalls += model.count;
    } else {
      runsWithUsage -= 1;
      runsMissingUsage += 1;
    }
    const tool = usageSummary.by_category.tool_call;
    if (tool && typeof tool === 'object' && Number.isFinite(tool.count)) toolCalls += tool.count;
  }

  return {
    available: true,
    unavailable_reason: null,
    day,
    business_id: targetBusinessId,
    runs_counted: runsCounted,
    runs_with_usage: runsWithUsage,
    runs_undated: runsUndated,
    runs_missing_usage: runsMissingUsage,
    tokens_total: tokensTotal,
    model_calls: modelCalls,
    tool_calls: toolCalls,
    // Complete only when every run counted for the day carried a readable usage ledger AND
    // the scan reached every run. Anything else means tokens_total is a floor.
    coverage_complete: runsMissingUsage === 0 && summaries.length < scanLimit,
    // The scan hit its cap, so older runs from the same day were not examined and every
    // total above is known to be a floor. Surfaced, never silently absorbed.
    scan_limit_reached: summaries.length >= scanLimit,
  };
}

module.exports = {
  DEFAULT_SCAN_LIMIT,
  utcDayKey,
  normalizeBusinessId,
  readDailyUsage,
};

if (require.main === module) {
  console.log("Smart E-Commerce Growth AI Agent - daily (cross-run) usage accounting:\n");
  console.log('Reads what usage/usageTracker.js already wrote into saved runs. It counts nothing of its own.\n');

  const os = require('os');
  const path = require('path');
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-usage-demo-'));
  const today = new Date().toISOString();

  const demoRun = (runId, businessId, tokens) => ({
    run_id: runId,
    business_id: businessId,
    kind: 'orchestrate',
    status: 'success',
    created_at: today,
    result: {
      usage_summary: {
        by_category: {
          model_call: { count: 1, tokens_input: 0, tokens_output: tokens, tokens_total: tokens },
          tool_call: { count: 2 },
        },
      },
    },
  });

  runHistoryStore.saveRunRecord(demoRun('demo-a-1', 'acme-store', 1200), { storeDir: demoDir });
  runHistoryStore.saveRunRecord(demoRun('demo-a-2', 'acme-store', 800), { storeDir: demoDir });
  runHistoryStore.saveRunRecord(demoRun('demo-b-1', 'other-store', 50000), { storeDir: demoDir });
  // A saved run that recorded no usage ledger - counted as a run, contributes no tokens.
  runHistoryStore.saveRunRecord(
    { run_id: 'demo-a-3', business_id: 'acme-store', status: 'success', created_at: today, result: {} },
    { storeDir: demoDir }
  );

  console.log("acme-store today:");
  console.log(JSON.stringify(readDailyUsage({ businessId: 'acme-store', storeDir: demoDir }), null, 2));
  console.log("\nother-store today - note acme-store's 2000 tokens are nowhere in this:");
  console.log(JSON.stringify(readDailyUsage({ businessId: 'other-store', storeDir: demoDir }), null, 2));
  console.log('\nAn unreadable store is NOT an empty one:');
  console.log(JSON.stringify(readDailyUsage({ businessId: 'acme-store', storeDir: path.join(demoDir, 'demo-a-1.json') }), null, 2));

  fs.rmSync(demoDir, { recursive: true, force: true });
}
