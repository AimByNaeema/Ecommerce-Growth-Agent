'use strict';

const assert = require('node:assert');
const { runAnalyticsTool } = require('../../tools/analyticsTool');

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

test('runAnalyticsTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runAnalyticsTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runAnalyticsTool returns failed status for an unknown analyticsCapability', () => {
  const outcome = runAnalyticsTool({ analyticsCapability: 'not_a_real_capability' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown analyticsCapability'));
});

test('runAnalyticsTool returns failed status when a required field is missing (growth_opportunities without opportunities)', () => {
  const outcome = runAnalyticsTool({ analyticsCapability: 'growth_opportunities' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runAnalyticsTool defaults to sales capability', () => {
  const outcome = runAnalyticsTool({ reportingPeriod: '2026-Q1', summary: 'Revenue up 8%.' });
  assert.strictEqual(outcome.result.capability, 'sales');
});

test('runAnalyticsTool returns empty status when no evidence is supplied', () => {
  const outcome = runAnalyticsTool({ reportingPeriod: '2026-Q1', summary: 'Revenue up 8%.' });
  assert.strictEqual(outcome.status, 'empty');
});

test('runAnalyticsTool returns success status when evidence is supplied', () => {
  const outcome = runAnalyticsTool({
    reportingPeriod: '2026-Q1',
    summary: 'Revenue up 8%.',
    evidence: [{ topic: 'report', finding: 'Q1 revenue export', source: ['dashboard export'] }],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runAnalyticsTool dispatches the products capability', () => {
  const outcome = runAnalyticsTool({
    analyticsCapability: 'products',
    reportingPeriod: '2026-Q1',
    summary: 'Jackets are the top category.',
  });
  assert.strictEqual(outcome.result.capability, 'products');
  assert.strictEqual(outcome.result.specialized_records[0].product_performance.summary, 'Jackets are the top category.');
});

test('runAnalyticsTool dispatches the advertising capability onto its own category, distinct from marketing', () => {
  const outcome = runAnalyticsTool({
    analyticsCapability: 'advertising',
    reportingPeriod: '2026-Q1',
    summary: 'ROAS improved.',
  });
  assert.strictEqual(outcome.result.capability, 'advertising');
  const record = outcome.result.specialized_records[0];
  assert.strictEqual(record.advertising_performance.summary, 'ROAS improved.');
  assert.strictEqual(record.marketing_performance.summary, '');
});

test('runAnalyticsTool dispatches the growth_opportunities capability with partial status across records', () => {
  const outcome = runAnalyticsTool({
    analyticsCapability: 'growth_opportunities',
    opportunities: [
      { opportunityType: 'cross_selling', productReference: '(Example jacket)', evidence: ['past purchase data'] },
      { opportunityType: 'repeat_purchases', productReference: '(Example hat)' },
    ],
  });
  assert.strictEqual(outcome.status, 'partial');
});

test('runAnalyticsTool dispatches the insights capability, returning only significant metrics', () => {
  const outcome = runAnalyticsTool({
    analyticsCapability: 'insights',
    metrics: [
      { metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000, evidence: ['sales export'] },
      { metric: 'average_order_value', currentValue: 65, comparisonValue: 64 },
    ],
  });
  assert.strictEqual(outcome.result.capability, 'insights');
  assert.strictEqual(outcome.result.specialized_records.length, 1);
  assert.strictEqual(outcome.result.specialized_records[0].metric, 'total_revenue');
});

test('runAnalyticsTool insights: a possible_cause without evidence never lets confidence stay high - correlation is never asserted as causation without evidence', () => {
  const outcome = runAnalyticsTool({
    analyticsCapability: 'insights',
    metrics: [
      {
        metric: 'checkout_conversion_rate',
        currentValue: 1.9,
        comparisonValue: 2.8,
        possibleCause: 'A checkout redesign may have introduced friction (unconfirmed).',
        confidence: 'high',
      },
    ],
  });
  assert.strictEqual(outcome.result.specialized_records[0].confidence, 'medium');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
