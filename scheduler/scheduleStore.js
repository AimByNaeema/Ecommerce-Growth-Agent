'use strict';

// Durable, business-isolated storage for scheduler/scheduleModel.js jobs, plus the
// claim-once guard that stops one occurrence being executed twice.
//
// Reuses this project's established persistence conventions rather than inventing any: one
// JSON file per record (agent/core/runHistoryStore.js), a per-business directory gated by
// isValidBusinessId (agent/core/memoryStore.js), atomic temp-file-then-rename writes and a
// credential-key refusal (approvals/approvalStore.js), and the claim-to-execute-once shape
// of approvals/approvalStore.js's claimApprovalForExecution. No database, no new dependency.
//
//   memory/state/schedules/<businessKey>/<jobId>.json
//
// DUPLICATE PREVENTION SURVIVES A RESTART BECAUSE THE CLAIM IS ON DISK, AND THE OCCURRENCE
// KEY IS DERIVED. scheduleModel.occurrenceKeyAt() computes which occurrence "now" belongs
// to from the schedule alone, so a process that restarts mid-cycle computes the SAME key
// the previous process did - and finds it already claimed. There is no in-memory "already
// ran" set to lose, and no timer whose loss would cause a re-run.
//
// THE CLAIM IS WRITTEN BEFORE THE WORK, NEVER AFTER. claimOccurrence() persists the claim
// and only then reports success. A crash between the claim and the work means that
// occurrence is skipped - which is the correct trade for a system whose jobs can reach real
// stores: a missed observation costs one cycle, a duplicated consequential action cannot be
// undone.
//
// BUSINESS ISOLATION IS STRUCTURAL. Each business's jobs live in their own directory and
// every read is scoped to exactly one of them - there is no listing across businesses that
// then filters, so there is nothing to get wrong. An invalid business id never becomes a
// path segment, and a job whose own business_id disagrees with the directory it was found
// in is not served.
//
// A CORRUPT JOB FAILS CLOSED AND IS CONTAINED. Unparseable or schema-invalid records read
// as absent - a job that cannot be validated is never run, which is the safe direction -
// and one bad file never prevents the others from loading.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const { isValidBusinessId } = require('../configuration/businessRegistry');
const { validateJobShape, occurrenceKeyAt, isDue } = require('./scheduleModel');

// The reserved directory name for the default single-business deployment. Starts with an
// underscore, which configuration/businessRegistry.js's BUSINESS_ID_PATTERN can never
// produce, so it cannot collide with a real business id.
const DEFAULT_BUSINESS_KEY = '_default';

const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

// Why a claim was refused. Machine-readable, matching the convention
// approvals/approvalStore.js's CLAIM_REFUSAL_REASONS and agent/core/autonomyPolicy.js's
// reason codes already follow.
const CLAIM_REFUSAL_REASONS = {
  not_found: 'No such job for this business.',
  disabled: 'That job is disabled, so it produces no occurrences.',
  invalid_schedule: 'That job\'s schedule cannot be computed, so it is never due.',
  not_due: 'That job has no unclaimed occurrence at or before this moment.',
  already_claimed: 'That occurrence has already been claimed - it is never executed twice.',
};

function getDefaultScheduleStoreDir() {
  return process.env.SCHEDULE_STORE_DIR
    ? path.resolve(process.env.SCHEDULE_STORE_DIR)
    : path.join(__dirname, '..', 'memory', 'state', 'schedules');
}

function businessKey(businessId) {
  return businessId === null || businessId === undefined || businessId === '' ? DEFAULT_BUSINESS_KEY : String(businessId);
}

function safeJobId(id) {
  return typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

// Resolves <root>/<businessKey>, or throws. Never builds a path from an unvalidated id.
function businessDir(businessId, rootDir) {
  const key = businessKey(businessId);
  if (key !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(key)) {
    throw new Error(
      `scheduleStore refuses an invalid businessId ${JSON.stringify(businessId)} - it never becomes a directory name.`
    );
  }
  return path.join(rootDir, key);
}

function findCredentialKeyPath(value, trail = []) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialKeyPath(value[index], trail.concat(`[${index}]`));
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const here = trail.concat(key);
    if (CREDENTIAL_KEY_PATTERN.test(key)) return here.join('.');
    const found = findCredentialKeyPath(value[key], here);
    if (found) return found;
  }
  return null;
}

