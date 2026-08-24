'use strict';

const assert = require('node:assert');
const { runPaidAdvertisingTool } = require('../../tools/paidAdvertisingTool');

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

test('runPaidAdvertisingTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runPaidAdvertisingTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runPaidAdvertisingTool returns failed status for an unknown adPlatform', () => {
  const outcome = runPaidAdvertisingTool({ adPlatform: 'snapchat_ads' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown adPlatform'));
});

test('runPaidAdvertisingTool returns failed status when a required field is missing', () => {
  const outcome = runPaidAdvertisingTool({ campaignReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runPaidAdvertisingTool defaults to meta_ads platform', () => {
  const outcome = runPaidAdvertisingTool({ campaignReference: '(Example campaign)' });
  assert.strictEqual(outcome.result.capability, 'meta_ads');
});

test('runPaidAdvertisingTool returns empty status when no evidence is supplied', () => {
  const outcome = runPaidAdvertisingTool({ campaignReference: '(Example campaign)', objective: 'Drive sales.' });
  assert.strictEqual(outcome.status, 'empty');
});

test('runPaidAdvertisingTool returns success status when evidence is supplied', () => {
  const outcome = runPaidAdvertisingTool({
    campaignReference: '(Example campaign)',
    objective: 'Drive sales.',
    evidence: ['prior campaign result'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runPaidAdvertisingTool dispatches google_ads platform', () => {
  const outcome = runPaidAdvertisingTool({ adPlatform: 'google_ads', campaignReference: '(Example campaign)' });
  assert.strictEqual(outcome.result.capability, 'google_ads');
  assert.strictEqual(outcome.result.specialized_records[0].platform, 'google_ads');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
