'use strict';

// Evidence-based trend and trend-vs-fad classification (agent/core/trendEvidence.js), and its use in live
// research. Deterministic: fixed dated series, no clock, no network. The workflow cases mock only the provider
// seams, so this is engineering verification - no live trend data is claimed.

const assert = require('node:assert');

const trend = require('../../agent/core/trendEvidence');
const tavilyClient = require('../../integrations/adapters/tavilyClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const workflow = require('../../workflows/customerMarketOpportunityWorkflow');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

// Monthly observations starting January 2024.
function monthly(values, { grade = 'observed', metric = 'listings', unit = 'count' } = {}) {
  return values.map((value, index) => {
    const year = 2024 + Math.floor(index / 12);
    const month = String((index % 12) + 1).padStart(2, '0');
    return { date: `${year}-${month}`, value, grade, metric, unit, source: `https://source.test/${index}`, provider: 'tavily' };
  });
}

(async () => {
  test('SUSTAINED GROWTH: persistent rise without decay is growing, verified, with its time window', () => {
    const r = trend.classifyTrend(monthly([10, 12, 13, 15, 17, 19, 22, 25, 27, 30, 33, 36]));
    assert.strictEqual(r.classification, 'growing');
    assert.strictEqual(r.verification, 'VERIFIED');
    assert.strictEqual(r.observations_used, 12);
    assert.strictEqual(r.time_window.from, '2024-01-01T00:00:00.000Z');
    assert.strictEqual(r.time_window.to, '2024-12-01T00:00:00.000Z');
    assert.deepStrictEqual(r.providers, ['tavily']);
  });

  test('EMERGING: sustained growth from almost nothing is emerging, not merely growing', () => {
    assert.strictEqual(trend.classifyTrend(monthly([0, 0, 1, 2, 4, 7, 10, 14, 18, 23, 29, 35])).classification, 'emerging');
  });

  test('SHORT SPIKE: a brief peak that decays back to baseline is a fad', () => {
    const r = trend.classifyTrend(monthly([10, 11, 10, 12, 40, 55, 18, 11, 10, 10, 9, 11]));
    assert.strictEqual(r.classification, 'fad');
    assert.ok(r.detail.elevated_days <= trend.SPIKE_MAX_DAYS);
  });

  test('NOT A FAD WHILE STILL ELEVATED: a spike that has not decayed is never called a fad', () => {
    const r = trend.classifyTrend(monthly([10, 11, 10, 12, 11, 10, 12, 11, 40, 55, 60, 70]));
    assert.notStrictEqual(r.classification, 'fad');
  });

  test('SEASONAL PATTERN: the same month peaks in two yearly cycles', () => {
    const r = trend.classifyTrend(monthly([10, 10, 11, 12, 12, 13, 14, 15, 20, 45, 18, 11, 11, 10, 12, 12, 13, 13, 15, 16, 22, 50, 19, 12]));
    assert.strictEqual(r.classification, 'seasonal');
    assert.deepStrictEqual(r.detail.peak_months, [10, 10]);
  });

  test('ONE YEAR IS NOT SEASONALITY: a single yearly peak is never called seasonal', () => {
    const r = trend.classifyTrend(monthly([10, 10, 11, 12, 12, 13, 14, 15, 20, 45, 18, 11]));
    assert.notStrictEqual(r.classification, 'seasonal');
  });

  test('FLAT TREND: little change and low variation is stable', () => {
    assert.strictEqual(trend.classifyTrend(monthly([20, 21, 19, 20, 22, 21, 20, 19, 21, 20, 20, 21])).classification, 'stable');
  });

  test('DECLINING TREND: persistent fall is declining', () => {
    assert.strictEqual(trend.classifyTrend(monthly([40, 38, 36, 33, 30, 28, 26, 23, 21, 19, 17, 15])).classification, 'declining');
  });

  test('INSUFFICIENT DATA: too few points or too short a window is unknown and not verified', () => {
    for (const series of [monthly([10, 20, 30]), [{ date: '2025-01-01', value: 1, grade: 'observed' }, { date: '2025-01-05', value: 2, grade: 'observed' }, { date: '2025-01-09', value: 3, grade: 'observed' }, { date: '2025-01-12', value: 4, grade: 'observed' }], []]) {
      const r = trend.classifyTrend(series);
      assert.strictEqual(r.classification, 'unknown');
      assert.strictEqual(r.evidence_status, 'INSUFFICIENT');
      assert.strictEqual(r.verification, 'NOT_VERIFIED');
    }
  });

  test('NO LABELS, NO GUESSES: inferred, estimated, undated or non-numeric values are ignored', () => {
    const inferred = monthly([10, 12, 14, 16, 18, 20, 22, 24], { grade: 'inferred' });
    const estimated = monthly([10, 12, 14, 16, 18, 20, 22, 24], { grade: 'estimated' });
    const undated = monthly([10, 12, 14, 16, 18, 20, 22, 24]).map((o) => ({ ...o, date: 'last spring' }));
    const words = monthly([10, 12, 14, 16, 18, 20, 22, 24]).map((o) => ({ ...o, value: 'rising fast' }));
    for (const series of [inferred, estimated, undated, words]) {
      assert.strictEqual(trend.classifyTrend(series).verification, 'NOT_VERIFIED');
    }
  });

  test('ONE SCALE ONLY: values on different metrics or units are never mixed into one series', () => {
    const listings = monthly([10, 12, 13, 15, 17, 19], { metric: 'listings', unit: 'count' });
    const price = monthly([4.99, 1.99, 9.99, 2.49], { metric: 'price', unit: 'USD' });
    const r = trend.classifyTrend(listings.concat(price));
    assert.strictEqual(r.metric, 'listings');
    assert.strictEqual(r.observations_used, 6);
  });

  test('VOLATILE: enough data but no clear pattern is unknown, never forced into a class', () => {
    const r = trend.classifyTrend(monthly([10, 40, 12, 38, 9, 41, 13, 37, 11, 39, 10, 42]));
    assert.strictEqual(r.classification, 'unknown');
    assert.strictEqual(r.evidence_status, 'SUFFICIENT');
    assert.strictEqual(r.verification, 'NOT_VERIFIED');
  });

  // ---- In live research ----------------------------------------------------------------------------
  const BUSINESS = { business_name: 'T', product_categories: ['stickers', 'planners', 'clipart'] };
  const CATALOGUE = [
    { title: 'Sticker Pack', tags: ['sticker', 'bundle'], channel: 'shopify' },
    { title: 'Planner Insert', tags: ['planner', 'bundle'], channel: 'etsy' },
    { title: 'Clipart Set', tags: ['clipart', 'bundle'], channel: 'shopify' },
    { title: 'Sticker Bundle Two', tags: ['sticker', 'bundle'], channel: 'shopify' },
  ];
  const URL_A = 'https://craft-stats.test/halloween';
  const URL_B = 'https://seller-guide.test/seasonal';
  async function research(trendPayload) {
    const originals = { search: tavilyClient.search, send: aiProviderSelector.sendMessage, configured: aiProviderSelector.isConfigured };
    const saved = { AI_PROVIDER: process.env.AI_PROVIDER, SEARCH_PROVIDER: process.env.SEARCH_PROVIDER, TAVILY_API_KEY: process.env.TAVILY_API_KEY, SEARCH_FALLBACK_PROVIDERS: process.env.SEARCH_FALLBACK_PROVIDERS };
    Object.assign(process.env, { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key' });
    delete process.env.SEARCH_FALLBACK_PROVIDERS;
    try {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [URL_A, URL_B].map((url) => ({ url, title: 't', content: 'c', provider: 'tavily' })) });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => ({
        text: JSON.stringify({
          candidates: [{ product: 'Sticker Bundle', market: 'stickers', keywords: ['sticker'], why_related: 'Adjacent.', source: [URL_A, URL_B] }],
          validated: [{ product: 'Sticker Bundle', demand: { assessment: 'x', value: null, grade: 'inferred' }, competition: { assessment: 'y', value: null, grade: 'inferred' }, trend: trendPayload, commercial: { assessment: 'z', grade: 'inferred' }, source: [URL_A, URL_B] }],
        }),
        model: 'm', stopReason: 'STOP', usage: {}, raw: {},
      });
      return await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
    } finally {
      tavilyClient.search = originals.search;
      aiProviderSelector.sendMessage = originals.send;
      aiProviderSelector.isConfigured = originals.configured;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  await testAsync('LIVE RESEARCH: an AI label alone never becomes the trend - kept as source_assessment, trend NOT VERIFIED', async () => {
    const r = await research({ classification: 'growing', assessment: 'Booming everywhere.', grade: 'inferred', observations: [] });
    const t = r.top_opportunities[0].trend;
    assert.strictEqual(t.classification, 'unknown');
    assert.strictEqual(t.verification, 'NOT_VERIFIED');
    assert.strictEqual(t.source_assessment.classification, 'growing');
    assert.ok(r.limitations.some((line) => /Trend is NOT VERIFIED/.test(line)));
  });

  await testAsync('LIVE RESEARCH: dated values a cited page states decide the trend, with source, provider and window', async () => {
    const values = [10, 10, 11, 12, 12, 13, 14, 15, 20, 45, 18, 11, 11, 10, 12, 12, 13, 13, 15, 16, 22, 50, 19, 12];
    const observations = values.map((value, index) => ({
      date: `${2024 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
      value,
      unit: 'index',
      metric: 'interest',
      source: URL_A,
    }));
    const r = await research({ classification: 'growing', assessment: 'Rising.', grade: 'inferred', observations });
    const t = r.top_opportunities[0].trend;
    assert.strictEqual(t.classification, 'seasonal', 'the dated evidence wins over the label');
    assert.strictEqual(t.verification, 'VERIFIED');
    assert.strictEqual(t.source_assessment.classification, 'growing');
    assert.deepStrictEqual(t.evidence_sources, [URL_A]);
    assert.deepStrictEqual(t.providers, ['tavily']);
    assert.strictEqual(t.time_window.days > 600, true);
    assert.ok(t.observations.every((o) => o.grade === 'OBSERVED' && o.source === URL_A));
  });

  await testAsync('LIVE RESEARCH: observations citing a page search never returned, or with invented dates, are dropped', async () => {
    const r = await research({
      classification: 'fad',
      grade: 'inferred',
      observations: [
        { date: '2024-01', value: 10, unit: 'index', metric: 'interest', source: 'https://model-invented.test/x' },
        { date: 'recently', value: 90, unit: 'index', metric: 'interest', source: URL_A },
        { date: '2024-02', value: 'lots', unit: 'index', metric: 'interest', source: URL_A },
      ],
    });
    const t = r.top_opportunities[0].trend;
    assert.deepStrictEqual(t.observations, []);
    assert.strictEqual(t.classification, 'unknown');
    assert.ok(!JSON.stringify(r).includes('model-invented.test'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
