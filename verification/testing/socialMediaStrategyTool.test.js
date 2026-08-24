'use strict';

const assert = require('node:assert');
const { runSocialMediaStrategyTool } = require('../../tools/socialMediaStrategyTool');

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

test('runSocialMediaStrategyTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runSocialMediaStrategyTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runSocialMediaStrategyTool returns failed status when a required field is missing', () => {
  const outcome = runSocialMediaStrategyTool({ strategyReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runSocialMediaStrategyTool returns empty status when no evidence is supplied', () => {
  const outcome = runSocialMediaStrategyTool({
    strategyReference: '(Example Q4 winter strategy)',
    objective: 'Grow winter jacket line awareness.',
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.capability, 'social_media_strategy');
});

test('runSocialMediaStrategyTool returns success status when evidence is supplied', () => {
  const outcome = runSocialMediaStrategyTool({
    strategyReference: '(Example Q4 winter strategy)',
    objective: 'Grow winter jacket line awareness.',
    evidence: ['prior quarter performance'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runSocialMediaStrategyTool relays content pillars, platform selection, and KPIs untouched', () => {
  const outcome = runSocialMediaStrategyTool({
    strategyReference: '(Example Q4 winter strategy)',
    contentPillars: ['Product education'],
    platformSelection: ['instagram', 'meta_ads'],
    kpis: ['Engagement rate'],
  });
  const record = outcome.result.specialized_records[0];
  assert.deepStrictEqual(record.content_pillars, ['Product education']);
  assert.deepStrictEqual(record.platform_selection, ['instagram', 'meta_ads']);
  assert.deepStrictEqual(record.kpis, ['Engagement rate']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
