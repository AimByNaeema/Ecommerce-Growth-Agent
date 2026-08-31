'use strict';

const assert = require('node:assert');
const { runMarketingAnalysisTool } = require('../../tools/marketingAnalysisTool');

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

test('runMarketingAnalysisTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runMarketingAnalysisTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runMarketingAnalysisTool returns failed status for an unknown marketingCapability', () => {
  const outcome = runMarketingAnalysisTool({ marketingCapability: 'not_a_real_capability' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown marketingCapability'));
});

test('runMarketingAnalysisTool returns failed status when a required field is missing', () => {
  const outcome = runMarketingAnalysisTool({ marketingChannel: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runMarketingAnalysisTool defaults to marketing_strategy capability', () => {
  const outcome = runMarketingAnalysisTool({ marketingChannel: 'email' });
  assert.strictEqual(outcome.result.capability, 'marketing_strategy');
});

test('runMarketingAnalysisTool returns empty status when no evidence is supplied', () => {
  const outcome = runMarketingAnalysisTool({ marketingChannel: 'email', objective: 'Drive awareness.' });
  assert.strictEqual(outcome.status, 'empty');
});

test('runMarketingAnalysisTool returns success status when evidence is supplied', () => {
  const outcome = runMarketingAnalysisTool({
    marketingChannel: 'email',
    objective: 'Drive awareness.',
    evidence: ['prior campaign result'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runMarketingAnalysisTool dispatches audience_segmentation capability', () => {
  const outcome = runMarketingAnalysisTool({
    marketingCapability: 'audience_segmentation',
    segments: [{ segmentDefinition: 'Budget-conscious weekend hikers' }],
  });
  assert.strictEqual(outcome.result.capability, 'audience_segmentation');
});

test('runMarketingAnalysisTool dispatches retention capability', () => {
  const outcome = runMarketingAnalysisTool({
    marketingCapability: 'retention',
    productReference: '(Example jacket)',
  });
  assert.strictEqual(outcome.result.capability, 'retention');
  assert.strictEqual(outcome.result.specialized_records[0].opportunity_type, 'retention');
});

test('runMarketingAnalysisTool dispatches conversion_opportunities capability with partial status across records', () => {
  const outcome = runMarketingAnalysisTool({
    marketingCapability: 'conversion_opportunities',
    opportunities: [
      { opportunityType: 'cross_selling', productReference: '(Example jacket)', evidence: ['past purchase data'] },
      { opportunityType: 'repeat_purchases', productReference: '(Example hat)' },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
});

test('runMarketingAnalysisTool dispatches marketing_opportunity_ranking capability with success status when every candidate has evidence', () => {
  const outcome = runMarketingAnalysisTool({
    marketingCapability: 'marketing_opportunity_ranking',
    candidates: [
      {
        opportunity: 'Launch Pinterest Ads for the insulated jacket line',
        reason: 'Pinterest organic pins already drive traffic.',
        evidence: ['(placeholder pinterest analytics report)'],
        expectedImpactCategory: 'revenue',
        expectedImpactMagnitude: 4,
        requiredAction: 'Set up a Pinterest Ads campaign.',
        actionClassification: 'externally_executable',
      },
    ],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.result.capability, 'marketing_opportunity_ranking');
  assert.strictEqual(outcome.result.specialized_records[0].category, 'marketing');
});

test('runMarketingAnalysisTool returns failed status for marketing_opportunity_ranking when candidates is missing', () => {
  const outcome = runMarketingAnalysisTool({ marketingCapability: 'marketing_opportunity_ranking' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty `candidates` array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
