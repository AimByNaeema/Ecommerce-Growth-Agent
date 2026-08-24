'use strict';

const assert = require('node:assert');
const {
  analyzeSales,
  analyzeProducts,
  analyzeCustomers,
  analyzeConversion,
  analyzeTraffic,
  analyzeMarketingAnalytics,
  analyzeAdvertisingAnalytics,
  analyzeInventory,
  analyzeGrowthOpportunities,
  analyzeInsights,
  runAnalyticsAgent,
} = require('../../agent/core/analyticsAgent');
const { validateAnalyticsAgentResultShape } = require('../../agent/core/analyticsAgentResultModel');
const { METRICS_SUB_KEYS } = require('../../agent/core/analyticsModel');

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
  const validation = validateAnalyticsAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- sales / products / customers / conversion / traffic / marketing / advertising / --
// --- inventory ---------------------------------------------------------------------
// All 8 share the same snapshot-based composition (composeAnalyticsSnapshotResult) -
// exercised together via a table, plus one deeper test per capability for its own
// category mapping.

const SNAPSHOT_CASES = [
  { fn: analyzeSales, capability: 'sales', categoryId: 'sales' },
  { fn: analyzeProducts, capability: 'products', categoryId: 'product_performance' },
  { fn: analyzeCustomers, capability: 'customers', categoryId: 'customer_behavior' },
  { fn: analyzeConversion, capability: 'conversion', categoryId: 'conversion' },
  { fn: analyzeTraffic, capability: 'traffic', categoryId: 'traffic' },
  { fn: analyzeMarketingAnalytics, capability: 'marketing', categoryId: 'marketing_performance' },
  { fn: analyzeAdvertisingAnalytics, capability: 'advertising', categoryId: 'advertising_performance' },
  { fn: analyzeInventory, capability: 'inventory', categoryId: 'inventory' },
];

const ALL_CATEGORY_IDS = [
  'sales', 'traffic', 'conversion', 'product_performance', 'inventory', 'customer_behavior',
  'marketing_performance', 'advertising_performance', 'seo_performance', 'retention',
  'growth_opportunities',
];

for (const { fn, capability, categoryId } of SNAPSHOT_CASES) {
  test(`${fn.name} populates only its own category (${categoryId}) on an analyticsModel.js snapshot, leaving every other category at its default`, () => {
    const result = fn({
      reportingPeriod: '2026-Q1',
      summary: `${capability} summary placeholder`,
      actualMetrics: [{ label: 'actual placeholder', value: 1 }],
      calculatedMetrics: [{ label: 'calculated placeholder', value: 2 }],
      estimatedMetrics: [{ label: 'estimated placeholder', value: 3, assumption: 'placeholder assumption' }],
    });
    assert.strictEqual(result.capability, capability);
    assertValidResult(result);
    const record = result.specialized_records[0];
    assert.strictEqual(record.reporting_period, '2026-Q1');
    assert.strictEqual(record[categoryId].summary, `${capability} summary placeholder`);
    assert.deepStrictEqual(record[categoryId].actual_metrics, [{ label: 'actual placeholder', value: 1 }]);
    assert.deepStrictEqual(record[categoryId].calculated_metrics, [{ label: 'calculated placeholder', value: 2 }]);
    assert.deepStrictEqual(record[categoryId].estimated_metrics, [{ label: 'estimated placeholder', value: 3, assumption: 'placeholder assumption' }]);

    const otherCategoryIds = ALL_CATEGORY_IDS.filter((id) => id !== categoryId);
    for (const otherId of otherCategoryIds) {
      assert.strictEqual(record[otherId].summary, '', `${otherId}.summary should stay untouched`);
      for (const metricsKey of METRICS_SUB_KEYS) {
        assert.deepStrictEqual(record[otherId][metricsKey], [], `${otherId}.${metricsKey} should stay untouched`);
      }
      assert.strictEqual(record[otherId].verification_status, 'unverified', `${otherId}.verification_status should stay untouched`);
    }
  });

  test(`${fn.name} clearly labels actual/calculated/estimated findings so they stay distinguishable after flattening`, () => {
    const result = fn({
      reportingPeriod: '2026-Q1',
      summary: 'x',
      actualMetrics: [{ label: 'orders_count', value: 12 }],
      calculatedMetrics: [{ label: 'total_revenue', value: 500 }],
      estimatedMetrics: [{ label: 'projected_monthly_revenue', value: 2000, assumption: 'steady rate' }],
    });
    assert.ok(result.findings.some((f) => f.startsWith('Actual: ')));
    assert.ok(result.findings.some((f) => f.startsWith('Calculated: ')));
    assert.ok(result.findings.some((f) => f.startsWith('Estimated: ')));
  });

  test(`${fn.name} flags estimated_metrics with an explicit approximation limitation, distinct from actual/calculated`, () => {
    const withoutEstimate = fn({ reportingPeriod: '2026-Q1', summary: 'x', actualMetrics: [{ label: 'a', value: 1 }] });
    assert.ok(!withoutEstimate.limitations.some((l) => l.includes('estimated_metrics')));

    const withEstimate = fn({
      reportingPeriod: '2026-Q1',
      summary: 'x',
      estimatedMetrics: [{ label: 'projected', value: 1, assumption: 'x' }],
    });
    assert.ok(withEstimate.limitations.some((l) => l.includes('estimated_metrics') && l.includes('not observed or mechanically calculated facts')));
  });

  test(`${fn.name} reports empty when no evidence is supplied, and surfaces supplied evidence otherwise`, () => {
    const withoutEvidence = fn({ reportingPeriod: '2026-Q1', summary: 'x' });
    assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));
    assert.deepStrictEqual(withoutEvidence.evidence, []);

    const withEvidence = fn({
      reportingPeriod: '2026-Q1',
      summary: 'x',
      evidence: [{ topic: 'report', finding: 'a data point', source: ['dashboard export'] }],
    });
    assert.deepStrictEqual(withEvidence.evidence, ['a data point']);
    assert.deepStrictEqual(withEvidence.source, ['dashboard export']);
  });

  test(`${fn.name} never invents a summary or metrics that were not supplied`, () => {
    const result = fn({});
    const record = result.specialized_records[0];
    assert.strictEqual(record[categoryId].summary, '');
    for (const metricsKey of METRICS_SUB_KEYS) {
      assert.deepStrictEqual(record[categoryId][metricsKey], []);
    }
  });

  test(`${fn.name} never mixes recommendations into the category's own metrics - recommendations stay only on the envelope`, () => {
    const result = fn({
      reportingPeriod: '2026-Q1',
      summary: 'x',
      recommendations: ['Consider running a promotion.'],
    });
    assert.deepStrictEqual(result.recommendations, ['Consider running a promotion.']);
    const record = result.specialized_records[0];
    for (const metricsKey of METRICS_SUB_KEYS) {
      assert.ok(
        !record[categoryId][metricsKey].some((m) => JSON.stringify(m).includes('promotion')),
        `${metricsKey} should never carry a recommendation`
      );
    }
  });
}

