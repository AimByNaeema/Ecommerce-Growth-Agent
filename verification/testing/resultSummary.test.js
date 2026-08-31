'use strict';

// Tests for agent/core/resultSummary.js's summarizeExecutionState - the pure function
// that turns one execution state (agent/core/executionState.js) into the one honest,
// human-readable sentence the dashboard shows as the primary result (see server.js's
// /run, /orchestrate, /orchestrate/approve and public/index.html's
// renderResult/renderPlanStep).

const assert = require('node:assert');
const { summarizeExecutionState } = require('../../agent/core/resultSummary');

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

test('summarizeExecutionState reports "not run yet" for a not_started state', () => {
  const summary = summarizeExecutionState({ completion_state: 'not_started', selected_specialist: null, outputs: null, errors: [] });
  assert.ok(/has not run yet/.test(summary));
});

test('summarizeExecutionState never claims success for a failed state - names the real error', () => {
  const summary = summarizeExecutionState({
    completion_state: 'failed',
    selected_specialist: { title: 'Product' },
    outputs: { status: 'failed', result: null, error: 'requires marketRow, productIdentity' },
    errors: ['requires marketRow, productIdentity'],
  });
  assert.ok(!/successfully|completed this request successfully/.test(summary));
  assert.ok(/requires marketRow, productIdentity/.test(summary));
  assert.ok(/Product/.test(summary));
});

test('summarizeExecutionState reports a blocked/empty tool-level result honestly, not as a completed answer', () => {
  const summary = summarizeExecutionState({
    completion_state: 'blocked',
    selected_specialist: { title: 'Analytics & Optimization' },
    outputs: { status: 'empty', result: { findings: [] }, error: null },
    errors: [],
  });
  assert.ok(!/completed this request successfully/.test(summary));
  assert.ok(/no real business data was available/.test(summary));
});

test('summarizeExecutionState reports a blocked (missing-input) result by naming the missing data', () => {
  const summary = summarizeExecutionState({
    completion_state: 'blocked',
    selected_specialist: { title: 'Research' },
    outputs: null,
    errors: ['No tool is registered yet for this capability.'],
  });
  assert.ok(/missing data needed to answer this/.test(summary));
  assert.ok(/No tool is registered yet/.test(summary));
});

test('summarizeExecutionState prefers the tool/result\'s own summary for a real success', () => {
  const summary = summarizeExecutionState({
    completion_state: 'complete',
    selected_specialist: { title: 'SEO' },
    outputs: { status: 'success', result: { summary: 'Found 3 keyword gaps.' }, error: null },
    errors: [],
  });
  assert.strictEqual(summary, 'Found 3 keyword gaps.');
});

test('summarizeExecutionState falls back to a generic completion sentence when no own summary exists', () => {
  const summary = summarizeExecutionState({
    completion_state: 'complete',
    selected_specialist: { title: 'Business configuration' },
    outputs: { name: 'Test Shop', domain: 'test-shop.myshopify.com' },
    errors: [],
  });
  assert.ok(/completed this request successfully/.test(summary));
});

test('summarizeExecutionState handles a missing/invalid state without throwing', () => {
  assert.strictEqual(summarizeExecutionState(null), 'No result is available.');
  assert.strictEqual(summarizeExecutionState(undefined), 'No result is available.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
