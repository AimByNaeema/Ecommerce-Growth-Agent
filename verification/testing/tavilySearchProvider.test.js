'use strict';

// Tavily as a web-search provider, behind the search abstraction that keeps SEARCH_PROVIDER
// independent of AI_PROVIDER.
//
// THE CONTRACT THESE TESTS DEFEND: a URL is evidence because a SEARCH TOOL returned it.
// Not because a model wrote it. Several tests exist only to pin that, under every provider
// combination, because it is the single assumption the whole research pipeline rests on.
//
// AND: a failure must keep its meaning. "The allowance is gone" and "we searched and found
// nothing" have different fixes, so they must never collapse into one status.
//
// NO NETWORK, NO REAL KEY. Every Tavily and AI response here is mocked.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const tavilyClient = require('../../integrations/adapters/tavilyClient');
const webSearchProvider = require('../../agent/core/webSearchProvider');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const geminiClient = require('../../agent/core/geminiClient');
const claudeClient = require('../../agent/core/claudeClient');
const { createToolResultCache } = require('../../agent/core/toolResultCache');
const workflow = require('../../workflows/customerMarketOpportunityWorkflow');
const { normalizeUsage, totalTokensFromUsage } = require('../../agent/core/tokenControls');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

const TEST_TAVILY_KEY = 'test-tavily-key-not-real';

function tavilyBody() {
  return {
    query: 'sticker bundles',
    results: [
      { title: 'A', url: 'https://real-search.test/a', content: 'Sticker bundles are widely sold.', score: 0.91 },
      { title: 'B', url: 'https://real-search.test/b', content: 'Planner inserts in demand.', score: 0.83 },
      { title: '', url: '', content: 'no url - must be dropped' },
    ],
    response_time: 1.2,
  };
}

function mockFetch(status, body, capture) {
  return async (url, options) => {
    if (capture) {
      capture.url = url;
      capture.options = options;
      capture.body = options && options.body ? JSON.parse(options.body) : null;
    }
    return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body };
  };
}

// Restores whatever the suite touched, unconditionally.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

