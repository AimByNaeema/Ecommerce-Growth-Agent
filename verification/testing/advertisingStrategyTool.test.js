'use strict';

const assert = require('node:assert');
const { runAdvertisingStrategyTool } = require('../../tools/advertisingStrategyTool');

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

test('runAdvertisingStrategyTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runAdvertisingStrategyTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runAdvertisingStrategyTool returns failed status when a required field is missing', () => {
  const outcome = runAdvertisingStrategyTool({ strategyReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runAdvertisingStrategyTool returns empty status when no evidence is supplied', () => {
  const outcome = runAdvertisingStrategyTool({
    strategyReference: '(Example winter jacket launch strategy)',
    campaignObjective: 'Drive first-week sales.',
    offer: '15% off for the first week.',
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.capability, 'advertising_strategy');
});

test('runAdvertisingStrategyTool returns success status when evidence is supplied', () => {
  const outcome = runAdvertisingStrategyTool({
    strategyReference: '(Example winter jacket launch strategy)',
    campaignObjective: 'Drive first-week sales.',
    evidence: ['prior campaign result'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runAdvertisingStrategyTool never spends budget or launches a campaign - no such fields ever appear in the result', () => {
  const outcome = runAdvertisingStrategyTool({
    strategyReference: '(Example strategy)',
    budgetRecommendation: '$500/month.',
    evidence: ['prior campaign result'],
  });
  const record = outcome.result.specialized_records[0];
  assert.deepStrictEqual(Object.keys(record).sort(), [
    'ad_copy',
    'audience',
    'budget_recommendation',
    'campaign_objective',
    'creative_angle',
    'cta',
    'evidence',
    'kpi',
    'offer',
    'strategy_reference',
    'testing_plan',
    'verification_status',
  ].sort());
});

test('runAdvertisingStrategyTool relays campaign objective, audience, offer, creative angle, ad copy, CTA, budget recommendation, KPI, and testing plan untouched', () => {
  const outcome = runAdvertisingStrategyTool({
    strategyReference: '(Example strategy)',
    campaignObjective: 'Drive first-week sales.',
    audience: 'Budget-conscious weekend hikers.',
    offer: '15% off for the first week.',
    creativeAngle: 'Warmth without the premium price tag.',
    adCopy: ['The warmest $80 jacket on the internet.'],
    cta: 'Shop the winter collection.',
    budgetRecommendation: '$500/month, reviewed weekly.',
    kpi: ['Return on ad spend.'],
    testingPlan: ['A/B test 2 creative angles for 1 week.'],
  });
  const record = outcome.result.specialized_records[0];
  assert.strictEqual(record.campaign_objective, 'Drive first-week sales.');
  assert.strictEqual(record.audience, 'Budget-conscious weekend hikers.');
  assert.strictEqual(record.offer, '15% off for the first week.');
  assert.strictEqual(record.creative_angle, 'Warmth without the premium price tag.');
  assert.deepStrictEqual(record.ad_copy, ['The warmest $80 jacket on the internet.']);
  assert.strictEqual(record.cta, 'Shop the winter collection.');
  assert.strictEqual(record.budget_recommendation, '$500/month, reviewed weekly.');
  assert.deepStrictEqual(record.kpi, ['Return on ad spend.']);
  assert.deepStrictEqual(record.testing_plan, ['A/B test 2 creative angles for 1 week.']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