// --- growth_opportunities --------------------------------------------------------------

test('analyzeGrowthOpportunities requires a non-empty opportunities array', () => {
  assert.throws(() => analyzeGrowthOpportunities({}), /requires a non-empty `opportunities` array/);
});

test('analyzeGrowthOpportunities composes growthOpportunityModel.js records directly, across multiple entries', () => {
  const result = analyzeGrowthOpportunities({
    opportunities: [
      { opportunityType: 'cross_selling', productReference: '(Example jacket)', relatedProducts: ['(Example hat)'], recommendation: 'Recommend the hat.' },
      { opportunityType: 'retention', productReference: '(Example jacket)' },
    ],
  });
  assert.strictEqual(result.capability, 'growth_opportunities');
  assertValidResult(result);
  assert.strictEqual(result.specialized_records.length, 2);
  assert.strictEqual(result.specialized_records[0].opportunity_type, 'cross_selling');
  assert.strictEqual(result.specialized_records[1].opportunity_type, 'retention');
  assert.ok(result.findings.includes('Recommend the hat.'));
});

test('analyzeGrowthOpportunities requires a non-empty productReference per entry', () => {
  assert.throws(
    () => analyzeGrowthOpportunities({ opportunities: [{}] }),
    /requires a non-empty `productReference`/
  );
});

// --- insights (the analytics insight engine) ---------------------------------------------

test('analyzeInsights requires a non-empty metrics array', () => {
  assert.throws(() => analyzeInsights({}), /requires a non-empty `metrics` array/);
});

test('analyzeInsights requires a non-empty metric per entry', () => {
  assert.throws(
    () => analyzeInsights({ metrics: [{ currentValue: 100, comparisonValue: 50 }] }),
    /requires a non-empty `metric`/
  );
});

test('analyzeInsights returns only significant insights - a metric below the significance threshold is excluded entirely', () => {
  const result = analyzeInsights({
    metrics: [
      { metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000, comparisonLabel: 'previous quarter', unit: 'USD' },
      { metric: 'average_order_value', currentValue: 65, comparisonValue: 64, comparisonLabel: 'previous quarter', unit: 'USD' },
    ],
  });
  assert.strictEqual(result.capability, 'insights');
  assertValidResult(result);
  assert.strictEqual(result.specialized_records.length, 1);
  assert.strictEqual(result.specialized_records[0].metric, 'total_revenue');
  assert.ok(result.limitations.some((l) => l.includes('average_order_value') && l.includes('did not clear the significance threshold')));
});