(async () => {
  const originalFetch = global.fetch;
  const originalTavilySearch = tavilyClient.search;
  const originalSend = aiProviderSelector.sendMessage;
  const originalConfigured = aiProviderSelector.isConfigured;
  tavilyClient.loadEnvOnce();

  // -------------------------------------------------------------------------------------
  // 1-3. Tavily success, normalization, URL extraction.
  // -------------------------------------------------------------------------------------

  await testAsync('1. a successful Tavily search returns SEARCH_OK with real results', async () => {
    await withEnv({ TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      const capture = {};
      global.fetch = mockFetch(200, tavilyBody(), capture);
      const out = await tavilyClient.search({ query: 'sticker bundles', maxResults: 5 });
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.status, 'SEARCH_OK');
      assert.strictEqual(out.provider, 'tavily');
      assert.strictEqual(out.results.length, 2, 'the result with no url must be dropped, not kept blank');
      assert.strictEqual(capture.body.query, 'sticker bundles');
      assert.strictEqual(capture.body.max_results, 5);
      assert.strictEqual(capture.options.headers.authorization, `Bearer ${TEST_TAVILY_KEY}`);
    });
  });

  test('2. Tavily results normalize to the shared shape, inventing nothing', () => {
    const full = tavilyClient.normalizeResult({ url: 'https://x.test/1', title: 'T', content: 'C', score: 0.5, published_date: '2026-01-01' });
    assert.deepStrictEqual(full, { url: 'https://x.test/1', title: 'T', content: 'C', score: 0.5, published_date: '2026-01-01', provider: 'tavily' });
    // Absent fields stay null - never '' , which would read as a real but blank value.
    const sparse = tavilyClient.normalizeResult({ url: 'https://x.test/2' });
    assert.strictEqual(sparse.title, null);
    assert.strictEqual(sparse.content, null);
    assert.strictEqual(sparse.score, null);
    assert.strictEqual(tavilyClient.normalizeResult({ title: 'no url' }), null);
    assert.strictEqual(tavilyClient.normalizeResult(null), null);
  });

  test('3. verified URLs come from the search results, de-duplicated and in order', () => {
    const outcome = { results: [{ url: 'https://a.test' }, { url: 'https://b.test' }, { url: 'https://a.test' }, { url: null }] };
    assert.deepStrictEqual(webSearchProvider.verifiedUrlsFromSearch(outcome), ['https://a.test', 'https://b.test']);
    assert.deepStrictEqual(webSearchProvider.verifiedUrlsFromSearch(null), []);
    assert.deepStrictEqual(webSearchProvider.verifiedUrlsFromSearch({}), []);
  });

  // -------------------------------------------------------------------------------------
  // 4-10. Every failure keeps its own meaning.
  // -------------------------------------------------------------------------------------

  await testAsync('4. a missing Tavily key is SEARCH_PROVIDER_NOT_CONFIGURED, and makes no request', async () => {
    await withEnv({ TAVILY_API_KEY: undefined }, async () => {
      let called = false;
      global.fetch = async () => { called = true; throw new Error('should not be reached'); };
      const out = await tavilyClient.search({ query: 'x' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.status, 'SEARCH_PROVIDER_NOT_CONFIGURED');
      assert.strictEqual(called, false, 'no request may be attempted without a key');
      assert.ok(/TAVILY_API_KEY is not set/.test(out.detail));
      assert.ok(!/Bearer/.test(JSON.stringify(out)), 'no credential material in the outcome');
    });
  });

  const FAILURES = [
    [402, 'plan credits exhausted', 'SEARCH_QUOTA_EXCEEDED', '5. quota exceeded'],
    [432, 'usage limit', 'SEARCH_QUOTA_EXCEEDED', '5b. plan-limit code'],
    [429, 'Too many requests', 'SEARCH_RATE_LIMITED', '6. rate limited'],
    [429, 'You exceeded your credit quota', 'SEARCH_QUOTA_EXCEEDED', '6b. 429 that is really a quota'],
    [401, 'invalid api key', 'SEARCH_AUTH_FAILED', '7. auth failure'],
    [403, 'forbidden', 'SEARCH_AUTH_FAILED', '7b. forbidden'],
    [503, 'unavailable', 'SEARCH_PROVIDER_UNAVAILABLE', '8. provider unavailable'],
    [418, 'weird', 'SEARCH_UNKNOWN_ERROR', '10. unknown error'],
  ];
  for (const [status, message, expected, label] of FAILURES) {
    await testAsync(`${label} -> ${expected}`, async () => {
      await withEnv({ TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
        global.fetch = mockFetch(status, { detail: message });
        const out = await tavilyClient.search({ query: 'x' });
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.status, expected, `HTTP ${status} "${message}"`);
        assert.notStrictEqual(out.status, 'SEARCH_OK');
        assert.strictEqual(out.results.length, 0);
      });
    });
  }

  await testAsync('9. a network failure is SEARCH_NETWORK_ERROR, not "no results"', async () => {
    await withEnv({ TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      global.fetch = async () => { throw new Error('ECONNREFUSED'); };
      const out = await tavilyClient.search({ query: 'x' });
      assert.strictEqual(out.status, 'SEARCH_NETWORK_ERROR');
      assert.strictEqual(out.results.length, 0);
    });
  });

  test('9b. every status the adapter can emit is in the shared vocabulary', () => {
    for (const status of ['SEARCH_AUTH_FAILED', 'SEARCH_QUOTA_EXCEEDED', 'SEARCH_RATE_LIMITED', 'SEARCH_PROVIDER_UNAVAILABLE', 'SEARCH_UNKNOWN_ERROR']) {
      assert.ok(webSearchProvider.SEARCH_STATUSES.includes(status), `${status} must be declared once, centrally`);
    }
    // An empty result set is NOT an error - it is a real research answer.
    assert.ok(!webSearchProvider.isOperationalFailure('SEARCH_OK'));
    assert.ok(webSearchProvider.isOperationalFailure('SEARCH_QUOTA_EXCEEDED'));
    assert.ok(webSearchProvider.isOperationalFailure('SEARCH_PROVIDER_NOT_CONFIGURED'));
  });

  test('9c. each status has a user-facing message that leaks no provider internals', () => {
    for (const status of webSearchProvider.SEARCH_STATUSES) {
      const message = webSearchProvider.userFacingStatusMessage(status);
      assert.ok(typeof message === 'string' && message.length > 0, `${status} needs a message`);
      assert.ok(!/api[_ -]?key|token|bearer|tavily|gemini|anthropic|http \d/i.test(message), `${status} message leaks internals: ${message}`);
    }
    assert.ok(/allowance has been reached/i.test(webSearchProvider.userFacingStatusMessage('SEARCH_QUOTA_EXCEEDED')));
    assert.ok(/not configured/i.test(webSearchProvider.userFacingStatusMessage('SEARCH_PROVIDER_NOT_CONFIGURED')));
  });

  // -------------------------------------------------------------------------------------
  // 11. Search provider selection, independent of AI provider.
  // -------------------------------------------------------------------------------------

  await testAsync('11. SEARCH_PROVIDER selects the provider and its execution mode', async () => {
    await withEnv({ SEARCH_PROVIDER: 'tavily' }, async () => {
      assert.strictEqual(webSearchProvider.getActiveSearchProvider(), 'tavily');
      assert.strictEqual(webSearchProvider.getSearchProviderMode(), 'external');
    });
    await withEnv({ SEARCH_PROVIDER: 'gemini_grounding' }, async () => {
      assert.strictEqual(webSearchProvider.getSearchProviderMode(), 'model_native');
    });
    await withEnv({ SEARCH_PROVIDER: undefined }, async () => {
      assert.strictEqual(webSearchProvider.getActiveSearchProvider(), 'claude_web_search', 'the default must preserve existing behaviour');
      assert.strictEqual(webSearchProvider.getSearchProviderMode(), 'model_native');
    });
    await withEnv({ SEARCH_PROVIDER: 'nonsense' }, async () => {
      assert.throws(() => webSearchProvider.getActiveSearchProvider(), /Unrecognized SEARCH_PROVIDER/);
    });
  });

  await testAsync('11b. AI_PROVIDER and SEARCH_PROVIDER are genuinely independent', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily' }, async () => {
      assert.strictEqual(aiProviderSelector.getActiveProvider(), 'gemini');
      assert.strictEqual(webSearchProvider.getActiveSearchProvider(), 'tavily');
    });
    await withEnv({ AI_PROVIDER: 'claude', SEARCH_PROVIDER: 'tavily' }, async () => {
      assert.strictEqual(aiProviderSelector.getActiveProvider(), 'claude', 'choosing Tavily must not change the AI provider');
      assert.strictEqual(webSearchProvider.getActiveSearchProvider(), 'tavily');
    });
  });

  test('11c. a model-native provider cannot be invoked as a separate search step', async () => {
    const out = await webSearchProvider.search({ query: 'x', providerId: 'claude_web_search' });
    assert.strictEqual(out.ok, false);
    assert.ok(/model-native/.test(out.detail));
  });

  // -------------------------------------------------------------------------------------
  // 12, 17, 16. Gemini + Tavily together, and what counts as evidence.
  // -------------------------------------------------------------------------------------

  function mockAi(payload, capture) {
    return async ({ messages }) => {
      if (capture) capture.prompt = messages[0].content;
      return {
        text: JSON.stringify(payload),
        model: 'gemini-3.6-flash',
        stopReason: 'STOP',
        usage: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
        raw: {},
      };
    };
  }

  const BUSINESS = { business_name: 'T', product_categories: ['stickers', 'planners', 'clipart'] };
  const CATALOGUE = [
    { title: 'Sticker Pack', tags: ['sticker', 'bundle'], channel: 'shopify' },
    { title: 'Planner Insert', tags: ['planner', 'bundle'], channel: 'etsy' },
    { title: 'Clipart Set', tags: ['clipart', 'bundle'], channel: 'shopify' },
    { title: 'Sticker Bundle Two', tags: ['sticker', 'bundle'], channel: 'shopify' },
  ];

  await testAsync('12 & 17. Tavily retrieves, Gemini reasons, Tavily URLs become evidence', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      let searches = 0;
      const capture = {};
      tavilyClient.search = async ({ query }) => {
        searches += 1;
        return { ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', title: 'A', content: 'Widely sold.', score: 0.9, provider: 'tavily' }], usage: { credits: 1 } };
      };
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = mockAi({
        candidates: [{ product: 'Sticker Bundle', market: 'stickers', keywords: ['sticker'], why_related: 'Adjacent.', source: ['https://real-search.test/a'] }],
        validated: [{ product: 'Sticker Bundle', demand: { assessment: 'Widely sold.', value: null, grade: 'inferred' }, competition: { assessment: 'Crowded.', value: null, grade: 'inferred' }, trend: { classification: 'stable', assessment: 'Steady.', grade: 'inferred' }, commercial: { assessment: 'Low.', grade: 'inferred' }, source: ['https://real-search.test/a'] }],
      }, capture);

      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.ok(searches > 0, 'Tavily must actually be called');
      assert.strictEqual(r.research_summary.search.provider, 'tavily');
      assert.strictEqual(r.research_summary.search.mode, 'external');
      assert.ok(/SEARCH RESULTS/.test(capture.prompt), 'real results must be handed to the model');
      assert.ok(/real-search\.test\/a/.test(capture.prompt));
      assert.ok(r.top_opportunities.length > 0, 'a Tavily-sourced opportunity must survive');
      assert.ok(
        r.top_opportunities[0].evidence.some((e) => e.source_url === 'https://real-search.test/a'),
        'the Tavily URL must be carried as evidence'
      );
      assert.strictEqual(r.search_status, 'SEARCH_OK');
    });
  });

  await testAsync('16. a URL the MODEL invented never becomes evidence, even alongside real ones', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({
        ok: true, status: 'SEARCH_OK', provider: 'tavily', query,
        results: [{ url: 'https://real-search.test/a', title: 'A', content: 'Real.', score: 0.9, provider: 'tavily' }],
      });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = mockAi({
        candidates: [
          { product: 'Real Find', market: 'stickers', why_related: 'From search.', source: ['https://real-search.test/a'] },
          { product: 'Invented Find', market: 'stickers', why_related: 'Made up.', source: ['https://model-invented.test/fake'] },
        ],
        validated: [],
      });
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      const serialized = JSON.stringify(r);
      assert.ok(!/model-invented\.test/.test(serialized), 'a model-written URL must not appear anywhere in the result');
      assert.ok(!/Invented Find/.test(serialized), 'a candidate with no verified source must be dropped entirely');
    });
  });

  // -------------------------------------------------------------------------------------
  // 13-15. Claude and Gemini both remain first-class.
  // -------------------------------------------------------------------------------------

  test('13. Claude remains fully present and functional', () => {
    for (const fn of ['sendMessage', 'isConfigured', 'extractText', 'extractWebSearchResultUrls', 'extractCitations', 'DEFAULT_MODEL']) {
      assert.ok(fn in claudeClient, `claudeClient.${fn} must still exist`);
    }
    assert.ok(fs.existsSync(path.join(__dirname, '../../agent/core/claudeClient.js')));
    assert.deepStrictEqual(
      claudeClient.extractWebSearchResultUrls([{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://c.test/1' }] }]),
      ['https://c.test/1'],
      "Claude's own web-search extraction must be untouched"
    );
    assert.ok(webSearchProvider.SEARCH_PROVIDERS.claude_web_search, 'Claude web search must remain a selectable provider');
  });

  test('14. Gemini remains fully present and functional', () => {
    for (const fn of ['sendMessage', 'isConfigured', 'extractText', 'extractWebSearchResultUrls', 'requestsWebSearch', 'DEFAULT_MODEL']) {
      assert.ok(fn in geminiClient, `geminiClient.${fn} must still exist`);
    }
    assert.ok(fs.existsSync(path.join(__dirname, '../../agent/core/geminiClient.js')));
  });

  test('15. Gemini Google Search grounding remains available and intact', () => {
    assert.ok(webSearchProvider.SEARCH_PROVIDERS.gemini_grounding, 'grounding must remain a selectable search provider');
    assert.strictEqual(webSearchProvider.SEARCH_PROVIDERS.gemini_grounding.mode, 'model_native');
    assert.strictEqual(geminiClient.requestsWebSearch([{ name: 'web_search' }]), true);
    assert.deepStrictEqual(
      geminiClient.extractWebSearchResultUrls([{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://g.test/1' } }] } }]),
      ['https://g.test/1']
    );
  });

  await testAsync('15b. AI_PROVIDER=claude still routes URL extraction to Claude', async () => {
    await withEnv({ AI_PROVIDER: 'claude' }, async () => {
      assert.deepStrictEqual(
        aiProviderSelector.extractWebSearchResultUrls({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://c.test/2' }] }] }),
        ['https://c.test/2']
      );
    });
  });

  // -------------------------------------------------------------------------------------
  // 18. The existing cache prevents a duplicate billed search.
  // -------------------------------------------------------------------------------------

  await testAsync('18. an identical query within one run is a cache hit, not a second search', async () => {
    await withEnv({ SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      let calls = 0;
      tavilyClient.search = async ({ query }) => {
        calls += 1;
        return { ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://a.test', provider: 'tavily' }] };
      };
      const cache = createToolResultCache();
      const first = await webSearchProvider.search({ query: 'sticker bundles', cache });
      const second = await webSearchProvider.search({ query: '  STICKER   Bundles ', cache });
      assert.strictEqual(calls, 1, 'an equivalent query must not be billed twice');
      assert.strictEqual(first.cached, false);
      assert.strictEqual(second.cached, true);
      assert.deepStrictEqual(second.results, first.results);
    });
  });

  await testAsync('18b. a FAILED search is never cached', async () => {
    await withEnv({ SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      let calls = 0;
      tavilyClient.search = async ({ query }) => {
        calls += 1;
        return { ok: false, status: 'SEARCH_QUOTA_EXCEEDED', provider: 'tavily', query, results: [], detail: 'quota' };
      };
      const cache = createToolResultCache();
      await webSearchProvider.search({ query: 'x', cache });
      await webSearchProvider.search({ query: 'x', cache });
      assert.strictEqual(calls, 2, 'a quota failure must not be memoized as if it were an answer');
    });
  });

  // -------------------------------------------------------------------------------------
  // 19. A failed fresh search does not destroy existing research.
  // -------------------------------------------------------------------------------------

  await testAsync('19. a quota failure yields a classified status, not a fabricated result', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: false, status: 'SEARCH_QUOTA_EXCEEDED', provider: 'tavily', query, results: [], detail: 'Tavily search failed (432): usage limit' });
      aiProviderSelector.isConfigured = () => true;
      let aiCalls = 0;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; return { text: '{}', model: 'm', stopReason: 'STOP', usage: {}, raw: {} }; };

      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.strictEqual(r.search_status, 'SEARCH_QUOTA_EXCEEDED', 'the operational cause must survive to the result');
      assert.notStrictEqual(r.status, 'complete', 'a run whose search failed operationally is never complete');
      assert.strictEqual(aiCalls, 0, 'no tokens may be spent once search has already failed');
      assert.deepStrictEqual(r.top_opportunities, [], 'nothing may be invented to fill the gap');
      assert.ok(r.limitations.some((l) => /allowance has been reached/i.test(l)), 'the user-facing reason must be stated');
      assert.ok(r.research_summary.stages.some((s) => s.search_status === 'SEARCH_QUOTA_EXCEEDED'));
    });
  });

  await testAsync('19b. an unconfigured search provider stops before spending anything', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: undefined }, async () => {
      let aiCalls = 0;
      let searches = 0;
      tavilyClient.search = async () => { searches += 1; return { ok: false, status: 'SEARCH_UNKNOWN_ERROR', results: [] }; };
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; return { text: '{}', raw: {}, usage: {} }; };
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.strictEqual(r.search_status, 'SEARCH_PROVIDER_NOT_CONFIGURED');
      assert.strictEqual(searches, 0, 'no search may be attempted');
      assert.strictEqual(aiCalls, 0, 'no tokens may be spent');
      assert.ok(/not configured/i.test(r.search_status_message));
      // The real market scope survives - it came from real business data, not from search.
      assert.ok(r.market_scope && r.market_scope.primary_market, 'existing derived context must be preserved');
    });
  });

  // -------------------------------------------------------------------------------------
  // 20-22. Secrets, token accounting, and fewer-than-10.
  // -------------------------------------------------------------------------------------

  await testAsync('20. no secret reaches a result object', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://a.test', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = mockAi({ candidates: [{ product: 'P', market: 'stickers', why_related: 'r', source: ['https://a.test'] }], validated: [] });
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      const serialized = JSON.stringify(r);
      assert.ok(!serialized.includes(TEST_TAVILY_KEY), 'the search key must never appear in a result');
      for (const pattern of [/authorization/i, /"api_key"/i, /bearer /i, /tavily_api_key/i]) {
        assert.ok(!pattern.test(serialized), `credential-shaped content in result: ${pattern}`);
      }
    });
  });

  test('20b. the adapter never writes the key into its own outcome', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../integrations/adapters/tavilyClient.js'), 'utf8');
    const code = source.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    // Every line that touches the key must be resolving it, testing it, or putting it in the
    // Authorization header - never returning it, logging it, or building a message from it.
    const keyLines = code.split('\n').filter((line) => /apiKey/.test(line));
    assert.ok(keyLines.length > 0, 'the adapter does read a key');
    for (const line of keyLines) {
      const legitimate =
        /resolveCredentials|const \{ apiKey \}|apiKey\.trim\(\)|!apiKey|authorization: `Bearer \$\{apiKey\}`|return \{ apiKey:/.test(line);
      assert.ok(legitimate, `unexpected use of the key: ${line.trim()}`);
      assert.ok(!/console\.|detail:|results:|throw new Error/.test(line), `the key must not be logged, returned or thrown: ${line.trim()}`);
    }
    assert.strictEqual((code.match(/Bearer \$\{apiKey\}/g) || []).length, 1, 'the key leaves this module in exactly one place');
  });

  await testAsync('21. token accounting stays provider-aware, including thinking tokens', async () => {
    assert.deepStrictEqual(normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 }), { input: 100, output: 50 });
    assert.strictEqual(totalTokensFromUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 }), 150);
    assert.deepStrictEqual(normalizeUsage({ input_tokens: 7, output_tokens: 3 }), { input: 7, output: 3 });

    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://a.test', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = mockAi({ candidates: [{ product: 'P', market: 'stickers', why_related: 'r', source: ['https://a.test'] }], validated: [] });
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.ok(r.research_summary.usage.tokensUsed > 0, 'Gemini token spend must be recorded, never 0');
      // Search cost is tracked SEPARATELY from token cost.
      assert.ok(r.research_summary.search.requests > 0);
      assert.ok('cacheHits' in r.research_summary.search && 'cacheMisses' in r.research_summary.search);
    });
  });

  await testAsync('22. fewer than 10 opportunities is a valid result, never padded', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://a.test', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = mockAi({
        candidates: [{ product: 'Only One', market: 'stickers', why_related: 'r', source: ['https://a.test'] }],
        validated: [{ product: 'Only One', demand: { assessment: 'a', value: null, grade: 'inferred' }, competition: { assessment: 'b', value: null, grade: 'inferred' }, trend: { classification: 'stable', assessment: 'c', grade: 'inferred' }, commercial: { assessment: 'd', grade: 'inferred' }, source: ['https://a.test'] }],
      });
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1, limit: 10 });
      assert.ok(r.top_opportunities.length < 10);
      assert.ok(r.top_opportunities.length >= 1);
      assert.ok(r.limitations.some((l) => /Remaining slots are deliberately left empty/.test(l)));
      // And no invented numbers on the one real opportunity.
      const o = r.top_opportunities[0];
      assert.strictEqual(o.demand.value, null, 'no source stated a demand number, so it stays null');
      assert.strictEqual(o.competition.value, null);
    });
  });

  // Regression from a real run: 3 Tavily searches executed but only 2 were recorded, because
  // the unparsable-JSON return path dropped the search outcome. A search is billed the moment
  // it runs - an unusable model answer afterwards does not un-bill it.
  await testAsync('22c. a Tavily search is counted even when the model answer is unparsable', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      let searches = 0;
      tavilyClient.search = async ({ query }) => {
        searches += 1;
        return { ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', title: 'A', content: 'Real.', score: 0.9, provider: 'tavily' }] };
      };
      aiProviderSelector.isConfigured = () => true;
      // Discovery returns usable JSON; the deep-validation call returns prose, exactly as the
      // real run did.
      let call = 0;
      aiProviderSelector.sendMessage = async () => {
        call += 1;
        const usable = JSON.stringify({ candidates: [{ product: 'Sticker Bundle', market: 'stickers', why_related: 'Adjacent.', source: ['https://real-search.test/a'] }] });
        return {
          text: call === 1 ? usable : 'I was unable to produce a structured answer.',
          model: 'gemini-3.6-flash',
          stopReason: 'STOP',
          usage: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 5 },
          raw: {},
        };
      };

      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.ok(searches >= 2, `the validation search must actually run (ran ${searches})`);
      assert.ok(
        r.research_summary.stages.some((s) => s.stage === 'validation' && s.status === 'failed'),
        'the validation stage must report its failure honestly'
      );
      assert.strictEqual(
        r.research_summary.search.requests,
        searches,
        `every executed search must be recorded: ${searches} ran, ${r.research_summary.search.requests} recorded`
      );
    });
  });

  // ---------------------------------------------------------------------------------------
  // 23. The validation-stage failure found in a real run, and its fix.
  //
  // REPRODUCED AGAINST THE LIVE API: in external mode the system prompt still said "Use the
  // web_search tool", but external mode supplies NO tools. Gemini attempted a function call
  // that could not exist and terminated with finishReason MALFORMED_FUNCTION_CALL and an
  // EMPTY text part, which the pipeline could only report as "not a parsable JSON result".
  // Replacing that one directive returned valid JSON with all 7 entries.
  // ---------------------------------------------------------------------------------------

  test('23. external mode removes the tool directive and nothing else', () => {
    const adapted = workflow.adaptSystemPromptForExternalSearch(workflow.VALIDATION_SYSTEM_PROMPT);
    assert.ok(!/Use the web_search tool/.test(adapted), 'the model must not be told to call a tool it was not given');
    assert.ok(/no tools available/i.test(adapted), 'it must be told plainly that it has no tools');
    assert.ok(/SEARCH RESULTS supplied/i.test(adapted), 'it must be pointed at the supplied results instead');
    // The rules that keep the result honest are untouched.
    assert.ok(/NEVER invent search volume, revenue, market size/.test(adapted), 'the never-invent rule must survive');
    assert.ok(/cited by exact URL/.test(adapted), 'the provenance rule must survive');
    assert.ok(/"unknown" is a correct answer/.test(adapted), 'unavailable must remain an allowed answer');
    assert.ok(/Return ONLY a JSON object/.test(adapted), 'the strict schema must survive');
    // Same treatment for discovery, which carries the identical directive.
    assert.ok(!/Use the web_search tool/.test(workflow.adaptSystemPromptForExternalSearch(workflow.DISCOVERY_SYSTEM_PROMPT)));
  });

  test('23b. the model-native prompts are left exactly as they were', () => {
    assert.ok(workflow.VALIDATION_SYSTEM_PROMPT.includes('Use the web_search tool'), 'Claude/Gemini-grounding must still be told to search');
    assert.ok(workflow.DISCOVERY_SYSTEM_PROMPT.includes('Use the web_search tool'));
    assert.strictEqual(workflow.adaptSystemPromptForExternalSearch(null), null, 'a non-string is passed through untouched');
  });

  await testAsync('23c. external mode sends the adapted prompt and no tools; model-native sends neither change', async () => {
    const seen = { external: null, native: null };
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', title: 'A', content: 'Real.', score: 0.9, provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async ({ system, tools }) => {
        seen.external = { system, tools };
        return { text: JSON.stringify({ candidates: [{ product: 'P', market: 'stickers', why_related: 'r', source: ['https://real-search.test/a'] }] }), model: 'g', stopReason: 'STOP', usage: {}, raw: {} };
      };
      await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
    });
    assert.ok(seen.external, 'the external call must have happened');
    assert.strictEqual(seen.external.tools, undefined, 'external mode must send no tools');
    assert.ok(!/Use the web_search tool/.test(seen.external.system), 'external mode must not ask for a tool call');

    await withEnv({ AI_PROVIDER: 'claude', SEARCH_PROVIDER: 'claude_web_search' }, async () => {
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async ({ system, tools }) => {
        seen.native = { system, tools };
        return {
          text: '',
          model: 'c',
          stopReason: 'end_turn',
          usage: {},
          raw: { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://real-search.test/a' }] }, { type: 'text', text: JSON.stringify({ candidates: [{ product: 'P', market: 'stickers', why_related: 'r', source: ['https://real-search.test/a'] }] }) }] },
        };
      };
      await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
    });
    assert.ok(seen.native, 'the model-native call must have happened');
    assert.deepStrictEqual(seen.native.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }], 'Claude must still get its hosted tool');
    assert.ok(/Use the web_search tool/.test(seen.native.system), 'model-native mode must keep the tool directive');
  });

  await testAsync('23d. an empty provider response is reported as such, naming the stop reason', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      // Exactly what the live API returned: an empty text part, MALFORMED_FUNCTION_CALL.
      aiProviderSelector.sendMessage = async () => ({ text: '', model: 'gemini-3.6-flash', stopReason: 'MALFORMED_FUNCTION_CALL', usage: { promptTokenCount: 1131, candidatesTokenCount: 26, thoughtsTokenCount: 669 }, raw: { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] } });

      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      const failed = r.research_summary.stages.filter((s) => s.status === 'failed');
      assert.ok(failed.length > 0, 'the failure must be recorded');
      assert.ok(
        failed.some((s) => /returned no text at all/.test(s.detail) && /MALFORMED_FUNCTION_CALL/.test(s.detail)),
        `the stop reason must be named, got: ${JSON.stringify(failed.map((s) => s.detail))}`
      );
      // And it must still not fabricate anything to cover the gap.
      assert.deepStrictEqual(r.top_opportunities, []);
    });
  });

  await testAsync('23e. unparsable-but-present text keeps its own distinct reason', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => ({ text: 'I could not answer that.', model: 'g', stopReason: 'STOP', usage: {}, raw: {} });
      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.ok(
        r.research_summary.stages.some((s) => s.status === 'failed' && /did not return a parsable JSON result/.test(s.detail)),
        'text that is present but not JSON must keep the parse-failure reason'
      );
    });
  });

  await testAsync('23f. a fenced JSON answer still parses, and only searched URLs become evidence', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: TEST_TAVILY_KEY }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', title: 'A', content: 'Real.', score: 0.9, provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      const payload = {
        candidates: [{ product: 'Sticker Bundle', market: 'stickers', why_related: 'Adjacent.', source: ['https://real-search.test/a'] }],
        validated: [{
          product: 'Sticker Bundle',
          demand: { assessment: 'Widely sold.', value: null, grade: 'inferred' },
          competition: { assessment: 'Crowded.', value: null, grade: 'inferred' },
          trend: { classification: 'stable', assessment: 'Steady.', grade: 'inferred' },
          commercial: { assessment: 'Low.', grade: 'inferred' },
          // One real source and one the model made up.
          source: ['https://real-search.test/a', 'https://model-invented.test/fake'],
        }],
      };
      aiProviderSelector.sendMessage = async () => ({ text: '```json\n' + JSON.stringify(payload) + '\n```', model: 'g', stopReason: 'STOP', usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, raw: {} });

      const r = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1 });
      assert.strictEqual(r.top_opportunities.length, 1, 'the fenced answer must parse');
      const o = r.top_opportunities[0];
      assert.ok(o.scores.evidence_coverage > 0, 'a genuinely validated opportunity must score non-zero coverage');
      const urls = o.evidence.map((e) => e.source_url);
      assert.ok(urls.includes('https://real-search.test/a'), 'the searched URL is evidence');
      assert.ok(!urls.includes('https://model-invented.test/fake'), 'the invented URL must never be evidence');
      assert.ok(!JSON.stringify(r).includes('model-invented.test'), 'it must not appear anywhere in the result');
      // Values a source never stated stay null - never zero.
      assert.strictEqual(o.demand.value, null);
      assert.strictEqual(o.competition.value, null);
    });
  });

  test('22b. no second search system, engine or provider selector was created', () => {
    const provider = fs.readFileSync(path.join(__dirname, '../../agent/core/webSearchProvider.js'), 'utf8');
    assert.ok(!/fetch\(/.test(provider), 'the abstraction must own no HTTP call');
    assert.ok(provider.includes("require('./toolResultCache')"), 'it must reuse the existing cache, not add one');
    assert.ok(!/class .*Cache|new Map\(\)/.test(provider), 'it must not implement its own cache');
    const wf = fs.readFileSync(path.join(__dirname, '../../workflows/customerMarketOpportunityWorkflow.js'), 'utf8');
    const code = wf.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(!/require\(.*tavilyClient/.test(code), 'the workflow must not reach past the abstraction to a provider');
    assert.ok(!/require\(.*geminiClient|require\(.*claudeClient/.test(code), 'nor to an AI client directly');
    assert.ok(code.includes("require('../agent/core/webSearchProvider')"));
  });

  global.fetch = originalFetch;
  tavilyClient.search = originalTavilySearch;
  aiProviderSelector.sendMessage = originalSend;
  aiProviderSelector.isConfigured = originalConfigured;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
