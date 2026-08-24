'use strict';

const assert = require('node:assert');
const {
  analyzeMarketingStrategy,
  analyzeAudienceSegmentation,
  analyzeOffers,
  analyzePromotions,
  analyzeRetention,
  analyzeCampaignPlanning,
  analyzeEmailStrategy,
  analyzeConversionOpportunities,
  runMarketingAgent,
  retrieveMarketingData,
} = require('../../agent/core/marketingAgent');
const { validateMarketingAgentResultShape } = require('../../agent/core/marketingAgentResultModel');

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

function assertValidResult(result) {
  const validation = validateMarketingAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- marketing_strategy ---------------------------------------------------------------

test('analyzeMarketingStrategy requires a non-empty marketingChannel', () => {
  assert.throws(() => analyzeMarketingStrategy({}), /requires a non-empty `marketingChannel`/);
});

test('analyzeMarketingStrategy produces a valid, correctly-capabilitied result composing a marketingAnalysisModel.js record', () => {
  const result = analyzeMarketingStrategy({
    marketingChannel: 'email',
    campaign: '(Example launch)',
    objective: 'Drive awareness.',
    message: 'Stay warm this winter.',
  });
  assert.strictEqual(result.capability, 'marketing_strategy');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.marketing_channel, 'email');
  assert.strictEqual(record.objective, 'Drive awareness.');
  assert.strictEqual(record.message, 'Stay warm this winter.');
});

test('analyzeMarketingStrategy reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeMarketingStrategy({ marketingChannel: 'email' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));
  assert.deepStrictEqual(withoutEvidence.evidence, []);

  const withEvidence = analyzeMarketingStrategy({ marketingChannel: 'email', evidence: ['prior campaign result'] });
  assert.deepStrictEqual(withEvidence.evidence, ['prior campaign result']);
});

// --- audience_segmentation --------------------------------------------------------------

test('analyzeAudienceSegmentation requires a non-empty segments array', () => {
  assert.throws(() => analyzeAudienceSegmentation({}), /requires a non-empty `segments` array/);
});

test('analyzeAudienceSegmentation reuses customerSegmentResearchModel.js records directly', () => {
  const result = analyzeAudienceSegmentation({
    segments: [{ segmentDefinition: 'Budget-conscious weekend hikers', needs: ['Reliable warmth'] }],
  });
  assert.strictEqual(result.capability, 'audience_segmentation');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.segment_definition, 'Budget-conscious weekend hikers');
  assert.deepStrictEqual(record.needs, ['Reliable warmth']);
  assert.ok(result.findings.includes('Reliable warmth'));
});

test('analyzeAudienceSegmentation never invents a segment - only relays caller-supplied fields', () => {
  const result = analyzeAudienceSegmentation({ segments: [{ segmentDefinition: 'x' }] });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.needs, []);
  assert.deepStrictEqual(record.problems, []);
});

// --- offers / promotions ------------------------------------------------------------------

test('analyzeOffers composes a marketingAnalysisModel.js record focused on the offer', () => {
  const result = analyzeOffers({ marketingChannel: 'email', offer: '15% off', campaign: '(Example launch)' });
  assert.strictEqual(result.capability, 'offers');
  assert.strictEqual(result.topic, 'Offer: 15% off');
  assert.strictEqual(result.specialized_records[0].offer, '15% off');
});

test('analyzePromotions composes a marketingAnalysisModel.js record focused on the promotional campaign', () => {
  const result = analyzePromotions({ marketingChannel: 'social', campaign: '(Example flash sale)', offer: '15% off', timing: 'This weekend' });
  assert.strictEqual(result.capability, 'promotions');
  assert.strictEqual(result.topic, 'Promotion: (Example flash sale)');
  assert.strictEqual(result.specialized_records[0].timing, 'This weekend');
});

test('offers and promotions never invent an offer or discount that was not supplied', () => {
  const offersResult = analyzeOffers({ marketingChannel: 'email' });
  assert.strictEqual(offersResult.specialized_records[0].offer, '');
  const promotionsResult = analyzePromotions({ marketingChannel: 'social' });
  assert.strictEqual(promotionsResult.specialized_records[0].offer, '');
});

// --- retention -------------------------------------------------------------------------

test('analyzeRetention requires a non-empty productReference', () => {
  assert.throws(() => analyzeRetention({}), /requires a non-empty `productReference`/);
});

test('analyzeRetention pins opportunity_type to retention regardless of caller input', () => {
  const result = analyzeRetention({ productReference: '(Example jacket)', opportunityType: 'upselling' });
  assert.strictEqual(result.capability, 'retention');
  assert.strictEqual(result.specialized_records[0].opportunity_type, 'retention');
});