test('analyzeInsights returns every requested field per insight: metric, current_state, comparison, possible_cause, opportunity, recommendation, confidence, evidence', () => {
  const result = analyzeInsights({
    metrics: [
      {
        metric: 'total_revenue',
        currentValue: 128400,
        comparisonValue: 109000,
        comparisonLabel: 'previous quarter',
        unit: 'USD',
        possibleCause: 'A site-wide promotion ran during this period.',
        opportunity: 'Extend the promotion cadence.',
        recommendation: 'Run a similar promotion next quarter.',
        confidence: 'medium',
        evidence: ['promo campaign log'],
      },
    ],
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.metric, 'total_revenue');
  assert.strictEqual(record.current_state, '128400 USD');
  assert.ok(record.comparison.includes('17.8%'));
  assert.strictEqual(record.possible_cause, 'A site-wide promotion ran during this period.');
  assert.strictEqual(record.opportunity, 'Extend the promotion cadence.');
  assert.strictEqual(record.recommendation, 'Run a similar promotion next quarter.');
  assert.strictEqual(record.confidence, 'medium');
  assert.deepStrictEqual(record.evidence, ['promo campaign log']);
});

test('analyzeInsights computes the comparison itself from currentValue/comparisonValue rather than requiring the caller to write it', () => {
  const result = analyzeInsights({
    metrics: [{ metric: 'checkout_conversion_rate', currentValue: 1.9, comparisonValue: 2.8, comparisonLabel: 'previous quarter', unit: '%' }],
  });
  assert.ok(result.specialized_records[0].comparison.includes('down'));
  assert.ok(result.specialized_records[0].comparison.includes('previous quarter'));
});

// --- CAUSATION HONESTY: do not state correlation as causation without evidence -----------

test('analyzeInsights caps confidence at medium when a possible_cause is stated with no evidence, even if the caller asserted high confidence', () => {
  const result = analyzeInsights({
    metrics: [
      {
        metric: 'checkout_conversion_rate',
        currentValue: 1.9,
        comparisonValue: 2.8,
        comparisonLabel: 'previous quarter',
        possibleCause: 'A checkout redesign may have introduced friction (unconfirmed).',
        confidence: 'high',
      },
    ],
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.confidence, 'medium');
  assert.ok(result.limitations.some((l) => l.includes('downgraded from high confidence') && l.includes('correlation is never asserted as causation')));
});

test('analyzeInsights leaves confidence untouched when a possible_cause is backed by real evidence', () => {
  const result = analyzeInsights({
    metrics: [
      {
        metric: 'total_revenue',
        currentValue: 128400,
        comparisonValue: 109000,
        comparisonLabel: 'previous quarter',
        possibleCause: 'A site-wide promotion ran during this period.',
        confidence: 'high',
        evidence: ['promo campaign log showing the promotion overlapped the revenue increase'],
      },
    ],
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.confidence, 'high');
  assert.ok(!result.limitations.some((l) => l.includes('downgraded from high confidence')));
});

test('analyzeInsights leaves confidence untouched (no downgrade) when no possible_cause is stated at all - the guard only fires on a stated causal claim', () => {
  const result = analyzeInsights({
    metrics: [
      { metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000, comparisonLabel: 'previous quarter', confidence: 'high' },
    ],
  });
  assert.strictEqual(result.specialized_records[0].confidence, 'high');
});

test('analyzeInsights never invents a possible_cause, opportunity, or recommendation that was not supplied', () => {
  const result = analyzeInsights({
    metrics: [{ metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000 }],
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.possible_cause, '');
  assert.strictEqual(record.opportunity, '');
  assert.strictEqual(record.recommendation, '');
});

test('analyzeInsights flattens each insight\'s recommendation into the envelope\'s recommendations array', () => {
  const result = analyzeInsights({
    metrics: [
      { metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000, recommendation: 'Run a similar promotion next quarter.' },
      { metric: 'checkout_conversion_rate', currentValue: 1.9, comparisonValue: 2.8, recommendation: 'Audit the checkout flow.' },
    ],
  });
  assert.deepStrictEqual(result.recommendations, ['Run a similar promotion next quarter.', 'Audit the checkout flow.']);
});

test('analyzeInsights honors a caller-supplied thresholdPercent', () => {
  const withDefaultThreshold = analyzeInsights({
    metrics: [{ metric: 'sessions', currentValue: 105, comparisonValue: 100 }],
  });
  assert.strictEqual(withDefaultThreshold.specialized_records.length, 0);

  const withLowerThreshold = analyzeInsights({
    metrics: [{ metric: 'sessions', currentValue: 105, comparisonValue: 100 }],
    thresholdPercent: 5,
  });
  assert.strictEqual(withLowerThreshold.specialized_records.length, 1);
});

// --- dispatcher --------------------------------------------------------------------------

test('runAnalyticsAgent dispatches by capability', () => {
  const result = runAnalyticsAgent({ capability: 'sales', reportingPeriod: '2026-Q1', summary: 'x' });
  assert.strictEqual(result.capability, 'sales');
});

test('runAnalyticsAgent dispatches to the new inventory capability', () => {
  const result = runAnalyticsAgent({ capability: 'inventory', reportingPeriod: '2026-Q1', summary: 'x' });
  assert.strictEqual(result.capability, 'inventory');
});

test('runAnalyticsAgent dispatches to the new insights capability', () => {
  const result = runAnalyticsAgent({
    capability: 'insights',
    metrics: [{ metric: 'total_revenue', currentValue: 128400, comparisonValue: 109000 }],
  });
  assert.strictEqual(result.capability, 'insights');
});

test('runAnalyticsAgent throws on an unknown capability', () => {
  assert.throws(() => runAnalyticsAgent({ capability: 'not_a_real_capability' }), /Unknown Analytics capability/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
