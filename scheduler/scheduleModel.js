'use strict';

// The schema for ONE scheduled job, and the deterministic arithmetic that decides when it
// is due.
//
// SCOPE: schema, validation and occurrence arithmetic only. Pure functions, no I/O, no
// clock of its own (every function that needs "now" takes it as an argument) - the same
// model/store/runner split monitoring/ and approvals/ already use. Persistence lives in
// scheduler/scheduleStore.js; turning a due job into a controlled execution request lives
// in scheduler/scheduleRunner.js.
//
// NOT A CRON PARSER, AND NO DEPENDENCY. Two schedule kinds are supported, both computable
// in a few lines of arithmetic: a fixed minute interval, and a once-a-day UTC time. Adding
// a cron library would mean a new dependency for expressiveness nothing has asked for.
// A schedule this project cannot compute is INVALID, never approximated.
//
// OCCURRENCES ARE ANCHORED, NOT RELATIVE. An interval job's occurrences are multiples of
// its interval from the Unix epoch, and a daily job's are that clock time each UTC day. So
// "which occurrence is this?" has the same answer on every process, before and after a
// restart, without consulting any stored state. That is what makes duplicate prevention
// possible at all: the occurrence key is derived, not remembered.
//
// A JOB NAMES A CAPABILITY, NEVER A COMMAND. `task.tool_id` must be a real id from
// tools/toolRegistry.js. There is no free-form command, no shell string, and no way to
// schedule something the tool registry does not already know about - so a schedule can
// never widen what this system is able to do.

const { getToolById } = require('../tools/toolRegistry');
const { isValidChannel } = require('../agent/core/channelModel');
const { isValidBusinessId } = require('../configuration/businessRegistry');
const { getMaxPlanStepsPerRun } = require('../agent/core/executionBounds');

const SCHEDULE_VERSION = 1;

// research_params keys autonomy/autonomousCycle.js fills from real observations and this
// business's own verified memory. A schedule may not pre-declare them, so a follow-up can
// never be handed a fabricated "detected change".
const RESERVED_FOLLOW_UP_PARAMS = ['detected_changes', 'relevant_memory'];

// Mirrors the pattern scheduler/scheduleStore.js and approvals/approvalStore.js use.
const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

const SCHEDULE_KINDS = ['interval_minutes', 'daily_utc'];

// A floor on how often a job may recur. Not a business threshold and not a rate limit - it
// is the smallest interval whose occurrence arithmetic stays meaningful, and it stops a
// typo ('every: 0') from becoming a hot loop. Every real limit that matters (budget, usage,
// the kill switch) is enforced by the autonomy policy, not here.
const MIN_INTERVAL_MINUTES = 5;

const JOB_FIELDS = [
  { id: 'schedule_version', description: 'Schema version of this job record.' },
  { id: 'job_id', description: 'Stable, filename-safe id. Supplied by the caller, never generated here.' },
  { id: 'business_id', description: 'The business this job belongs to. null is the default single-business deployment.' },
  { id: 'enabled', description: 'Whether this job may produce occurrences at all. Off unless explicitly true.' },
  { id: 'schedule', description: 'When it recurs: { kind, ... }. Only kinds this project can compute are valid.' },
  { id: 'task', description: 'What it asks for: { tool_id, objective, platform }. A registry capability, never a command.' },
  { id: 'last_occurrence_key', description: 'The occurrence this job has already been claimed for. The duplicate-execution guard.' },
  { id: 'last_claimed_at', description: 'When that claim was recorded.' },
  { id: 'last_status', description: 'What the runner reported for the last claimed occurrence.' },
  { id: 'created_at', description: 'ISO-8601 UTC creation time.' },
  { id: 'updated_at', description: 'ISO-8601 UTC time of the last change to this record.' },
];

