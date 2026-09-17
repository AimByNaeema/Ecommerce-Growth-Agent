'use strict';

// Cross-run, cross-session reuse of live market research (agent/core/externalResearchMemory.js), stored in
// the EXISTING run history store. Research results come from the real workflow with provider seams mocked;
// run records are written through the real runHistoryStore into a temporary directory. No network.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../../agent/core/externalResearchMemory');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const tavilyClient = require('../../integrations/adapters/tavilyClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const workflow = require('../../workflows/customerMarketOpportunityWorkflow');

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

const STORE = 'shopify:test-store';
const BUSINESS = { business_name: 'T', product_categories: ['stickers', 'planners', 'clipart'] };
const CATALOGUE = [
  { title: 'Sticker Pack', tags: ['sticker', 'bundle'], channel: 'shopify' },
  { title: 'Planner Insert', tags: ['planner', 'bundle'], channel: 'etsy' },
  { title: 'Clipart Set', tags: ['clipart', 'bundle'], channel: 'shopify' },
  { title: 'Sticker Bundle Two', tags: ['sticker', 'bundle'], channel: 'shopify' },
];
const URLS = ['https://source-one.test/a', 'https://source-two.test/b'];

// Runs the real workflow with mocked providers. `searchStatus` forces a provider failure.
async function research({ storeDir, reuseResearch = true, searchStatus = 'SEARCH_OK', catalogue = CATALOGUE, requestedMarkets = [], businessId = null, competitionValue = null, now = Date.now() }) {
  const originals = { search: tavilyClient.search, send: aiProviderSelector.sendMessage, configured: aiProviderSelector.isConfigured };
  const saved = { AI_PROVIDER: process.env.AI_PROVIDER, SEARCH_PROVIDER: process.env.SEARCH_PROVIDER, TAVILY_API_KEY: process.env.TAVILY_API_KEY, SEARCH_FALLBACK_PROVIDERS: process.env.SEARCH_FALLBACK_PROVIDERS };
  Object.assign(process.env, { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key' });
  delete process.env.SEARCH_FALLBACK_PROVIDERS;
  const calls = { search: 0, ai: 0 };
  try {
    tavilyClient.search = async ({ query }) => {
      calls.search += 1;
      if (searchStatus !== 'SEARCH_OK') return { ok: false, status: searchStatus, provider: 'tavily', query, results: [], detail: 'mocked failure' };
      return { ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: URLS.map((url) => ({ url, title: 't', content: 'c', provider: 'tavily' })) };
    };
    aiProviderSelector.isConfigured = () => true;
    aiProviderSelector.sendMessage = async () => {
      calls.ai += 1;
      return {
        text: JSON.stringify({
          candidates: [{ product: 'Sticker Bundle', market: 'stickers', keywords: ['sticker'], why_related: 'Adjacent.', source: URLS }],
          validated: [{
            product: 'Sticker Bundle',
            demand: { assessment: 'Sold widely.', value: null, grade: 'inferred' },
            competition: competitionValue === null ? { assessment: 'Crowded.', value: null, grade: 'inferred' } : { assessment: 'Listings counted on page.', value: competitionValue, unit: 'listings', grade: 'measured' },
            trend: { classification: 'stable', assessment: 'Steady.', grade: 'inferred', observations: [] },
            commercial: { assessment: 'Low.', grade: 'inferred' },
            source: URLS,
          }],
        }),
        model: 'm', stopReason: 'STOP', usage: {}, raw: {},
      };
    };
    const result = await workflow.runCustomerMarketOpportunityResearch({
      businessConfig: BUSINESS, catalogue, discoveryBatches: 1, reuseResearch, storeReference: STORE, researchStoreDir: storeDir, requestedMarkets, businessId, now,
    });
    return { result, calls };
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

// Persists a research result the way a Chief run does: one run record whose plan step carries the tool output.
function store(storeDir, result, { runId, businessId = null, sessionId = 'session-1', createdAt = new Date().toISOString() }) {
  runHistoryStore.saveRunRecord({
    run_id: runId,
    kind: 'orchestrate',
    objective: 'What should this store sell next?',
    status: 'success',
    session_id: sessionId,
    business_id: businessId,
    created_at: createdAt,
    result: { routing: { plan: [{ inputs: { tool_id: 'catalogue_expansion_opportunities' }, outputs: { status: result.status === 'complete' ? 'success' : 'partial', result } }] } },
  }, { storeDir });
}

function tempStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'external-research-memory-'));
}

(async () => {
  test('RESEARCH KEY: the same question gives the same key; any change of scope, market, store or business does not', () => {
    const base = { toolId: 'catalogue_expansion_opportunities', businessId: null, storeReference: STORE, scope: { primary_market: 'Stickers', related_markets: ['planners', 'clipart'], geographies: [] }, requestedMarkets: ['United Kingdom'], limit: 10 };
    const key = memory.buildResearchKey(base);
    assert.strictEqual(memory.buildResearchKey({ ...base, scope: { primary_market: 'stickers', related_markets: ['clipart', 'planners'] } }), key, 'order and case do not change the question');
    for (const change of [
      { scope: { ...base.scope, primary_market: 'fonts' } },
      { scope: { ...base.scope, buyer_intents: ['font'] } },
      { requestedMarkets: ['Canada'] },
      { storeReference: 'shopify:another-store' },
      { businessId: 'another-business' },
      { limit: 5 },
    ]) {
      assert.notStrictEqual(memory.buildResearchKey({ ...base, ...change }), key, JSON.stringify(change));
    }
  });

  await testAsync('REUSE: a successful, fresh result is served from the stored run - no search, no model call, provenance intact', async () => {
    const storeDir = tempStore();
    try {
      const first = await research({ storeDir });
      assert.strictEqual(first.result.status, 'complete', JSON.stringify(first.result.limitations));
      assert.strictEqual(first.result.research_memory.mode, 'fresh');
      store(storeDir, first.result, { runId: 'cc-run-first', sessionId: 'session-A' });

      // A different session, later: the question is found through the store, not the session.
      const second = await research({ storeDir });
      assert.strictEqual(second.calls.search, 0);
      assert.strictEqual(second.calls.ai, 0);
      assert.strictEqual(second.result.research_memory.mode, 'reused');
      assert.strictEqual(second.result.research_memory.source_run_id, 'cc-run-first');
      assert.strictEqual(second.result.research_memory.research_id, first.result.research_memory.research_id, 'the research identity is the original');
      assert.deepStrictEqual(second.result.top_opportunities[0].evidence, first.result.top_opportunities[0].evidence, 'every source and timestamp survives reuse');
      assert.deepStrictEqual(second.result.research_summary.sources_used, first.result.research_summary.sources_used);
      assert.ok(/Reused live research from run cc-run-first/.test(second.result.limitations[0]));
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('STALE: research past the freshness limit is refreshed with live research, and says so', async () => {
    const storeDir = tempStore();
    const previous = process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV];
    try {
      const first = await research({ storeDir });
      store(storeDir, first.result, { runId: 'cc-run-old' });
      process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV] = '1';
      const later = await research({ storeDir, now: Date.now() + 2 * 60 * 60 * 1000 });
      assert.ok(later.calls.search > 0, 'live research ran again');
      assert.strictEqual(later.result.research_memory.mode, 'refreshed');
      assert.ok(/older than the 1-hour limit/.test(later.result.research_memory.reason));
    } finally {
      if (previous === undefined) delete process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV];
      else process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV] = previous;
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('FAILED RESEARCH: a provider failure is stored but never reused as evidence', async () => {
    const storeDir = tempStore();
    try {
      const failedRun = await research({ storeDir, searchStatus: 'SEARCH_QUOTA_EXCEEDED' });
      assert.notStrictEqual(failedRun.result.status, 'complete');
      store(storeDir, failedRun.result, { runId: 'cc-run-failed' });
      // Within the failed-research cooldown the same failure is reported again - still a failure, never evidence -
      // and no provider is called.
      const repeat = await research({ storeDir });
      assert.strictEqual(repeat.calls.search, 0, 'no provider call for a just-failed identical question');
      assert.strictEqual(repeat.result.research_memory.mode, 'failure_cooldown');
      assert.strictEqual(repeat.result.search_status, 'SEARCH_QUOTA_EXCEEDED', 'reported as the failure it was');
      assert.notStrictEqual(repeat.result.status, 'complete');
      // With no cooldown (or once it has passed) the failed research is not reused, and live research runs.
      const savedCooldown = process.env.RESEARCH_FAILURE_COOLDOWN_MINUTES;
      process.env.RESEARCH_FAILURE_COOLDOWN_MINUTES = '0';
      let next;
      try {
        next = await research({ storeDir });
      } finally {
        if (savedCooldown === undefined) delete process.env.RESEARCH_FAILURE_COOLDOWN_MINUTES;
        else process.env.RESEARCH_FAILURE_COOLDOWN_MINUTES = savedCooldown;
      }
      assert.ok(next.calls.search > 0, 'the failed research was not served');
      assert.strictEqual(next.result.research_memory.mode, 'fresh');
      assert.ok(/did not complete successfully/.test(next.result.research_memory.reason));
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('CHANGED QUESTION: a different requested market or catalogue scope is never answered with old research', async () => {
    const storeDir = tempStore();
    try {
      const first = await research({ storeDir });
      store(storeDir, first.result, { runId: 'cc-run-scope' });
      const otherMarket = await research({ storeDir, requestedMarkets: ['Australia'] });
      assert.ok(otherMarket.calls.search > 0);
      assert.strictEqual(otherMarket.result.research_memory.mode, 'fresh');
      assert.deepStrictEqual(otherMarket.result.market_scope.requested_markets, ['Australia']);
      const otherCatalogue = await research({ storeDir, catalogue: [{ title: 'Font Bundle', tags: ['font'], channel: 'shopify' }, { title: 'Script Font Pack', tags: ['font'], channel: 'shopify' }, { title: 'Serif Font Set', tags: ['font'], channel: 'shopify' }] });
      assert.notStrictEqual(otherCatalogue.result.research_memory && otherCatalogue.result.research_memory.mode, 'reused');
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('TENANT ISOLATION: one business\'s stored research never reaches another', async () => {
    const storeDir = tempStore();
    try {
      const first = await research({ storeDir, businessId: 'business-a' });
      store(storeDir, first.result, { runId: 'cc-run-a', businessId: 'business-a' });
      const other = await research({ storeDir, businessId: 'business-b' });
      assert.ok(other.calls.search > 0);
      assert.strictEqual(other.result.research_memory.mode, 'fresh');
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('OPT-IN: without reuseResearch a direct call never reads stored research', async () => {
    const storeDir = tempStore();
    try {
      const first = await research({ storeDir });
      store(storeDir, first.result, { runId: 'cc-run-optin' });
      const direct = await research({ storeDir, reuseResearch: false });
      assert.ok(direct.calls.search > 0);
      assert.strictEqual(direct.result.research_memory.mode, 'fresh');
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await testAsync('TREND OVER RUNS: measured values recorded by repeated research build a real series for the trend', async () => {
    const storeDir = tempStore();
    const previous = process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV];
    process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV] = '0.000001';
    try {
      const values = [100, 115, 130, 150, 170];
      const start = Date.parse('2026-01-05T00:00:00Z');
      for (let i = 0; i < values.length; i += 1) {
        const r = await research({ storeDir, competitionValue: values[i] });
        const signal = r.result.top_opportunities[0].competition;
        // Date each stored observation as the week it was researched.
        signal.retrieved_at = new Date(start + i * 14 * 24 * 60 * 60 * 1000).toISOString();
        store(storeDir, r.result, { runId: `cc-run-week-${i}`, createdAt: signal.retrieved_at });
      }
      const history = memory.collectHistoricalObservations({ toolId: 'catalogue_expansion_opportunities', productKey: 'Sticker Bundle', storeDir });
      assert.strictEqual(history.length, 5);
      assert.ok(history.every((o) => o.grade === 'MEASURED' && o.metric === 'competition:listings' && o.provider === 'tavily'));
      const latest = await research({ storeDir, competitionValue: 190 });
      const t = latest.result.top_opportunities[0].trend;
      assert.strictEqual(t.verification, 'VERIFIED');
      assert.strictEqual(t.classification, 'growing');
      assert.strictEqual(t.observations_used, 6);
    } finally {
      if (previous === undefined) delete process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV];
      else process.env[memory.EXTERNAL_RESEARCH_MAX_AGE_ENV] = previous;
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
