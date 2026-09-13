'use strict';

// The scheduling layer: scheduler/scheduleModel.js, scheduler/scheduleStore.js and
// scheduler/scheduleRunner.js.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, AND NONE CAN BE. The scheduler executes nothing
// by design, and global.fetch is replaced for the whole file with a function that FAILS the
// suite if anything reaches for the network.
//
// THE POLICY IS THE REAL ONE. Every decision below comes from the real
// agent/core/autonomyPolicy.js, with the real kill switch read from the real environment
// variable - nothing about the gate is mocked, so "a scheduled action cannot bypass the
// policy" is evidence rather than assertion.
//
// "RESTART" IS SIMULATED HONESTLY. The store holds no in-memory cache, so a restart is
// exactly "drop every object you held and read only what reached disk". The recovery tests
// discard their local job objects entirely and re-read from the store.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scheduleModel = require('../../scheduler/scheduleModel');
const {
  SCHEDULE_KINDS,
  MIN_INTERVAL_MINUTES,
  createScheduledJob,
  validateSchedule,
  validateJobShape,
  occurrenceKeyAt,
  nextOccurrenceAfter,
  isDue,
  describeJob,
} = scheduleModel;
const scheduleStore = require('../../scheduler/scheduleStore');
const {
  saveScheduledJob,
  loadScheduledJob,
  listScheduledJobs,
  listDueJobs,
  setJobEnabled,
  claimOccurrence,
} = scheduleStore;
const scheduleRunner = require('../../scheduler/scheduleRunner');
const { runSchedulerPass, evaluateScheduledJob, resolveComplianceVerdict, RUN_OUTCOMES } = scheduleRunner;
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

const NOW = new Date('2026-03-04T09:07:00.000Z');