// ---------------------------------------------------------------------------------
// Occurrence arithmetic
// ---------------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseDailyTime(at) {
  if (typeof at !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

// Whether a schedule is one this project can actually compute. Returns the reason it is
// not, so a malformed schedule is reported rather than silently never firing.
function validateSchedule(schedule) {
  const errors = [];
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { valid: false, errors: ['schedule must be an object with a `kind`'] };
  }
  if (!SCHEDULE_KINDS.includes(schedule.kind)) {
    return { valid: false, errors: [`schedule.kind must be one of: ${SCHEDULE_KINDS.join(', ')} (got ${JSON.stringify(schedule.kind)})`] };
  }
  if (schedule.kind === 'interval_minutes') {
    const every = Number(schedule.every);
    if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES) {
      errors.push(`schedule.every must be a whole number of minutes of at least ${MIN_INTERVAL_MINUTES} (got ${JSON.stringify(schedule.every)})`);
    }
  }
  if (schedule.kind === 'daily_utc' && parseDailyTime(schedule.at) === null) {
    errors.push(`schedule.at must be a 24-hour UTC time of day as 'HH:MM' (got ${JSON.stringify(schedule.at)})`);
  }
  return { valid: errors.length === 0, errors };
}

// The most recent occurrence at or before `now`, as an ISO string - the OCCURRENCE KEY.
//
// Derived purely from the schedule and the clock, so two processes (or the same process
// before and after a restart) computing it at the same moment get the same answer. That is
// what makes it usable as a claim token: claiming occurrence T once means T can never be
// claimed again, whatever happens in between.
//
// Returns null for an invalid schedule - an uncomputable schedule is never due.
function occurrenceKeyAt(schedule, now) {
  if (!validateSchedule(schedule).valid) return null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  if (schedule.kind === 'interval_minutes') {
    const intervalMs = Number(schedule.every) * MINUTE_MS;
    return new Date(Math.floor(nowMs / intervalMs) * intervalMs).toISOString();
  }

  const { hours, minutes } = parseDailyTime(schedule.at);
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todaysOccurrence = dayStart + hours * 60 * MINUTE_MS + minutes * MINUTE_MS;
  // Before today's time, the most recent occurrence was yesterday's.
  return new Date(todaysOccurrence <= nowMs ? todaysOccurrence : todaysOccurrence - DAY_MS).toISOString();
}

// The next occurrence strictly after `now` - reported on a job so a caller (or an operator
// reading the stored record) can see when it will next be due, without re-deriving it.
function nextOccurrenceAfter(schedule, now) {
  if (!validateSchedule(schedule).valid) return null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  if (schedule.kind === 'interval_minutes') {
    const intervalMs = Number(schedule.every) * MINUTE_MS;
    return new Date((Math.floor(nowMs / intervalMs) + 1) * intervalMs).toISOString();
  }

  const { hours, minutes } = parseDailyTime(schedule.at);
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todaysOccurrence = dayStart + hours * 60 * MINUTE_MS + minutes * MINUTE_MS;
  return new Date(todaysOccurrence > nowMs ? todaysOccurrence : todaysOccurrence + DAY_MS).toISOString();
}

// Whether this job has an unclaimed occurrence at or before `now`.
//
// A disabled job is NEVER due - checked here rather than only at the runner, so there is no
// path that computes a due occurrence for a job an operator has switched off.
function isDue(job, now) {
  if (!job || job.enabled !== true) return false;
  const key = occurrenceKeyAt(job.schedule, now);
  if (key === null) return false;
  return job.last_occurrence_key !== key;
}

// ---------------------------------------------------------------------------------
// The job record
// ---------------------------------------------------------------------------------

