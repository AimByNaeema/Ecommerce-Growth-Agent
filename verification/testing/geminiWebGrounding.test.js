'use strict';

// Gemini web-search grounding, and the provider abstraction that lets the existing market
// research pipeline use it.
//
// THE POINT OF THESE TESTS IS THE EVIDENCE CONTRACT. Grounding is only useful here because
// it lets a URL be verified MECHANICALLY: a source counts because Google Search returned
// it, never because the model wrote it in prose. Several tests below exist purely to pin
// that a model-written URL is NOT verified evidence under either provider.
//
// NO NETWORK. Every Gemini/Claude response in this file is a mocked fetch.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const geminiClient = require('../../agent/core/geminiClient');
const claudeClient = require('../../agent/core/claudeClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const { normalizeUsage, totalTokensFromUsage, checkTokenBudget, getMaxTokensPerRun } = require('../../agent/core/tokenControls');

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

// The exact tool object the research workflow already passes.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };

// A Gemini response carrying real grounding chunks, plus a model-written URL in the prose
// that must NEVER be treated as verified.
function geminiGroundedResponse() {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Per my research, see https://model-invented.test/made-up for details.' }] },
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://real-search-result.test/a', title: 'A' } },
            { web: { uri: 'https://real-search-result.test/b', title: 'B' } },
            { web: { uri: 'https://real-search-result.test/a', title: 'A duplicate' } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 60, totalTokenCount: 200 },
    modelVersion: 'gemini-3.6-flash',
  };
}

function mockFetch(responseBody, capture) {
  return async (url, options) => {
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(options.body);
      capture.headers = options.headers;
    }
    return { ok: true, status: 200, json: async () => responseBody };
  };
}