function withKillSwitch(value, fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  if (value === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
  else process.env[AUTONOMY_KILL_SWITCH_ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function job({ jobId = 'observe-products', businessId = 'alpha-co', enabled = true, schedule = { kind: 'interval_minutes', every: 60 }, toolId = 'product_data_retrieval', objective = 'Observe the product catalogue.', platform = 'shopify', now = NOW } = {}) {
  return createScheduledJob({ jobId, businessId, enabled, schedule, task: { tool_id: toolId, objective, platform }, now });
}

const PASSING_POLICY = {
  ok: true,
  business_id: 'alpha-co',
  enabled_platforms: ['shopify'],
  autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 },
};
const PASSING_DAILY = { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true };

function pass(rootDir, overrides = {}) {
  return runSchedulerPass({
    businessId: 'alpha-co',
    now: NOW,
    rootDir,
    enabledPlatforms: ['shopify'],
    businessPolicy: PASSING_POLICY,
    dailyUsage: PASSING_DAILY,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------

test('a job carries every required field', () => {
  const record = job();
  for (const field of ['job_id', 'business_id', 'enabled', 'schedule', 'task', 'last_occurrence_key', 'created_at', 'updated_at']) {
    assert.ok(field in record, `missing ${field}`);
  }
  assert.strictEqual(validateJobShape(record).valid, true);
  const described = describeJob(record, NOW);
  assert.strictEqual(described.next_occurrence_at, '2026-03-04T10:00:00.000Z');
  assert.strictEqual(described.due, true);
});

test('a job is disabled unless explicitly enabled', () => {
  assert.strictEqual(job({ enabled: false }).enabled, false);
  assert.strictEqual(createScheduledJob({ jobId: 'x', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'market_research', objective: 'o' } }).enabled, false);
  for (const truthy of ['true', 1, 'yes']) {
    assert.strictEqual(job({ enabled: truthy }).enabled, false, `enabled: ${JSON.stringify(truthy)} must not enable a job`);
  }
});

test('occurrence keys are derived and anchored, so every process agrees', () => {
  const schedule = { kind: 'interval_minutes', every: 60 };
  assert.strictEqual(occurrenceKeyAt(schedule, new Date('2026-03-04T09:07:00.000Z')), '2026-03-04T09:00:00.000Z');
  assert.strictEqual(occurrenceKeyAt(schedule, new Date('2026-03-04T09:59:59.999Z')), '2026-03-04T09:00:00.000Z');
  assert.strictEqual(occurrenceKeyAt(schedule, new Date('2026-03-04T10:00:00.000Z')), '2026-03-04T10:00:00.000Z');

  const daily = { kind: 'daily_utc', at: '06:30' };
  assert.strictEqual(occurrenceKeyAt(daily, new Date('2026-03-04T09:07:00.000Z')), '2026-03-04T06:30:00.000Z');
  // Before today's time, the most recent occurrence was yesterday's - never tomorrow's.
  assert.strictEqual(occurrenceKeyAt(daily, new Date('2026-03-04T05:00:00.000Z')), '2026-03-03T06:30:00.000Z');
  assert.strictEqual(nextOccurrenceAfter(daily, new Date('2026-03-04T05:00:00.000Z')), '2026-03-04T06:30:00.000Z');
});

test('a malformed schedule is invalid and never due - it is not approximated', () => {
  for (const schedule of [
    { kind: 'cron', expression: '*/5 * * * *' },
    { kind: 'interval_minutes', every: 0 },
    { kind: 'interval_minutes', every: MIN_INTERVAL_MINUTES - 1 },
    { kind: 'interval_minutes', every: 'hourly' },
    { kind: 'daily_utc', at: '25:00' },
    { kind: 'daily_utc', at: 'noon' },
    null,
    'hourly',
    [],
  ]) {
    assert.strictEqual(validateSchedule(schedule).valid, false, `${JSON.stringify(schedule)} must be invalid`);
    assert.strictEqual(occurrenceKeyAt(schedule, NOW), null);
    assert.strictEqual(isDue({ enabled: true, schedule, last_occurrence_key: null }, NOW), false);
    assert.throws(() => job({ schedule }));
  }
  assert.deepStrictEqual(SCHEDULE_KINDS, ['interval_minutes', 'daily_utc']);
});

test('a job can only name a real registry capability - never a command', () => {
  for (const toolId of ['rm -rf /', 'not_a_tool', '', null, 42]) {
    assert.throws(() => job({ toolId }), /tool_id must be a real id/);
  }
  // And a platform it names must be one this project recognizes.
  assert.throws(() => job({ platform: 'amazon' }), /platform must be a platform this project recognizes/);
  assert.doesNotThrow(() => job({ platform: null }));
});

test('an invalid business id is refused before it can become anything', () => {
  for (const businessId of ['../escape', 'not a valid id', '!!']) {
    assert.throws(() => job({ businessId }), /valid businessId/);
  }
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: persistence, restart recovery, isolation
// ---------------------------------------------------------------------------------

test('a job persists and survives a process reload', () => {
  withTempRoot((rootDir) => {
    const original = job();
    saveScheduledJob(original, { rootDir });

    // The restart: nothing above is reused, only what reached disk.
    const reloaded = loadScheduledJob('observe-products', { businessId: 'alpha-co', rootDir });
    assert.deepStrictEqual(reloaded, original);
    assert.strictEqual(validateJobShape(reloaded).valid, true);
    assert.strictEqual(isDue(reloaded, NOW), true);
  });
});

test('a corrupt job file fails closed and does not destroy unrelated jobs', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'good-job' }), { rootDir });
    saveScheduledJob(job({ jobId: 'bad-job' }), { rootDir });
    fs.writeFileSync(path.join(rootDir, 'alpha-co', 'bad-job.json'), '{ not json');

    assert.strictEqual(loadScheduledJob('bad-job', { businessId: 'alpha-co', rootDir }), null);
    const remaining = listScheduledJobs({ businessId: 'alpha-co', rootDir });
    assert.deepStrictEqual(remaining.map((entry) => entry.job_id), ['good-job']);
    // A job that cannot be validated is never run - fail closed in the safe direction.
    assert.strictEqual(listDueJobs({ businessId: 'alpha-co', now: NOW, rootDir }).length, 1);
  });
});

test('business isolation: one business never sees or runs another business\'s jobs', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'alpha-job', businessId: 'alpha-co' }), { rootDir });
    saveScheduledJob(job({ jobId: 'beta-job', businessId: 'beta-co' }), { rootDir });

    assert.deepStrictEqual(listScheduledJobs({ businessId: 'alpha-co', rootDir }).map((entry) => entry.job_id), ['alpha-job']);
    assert.deepStrictEqual(listScheduledJobs({ businessId: 'beta-co', rootDir }).map((entry) => entry.job_id), ['beta-job']);
    // Not even by id.
    assert.strictEqual(loadScheduledJob('beta-job', { businessId: 'alpha-co', rootDir }), null);
    assert.strictEqual(claimOccurrence('beta-job', { businessId: 'alpha-co', now: NOW, rootDir }).claimed, false);
    // A pass for one business never touches the other's jobs.
    const result = pass(rootDir);
    assert.deepStrictEqual(result.results.map((entry) => entry.job_id), ['alpha-job']);
    // And the default (null) business is its own third space.
    assert.deepStrictEqual(listScheduledJobs({ businessId: null, rootDir }), []);
  });
});