function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { valid: false, errors: ['task must be an object naming a tool_id and an objective'] };
  }
  if (typeof task.tool_id !== 'string' || !getToolById(task.tool_id)) {
    errors.push(`task.tool_id must be a real id from tools/toolRegistry.js (got ${JSON.stringify(task.tool_id)}) - a schedule can never name a capability this project does not have`);
  }
  if (typeof task.objective !== 'string' || task.objective.trim() === '') {
    errors.push('task.objective must be a non-empty string');
  }
  if (task.platform !== null && task.platform !== undefined && !isValidChannel(task.platform)) {
    errors.push(`task.platform must be a platform this project recognizes, or null (got ${JSON.stringify(task.platform)})`);
  }
  // OPTIONAL PARAMETERS the action will be performed with - and, for a content-bearing
  // action, the content itself under `content`. Declared at schedule time so that a real
  // compliance evaluation can run on real content BEFORE the action is proposed, rather
  // than a verdict being invented for content that does not exist yet.
  //
  // NEVER CREDENTIALS. A schedule is persisted business data; a credential-shaped key in
  // it is refused outright by scheduler/scheduleStore.js, and refused here too so the
  // error names the field rather than the file.
  if (task.params !== null && task.params !== undefined) {
    if (typeof task.params !== 'object' || Array.isArray(task.params)) {
      errors.push(`task.params must be an object of action parameters, or null (got ${JSON.stringify(task.params)})`);
    } else {
      for (const key of Object.keys(task.params)) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) {
          errors.push(`task.params.${key} is credential-shaped; a schedule never carries credentials`);
        }
      }
    }
  }
  // OPTIONAL FOLLOW-UPS: what the owner wants analysed WHEN this job's observation detects a
  // real change. Declared explicitly per job - there is no built-in mapping from a change to
  // a specialist, because inventing one would be deciding on the owner's behalf. Each entry
  // names a registry capability exactly like the task itself does, and is run by
  // autonomy/autonomousCycle.js through the same policy, compliance and approval gates as a
  // scheduled job. A follow-up inherits this job's platform and cannot nest further
  // follow-ups, so one change can never fan out without bound.
  if (task.follow_ups !== null && task.follow_ups !== undefined) {
    if (!Array.isArray(task.follow_ups)) {
      errors.push(`task.follow_ups must be an array, or null (got ${JSON.stringify(task.follow_ups)})`);
    } else {
      if (task.follow_ups.length > getMaxPlanStepsPerRun()) {
        errors.push(`task.follow_ups may name at most ${getMaxPlanStepsPerRun()} capabilities (got ${task.follow_ups.length})`);
      }
      task.follow_ups.forEach((followUp, index) => {
        const label = `task.follow_ups[${index}]`;
        if (!followUp || typeof followUp !== 'object' || Array.isArray(followUp)) {
          errors.push(`${label} must be an object naming a tool_id and an objective`);
          return;
        }
        if (typeof followUp.tool_id !== 'string' || !getToolById(followUp.tool_id)) {
          errors.push(`${label}.tool_id must be a real id from tools/toolRegistry.js (got ${JSON.stringify(followUp.tool_id)})`);
        }
        if (typeof followUp.objective !== 'string' || followUp.objective.trim() === '') {
          errors.push(`${label}.objective must be a non-empty string`);
        }
        for (const inherited of ['platform', 'follow_ups']) {
          if (inherited in followUp) errors.push(`${label}.${inherited} is not allowed; a follow-up inherits its job's platform and cannot nest`);
        }
        if (followUp.params !== null && followUp.params !== undefined) {
          if (typeof followUp.params !== 'object' || Array.isArray(followUp.params)) {
            errors.push(`${label}.params must be an object, or null`);
          } else {
            for (const key of Object.keys(followUp.params)) {
              if (CREDENTIAL_KEY_PATTERN.test(key)) errors.push(`${label}.params.${key} is credential-shaped; a schedule never carries credentials`);
              if (RESERVED_FOLLOW_UP_PARAMS.includes(key)) errors.push(`${label}.params.${key} is supplied by the cycle from real observations and cannot be declared`);
            }
          }
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

// Composes one job record. Throws for input that cannot make a valid job rather than
// storing something the runner would have to guess about later.
function createScheduledJob({ jobId, businessId = null, enabled = false, schedule, task, now = new Date() } = {}) {
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('createScheduledJob requires a non-empty `jobId`.');
  }
  const normalizedBusinessId = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  if (normalizedBusinessId !== null && !isValidBusinessId(normalizedBusinessId)) {
    throw new Error(`createScheduledJob requires a valid businessId, got ${JSON.stringify(businessId)}.`);
  }
  const scheduleCheck = validateSchedule(schedule);
  if (!scheduleCheck.valid) {
    throw new Error(`createScheduledJob requires a computable schedule: ${scheduleCheck.errors.join('; ')}`);
  }
  const taskCheck = validateTask(task);
  if (!taskCheck.valid) {
    throw new Error(`createScheduledJob requires a valid task: ${taskCheck.errors.join('; ')}`);
  }

  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    schedule_version: SCHEDULE_VERSION,
    job_id: jobId.trim(),
    business_id: normalizedBusinessId,
    // OFF UNLESS EXPLICITLY TRUE - the same rule autonomy enablement follows. A job created
    // without stating `enabled` produces no occurrences.
    enabled: enabled === true,
    schedule: { ...schedule },
    task: {
      tool_id: task.tool_id,
      objective: task.objective.trim(),
      platform: task.platform === undefined ? null : task.platform,
      params: task.params === undefined ? null : task.params,
      // Present only when the owner declared follow-ups, so every existing job keeps its shape.
      ...(Array.isArray(task.follow_ups) ? { follow_ups: task.follow_ups.map((followUp) => ({ ...followUp })) } : {}),
    },
    last_occurrence_key: null,
    last_claimed_at: null,
    last_status: null,
    created_at: iso,
    updated_at: iso,
  };
}

function validateJobShape(job) {
  const errors = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { valid: false, errors: ['job must be an object'] };
  }
  for (const field of JOB_FIELDS) {
    if (!(field.id in job)) errors.push(`missing field: ${field.id}`);
  }
  if (job.schedule_version !== SCHEDULE_VERSION) {
    errors.push(`schedule_version must be ${SCHEDULE_VERSION}, got ${JSON.stringify(job.schedule_version)}`);
  }
  if (typeof job.job_id !== 'string' || job.job_id.trim() === '') errors.push('job_id must be a non-empty string');
  if (job.business_id !== null && typeof job.business_id !== 'string') errors.push('business_id must be a string or null');
  if (typeof job.enabled !== 'boolean') errors.push('enabled must be a boolean');
  if (job.last_occurrence_key !== null && typeof job.last_occurrence_key !== 'string') {
    errors.push('last_occurrence_key must be a string or null');
  }
  const scheduleCheck = validateSchedule(job.schedule);
  if (!scheduleCheck.valid) errors.push(...scheduleCheck.errors);
  const taskCheck = validateTask(job.task);
  if (!taskCheck.valid) errors.push(...taskCheck.errors);
  return { valid: errors.length === 0, errors };
}

// A job plus its derived timing, for a caller that wants to display or reason about it
// without repeating the arithmetic. Pure - it never mutates the job.
function describeJob(job, now = new Date()) {
  return {
    job_id: job.job_id,
    business_id: job.business_id,
    enabled: job.enabled,
    tool_id: job.task ? job.task.tool_id : null,
    platform: job.task ? job.task.platform : null,
    schedule: job.schedule,
    schedule_valid: validateSchedule(job.schedule).valid,
    current_occurrence_key: occurrenceKeyAt(job.schedule, now),
    next_occurrence_at: nextOccurrenceAfter(job.schedule, now),
    last_occurrence_key: job.last_occurrence_key,
    last_claimed_at: job.last_claimed_at,
    last_status: job.last_status,
    due: isDue(job, now),
  };
}

module.exports = {
  SCHEDULE_VERSION,
  SCHEDULE_KINDS,
  MIN_INTERVAL_MINUTES,
  JOB_FIELDS,
  validateSchedule,
  validateTask,
  occurrenceKeyAt,
  nextOccurrenceAfter,
  isDue,
  createScheduledJob,
  validateJobShape,
  describeJob,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - scheduled job model:\n');
  const now = new Date('2026-03-04T09:07:00.000Z');

  const hourly = createScheduledJob({
    jobId: 'demo-hourly',
    businessId: 'demo-co',
    enabled: true,
    schedule: { kind: 'interval_minutes', every: 60 },
    task: { tool_id: 'product_data_retrieval', objective: 'Observe the product catalogue.', platform: 'shopify' },
    now,
  });
  console.log(JSON.stringify(describeJob(hourly, now), null, 2));

  const daily = createScheduledJob({
    jobId: 'demo-daily',
    businessId: 'demo-co',
    enabled: true,
    schedule: { kind: 'daily_utc', at: '06:30' },
    task: { tool_id: 'analytics_data_retrieval', objective: 'Observe store analytics.', platform: 'shopify' },
    now,
  });
  console.log(`\ndaily_utc 06:30 at 09:07 -> current occurrence ${occurrenceKeyAt(daily.schedule, now)}, next ${nextOccurrenceAfter(daily.schedule, now)}`);

  console.log('\nAn occurrence key is derived, never remembered - so it is identical on every process:');
  console.log(`  ${occurrenceKeyAt(hourly.schedule, now)} === ${occurrenceKeyAt(hourly.schedule, new Date('2026-03-04T09:59:59.999Z'))}`);

  console.log('\nA schedule this project cannot compute is invalid, never approximated:');
  for (const schedule of [{ kind: 'cron', expression: '*/5 * * * *' }, { kind: 'interval_minutes', every: 1 }, { kind: 'daily_utc', at: '25:00' }]) {
    console.log(`  ${JSON.stringify(schedule)} -> ${validateSchedule(schedule).errors[0]}`);
  }
}
