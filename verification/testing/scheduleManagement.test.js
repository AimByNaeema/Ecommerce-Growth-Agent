'use strict';

// scheduler/scheduleManagement.js - how an owner explicitly creates and enables schedules.
// Every schedule is checked against the business it belongs to with the existing gates, is
// saved disabled, and can never name a platform or capability the business may not use.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBusinessSchedule, setBusinessScheduleEnabled, listBusinessSchedules } = require('../../scheduler/scheduleManagement');
const scheduleStore = require('../../scheduler/scheduleStore');

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

function withRoot(fn) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-management-'));
  try {
    return fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

const T0 = new Date('2026-03-04T09:07:00.000Z');
const HOURLY = { kind: 'interval_minutes', every: 60 };
const OBSERVE = { tool_id: 'product_data_retrieval', objective: 'Observe the catalogue.', platform: 'shopify' };

function policy(businessId, enabledPlatforms = ['shopify']) {
  return { ok: true, business_id: businessId, enabled_platforms: enabledPlatforms, autonomy: { enabled: false, daily_token_budget: null, daily_run_budget: null } };
}

function create(rootDir, overrides = {}) {
  return createBusinessSchedule({
    businessId: 'alpha-co',
    jobId: 'observe',
    schedule: HOURLY,
    task: OBSERVE,
    now: T0,
    rootDir,
    businessPolicy: policy('alpha-co'),
    ...overrides,
  });
}

test('an owner-declared schedule is saved exactly as declared, and disabled', () => {
  withRoot((rootDir) => {
    const task = { ...OBSERVE, follow_ups: [{ tool_id: 'listing_quality_check', objective: 'Check listing quality.' }] };
    const result = create(rootDir, { task });
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.job.enabled, false);
    const stored = scheduleStore.loadScheduledJob('observe', { businessId: 'alpha-co', rootDir });
    // Exactly what was declared; an undeclared `params` is normalized to null by the model.
    assert.deepStrictEqual(stored.task, { ...task, params: null });
    assert.deepStrictEqual(stored.schedule, HOURLY);
  });
});

test('an existing schedule is never overwritten', () => {
  withRoot((rootDir) => {
    assert.strictEqual(create(rootDir).ok, true);
    const again = create(rootDir, { schedule: { kind: 'interval_minutes', every: 5 } });
    assert.strictEqual(again.reason_code, 'schedule_exists');
    assert.deepStrictEqual(scheduleStore.loadScheduledJob('observe', { businessId: 'alpha-co', rootDir }).schedule, HOURLY);
  });
});

test('a platform the business has not enabled is refused', () => {
  withRoot((rootDir) => {
    const result = create(rootDir, { task: { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe Etsy.', platform: 'etsy' } });
    assert.strictEqual(result.reason_code, 'platform_not_enabled');
    assert.strictEqual(listBusinessSchedules({ businessId: 'alpha-co', rootDir }).length, 0);
  });
});

test('a platform this project has no integration for is refused - no Amazon or eBay is invented', () => {
  withRoot((rootDir) => {
    for (const platform of ['amazon', 'ebay']) {
      const result = create(rootDir, { jobId: `observe-${platform}`, task: { ...OBSERVE, platform }, businessPolicy: policy('alpha-co', ['shopify', platform]) });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason_code, 'invalid_schedule');
    }
  });
});

test('an unimplemented capability, directly or as a follow-up, is refused', () => {
  withRoot((rootDir) => {
    assert.strictEqual(create(rootDir, { task: { tool_id: 'memory_retrieval', objective: 'Retrieve.', platform: null } }).reason_code, 'tool_not_implemented');
    const followUp = create(rootDir, { task: { ...OBSERVE, follow_ups: [{ tool_id: 'verification', objective: 'Verify.' }] } });
    assert.strictEqual(followUp.reason_code, 'tool_not_implemented');
  });
});

test('malformed schedules, credential-shaped params and bad job ids are refused', () => {
  withRoot((rootDir) => {
    assert.strictEqual(create(rootDir, { schedule: { kind: 'interval_minutes', every: 1 } }).reason_code, 'invalid_schedule');
    assert.strictEqual(create(rootDir, { task: { ...OBSERVE, params: { access_token: 'x' } } }).reason_code, 'invalid_schedule');
    assert.strictEqual(create(rootDir, { jobId: '../escape' }).reason_code, 'invalid_job_id');
    assert.strictEqual(create(rootDir, { jobId: '' }).reason_code, 'invalid_job_id');
  });
});

test('an unreadable business policy refuses rather than guessing', () => {
  withRoot((rootDir) => {
    const result = create(rootDir, { businessPolicy: { ok: false, reason_code: 'policy_data_unreadable' } });
    assert.strictEqual(result.reason_code, 'policy_data_unreadable');
  });
});

test('enabling re-checks the business, so a withdrawn platform cannot be enabled', () => {
  withRoot((rootDir) => {
    assert.strictEqual(create(rootDir).ok, true);
    const refused = setBusinessScheduleEnabled({ businessId: 'alpha-co', jobId: 'observe', enabled: true, rootDir, businessPolicy: policy('alpha-co', []) });
    assert.strictEqual(refused.reason_code, 'platform_not_enabled');
    assert.strictEqual(scheduleStore.loadScheduledJob('observe', { businessId: 'alpha-co', rootDir }).enabled, false);

    const enabled = setBusinessScheduleEnabled({ businessId: 'alpha-co', jobId: 'observe', enabled: true, rootDir, businessPolicy: policy('alpha-co') });
    assert.strictEqual(enabled.ok, true);
    assert.strictEqual(enabled.job.enabled, true);
    assert.strictEqual(setBusinessScheduleEnabled({ businessId: 'alpha-co', jobId: 'observe', enabled: 'yes', rootDir }).reason_code, 'invalid_request');
  });
});

test('business isolation: one business cannot see, enable or collide with another\'s schedule', () => {
  withRoot((rootDir) => {
    assert.strictEqual(create(rootDir).ok, true);
    assert.strictEqual(listBusinessSchedules({ businessId: 'beta-co', rootDir }).length, 0);
    assert.strictEqual(listBusinessSchedules({ businessId: null, rootDir }).length, 0);
    const foreign = setBusinessScheduleEnabled({ businessId: 'beta-co', jobId: 'observe', enabled: true, rootDir, businessPolicy: policy('beta-co') });
    assert.strictEqual(foreign.reason_code, 'schedule_not_found');
    const sameIdOtherBusiness = create(rootDir, { businessId: 'beta-co', businessPolicy: policy('beta-co') });
    assert.strictEqual(sameIdOtherBusiness.ok, true, 'job ids are scoped per business');
    assert.strictEqual(create(rootDir, { businessId: 'beta-co', businessPolicy: policy('alpha-co') }).reason_code, 'invalid_business');
  });
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('scheduleManagement.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