test('path traversal is impossible - neither segment is ever an unvalidated path', () => {
  withTempRoot((rootDir) => {
    const record = job();
    for (const businessId of ['../escape', '..', 'a/b']) {
      assert.throws(() => saveScheduledJob({ ...record, business_id: businessId }, { rootDir }), /invalid/);
      assert.deepStrictEqual(listScheduledJobs({ businessId, rootDir }), []);
    }
    assert.strictEqual(scheduleStore.safeJobId('../../etc/passwd'), 'etcpasswd');
    assert.strictEqual(scheduleStore.safeJobId('..'), '');
    assert.strictEqual(loadScheduledJob('../../etc/passwd', { businessId: 'alpha-co', rootDir }), null);
  });
});

test('a credential-shaped key is refused rather than persisted', () => {
  withTempRoot((rootDir) => {
    const polluted = job();
    polluted.task.access_token = 'shpat_CANARY-DO-NOT-LEAK';
    assert.throws(() => saveScheduledJob(polluted, { rootDir }), /credential-shaped/);
    assert.strictEqual(scheduleStore.findCredentialKeyPath(job()), null);
  });
});

test('atomic persistence leaves no partial job file behind', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    const names = fs.readdirSync(path.join(rootDir, 'alpha-co'));
    assert.deepStrictEqual(names, ['observe-products.json']);
    assert.ok(names.every((name) => !name.endsWith('.tmp')));
    // A refused write leaves the directory exactly as it was.
    assert.throws(() => saveScheduledJob({ ...job(), schedule: { kind: 'cron' } }, { rootDir }));
    assert.deepStrictEqual(fs.readdirSync(path.join(rootDir, 'alpha-co')), names);
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: disabled schedule, duplicate prevention
// ---------------------------------------------------------------------------------

test('a disabled job is never due and is never claimed', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ enabled: false }), { rootDir });
    assert.strictEqual(listDueJobs({ businessId: 'alpha-co', now: NOW, rootDir }).length, 0);
    const claim = claimOccurrence('observe-products', { businessId: 'alpha-co', now: NOW, rootDir });
    assert.strictEqual(claim.claimed, false);
    assert.strictEqual(claim.reason_code, 'disabled');
    assert.deepStrictEqual(pass(rootDir).results, []);

    // Re-enabling is an explicit operator action, and it makes the job due again.
    setJobEnabled('observe-products', true, { businessId: 'alpha-co', now: NOW, rootDir });
    assert.strictEqual(listDueJobs({ businessId: 'alpha-co', now: NOW, rootDir }).length, 1);
  });
});

test('an occurrence is claimed exactly once, and a restart does not change that', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });

    const first = claimOccurrence('observe-products', { businessId: 'alpha-co', now: NOW, rootDir });
    assert.strictEqual(first.claimed, true);
    assert.strictEqual(first.occurrence_key, '2026-03-04T09:00:00.000Z');

    // A second attempt in the same occurrence window - this is the restart case, because
    // the key is derived from the schedule rather than remembered in memory.
    const second = claimOccurrence('observe-products', { businessId: 'alpha-co', now: new Date('2026-03-04T09:45:00.000Z'), rootDir });
    assert.strictEqual(second.claimed, false);
    assert.strictEqual(second.reason_code, 'already_claimed');

    // The next occurrence is a different key, so it claims cleanly.
    const nextHour = claimOccurrence('observe-products', { businessId: 'alpha-co', now: new Date('2026-03-04T10:00:00.000Z'), rootDir });
    assert.strictEqual(nextHour.claimed, true);
    assert.strictEqual(nextHour.occurrence_key, '2026-03-04T10:00:00.000Z');
  });
});

test('a repeated scheduler pass in the same window produces no second request', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      const first = pass(rootDir);
      assert.strictEqual(first.results.length, 1);
      assert.strictEqual(first.results[0].outcome, 'allowed');

      // Same hour again - nothing is even considered, so no duplicate request exists.
      const second = pass(rootDir, { now: new Date('2026-03-04T09:45:00.000Z') });
      assert.strictEqual(second.considered, 0);
      assert.deepStrictEqual(second.results, []);
    });
  });
});

