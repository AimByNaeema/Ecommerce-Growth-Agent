'use strict';

const assert = require('node:assert');
const { runSocialContentTool } = require('../../tools/socialContentTool');

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

test('runSocialContentTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runSocialContentTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runSocialContentTool returns failed status for an unknown socialPlatform', () => {
  const outcome = runSocialContentTool({ socialPlatform: 'snapchat' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown socialPlatform'));
});

test('runSocialContentTool returns failed status when a required field is missing', () => {
  const outcome = runSocialContentTool({ contentReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runSocialContentTool defaults to instagram platform', () => {
  const outcome = runSocialContentTool({ contentReference: '(Example post)' });
  assert.strictEqual(outcome.result.capability, 'instagram');
});

test('runSocialContentTool returns empty status when no evidence is supplied', () => {
  const outcome = runSocialContentTool({ contentReference: '(Example post)', caption: 'Stay warm this winter.' });
  assert.strictEqual(outcome.status, 'empty');
});

test('runSocialContentTool returns success status when evidence is supplied', () => {
  const outcome = runSocialContentTool({
    contentReference: '(Example post)',
    caption: 'Stay warm this winter.',
    evidence: ['prior post performance'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runSocialContentTool dispatches tiktok platform', () => {
  const outcome = runSocialContentTool({ socialPlatform: 'tiktok', contentReference: '(Example video)' });
  assert.strictEqual(outcome.result.capability, 'tiktok');
  assert.strictEqual(outcome.result.specialized_records[0].platform, 'tiktok');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
