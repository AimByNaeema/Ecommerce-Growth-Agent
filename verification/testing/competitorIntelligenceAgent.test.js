'use strict';

const assert = require('node:assert');
const { analyzeCompetitorIntelligence } = require('../../agent/core/competitorIntelligenceAgent');
const { validateCompetitorIntelligenceShape } = require('../../agent/core/competitorIntelligenceModel');

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
  const validation = validateCompetitorIntelligenceShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

function areaEntry(list, area) {
  return list.find((entry) => entry.area === area);
}

test('analyzeCompetitorIntelligence requires a non-empty competitor', () => {
  assert.throws(() => analyzeCompetitorIntelligence({}), /requires a non-empty `competitor`/);
});

test('reports data_availability for all 8 areas even when nothing is supplied', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A' });
  assertValid(result);
  for (const status of Object.values(result.data_availability)) {
    assert.strictEqual(status, 'empty');
  }
});

// --- scalar areas (positioning/pricing/seo_signals) ------------------------------------

test('scalar area (pricing) reports success when value and evidence are both supplied', () => {
  const result = analyzeCompetitorIntelligence({
    competitor: 'A',
    pricingEvidence: ['$49.99 observed on PDP'],
    source: ['https://example.com/product'],
  });
  assert.strictEqual(result.data_availability.pricing, 'success');
  const fact = areaEntry(result.observed_facts, 'pricing');
  assert.deepStrictEqual(fact.findings, ['$49.99 observed on PDP']);
  assert.deepStrictEqual(fact.evidence, ['https://example.com/product']);
});

test('scalar area (pricing) reports partial when a value is supplied without any evidence', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A', pricingEvidence: ['$49.99 observed'] });
  assert.strictEqual(result.data_availability.pricing, 'partial');
});

test('scalar area (positioning) reports empty when nothing is supplied at all', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A' });
  assert.strictEqual(result.data_availability.positioning, 'empty');
  const fact = areaEntry(result.observed_facts, 'positioning');
  assert.deepStrictEqual(fact.findings, []);
});

// --- list areas (products/offers/listings/social_presence/advertising_signals) ---------

test('list area (products) reports success when every item is evidenced', () => {
  const result = analyzeCompetitorIntelligence({
    competitor: 'A',
    products: [{ topic: 'Jacket', finding: 'Sells insulated jackets', source: ['s1'] }],
  });
  assert.strictEqual(result.data_availability.products, 'success');
  const fact = areaEntry(result.observed_facts, 'products');
  assert.deepStrictEqual(fact.findings, ['Sells insulated jackets']);
  assert.deepStrictEqual(fact.evidence, ['s1']);
});

test('list area (products) reports partial when some items are evidenced and some are not', () => {
  const result = analyzeCompetitorIntelligence({
    competitor: 'A',
    products: [
      { topic: 'Jacket', finding: 'Sells insulated jackets', source: ['s1'] },
      { topic: 'Gloves', finding: 'Sells gloves' },
    ],
  });
  assert.strictEqual(result.data_availability.products, 'partial');
});

test('list area (advertising_signals) reports empty when nothing is supplied', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A' });
  assert.strictEqual(result.data_availability.advertising_signals, 'empty');
  assert.deepStrictEqual(areaEntry(result.observed_facts, 'advertising_signals').findings, []);
});

// --- separation of observed facts / analysis / recommendations -------------------------

test('observed_facts entries never carry a judgment - only findings/evidence', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A', pricingEvidence: ['$49.99'] });
  const fact = areaEntry(result.observed_facts, 'pricing');
  assert.deepStrictEqual(Object.keys(fact).sort(), ['area', 'evidence', 'findings', 'statement_type']);
  assert.strictEqual(fact.statement_type, 'observed_fact');
});

test('analysis entries never carry raw findings - only a status and a labeled statement', () => {
  const result = analyzeCompetitorIntelligence({ competitor: 'A', pricingEvidence: ['$49.99'] });
  const entry = areaEntry(result.analysis, 'pricing');
  assert.deepStrictEqual(Object.keys(entry).sort(), ['area', 'statement_type', 'status', 'text']);
  assert.strictEqual(entry.statement_type, 'interpretation');
  assert.ok(!('findings' in entry) && !('evidence' in entry));
});

test('recommendations pass through unchanged and are never invented when omitted', () => {
  const withRecs = analyzeCompetitorIntelligence({ competitor: 'A', recommendations: ['Track pricing monthly'] });
  assert.deepStrictEqual(withRecs.recommendations, ['Track pricing monthly']);

  const withoutRecs = analyzeCompetitorIntelligence({ competitor: 'A' });
  assert.deepStrictEqual(withoutRecs.recommendations, []);
});

test('specialized_records retains the full underlying competitor and area records - evidence is traceable', () => {
  const result = analyzeCompetitorIntelligence({
    competitor: 'A',
    pricingEvidence: ['$49.99'],
    source: ['s1'],
    products: [{ topic: 'Jacket', finding: 'Sells jackets', source: ['s2'] }],
  });
  assert.strictEqual(result.specialized_records.competitor_record.competitor, 'A');
  assert.deepStrictEqual(result.specialized_records.competitor_record.pricing_evidence, ['$49.99']);
  assert.strictEqual(result.specialized_records.area_records.products[0].topic, 'Jacket');
});

test('no field anywhere in the result is a computed number/statistic - only pass-through content and structural signals', () => {
  const result = analyzeCompetitorIntelligence({
    competitor: 'A',
    market: 'European Union',
    positioning: 'Premium',
    pricingEvidence: ['$49.99'],
    seoSignals: ['ranks for X'],
    source: ['s1'],
    products: [{ topic: 'Jacket', finding: 'Sells jackets', source: ['s2'] }],
    recommendations: ['Track pricing monthly'],
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