test('the claim is durable before the decision is made', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => pass(rootDir));
    // Re-read from disk: the claim is there, not only in the returned object.
    const reloaded = loadScheduledJob('observe-products', { businessId: 'alpha-co', rootDir });
    assert.strictEqual(reloaded.last_occurrence_key, '2026-03-04T09:00:00.000Z');
    assert.strictEqual(reloaded.last_status, 'allowed');
    assert.strictEqual(isDue(reloaded, NOW), false);
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: every gate applies, and nothing is executed
// ---------------------------------------------------------------------------------

test('the kill switch stops scheduler-created autonomous execution', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('false', () => {
      const result = pass(rootDir);
      assert.strictEqual(result.results[0].outcome, 'blocked');
      assert.strictEqual(result.results[0].reason_code, 'kill_switch_off');
    });
  });
  // And an unset switch is equally closed.
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'unset-switch' }), { rootDir });
    withKillSwitch(undefined, () => {
      assert.strictEqual(pass(rootDir).results[0].reason_code, 'kill_switch_off');
    });
  });
});

test('a disabled platform blocks a scheduled job', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'etsy-observe', toolId: 'etsy_shop_data_retrieval', platform: 'etsy' }), { rootDir });
    withKillSwitch('true', () => {
      const shopifyOnly = { ...PASSING_POLICY, enabled_platforms: ['shopify'] };
      const result = pass(rootDir, { enabledPlatforms: ['shopify'], businessPolicy: shopifyOnly });
      assert.strictEqual(result.results[0].outcome, 'blocked');
      assert.strictEqual(result.results[0].reason_code, 'unauthorized_platform');
    });
  });
});

test('an exhausted daily budget blocks a scheduled job before anything is requested', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      const spent = { available: true, day: '2026-03-04', tokens_total: 999999, runs_counted: 99 };
      const result = pass(rootDir, { dailyUsage: spent });
      assert.strictEqual(result.results[0].outcome, 'blocked');
      assert.strictEqual(result.results[0].reason_code, 'daily_budget_exhausted');
    });
  });
});

test('a business that has not enabled autonomy blocks its own scheduled jobs', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      const noAutonomy = { ...PASSING_POLICY, autonomy: { enabled: false, daily_token_budget: null, daily_run_budget: null } };
      assert.strictEqual(pass(rootDir, { businessPolicy: noAutonomy }).results[0].reason_code, 'business_autonomy_disabled');
    });
  });
});

test('a consequential scheduled job never becomes autonomous execution', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'correct-vendor', toolId: 'shopify_vendor_correction', objective: 'Correct a vendor field.' }), { rootDir });
    withKillSwitch('true', () => {
      const result = pass(rootDir);
      assert.strictEqual(result.results[0].outcome, 'blocked');
      // The runner refuses to state a compliance verdict for content-bearing work, so the
      // policy blocks rather than a PASS being fabricated to reach the approval gate.
      assert.strictEqual(result.results[0].reason_code, 'compliance_verdict_missing');
      assert.notStrictEqual(result.results[0].outcome, 'allowed');
    });
  });
});

test('the runner will only ever state a compliance verdict for content-free work', () => {
  assert.strictEqual(resolveComplianceVerdict('product_data_retrieval'), 'not_applicable');
  assert.strictEqual(resolveComplianceVerdict('market_research'), 'not_applicable');
  // Consequential tools get NO verdict from the scheduler - it may not invent a PASS.
  assert.strictEqual(resolveComplianceVerdict('shopify_vendor_correction'), null);
  assert.strictEqual(resolveComplianceVerdict('shopify_inventory_correction'), null);
  assert.strictEqual(resolveComplianceVerdict('not_a_tool'), null);
});

test('the scheduler never supplies a human approval', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      const decision = pass(rootDir).results[0].decision;
      assert.strictEqual(decision.human_approval_present, false);
      assert.strictEqual(decision.human_approval_request_id, null);
      assert.strictEqual(decision.approval_gate_is_authoritative, true);
    });
  });
});