// Same atomic write as approvals/approvalStore.js and monitoring/snapshotStore.js.
function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // Already gone - the real error below is the one that matters.
    }
    throw err;
  }
}

function saveScheduledJob(job, { rootDir = getDefaultScheduleStoreDir() } = {}) {
  const validation = validateJobShape(job);
  if (!validation.valid) {
    throw new Error(`Refusing to persist an invalid scheduled job: ${validation.errors.join('; ')}`);
  }
  const offending = findCredentialKeyPath(job);
  if (offending) {
    throw new Error(
      `Refusing to persist a scheduled job: it carries credential-shaped material at '${offending}'. ` +
        'Schedule state never contains credentials, tokens or keys.'
    );
  }
  const id = safeJobId(job.job_id);
  if (!id) throw new Error('Refusing to persist a scheduled job with no filename-safe job_id.');

  const directory = businessDir(job.business_id, rootDir);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${id}.json`);
  writeJsonAtomically(filePath, job);
  return filePath;
}

// Every failure mode returns null, so a corrupt job is indistinguishable from an absent one
// and is therefore never run.
function readJobFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
  return validateJobShape(parsed).valid ? parsed : null;
}

function loadScheduledJob(jobId, { businessId = null, rootDir = getDefaultScheduleStoreDir() } = {}) {
  const id = safeJobId(jobId);
  if (!id) return null;
  let directory;
  try {
    directory = businessDir(businessId, rootDir);
  } catch (err) {
    return null;
  }
  const job = readJobFile(path.join(directory, `${id}.json`));
  if (!job) return null;
  const expected = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  // Belt and braces: a record whose own business_id disagrees with the directory it was
  // found in is not served, whatever put it there.
  if (job.business_id !== expected) return null;
  return job;
}

// One business's jobs only, ordered by job_id so listing is deterministic. Invalid files are
// skipped individually.
function listScheduledJobs({ businessId = null, rootDir = getDefaultScheduleStoreDir() } = {}) {
  let directory;
  try {
    directory = businessDir(businessId, rootDir);
  } catch (err) {
    return [];
  }
  let fileNames;
  try {
    fileNames = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const expected = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  const jobs = [];
  for (const fileName of fileNames) {
    const job = readJobFile(path.join(directory, fileName));
    if (!job || job.business_id !== expected) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return jobs;
}

// The jobs that have an unclaimed occurrence at or before `now`, for one business.
function listDueJobs({ businessId = null, now = new Date(), rootDir = getDefaultScheduleStoreDir() } = {}) {
  return listScheduledJobs({ businessId, rootDir }).filter((job) => isDue(job, now));
}

// Enables or disables one job. Separate from saveScheduledJob so an operator action is one
// explicit call rather than a hand-built record, and so `updated_at` is maintained here.
function setJobEnabled(jobId, enabled, { businessId = null, now = new Date(), rootDir = getDefaultScheduleStoreDir() } = {}) {
  const job = loadScheduledJob(jobId, { businessId, rootDir });
  if (!job) return null;
  const updated = {
    ...job,
    enabled: enabled === true,
    updated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  saveScheduledJob(updated, { rootDir });
  return updated;
}

// CLAIMS ONE OCCURRENCE, EXACTLY ONCE.
//
// Returns { claimed: true, job, occurrence_key } on success, or { claimed: false, reason,
// reason_code } - never a partial. On success the claim is already on disk before this
// returns, so a crash immediately afterwards cannot produce a second claim for the same
// occurrence, in this process or any later one.
function claimOccurrence(jobId, { businessId = null, now = new Date(), rootDir = getDefaultScheduleStoreDir() } = {}) {
  const refuse = (code) => ({ claimed: false, reason_code: code, reason: CLAIM_REFUSAL_REASONS[code], job: null, occurrence_key: null });

  const job = loadScheduledJob(jobId, { businessId, rootDir });
  if (!job) return refuse('not_found');
  if (job.enabled !== true) return refuse('disabled');

  const occurrenceKey = occurrenceKeyAt(job.schedule, now);
  if (occurrenceKey === null) return refuse('invalid_schedule');
  if (job.last_occurrence_key === occurrenceKey) return refuse('already_claimed');
  if (!isDue(job, now)) return refuse('not_due');

  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const claimed = {
    ...job,
    last_occurrence_key: occurrenceKey,
    last_claimed_at: nowIso,
    last_status: 'claimed',
    updated_at: nowIso,
  };
  saveScheduledJob(claimed, { rootDir });
  return { claimed: true, reason_code: null, reason: null, job: claimed, occurrence_key: occurrenceKey };
}

// Records what the runner concluded for the occurrence already claimed. Never re-opens the
// claim: the occurrence key is not touched, so recording an outcome can never make a job
// runnable again for the same occurrence.
function recordOccurrenceOutcome(jobId, status, { businessId = null, now = new Date(), rootDir = getDefaultScheduleStoreDir() } = {}) {
  const job = loadScheduledJob(jobId, { businessId, rootDir });
  if (!job) return null;
  const updated = {
    ...job,
    last_status: typeof status === 'string' && status.trim() !== '' ? status.trim() : 'unknown',
    updated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  saveScheduledJob(updated, { rootDir });
  return updated;
}

module.exports = {
  DEFAULT_BUSINESS_KEY,
  CLAIM_REFUSAL_REASONS,
  getDefaultScheduleStoreDir,
  safeJobId,
  findCredentialKeyPath,
  saveScheduledJob,
  loadScheduledJob,
  listScheduledJobs,
  listDueJobs,
  setJobEnabled,
  claimOccurrence,
  recordOccurrenceOutcome,
};

if (require.main === module) {
  const os = require('os');
  const { createScheduledJob } = require('./scheduleModel');
  console.log('Smart E-Commerce Growth AI Agent - scheduled job store:\n');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-store-demo-'));
  const now = new Date('2026-03-04T09:07:00.000Z');

  saveScheduledJob(
    createScheduledJob({
      jobId: 'observe-catalogue',
      businessId: 'alpha-co',
      enabled: true,
      schedule: { kind: 'interval_minutes', every: 60 },
      task: { tool_id: 'product_data_retrieval', objective: 'Observe the product catalogue.', platform: 'shopify' },
      now,
    }),
    { rootDir }
  );
  saveScheduledJob(
    createScheduledJob({
      jobId: 'beta-only',
      businessId: 'beta-co',
      enabled: true,
      schedule: { kind: 'interval_minutes', every: 60 },
      task: { tool_id: 'product_data_retrieval', objective: 'Observe the product catalogue.', platform: 'shopify' },
      now,
    }),
    { rootDir }
  );

  console.log('alpha-co sees only its own jobs:', listScheduledJobs({ businessId: 'alpha-co', rootDir }).map((job) => job.job_id));
  console.log('beta-co sees only its own jobs: ', listScheduledJobs({ businessId: 'beta-co', rootDir }).map((job) => job.job_id));

  const first = claimOccurrence('observe-catalogue', { businessId: 'alpha-co', now, rootDir });
  console.log(`\nFirst claim at 09:07  -> claimed: ${first.claimed} (occurrence ${first.occurrence_key})`);

  const second = claimOccurrence('observe-catalogue', { businessId: 'alpha-co', now: new Date('2026-03-04T09:45:00.000Z'), rootDir });
  console.log(`Second claim at 09:45 -> claimed: ${second.claimed} (${second.reason_code}) - a restart in between changes nothing, because the key is derived`);

  const nextHour = claimOccurrence('observe-catalogue', { businessId: 'alpha-co', now: new Date('2026-03-04T10:00:00.000Z'), rootDir });
  console.log(`Claim at 10:00        -> claimed: ${nextHour.claimed} (occurrence ${nextHour.occurrence_key})`);

  fs.rmSync(rootDir, { recursive: true, force: true });
}
