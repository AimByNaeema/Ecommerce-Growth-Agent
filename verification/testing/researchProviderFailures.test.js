'use strict';

// Provider failures in live market research are classified, never reported as success, and fallback
// goes only to providers that can genuinely serve the request.
//
// THE DEFECT THIS PINS (found by the Global Research Audit): with SEARCH_PROVIDER=gemini_grounding a real
// Gemini 429 "You exceeded your current quota" ended discovery with no results - and the run reported
// search_status SEARCH_OK, because a failure raised inside a model-native call carried no status at all.
// The same was true of Anthropic's "credit balance is too low", a 401, a timeout, an unreadable answer
// and an empty grounding result.
//
// NO NETWORK, NO REAL KEY. Provider responses are mocked at the same seams the existing
// tavilySearchProvider suite uses (tavilyClient.search, aiProviderSelector.sendMessage), so the real
// workflow, provider chain, classifier and status logic all run unchanged. Engineering verification only.

const assert = require('node:assert');

const tavilyClient = require('../../integrations/adapters/tavilyClient');
const webSearchProvider = require('../../agent/core/webSearchProvider');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const workflow = require('../../workflows/customerMarketOpportunityWorkflow');

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

const BUSINESS = { business_name: 'T', product_categories: ['stickers', 'planners', 'clipart'] };
const CATALOGUE = [
  { title: 'Sticker Pack', tags: ['sticker', 'bundle'], channel: 'shopify' },
  { title: 'Planner Insert', tags: ['planner', 'bundle'], channel: 'etsy' },
  { title: 'Clipart Set', tags: ['clipart', 'bundle'], channel: 'shopify' },
  { title: 'Sticker Bundle Two', tags: ['sticker', 'bundle'], channel: 'shopify' },
];

// A Gemini grounding response: the answer text plus the URLs Google Search itself returned.
function groundedResponse(payload, urls) {
  return {
    text: JSON.stringify(payload),
    model: 'gemini-test',
    stopReason: 'STOP',
    usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
    raw: { candidates: [{ groundingMetadata: { groundingChunks: urls.map((uri) => ({ web: { uri } })) } }] },
  };
}

const DISCOVERY = { candidates: [{ product: 'Sticker Bundle', market: 'stickers', keywords: ['sticker'], why_related: 'Adjacent.', source: ['https://grounded.test/a'] }] };

function run(options = {}) {
  return workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS, catalogue: CATALOGUE, discoveryBatches: 1, ...options });
}