test('an allowed job yields a request built by the existing contract - not an execution', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      const result = pass(rootDir).results[0];
      assert.strictEqual(result.outcome, 'allowed');
      const request = result.execution_request;
      // Exactly the shape agent/core/orchestratorExecutionContract.js's createExecutionRequest
      // produces for a dashboard request - the scheduler builds no shape of its own.
      assert.deepStrictEqual(Object.keys(request).sort(), ['business_id', 'category', 'is_shared_infrastructure', 'objective', 'research_params', 'specialist_id', 'tool_id'].sort());
      assert.strictEqual(request.tool_id, 'product_data_retrieval');
      assert.strictEqual(request.business_id, 'alpha-co');
      assert.ok(RUN_OUTCOMES.includes(result.outcome));
    });
  });
});

test('a job naming a tool that has left the registry blocks rather than guessing', () => {
  withTempRoot((rootDir) => {
    const record = job();
    saveScheduledJob(record, { rootDir });
    // Simulate the registry entry disappearing after the job was written.
    const stale = { ...record, task: { ...record.task, tool_id: 'tool_removed_later' } };
    const evaluated = evaluateScheduledJob(stale, { enabledPlatforms: ['shopify'], now: NOW, businessPolicy: PASSING_POLICY, dailyUsage: PASSING_DAILY });
    assert.strictEqual(evaluated.outcome, 'blocked');
    assert.strictEqual(evaluated.execution_request, null);
  });
});

test('an unresolvable enablement list fails closed rather than defaulting to permitted', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job(), { rootDir });
    withKillSwitch('true', () => {
      // No enabledPlatforms and no readable config for this business: the policy's platform
      // gate denies rather than permitting.
      const result = runSchedulerPass({ businessId: 'alpha-co', now: NOW, rootDir, businessPolicy: null, dailyUsage: PASSING_DAILY });
      assert.strictEqual(result.results[0].outcome, 'blocked');
      assert.ok(['policy_data_unreadable', 'unauthorized_platform', 'invalid_business'].includes(result.results[0].reason_code));
    });
  });
});

test('one failing job never takes down the pass', () => {
  withTempRoot((rootDir) => {
    saveScheduledJob(job({ jobId: 'a-healthy' }), { rootDir });
    saveScheduledJob(job({ jobId: 'b-hostile' }), { rootDir });

    // A policy input that throws the moment it is read, reached only for the second job.
    let seen = 0;
    const hostileDaily = {
      get available() {
        seen += 1;
        if (seen > 1) throw new Error('boom');
        return true;
      },
      day: '2026-03-04',
      tokens_total: 0,
      runs_counted: 0,
    };

    withKillSwitch('true', () => {
      const result = pass(rootDir, { dailyUsage: hostileDaily });
      assert.strictEqual(result.results.length, 2, 'both jobs must be reported');
      assert.strictEqual(result.store_error, false);
      // Whatever happened to the second, the pass returned normally rather than throwing.
      assert.ok(result.results.every((entry) => RUN_OUTCOMES.includes(entry.outcome)));
      assert.ok(!JSON.stringify(result).includes('boom'));
    });
  });
});

test('an unreadable store yields an honest empty pass rather than a crash', () => {
  const result = runSchedulerPass({ businessId: 'alpha-co', now: NOW, rootDir: path.join(os.tmpdir(), 'scheduler-never-created'), enabledPlatforms: ['shopify'], businessPolicy: PASSING_POLICY, dailyUsage: PASSING_DAILY });
  assert.strictEqual(result.considered, 0);
  assert.deepStrictEqual(result.results, []);
});

test('an unsupported platform can never be scheduled at all', () => {
  // Refused at job creation - it never reaches the store, let alone a pass.
  for (const platform of ['amazon', 'ebay', 'woocommerce']) {
    assert.throws(() => job({ platform }), /platform must be a platform this project recognizes/);
  }
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: no direct consequential execution bypass
// ---------------------------------------------------------------------------------

test('no module in scheduler/ can execute, approve or publish anything', () => {
  const dir = path.join(__dirname, '..', '..', 'scheduler');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 3, 'the scheduler modules must be present');

  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of [
      'runExecutor',
      'executeSelectedCapability',
      'runOrchestratorContract',
      'resumeApprovedExecution',
      'decideApprovalRequest',
      'authorizePublishing',
      'publishListing',
      "require('../integrations/adapters/shopifyClient",
      "require('../integrations/adapters/etsyReadClient",
      "require('../approvals",
      'setInterval(',
      'setTimeout(',
      'fetch(',
    ]) {
      assert.ok(!code.includes(forbidden), `scheduler/${file} must not contain ${forbidden}`);
    }
  }
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('scheduler.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