(async () => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  geminiClient.loadEnvOnce();
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key-not-real';

  // -------------------------------------------------------------------------------------
  // 1-3. sendMessage accepts tools; web search maps to grounding; other calls unchanged.
  // -------------------------------------------------------------------------------------

  await testAsync('1. geminiClient.sendMessage accepts a `tools` argument', async () => {
    const capture = {};
    global.fetch = mockFetch(geminiGroundedResponse(), capture);
    const res = await geminiClient.sendMessage({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEB_SEARCH_TOOL],
      maxTokens: 8192,
    });
    assert.ok(res, 'a response must come back');
    assert.ok(capture.body, 'a request body must have been built');
  });

  await testAsync('2. the existing web-search tool maps to Gemini google_search grounding', async () => {
    const capture = {};
    global.fetch = mockFetch(geminiGroundedResponse(), capture);
    await geminiClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }], tools: [WEB_SEARCH_TOOL], maxTokens: 8192 });
    assert.deepStrictEqual(capture.body.tools, [{ google_search: {} }], 'the request must carry Gemini\'s own grounding tool');
    // Still the generateContent endpoint - no API migration.
    assert.ok(/:generateContent$/.test(capture.url), `must stay on generateContent, got ${capture.url}`);
    assert.ok(!/interactions/i.test(capture.url), 'must not migrate to the Interactions API');
  });

  await testAsync('3. a non-web Gemini call is byte-identical to before (no tools sent)', async () => {
    const capture = {};
    global.fetch = mockFetch(geminiGroundedResponse(), capture);
    await geminiClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }], system: 'sys', maxTokens: 512 });
    assert.ok(!('tools' in capture.body), 'an ordinary reasoning call must send no tools at all');
    assert.deepStrictEqual(Object.keys(capture.body).sort(), ['contents', 'generationConfig', 'systemInstruction']);
    assert.strictEqual(capture.body.generationConfig.maxOutputTokens, 512);
  });

  await testAsync('3b. a tool that is NOT web search is not silently mapped to search', async () => {
    const capture = {};
    global.fetch = mockFetch(geminiGroundedResponse(), capture);
    await geminiClient.sendMessage({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'calculator', type: 'custom_tool' }],
      maxTokens: 512,
    });
    assert.ok(!('tools' in capture.body), 'an unrelated tool must not become a search grant');
  });

  test('3c. requestsWebSearch matches on name, not a dated type string', () => {
    assert.strictEqual(geminiClient.requestsWebSearch([WEB_SEARCH_TOOL]), true);
    assert.strictEqual(geminiClient.requestsWebSearch([{ type: 'web_search_20260101', name: 'web_search' }]), true);
    assert.strictEqual(geminiClient.requestsWebSearch([{ name: 'calculator' }]), false);
    assert.strictEqual(geminiClient.requestsWebSearch([]), false);
    assert.strictEqual(geminiClient.requestsWebSearch(undefined), false);
  });

  // -------------------------------------------------------------------------------------
  // 4-6. Grounding URL extraction, and what is NOT evidence.
  // -------------------------------------------------------------------------------------

  test('4. Gemini grounding URL extraction returns the real chunk URIs, de-duplicated', () => {
    const urls = geminiClient.extractWebSearchResultUrls(geminiGroundedResponse().candidates);
    assert.deepStrictEqual(urls, ['https://real-search-result.test/a', 'https://real-search-result.test/b']);
  });

  test('5. missing / malformed grounding metadata returns []', () => {
    assert.deepStrictEqual(geminiClient.extractWebSearchResultUrls(undefined), []);
    assert.deepStrictEqual(geminiClient.extractWebSearchResultUrls([]), []);
    assert.deepStrictEqual(geminiClient.extractWebSearchResultUrls([{ content: { parts: [{ text: 'x' }] } }]), []);
    assert.deepStrictEqual(geminiClient.extractWebSearchResultUrls([{ groundingMetadata: {} }]), []);
    assert.deepStrictEqual(geminiClient.extractWebSearchResultUrls([{ groundingMetadata: { groundingChunks: [{}, { web: {} }] } }]), []);
  });

  test('6. a URL the MODEL WROTE is not treated as a verified search result', () => {
    const response = geminiGroundedResponse();
    const prose = geminiClient.extractText(response.candidates);
    assert.ok(prose.includes('https://model-invented.test/made-up'), 'the fixture must contain a model-written URL');
    const verified = geminiClient.extractWebSearchResultUrls(response.candidates);
    assert.ok(
      !verified.includes('https://model-invented.test/made-up'),
      'a URL that appears only in prose must never be verified evidence'
    );
  });

  test('6b. the same holds for Claude - prose URLs are not search results', () => {
    const content = [
      { type: 'text', text: 'See https://model-invented.test/made-up' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://real-search-result.test/a' }] },
    ];
    const verified = claudeClient.extractWebSearchResultUrls(content);
    assert.deepStrictEqual(verified, ['https://real-search-result.test/a']);
  });

  // -------------------------------------------------------------------------------------
  // 7. The provider selector exposes the active provider's extractor.
  // -------------------------------------------------------------------------------------

  test('7. the selector routes URL extraction to the active provider', () => {
    process.env.AI_PROVIDER = 'gemini';
    assert.deepStrictEqual(
      aiProviderSelector.extractWebSearchResultUrls({ candidates: geminiGroundedResponse().candidates }),
      ['https://real-search-result.test/a', 'https://real-search-result.test/b']
    );
    process.env.AI_PROVIDER = 'claude';
    assert.deepStrictEqual(
      aiProviderSelector.extractWebSearchResultUrls({
        content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://claude-side.test/x' }] }],
      }),
      ['https://claude-side.test/x']
    );
    process.env.AI_PROVIDER = 'gemini';
  });

  test('7b. the selector returns [] for a missing/!object raw response rather than throwing', () => {
    assert.deepStrictEqual(aiProviderSelector.extractWebSearchResultUrls(null), []);
    assert.deepStrictEqual(aiProviderSelector.extractWebSearchResultUrls(undefined), []);
    assert.deepStrictEqual(aiProviderSelector.extractWebSearchResultUrls('nope'), []);
  });

  test('7c. no second provider system was created', () => {
    const selector = fs.readFileSync(path.join(__dirname, '../../agent/core/aiProviderSelector.js'), 'utf8');
    assert.ok(selector.includes("require('./claudeClient')") && selector.includes("require('./geminiClient')"));
    assert.ok(!/fetch\(/.test(selector), 'the selector must make no HTTP call of its own');
    assert.ok(!/API_BASE_URL|generativelanguage|api\.anthropic/.test(selector), 'the selector must hold no endpoint of its own');
  });

  // -------------------------------------------------------------------------------------
  // 8. The research workflow goes through the selector.
  // -------------------------------------------------------------------------------------

  test('8. the research workflow uses the provider selector, not a Claude-only client', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../workflows/customerMarketOpportunityWorkflow.js'), 'utf8');
    const code = source.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(!code.includes('claudeClient'), 'the workflow must no longer depend on claudeClient directly');
    assert.ok(code.includes("require('../agent/core/aiProviderSelector')"), 'it must use the existing selector');
    assert.ok(code.includes('aiProviderSelector.extractWebSearchResultUrls'), 'URL verification must go through the selector');
    assert.ok(code.includes('aiProviderSelector.sendMessage'), 'the model call must go through the selector');
    // And it must still verify, not trust.
    assert.ok(code.includes('verifiedUrls'), 'the verification step must still exist');
  });

  test('8b. no second research engine or web-search tool was introduced', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../workflows/customerMarketOpportunityWorkflow.js'), 'utf8');
    assert.strictEqual((source.match(/WEB_SEARCH_TOOL\s*=/g) || []).length, 1, 'exactly one web-search tool definition');
    const gemini = fs.readFileSync(path.join(__dirname, '../../agent/core/geminiClient.js'), 'utf8');
    assert.strictEqual((gemini.match(/google_search/g) || []).length >= 1, true);
    // Comments may name the callers; the CODE must contain no research logic.
    const geminiCode = gemini.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(!/require\(.*(workflow|opportunity|research)/i.test(geminiCode), 'the client must not import research code');
    assert.ok(!/customerMarketOpportunity|opportunityCandidate|top_opportunities/.test(geminiCode), 'the client must hold no research logic');
  });

  // -------------------------------------------------------------------------------------
  // 9, 12. Token accounting and the per-run budget.
  // -------------------------------------------------------------------------------------

  test('9. Gemini usage is normalized, including thinking tokens', () => {
    const usage = { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 60, totalTokenCount: 200 };
    assert.deepStrictEqual(normalizeUsage(usage), { input: 100, output: 100 }, 'thinking tokens count as output');
    assert.strictEqual(totalTokensFromUsage(usage), 200);
  });

  test('9b. Claude usage accounting is unchanged', () => {
    assert.deepStrictEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), { input: 10, output: 5 });
    assert.strictEqual(totalTokensFromUsage({ input_tokens: 10, output_tokens: 5 }), 15);
    assert.deepStrictEqual(normalizeUsage(null), { input: 0, output: 0 });
  });

  test('9c. the workflow no longer keeps a Claude-only token helper', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../workflows/customerMarketOpportunityWorkflow.js'), 'utf8');
    assert.ok(!/Number\(usage\.input_tokens\)/.test(source), 'the local Claude-only usage reader must be gone');
    assert.ok(source.includes('normalizeUsage'), 'it must reuse the shared provider-aware helper');
  });

  test('12. the per-run token budget decrements under Gemini usage', () => {
    // MAX_TOKENS_PER_RUN is pinned here for the same reason AI_PROVIDER and SEARCH_PROVIDER
    // are pinned in customerMarketOpportunity.test.js: getMaxTokensPerRun() reads the
    // environment, so without this the assertion would measure whatever the operator's .env
    // happens to say. A clean checkout has no .env and correctly falls back to the project
    // default, and this test would then fail for a reason that has nothing to do with the
    // budget logic under test. The value is restored unconditionally below.
    //
    // Production behaviour and the default are untouched - this only fixes the environment
    // the assertion runs against.
    const savedPerRun = process.env.MAX_TOKENS_PER_RUN;
    process.env.MAX_TOKENS_PER_RUN = '32768';
    try {
      const perRun = getMaxTokensPerRun();
      assert.strictEqual(perRun, 32768, 'the ceiling this test pins');
      const geminiUsage = { promptTokenCount: 20000, candidatesTokenCount: 4000, thoughtsTokenCount: 6000 };
      const spent = totalTokensFromUsage(geminiUsage);
      assert.strictEqual(spent, 30000, 'a Gemini call must register real spend, never 0');
      const next = checkTokenBudget({ requestedMaxTokens: 8192, tokensUsedThisRun: spent });
      assert.strictEqual(next.allowed, true);
      assert.ok(next.capped_max_tokens <= perRun - spent, `remaining budget must cap the next call, got ${next.capped_max_tokens}`);
      const exhausted = checkTokenBudget({ requestedMaxTokens: 8192, tokensUsedThisRun: perRun });
      assert.strictEqual(exhausted.allowed, false, 'an exhausted budget must refuse the call outright');
      assert.ok(typeof exhausted.reason === 'string' && exhausted.reason !== '');
    } finally {
      if (savedPerRun === undefined) delete process.env.MAX_TOKENS_PER_RUN;
      else process.env.MAX_TOKENS_PER_RUN = savedPerRun;
    }
  });

  // -------------------------------------------------------------------------------------
  // 10. Gemini's MAX_TOKENS stop reason.
  // -------------------------------------------------------------------------------------

  test('10. both providers\' max-token stop reasons are handled', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../workflows/customerMarketOpportunityWorkflow.js'), 'utf8');
    assert.ok(source.includes('isMaxTokensStopReason'), 'a shared stop-reason check must exist');
    assert.ok(!/stopReason === 'max_tokens'/.test(source), 'the Claude-only literal comparison must be gone');
    // The helper itself, exercised through the file it lives in.
    const fn = new Function(`${source.match(/function isMaxTokensStopReason[\s\S]*?\n\}/)[0]}; return isMaxTokensStopReason;`)();
    assert.strictEqual(fn('MAX_TOKENS'), true, 'Gemini');
    assert.strictEqual(fn('max_tokens'), true, 'Claude');
    assert.strictEqual(fn('STOP'), false);
    assert.strictEqual(fn('end_turn'), false);
    assert.strictEqual(fn(undefined), false);
  });

  await testAsync('10b. Gemini reports its stop reason through sendMessage', async () => {
    const body = geminiGroundedResponse();
    body.candidates[0].finishReason = 'MAX_TOKENS';
    global.fetch = mockFetch(body);
    const res = await geminiClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
    assert.strictEqual(res.stopReason, 'MAX_TOKENS');
  });

  // -------------------------------------------------------------------------------------
  // 11. Claude's web-search path is untouched.
  // -------------------------------------------------------------------------------------

  await testAsync('11. Claude still receives its own hosted web_search tool verbatim', async () => {
    const capture = {};
    global.fetch = async (url, options) => {
      capture.url = url;
      capture.body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-x',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    };
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key-not-real';
    await claudeClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }], tools: [WEB_SEARCH_TOOL], maxTokens: 8192 });
    assert.deepStrictEqual(capture.body.tools, [WEB_SEARCH_TOOL], 'Claude must still get the Anthropic tool unchanged');
    assert.ok(!/google_search/.test(JSON.stringify(capture.body)), 'no Gemini grounding may leak into a Claude request');
  });

  test('11b. geminiClient still exposes its original surface', () => {
    for (const fn of ['sendMessage', 'isConfigured', 'loadEnvOnce', 'resolveCredentials', 'extractText', 'DEFAULT_MODEL', 'DEFAULT_MAX_TOKENS']) {
      assert.ok(fn in geminiClient, `${fn} must still be exported`);
    }
    assert.strictEqual(geminiClient.DEFAULT_MAX_TOKENS, 1024, 'the Gemini default is deliberately unchanged - the research path supplies its own');
  });

  global.fetch = originalFetch;
  if (originalProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = originalProvider;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
