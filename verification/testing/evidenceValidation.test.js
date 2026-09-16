'use strict';

// Multi-source evidence validation (agent/core/evidenceValidation.js) and its use on ranked research
// opportunities. Deterministic: no network, no model. The workflow case mocks only the provider seams
// (tavilyClient.search, aiProviderSelector.sendMessage) - engineering verification, not a live claim.

const assert = require('node:assert');

const ev = require('../../agent/core/evidenceValidation');
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
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

(async () => {
  test('DOMAINS: subdomains are one source, country suffixes are distinct, non-URLs are no source', () => {
    assert.strictEqual(ev.sourceDomain('https://shop.example.com/a'), 'example.com');
    assert.strictEqual(ev.sourceDomain('https://www.example.com/b'), 'example.com');
    assert.strictEqual(ev.sourceDomain('https://news.example.co.uk/c'), 'example.co.uk');
    assert.notStrictEqual(ev.sourceDomain('https://example.co.uk'), ev.sourceDomain('https://example.com'));
    assert.strictEqual(ev.sourceDomain('not a url'), null);
    assert.strictEqual(ev.sourceDomain('javascript:alert(1)'), null);
  });

  test('INDEPENDENCE: five pages from one site are one independent source, all five kept as support', () => {
    const claims = [1, 2, 3, 4, 5].map((n) => ({ source_url: `https://blog.samesite.com/post-${n}`, grade: 'inferred' }));
    const result = ev.validateEvidence({ claims, minIndependentSources: 2 });
    assert.strictEqual(result.independent_source_count, 1);
    assert.strictEqual(result.supporting_sources.length, 5, 'every supporting source is preserved');
    assert.strictEqual(result.same_domain_duplicates.length, 4);
    assert.strictEqual(result.status, 'insufficient_corroboration');
    assert.strictEqual(result.confidence, 'low', 'insufficient corroboration never becomes strong validation');
  });

  test('CORROBORATION: two independent domains corroborate; high confidence also needs a measured or observed claim', () => {
    const inferred = ev.validateEvidence({ claims: [{ source_url: 'https://a.test/1', grade: 'inferred' }, { source_url: 'https://b.test/2', grade: 'inferred' }], minIndependentSources: 2 });
    assert.strictEqual(inferred.status, 'corroborated');
    assert.strictEqual(inferred.confidence, 'medium');
    const observed = ev.validateEvidence({ claims: [{ source_url: 'https://a.test/1', grade: 'observed' }, { source_url: 'https://b.test/2', grade: 'inferred' }], minIndependentSources: 2 });
    assert.strictEqual(observed.confidence, 'high');
    assert.strictEqual(observed.strongest_grade, 'OBSERVED');
  });

  test('CONFIGURABLE MINIMUM: RESEARCH_MIN_INDEPENDENT_SOURCES sets the rule; invalid values fall back to the default', () => {
    const claims = [{ source_url: 'https://a.test/1', grade: 'observed' }, { source_url: 'https://b.test/2', grade: 'observed' }];
    const previous = process.env[ev.MIN_INDEPENDENT_SOURCES_ENV];
    try {
      process.env[ev.MIN_INDEPENDENT_SOURCES_ENV] = '3';
      assert.strictEqual(ev.validateEvidence({ claims }).status, 'insufficient_corroboration');
      process.env[ev.MIN_INDEPENDENT_SOURCES_ENV] = '0';
      assert.strictEqual(ev.getMinIndependentSources(), ev.DEFAULT_MIN_INDEPENDENT_SOURCES);
      process.env[ev.MIN_INDEPENDENT_SOURCES_ENV] = 'lots';
      assert.strictEqual(ev.getMinIndependentSources(), ev.DEFAULT_MIN_INDEPENDENT_SOURCES);
    } finally {
      if (previous === undefined) delete process.env[ev.MIN_INDEPENDENT_SOURCES_ENV];
      else process.env[ev.MIN_INDEPENDENT_SOURCES_ENV] = previous;
    }
  });

  test('CONFLICTS: disagreeing values or classifications lower confidence and every value is kept with its source', () => {
    const numeric = ev.validateEvidence({
      claims: [
        { source_url: 'https://a.test/1', grade: 'observed', metric: 'price', value: 5, unit: 'USD' },
        { source_url: 'https://b.test/2', grade: 'observed', metric: 'price', value: 20, unit: 'USD' },
      ],
      minIndependentSources: 2,
    });
    assert.strictEqual(numeric.status, 'conflicting');
    assert.strictEqual(numeric.confidence, 'medium', 'what would have been high drops a level');
    assert.deepStrictEqual(numeric.conflicts[0].values.map((v) => [v.value, v.source_url]), [[5, 'https://a.test/1'], [20, 'https://b.test/2']]);

    const close = ev.validateEvidence({
      claims: [
        { source_url: 'https://a.test/1', grade: 'observed', metric: 'price', value: 10, unit: 'USD' },
        { source_url: 'https://b.test/2', grade: 'observed', metric: 'price', value: 11, unit: 'USD' },
      ],
      minIndependentSources: 2,
    });
    assert.strictEqual(close.status, 'corroborated', 'values within tolerance agree');

    const trend = ev.validateEvidence({
      claims: [
        { source_url: 'https://a.test/1', grade: 'inferred', metric: 'trend', classification: 'growing' },
        { source_url: 'https://b.test/2', grade: 'inferred', metric: 'trend', classification: 'declining' },
      ],
      minIndependentSources: 2,
    });
    assert.strictEqual(trend.status, 'conflicting');
    assert.strictEqual(trend.confidence, 'low');

    const single = ev.validateEvidence({
      claims: [
        { source_url: 'https://a.test/1', grade: 'observed', metric: 'price', value: 5, unit: 'USD' },
        { source_url: 'https://a.test/2', grade: 'observed', metric: 'price', value: 50, unit: 'USD' },
      ],
      minIndependentSources: 2,
    });
    assert.strictEqual(single.confidence, 'low', 'a conflict never raises confidence above what corroboration allows');
  });

  test('NO FABRICATION: claims without a real http(s) source contribute nothing', () => {
    const result = ev.validateEvidence({ claims: [{ source_url: 'model said so', grade: 'measured' }, { source_url: null, grade: 'observed' }, {}] });
    assert.strictEqual(result.status, 'unverified');
    assert.strictEqual(result.confidence, 'none');
    assert.deepStrictEqual(result.supporting_sources, []);
    assert.strictEqual(result.strongest_grade, 'UNKNOWN', 'a grade on an unsourced claim is not evidence');
  });

  test('GRADES: the research model\'s grades map onto the validation vocabulary; anything else is UNKNOWN', () => {
    assert.deepStrictEqual(ev.EVIDENCE_VALIDATION_GRADES, ['MEASURED', 'OBSERVED', 'ESTIMATED', 'DERIVED', 'INFERRED', 'UNKNOWN']);
    assert.strictEqual(ev.toValidationGrade('measured'), 'MEASURED');
    assert.strictEqual(ev.toValidationGrade('estimated'), 'ESTIMATED');
    assert.strictEqual(ev.toValidationGrade('certain'), 'UNKNOWN');
  });

  // ---- On ranked research opportunities ----------------------------------------------------------
  const BUSINESS = { business_name: 'T', product_categories: ['stickers', 'planners', 'clipart'] };
  const CATALOGUE = [
    { title: 'Sticker Pack', tags: ['sticker', 'bundle'], channel: 'shopify' },
    { title: 'Planner Insert', tags: ['planner', 'bundle'], channel: 'etsy' },
    { title: 'Clipart Set', tags: ['clipart', 'bundle'], channel: 'shopify' },
    { title: 'Sticker Bundle Two', tags: ['sticker', 'bundle'], channel: 'shopify' },
  ];
  async function researchWith(urls) {
    const originalSearch = tavilyClient.search;
    const originalSend = aiProviderSelector.sendMessage;
    const originalConfigured = aiProviderSelector.isConfigured;
    try {
      return await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: undefined, RESEARCH_MIN_INDEPENDENT_SOURCES: undefined }, async () => {
        tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: urls.map((url) => ({ url, title: 't', content: 'c', provider: 'tavily' })) });
        aiProviderSelector.isConfigured = () => true;
        aiProviderSelector.sendMessage = async () => ({
          text: JSON.stringify({
            candidates: [{ product: 'Sticker Bundle', market: 'stickers', keywords: ['sticker'], why_related: 'Adjacent.', source: urls }],
            validated: [{ product: 'Sticker Bundle', demand: { assessment: 'Sold widely.', value: null, grade: 'inferred' }, competition: { assessment: 'Crowded.', value: null, grade: 'inferred' }, trend: { classification: 'stable', assessment: 'Steady.', grade: 'inferred' }, commercial: { assessment: 'Low price.', grade: 'inferred' }, source: urls }],
          }),
          model: 'm', stopReason: 'STOP', usage: {}, raw: {},
        });
        return workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      });
    } finally {
      tavilyClient.search = originalSearch;
      aiProviderSelector.sendMessage = originalSend;
      aiProviderSelector.isConfigured = originalConfigured;
    }
  }

  await testAsync('RANKED OPPORTUNITIES: corroborated by two independent domains, validation is attached and preserved', async () => {
    const r = await researchWith(['https://marketplace-one.test/a', 'https://guide-two.test/b']);
    const top = r.top_opportunities[0];
    assert.ok(top, JSON.stringify(r.limitations));
    assert.strictEqual(top.validation.status, 'corroborated');
    assert.strictEqual(top.validation.independent_source_count, 2);
    assert.ok(['medium', 'low'].includes(top.confidence), 'inferred-only evidence never reaches high');
  });

  await testAsync('RANKED OPPORTUNITIES: one site only is insufficient corroboration - low confidence, and said so', async () => {
    const r = await researchWith(['https://one-site.test/a', 'https://www.one-site.test/b']);
    const top = r.top_opportunities[0];
    assert.ok(top, JSON.stringify(r.limitations));
    assert.strictEqual(top.validation.status, 'insufficient_corroboration');
    assert.strictEqual(top.validation.independent_source_count, 1);
    assert.strictEqual(top.validation.supporting_sources.length, 2);
    assert.strictEqual(top.confidence, 'low');
    assert.ok(r.limitations.some((line) => /not corroborated by at least 2 independent source domain/.test(line)), JSON.stringify(r.limitations));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
