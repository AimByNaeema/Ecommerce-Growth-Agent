'use strict';

// Live competitor research through the shared research call (agent/core/liveResearchCall.js): any configured
// provider, classified failures, fallback, and graded provenance.
//
// PINS THE AUDIT FINDING: live_competitor_research was bound to Anthropic alone, so "Your credit balance is too
// low" made competitor research unavailable although other providers were configured. Provider seams are mocked
// (tavilyClient.search, aiProviderSelector.sendMessage); the real tool, call, chain, verification and grading run.
// Engineering verification only - no live competitor data is claimed.

const assert = require('node:assert');

const tavilyClient = require('../../integrations/adapters/tavilyClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const { runWebCompetitorResearchTool, describeCompetitorEvidence } = require('../../tools/webCompetitorResearchTool');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

const URL_SHOP = 'https://clipart-shop.test/bundles';
const URL_MARKET = 'https://design-market.test/svg';

async function withProviders({ env, search, send }, fn) {
  const originals = { search: tavilyClient.search, send: aiProviderSelector.sendMessage, configured: aiProviderSelector.isConfigured };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  tavilyClient.loadEnvOnce();
  try {
    if (search) tavilyClient.search = search;
    aiProviderSelector.isConfigured = () => true;
    aiProviderSelector.sendMessage = send;
    return await fn();
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

const COMPETITORS = {
  topic: 'SVG bundle competitors',
  competitors: [
    {
      competitor: 'Clipart Shop',
      market: 'United States',
      productCategory: 'SVG bundles',
      positioning: 'Low-price mega bundles.',
      pricingEvidence: ['$4.99 for a 500-design bundle', 'Frequent discounts'],
      opportunities: ['No commercial licence tier'],
      source: [URL_SHOP],
    },
    { competitor: 'Invented Co', market: 'US', productCategory: 'SVG', positioning: 'Made up.', pricingEvidence: ['$1'], source: ['https://model-invented.test/x'] },
    { competitor: 'Design Market', market: 'Global', productCategory: 'Clipart', source: [URL_MARKET] },
  ],
  recommendations: ['Offer a commercial licence tier.'],
};

(async () => {
  test('GRADES: a quoted price is OBSERVED, a description is INFERRED, anything absent is UNKNOWN', () => {
    const graded = describeCompetitorEvidence(COMPETITORS.competitors[0], { provider: 'tavily', retrievedAt: '2026-09-16T00:00:00.000Z' });
    assert.deepStrictEqual(graded.pricing_evidence.map((p) => p.grade), ['OBSERVED', 'INFERRED']);
    assert.strictEqual(graded.positioning.grade, 'INFERRED');
    assert.deepStrictEqual(graded.catalogue_gaps.map((g) => g.grade), ['INFERRED']);
    const bare = describeCompetitorEvidence(COMPETITORS.competitors[2], { provider: 'tavily', retrievedAt: '2026-09-16T00:00:00.000Z' });
    assert.deepStrictEqual(bare.pricing_evidence, [{ text: null, grade: 'UNKNOWN' }], 'no price is ever estimated');
    assert.deepStrictEqual(bare.positioning, { text: null, grade: 'UNKNOWN' });
    for (const price of ['£3.50 each', 'EUR 12', '19.99 USD']) {
      assert.strictEqual(describeCompetitorEvidence({ pricingEvidence: [price], source: [] }, {}).pricing_evidence[0].grade, 'OBSERVED', price);
    }
  });

  await testAsync('TAVILY + GEMINI: competitor research runs without Anthropic; verified competitors only, with provenance', async () => {
    let aiCalls = 0;
    const outcome = await withProviders({
      env: { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: undefined },
      search: async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [URL_SHOP, URL_MARKET].map((url) => ({ url, title: 't', content: 'c', provider: 'tavily' })) }),
      send: async ({ tools }) => {
        aiCalls += 1;
        assert.ok(!tools, 'external mode offers the model no search tool');
        return { text: JSON.stringify(COMPETITORS), model: 'gemini-test', stopReason: 'STOP', usage: { promptTokenCount: 50, candidatesTokenCount: 25 }, raw: {} };
      },
    }, () => runWebCompetitorResearchTool({ objective: 'Research my top competitors for SVG bundles: pricing, positioning and gaps.' }));

    assert.strictEqual(aiCalls, 1);
    assert.strictEqual(outcome.status, 'partial', 'the invented competitor was dropped');
    assert.strictEqual(outcome.search_status, 'SEARCH_OK');
    assert.deepStrictEqual(outcome.result.specialized_records.map((r) => r.competitor), ['Clipart Shop', 'Design Market']);
    assert.ok(!JSON.stringify(outcome).includes('model-invented.test'), 'an unverified URL appears nowhere');
    const provenance = outcome.result.provenance;
    assert.strictEqual(provenance.provider, 'tavily');
    assert.strictEqual(provenance.mode, 'external');
    assert.ok(Date.parse(provenance.retrieved_at) > 0);
    assert.deepStrictEqual(provenance.search_attempts.map((a) => [a.provider, a.status]), [['tavily', 'SEARCH_OK']]);
    assert.strictEqual(provenance.competitors[0].pricing_evidence[0].grade, 'OBSERVED');
    assert.strictEqual(provenance.competitors[0].validation.status, 'insufficient_corroboration', 'one site is one source');
    assert.strictEqual(outcome.tokensUsed, 75, 'real usage is counted');
  });

  await testAsync('FALLBACK: Tavily allowance exhausted -> Gemini grounding answers; both attempts are on record', async () => {
    const outcome = await withProviders({
      env: { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: 'gemini_grounding' },
      search: async ({ query }) => ({ ok: false, status: 'SEARCH_QUOTA_EXCEEDED', provider: 'tavily', query, results: [], detail: 'Tavily search failed (432): usage limit' }),
      send: async () => ({
        text: JSON.stringify(COMPETITORS),
        model: 'gemini-test',
        stopReason: 'STOP',
        usage: {},
        raw: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: URL_SHOP } }] } }] },
      }),
    }, () => runWebCompetitorResearchTool({ objective: 'Research my competitors for SVG bundles.' }));
    assert.strictEqual(outcome.search_status, 'SEARCH_OK');
    assert.deepStrictEqual(outcome.search_attempts.map((a) => [a.provider, a.status]), [['tavily', 'SEARCH_QUOTA_EXCEEDED'], ['gemini_grounding', 'SEARCH_OK']]);
    assert.deepStrictEqual(outcome.result.specialized_records.map((r) => r.competitor), ['Clipart Shop'], 'only what grounding really returned');
    assert.strictEqual(outcome.result.provenance.provider, 'gemini_grounding');
  });

  const failures = [
    ['Anthropic credit exhausted', { AI_PROVIDER: 'claude', SEARCH_PROVIDER: 'claude_web_search', ANTHROPIC_API_KEY: 'sk-ant-test' }, 'Claude API request failed (400): Your credit balance is too low to access the Anthropic API.', 'SEARCH_QUOTA_EXCEEDED'],
    ['Gemini grounding quota', { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding' }, 'Gemini API request failed (429): You exceeded your current quota', 'SEARCH_QUOTA_EXCEEDED'],
    ['invalid Gemini key', { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding' }, 'Gemini API request failed (401): Request had invalid authentication credentials.', 'SEARCH_AUTH_FAILED'],
    ['provider timeout', { AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding' }, 'Request timed out after 30000ms', 'SEARCH_TIMEOUT'],
  ];
  for (const [label, env, message, expected] of failures) {
    await testAsync(`PROVIDER FAILURE (${label}): failed with ${expected} - never empty, never fabricated`, async () => {
      const outcome = await withProviders({
        env: { ...env, SEARCH_FALLBACK_PROVIDERS: undefined },
        send: async () => { throw new Error(message); },
      }, () => runWebCompetitorResearchTool({ objective: 'Research my competitors for SVG bundles.' }));
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.result, null);
      assert.strictEqual(outcome.search_status, expected);
      assert.ok(outcome.search_status_message && outcome.search_status_message !== 'Live market research ran normally.');
      assert.ok(outcome.error.includes(message.slice(0, 25)), outcome.error);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