test('analyzeRetention composes a growthOpportunityModel.js record', () => {
  const result = analyzeRetention({
    productReference: '(Example jacket)',
    targetSegment: 'Lapsed customers',
    recommendation: 'Send a win-back offer.',
  });
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.target_segment, 'Lapsed customers');
  assert.strictEqual(record.recommendation, 'Send a win-back offer.');
  assert.ok(result.findings.includes('Send a win-back offer.'));
});

// --- campaign_planning -------------------------------------------------------------------

test('analyzeCampaignPlanning composes a marketingAnalysisModel.js record with timing/objective', () => {
  const result = analyzeCampaignPlanning({
    marketingChannel: 'email',
    campaign: '(Example launch)',
    timing: 'Early November',
    objective: 'Drive first-week sales.',
  });
  assert.strictEqual(result.capability, 'campaign_planning');
  const record = result.specialized_records[0];
  assert.strictEqual(record.timing, 'Early November');
  assert.strictEqual(record.objective, 'Drive first-week sales.');
});

// --- email_strategy ----------------------------------------------------------------------

test('analyzeEmailStrategy pins marketing_channel to email regardless of caller input', () => {
  const result = analyzeEmailStrategy({ marketingChannel: 'social', campaign: '(Example launch)' });
  assert.strictEqual(result.capability, 'email_strategy');
  assert.strictEqual(result.specialized_records[0].marketing_channel, 'email');
});

test('analyzeEmailStrategy works with no marketingChannel supplied at all', () => {
  const result = analyzeEmailStrategy({ campaign: '(Example launch)' });
  assert.strictEqual(result.specialized_records[0].marketing_channel, 'email');
});

// --- conversion_opportunities --------------------------------------------------------------

test('analyzeConversionOpportunities requires a non-empty opportunities array', () => {
  assert.throws(() => analyzeConversionOpportunities({}), /requires a non-empty `opportunities` array/);
});

test('analyzeConversionOpportunities composes multiple growthOpportunityModel.js records across types', () => {
  const result = analyzeConversionOpportunities({
    opportunities: [
      { opportunityType: 'cross_selling', productReference: '(Example jacket)', relatedProducts: ['(Example hat)'] },
      { opportunityType: 'repeat_purchases', productReference: '(Example jacket)' },
    ],
  });
  assert.strictEqual(result.capability, 'conversion_opportunities');
  assertValidResult(result);
  assert.strictEqual(result.specialized_records.length, 2);
  assert.strictEqual(result.specialized_records[0].opportunity_type, 'cross_selling');
  assert.strictEqual(result.specialized_records[1].opportunity_type, 'repeat_purchases');
});

test('analyzeConversionOpportunities is not mutually exclusive with retention - accepts a retention-typed entry too', () => {
  const result = analyzeConversionOpportunities({
    opportunities: [{ opportunityType: 'retention', productReference: '(Example jacket)' }],
  });
  assert.strictEqual(result.specialized_records[0].opportunity_type, 'retention');
});

// --- dispatcher / reuse helper ------------------------------------------------------------

test('runMarketingAgent dispatches by capability', () => {
  const result = runMarketingAgent({ capability: 'retention', productReference: '(Example jacket)' });
  assert.strictEqual(result.capability, 'retention');
});

test('runMarketingAgent throws on an unknown capability', () => {
  assert.throws(() => runMarketingAgent({ capability: 'not_a_real_capability' }), /Unknown Marketing capability/);
});

test('retrieveMarketingData delegates customer_segment-kind entries to researchAgent.js', () => {
  const records = retrieveMarketingData('customer_segment', [{ segmentDefinition: 'x' }], 'test');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].segment_definition, 'x');
});

test('retrieveMarketingData delegates generic-kind entries to researchAgent.js', () => {
  const records = retrieveMarketingData('generic', [{ topic: 'x', finding: 'y' }], 'test');
  assert.strictEqual(records[0].finding, 'y');
});

test('retrieveMarketingData builds marketing_analysis and growth_opportunity records directly', () => {
  const marketingRecords = retrieveMarketingData('marketing_analysis', [{ marketingChannel: 'email' }], 'test');
  assert.strictEqual(marketingRecords[0].marketing_channel, 'email');
  const growthRecords = retrieveMarketingData('growth_opportunity', [{ productReference: 'x' }], 'test');
  assert.strictEqual(growthRecords[0].product_reference, 'x');
});

test('retrieveMarketingData throws on an unknown record kind', () => {
  assert.throws(() => retrieveMarketingData('not_a_real_kind', [], 'test'), /unknown record kind/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
