'use strict';

const assert = require('node:assert');
const {
  getMaxArrayFieldEntries,
  getMaxPlanStepsPerRun,
  checkArrayFieldBounds,
  checkPlanStepBounds,
} = require('../../agent/core/executionBounds');

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

function withEnv(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test('getMaxArrayFieldEntries and getMaxPlanStepsPerRun return positive numbers by default', () => {
  assert.ok(getMaxArrayFieldEntries() > 0);
  assert.ok(getMaxPlanStepsPerRun() > 0);
});

test('getMaxArrayFieldEntries respects a MAX_ARRAY_FIELD_ENTRIES env override', () => {
  withEnv('MAX_ARRAY_FIELD_ENTRIES', '5', () => {
    assert.strictEqual(getMaxArrayFieldEntries(), 5);
  });
});

test('getMaxPlanStepsPerRun respects a MAX_PLAN_STEPS_PER_RUN env override', () => {
  withEnv('MAX_PLAN_STEPS_PER_RUN', '2', () => {
    assert.strictEqual(getMaxPlanStepsPerRun(), 2);
  });
});

test('checkArrayFieldBounds allows an array field exactly at the max', () => {
  withEnv('MAX_ARRAY_FIELD_ENTRIES', '3', () => {
    const result = checkArrayFieldBounds({ keywords: ['a', 'b', 'c'] });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, null);
  });
});

test('checkArrayFieldBounds rejects an array field one entry over the max, naming the offending field', () => {
  withEnv('MAX_ARRAY_FIELD_ENTRIES', '3', () => {
    const result = checkArrayFieldBounds({ keywords: ['a', 'b', 'c', 'd'] });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.field, 'keywords');
    assert.strictEqual(result.length, 4);
    assert.strictEqual(result.max, 3);
    assert.ok(/keywords/.test(result.reason));
    assert.ok(/split this into multiple calls/.test(result.reason));
  });
});

test('checkArrayFieldBounds identifies the correct field among several, and ignores non-array fields', () => {
  withEnv('MAX_ARRAY_FIELD_ENTRIES', '2', () => {
    const result = checkArrayFieldBounds({ topic: 'a very long string that is not an array', market: 'EU', markets: ['a', 'b', 'c'] });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.field, 'markets');
  });
});

test('checkArrayFieldBounds never truncates - the caller-supplied array is untouched', () => {
  withEnv('MAX_ARRAY_FIELD_ENTRIES', '2', () => {
    const original = ['a', 'b', 'c'];
    checkArrayFieldBounds({ keywords: original });
    assert.strictEqual(original.length, 3, 'the input array must never be mutated/truncated');
  });
});

test('checkArrayFieldBounds allows a request with no research_params (null/undefined)', () => {
  assert.strictEqual(checkArrayFieldBounds(null).allowed, true);
  assert.strictEqual(checkArrayFieldBounds(undefined).allowed, true);
});

test('checkPlanStepBounds allows a target count exactly at the max', () => {
  withEnv('MAX_PLAN_STEPS_PER_RUN', '5', () => {
    assert.strictEqual(checkPlanStepBounds(5).allowed, true);
  });
});

test('checkPlanStepBounds rejects a target count one over the max, with an actionable reason', () => {
  withEnv('MAX_PLAN_STEPS_PER_RUN', '5', () => {
    const result = checkPlanStepBounds(6);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.count, 6);
    assert.strictEqual(result.max, 5);
    assert.ok(/split it into smaller/.test(result.reason));
  });
});

test('checkPlanStepBounds default (20) comfortably exceeds today\'s natural 11-target ceiling', () => {
  assert.strictEqual(checkPlanStepBounds(11).allowed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