(async () => {
  const originalTavilySearch = tavilyClient.search;
  const originalSend = aiProviderSelector.sendMessage;
  const originalConfigured = aiProviderSelector.isConfigured;
  tavilyClient.loadEnvOnce();
  const restore = () => {
    tavilyClient.search = originalTavilySearch;
    aiProviderSelector.sendMessage = originalSend;
    aiProviderSelector.isConfigured = originalConfigured;
  };

  // ---- Classification -------------------------------------------------------------------------------
  test('CLASSIFY: real provider failure messages map to explicit statuses', () => {
    const cases = [
      ['Gemini API request failed (429): You exceeded your current quota, please check your plan and billing details.', 'SEARCH_QUOTA_EXCEEDED'],
      ['Claude API request failed (400): Your credit balance is too low to access the Anthropic API.', 'SEARCH_QUOTA_EXCEEDED'],
      ['Gemini API request failed (401): Request had invalid authentication credentials.', 'SEARCH_AUTH_FAILED'],
      ['Claude API request failed (403): permission denied', 'SEARCH_AUTH_FAILED'],
      ['Gemini API request failed (429): Resource has been exhausted (e.g. check quota).', 'SEARCH_RATE_LIMITED'],
      ['Claude API request failed (529): Overloaded', 'SEARCH_PROVIDER_UNAVAILABLE'],
      ['Request timed out after 30000ms', 'SEARCH_TIMEOUT'],
      ['Could not reach the Gemini API: fetch failed', 'SEARCH_NETWORK_ERROR'],
      ['Gemini API returned a success response with an unexpected/missing content shape.', 'SEARCH_MALFORMED_RESULTS'],
      ['something nobody anticipated', 'SEARCH_UNKNOWN_ERROR'],
    ];
    for (const [message, expected] of cases) {
      assert.strictEqual(webSearchProvider.classifyProviderFailure(message), expected, message);
    }
    for (const status of ['SEARCH_TIMEOUT', 'SEARCH_EMPTY_RESULTS', 'SEARCH_MALFORMED_RESULTS', 'SEARCH_UNSUPPORTED_CAPABILITY']) {
      assert.ok(webSearchProvider.SEARCH_STATUSES.includes(status), status);
      assert.ok(webSearchProvider.userFacingStatusMessage(status) !== webSearchProvider.userFacingStatusMessage('SEARCH_OK'), status);
    }
    assert.ok(webSearchProvider.isOperationalFailure('SEARCH_TIMEOUT'), 'a timeout is an outage, and may fall back');
    assert.ok(!webSearchProvider.isOperationalFailure('SEARCH_EMPTY_RESULTS'), 'empty results are an answer, not an outage');
  });

  // ---- Never SEARCH_OK after a failure ------------------------------------------------------------
  const neverOk = [
    ['Gemini grounding quota exhausted (429)', 'Gemini API request failed (429): You exceeded your current quota', 'SEARCH_QUOTA_EXCEEDED'],
    ['invalid Gemini key (401)', 'Gemini API request failed (401): Request had invalid authentication credentials.', 'SEARCH_AUTH_FAILED'],
    ['provider timeout', 'Request timed out after 30000ms', 'SEARCH_TIMEOUT'],
    ['provider overloaded (503)', 'Gemini API request failed (503): The model is overloaded.', 'SEARCH_PROVIDER_UNAVAILABLE'],
  ];
  for (const [label, message, expected] of neverOk) {
    await testAsync(`MODEL-NATIVE FAILURE (${label}): reported as ${expected}, never SEARCH_OK, nothing invented`, async () => {
      await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding', SEARCH_FALLBACK_PROVIDERS: undefined }, async () => {
        aiProviderSelector.isConfigured = () => true;
        aiProviderSelector.sendMessage = async () => { throw new Error(message); };
        const r = await run();
        assert.strictEqual(r.search_status, expected);
        assert.notStrictEqual(r.status, 'complete');
        assert.deepStrictEqual(r.top_opportunities, []);
        assert.ok(r.research_summary.stages.some((stage) => stage.stage === 'discovery' && stage.search_status === expected), JSON.stringify(r.research_summary.stages));
        assert.ok(r.research_summary.search.attempts.every((attempt) => attempt.status !== 'SEARCH_OK'));
        assert.ok(r.limitations.some((line) => line.includes(expected)));
      }).finally(restore);
    });
  }

  await testAsync('EMPTY RESULTS: a grounded answer with no URLs from search is SEARCH_EMPTY_RESULTS, not success', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding', SEARCH_FALLBACK_PROVIDERS: undefined }, async () => {
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => groundedResponse(DISCOVERY, []);
      const r = await run();
      assert.strictEqual(r.search_status, 'SEARCH_EMPTY_RESULTS');
      assert.deepStrictEqual(r.top_opportunities, []);
    }).finally(restore);
  });

  await testAsync('MALFORMED RESULTS: an unreadable answer is SEARCH_MALFORMED_RESULTS, not success', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'gemini_grounding', SEARCH_FALLBACK_PROVIDERS: undefined }, async () => {
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => ({ ...groundedResponse({}, ['https://grounded.test/a']), text: 'Here are some ideas, not JSON.' });
      const r = await run();
      assert.strictEqual(r.search_status, 'SEARCH_MALFORMED_RESULTS');
      assert.notStrictEqual(r.status, 'complete');
    }).finally(restore);
  });

  await testAsync('EXTERNAL EMPTY RESULTS: Tavily returning nothing is SEARCH_EMPTY_RESULTS and spends no AI call', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: undefined }, async () => {
      let aiCalls = 0;
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; return groundedResponse(DISCOVERY, []); };
      const r = await run();
      assert.strictEqual(r.search_status, 'SEARCH_EMPTY_RESULTS');
      assert.strictEqual(aiCalls, 0);
    }).finally(restore);
  });

  await testAsync('AI LAYER FAILURE after a good search: the AI provider\'s own failure is reported, not SEARCH_OK', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: 'gemini_grounding' }, async () => {
      let aiCalls = 0;
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: 'https://real-search.test/a', title: 'A', content: 'x', provider: 'tavily' }] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; throw new Error('Gemini API request failed (429): You exceeded your current quota'); };
      const r = await run();
      assert.strictEqual(r.search_status, 'SEARCH_QUOTA_EXCEEDED');
      assert.strictEqual(aiCalls, 1, 'another SEARCH provider cannot fix a failed AI provider, so no fallback is spent');
      assert.deepStrictEqual(r.research_summary.search.attempts.map((a) => [a.provider, a.status, a.layer]), [['tavily', 'SEARCH_QUOTA_EXCEEDED', 'ai']]);
    }).finally(restore);
  });

  // ---- Fallback -------------------------------------------------------------------------------------
  await testAsync('FALLBACK: Tavily quota exhausted -> configured Gemini grounding succeeds; the run is OK and both attempts are recorded', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: 'gemini_grounding' }, async () => {
      tavilyClient.search = async ({ query }) => ({ ok: false, status: 'SEARCH_QUOTA_EXCEEDED', provider: 'tavily', query, results: [], detail: 'Tavily search failed (432): usage limit' });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async ({ tools }) => {
        assert.ok(Array.isArray(tools) && tools.length === 1, 'the grounding fallback searches inside the AI call');
        return groundedResponse(DISCOVERY, ['https://grounded.test/a']);
      };
      const r = await run();
      const attempts = r.research_summary.search.attempts;
      assert.deepStrictEqual(attempts.slice(0, 2).map((a) => [a.provider, a.status]), [['tavily', 'SEARCH_QUOTA_EXCEEDED'], ['gemini_grounding', 'SEARCH_OK']]);
      assert.strictEqual(r.research_summary.search.fallbacksUsed >= 1, true);
      assert.ok(r.candidate_count.discovered >= 1, 'the fallback provider\'s verified candidate survived');
      assert.notStrictEqual(r.search_status, 'SEARCH_QUOTA_EXCEEDED', 'a failure the fallback recovered from does not fail the run');
    }).finally(restore);
  });

  await testAsync('FALLBACK LIMITS: never to a provider that cannot serve the active AI provider, and not after an empty result', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: 'claude_web_search, not-a-provider' }, async () => {
      assert.deepStrictEqual(webSearchProvider.getSearchProviderChain({ aiProviderId: 'gemini' }), ['tavily'], 'Anthropic web_search cannot run inside a Gemini call; an unknown name is ignored');
    });
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-key', SEARCH_FALLBACK_PROVIDERS: 'gemini_grounding' }, async () => {
      let aiCalls = 0;
      tavilyClient.search = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [] });
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; return groundedResponse(DISCOVERY, ['https://grounded.test/a']); };
      const r = await run();
      assert.strictEqual(aiCalls, 0, 'an empty result is an answer; another provider is not tried');
      assert.strictEqual(r.search_status, 'SEARCH_EMPTY_RESULTS');
    }).finally(restore);
  });

  await testAsync('UNSUPPORTED CAPABILITY: Anthropic web_search configured while the AI provider is Gemini is refused before any call', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', SEARCH_PROVIDER: 'claude_web_search', SEARCH_FALLBACK_PROVIDERS: undefined }, async () => {
      let aiCalls = 0;
      aiProviderSelector.isConfigured = () => true;
      aiProviderSelector.sendMessage = async () => { aiCalls += 1; return groundedResponse(DISCOVERY, ['https://grounded.test/a']); };
      const r = await run();
      assert.strictEqual(r.search_status, 'SEARCH_UNSUPPORTED_CAPABILITY');
      assert.strictEqual(aiCalls, 0, 'no call is spent on a search the AI provider cannot perform');
    }).finally(restore);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
