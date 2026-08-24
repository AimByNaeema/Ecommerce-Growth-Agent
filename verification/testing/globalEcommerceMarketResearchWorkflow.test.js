'use strict';

const assert = require('node:assert');
const { compareGlobalMarkets } = require('../../workflows/globalEcommerceMarketResearchWorkflow');
const { validateGlobalMarketComparisonShape } = require('../../agent/core/globalMarketComparisonModel');

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

function assertValid(result) {
  const validation = validateGlobalMarketComparisonShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

test('compareGlobalMarkets requires a non-empty markets array', () => {
  assert.throws(() => compareGlobalMarkets({}), /requires a non-empty `markets`/);
  assert.throws(() => compareGlobalMarkets({ markets: [] }), /requires a non-empty `markets`/);
});

test('compareGlobalMarkets throws when an entry is missing its required market', () => {
  assert.throws(() => compareGlobalMarkets({ markets: [{ country: 'DE' }] }), /requires a non-empty `market`/);
});

test('compareGlobalMarkets throws when a product entry is missing its required productIdentity', () => {
  assert.throws(
    () =>
      compareGlobalMarkets({
        markets: [{ market: 'European Union', products: [{ category: 'apparel' }] }],
      }),
    /requires each `products` entry to have a non-empty `productIdentity`/
  );
});

test('produces one row per market, with markets_compared in the correct order', () => {
  const result = compareGlobalMarkets({
    markets: [{ market: 'European Union' }, { market: 'North America' }],
  });
  assertValid(result);
  assert.deepStrictEqual(result.markets_compared, ['European Union', 'North America']);
  assert.strictEqual(result.comparison.length, 2);
});

test('scalar facets (category/demand_signals/trends/risks) carry the right value and evidence', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['signal A'],
        trends: ['trend A'],
        risks: ['risk A'],
        evidence: ['source A'],
      },
    ],
  });
  const row = result.comparison[0];
  assert.strictEqual(row.category.value, 'outdoor apparel');
  assert.deepStrictEqual(row.category.evidence, ['source A']);
  assert.strictEqual(row.category.has_evidence, true);
  assert.deepStrictEqual(row.demand_signals.value, ['signal A']);
  assert.strictEqual(row.demand_signals.has_evidence, true);
  assert.deepStrictEqual(row.trends.value, ['trend A']);
  assert.deepStrictEqual(row.risks.value, ['risk A']);
});

test('scalar facets report has_evidence=false and a limitation when no evidence is supplied', () => {
  const result = compareGlobalMarkets({
    markets: [{ market: 'European Union', category: 'outdoor apparel', demandSignals: ['signal A'] }],
  });
  const row = result.comparison[0];
  assert.strictEqual(row.category.has_evidence, false);
  assert.strictEqual(row.demand_signals.has_evidence, false);
  assert.ok(row.limitations.some((l) => l.includes('No evidence was supplied for category in European Union')));
  assert.ok(result.limitations.some((l) => l.includes('[European Union] No evidence was supplied for category')));
});

test('competition/pricing facets report success when every competitor has evidence', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        competitors: [
          { competitor: 'A', strengths: ['fast'], pricingEvidence: ['p1'], source: ['s1'] },
          { competitor: 'B', strengths: ['cheap'], pricingEvidence: ['p2'], source: ['s2'] },
        ],
      },
    ],
  });
  const row = result.comparison[0];
  assert.strictEqual(row.competition.status, 'success');
  assert.strictEqual(row.pricing.status, 'success');
  assert.strictEqual(row.competition.entries.length, 2);
  assert.deepStrictEqual(row.competition.entries[0].strengths, ['fast']);
  assert.deepStrictEqual(row.pricing.entries[0].pricing_evidence, ['p1']);
});

test('competition/pricing facets report partial when some competitors lack evidence', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        competitors: [{ competitor: 'A', strengths: ['fast'] }, { competitor: 'B', strengths: ['cheap'], source: ['s1'] }],
      },
    ],
  });
  const row = result.comparison[0];
  assert.strictEqual(row.competition.status, 'partial');
  assert.strictEqual(row.pricing.status, 'partial');
  assert.ok(row.limitations.some((l) => l.includes('Competition in European Union evidence is partial')));
});

test('competition/pricing/products facets report empty when nothing is supplied', () => {
  const result = compareGlobalMarkets({ markets: [{ market: 'European Union' }] });
  const row = result.comparison[0];
  assert.strictEqual(row.competition.status, 'empty');
  assert.strictEqual(row.pricing.status, 'empty');
  assert.strictEqual(row.products.status, 'empty');
  assert.deepStrictEqual(row.competition.entries, []);
});

test('products facet reports success and carries pricing/availability with evidence', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        products: [
          {
            productIdentity: 'Insulated jacket',
            pricing: { currency: 'EUR', cost: '40', price: '90' },
            availability: 'available',
            source: ['s1'],
          },
        ],
      },
    ],
  });
  const row = result.comparison[0];
  assert.strictEqual(row.products.status, 'success');
  assert.strictEqual(row.products.entries[0].product_identity, 'Insulated jacket');
  assert.deepStrictEqual(row.products.entries[0].pricing, { currency: 'EUR', cost: '40', price: '90' });
  assert.strictEqual(row.products.entries[0].availability, 'available');
});

test('specialized_records retains the full validated market/competitor/product records - evidence is traceable, not just summarized', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        country: 'DE',
        evidence: ['market source'],
        competitors: [{ competitor: 'A', source: ['comp source'] }],
        products: [{ productIdentity: 'Jacket', source: ['prod source'] }],
      },
    ],
  });
  const records = result.comparison[0].specialized_records;
  assert.strictEqual(records.market.country, 'DE');
  assert.deepStrictEqual(records.market.evidence, ['market source']);
  assert.strictEqual(records.competitors[0].competitor, 'A');
  assert.deepStrictEqual(records.competitors[0].source, ['comp source']);
  assert.strictEqual(records.products[0].product_identity, 'Jacket');
  assert.deepStrictEqual(records.products[0].source, ['prod source']);
});

test('no field anywhere in the result is a computed number/statistic - only pass-through content and structural signals', () => {
  const result = compareGlobalMarkets({
    markets: [
      {
        market: 'European Union',
        demandSignals: ['signal A'],
        evidence: ['e1'],
        competitors: [{ competitor: 'A', source: ['s1'] }],
        products: [{ productIdentity: 'Jacket', source: ['s2'] }],
      },
    ],
  });

  function assertNoNumericField(value, path) {
    if (typeof value === 'number') {
      throw new Error(`found a numeric field at ${path} - no field should ever be a computed statistic`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoNumericField(item, `${path}[${index}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assertNoNumericField(child, `${path}.${key}`);
      }
    }
  }

  assertNoNumericField(result, 'result');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
