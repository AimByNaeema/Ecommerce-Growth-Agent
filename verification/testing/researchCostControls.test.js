'use strict';

// API COST CONTROLS - the fixes from the API cost audit.
//
//   - the test network guard: no external network, no root .env, no inherited credentials;
//   - every research provider attempt, fallbacks included, counts toward the run's usage limits;
//   - hard per-business daily research limits;
//   - a quota/billing 429 is not retried, a per-minute rate limit still is;
//   - a provider that reported its quota exhausted is not called again until its cooldown ends;
//   - an identical research request that just failed operationally is not re-run with the same providers;
//   - the token budget is re-checked before every fallback attempt;
//   - unrecognisable text asks for clarification without a model call.
//
// NO NETWORK, NO REAL KEY: provider responses come from the tavilyClient.search and aiProviderSelector.sendMessage
// seams, and fetch is a mock or the guard. Engineering verification only.

require('./testNetworkGuard');

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('./testNetworkGuard');
const tavilyClient = require('../../integrations/adapters/tavilyClient');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const claudeClient = require('../../agent/core/claudeClient');
const geminiClient = require('../../agent/core/geminiClient');
const liveResearchCall = require('../../agent/core/liveResearchCall');
const researchUsageGuard = require('../../agent/core/researchUsageGuard');
const externalResearchMemory = require('../../agent/core/externalResearchMemory');
const webSearchProvider = require('../../agent/core/webSearchProvider');
const { isQuotaExhaustedMessage } = require('../../agent/core/networkRetry');
const { createUsageTracker } = require('../../agent/core/usageLimits');
const orchestrator = require('../../agent/core/orchestratorExecutionContract');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

const URL_A = 'https://market-evidence.test/a';

// A fresh usage store and the given environment for one test; everything restored afterwards.
async function scenario({ env = {}, search, send }, fn) {
  const saved = {};
  const vars = {
    AI_PROVIDER: 'gemini',
    SEARCH_PROVIDER: 'tavily',
    TAVILY_API_KEY: 'tvly-test-not-real',
    SEARCH_FALLBACK_PROVIDERS: 'gemini_grounding',
    RESEARCH_USAGE_STORE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cost-controls-')),
    ...env,
  };
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const originals = { search: tavilyClient.search, send: aiProviderSelector.sendMessage, configured: aiProviderSelector.isConfigured };
  if (search) tavilyClient.search = search;
  if (send) aiProviderSelector.sendMessage = send;
  aiProviderSelector.isConfigured = () => true;
  try {
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

const tavilyQuota = async ({ query }) => ({ ok: false, status: 'SEARCH_QUOTA_EXCEEDED', provider: 'tavily', query, results: [], detail: 'Tavily search failed (432): usage limit' });
const tavilyOk = async ({ query }) => ({ ok: true, status: 'SEARCH_OK', provider: 'tavily', query, results: [{ url: URL_A, title: 't', content: 'c', provider: 'tavily' }] });
const groundedAnswer = async () => ({ text: '{"items":[]}', model: 'gemini-test', stopReason: 'STOP', usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, raw: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: URL_A } }] } }] } });
const geminiQuota = async () => { throw new Error('Gemini API request failed (429): You exceeded your current quota, please check your plan and billing details.'); };

function call() {
  return liveResearchCall.runSearchCall({ system: 'Use the web_search tool to find evidence.', prompt: 'Find evidence.', query: 'evidence', businessId: null, tokensUsedThisRun: 0 });
}

(async () => {
  // ---- 1. The test network guard ----------------------------------------------------------------
  await testAsync('TEST GUARD: external fetch is refused, localhost is not blocked, and no request reaches a provider', async () => {
    await assert.rejects(() => fetch('https://api.tavily.com/search'), /TEST NETWORK GUARD/);
    await assert.rejects(() => fetch('https://generativelanguage.googleapis.com/v1beta/models'), /TEST NETWORK GUARD/);
    assert.throws(() => require('https').request({ hostname: 'api.anthropic.com', path: '/' }), /TEST NETWORK GUARD/);
    assert.ok(guard.blockedRequests().length >= 3);
    await assert.rejects(() => fetch('http://127.0.0.1:9/'), (err) => !/TEST NETWORK GUARD/.test(err.message), 'a local address is not blocked by the guard');
  });

  test('TEST GUARD: the root .env is never loaded and no provider or store credential is inherited', () => {
    process.loadEnvFile(guard.ROOT_ENV_FILE);
    for (const name of guard.CREDENTIAL_VARIABLES) assert.strictEqual(process.env[name], undefined, name);
    const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-env-')), 'test.env');
    fs.writeFileSync(temp, 'GUARD_TEST_VALUE=loaded\n');
    process.loadEnvFile(temp);
    assert.strictEqual(process.env.GUARD_TEST_VALUE, 'loaded', "a test's own env file still loads");
    delete process.env.GUARD_TEST_VALUE;
    assert.ok(process.env.RESEARCH_USAGE_STORE_DIR && process.env.RESEARCH_USAGE_STORE_DIR.startsWith(os.tmpdir()));
  });

  test('TEST GUARD: every test process runs behind it', () => {
    const runner = fs.readFileSync(path.join(__dirname, 'runAllTests.js'), 'utf8');
    assert.ok(/'--require', NETWORK_GUARD/.test(runner));
    assert.ok(require('./runAllTests').TEST_FILES.includes('researchCostControls.test.js'));
  });

  // ---- 4. Quota/billing 429 is not retried ------------------------------------------------------
  test('QUOTA 429: allowance-exhausted messages are recognised; per-minute rate limits are not', () => {
    for (const message of ['Gemini API request failed (429): You exceeded your current quota, please check your plan and billing details.', 'Your credit balance is too low', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 per day']) {
      assert.strictEqual(isQuotaExhaustedMessage(message), true, message);
    }
    for (const message of ['Rate limited', 'Quota exceeded for metric: GenerateRequestsPerMinutePerProjectPerModel', 'Resource has been exhausted (e.g. check quota).']) {
      assert.strictEqual(isQuotaExhaustedMessage(message), false, message);
    }
  });

  async function countGeminiCalls(status, message) {
    const savedFetch = global.fetch;
    const savedKey = process.env.GEMINI_API_KEY;
    const savedDelay = process.env.NETWORK_RETRY_BASE_DELAY_MS;
    process.env.GEMINI_API_KEY = 'AIzaSyTestKeyNotReal00000000000000000';
    process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return { ok: false, status, statusText: 'x', headers: { get: () => null }, json: async () => ({ error: { message } }) };
    };
    try {
      await assert.rejects(() => geminiClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }] }));
    } finally {
      global.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
      if (savedDelay === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
      else process.env.NETWORK_RETRY_BASE_DELAY_MS = savedDelay;
    }
    return calls;
  }

  await testAsync('QUOTA 429: an exhausted Gemini quota is sent once, never retried; a plain rate limit is still retried', async () => {
    assert.strictEqual(await countGeminiCalls(429, 'You exceeded your current quota, please check your plan and billing details.'), 1);
    assert.strictEqual(await countGeminiCalls(429, 'Rate limited'), 3);
  });

  await testAsync('QUOTA 429: Claude applies the same rule', async () => {
    const savedFetch = global.fetch;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedDelay = process.env.NETWORK_RETRY_BASE_DELAY_MS;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
    process.env.NETWORK_RETRY_BASE_DELAY_MS = '0';
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return { ok: false, status: 429, statusText: 'x', headers: { get: () => null }, json: async () => ({ error: { message: 'Your credit balance is too low to access the Anthropic API.' } }) };
    };
    try {
      await assert.rejects(() => claudeClient.sendMessage({ messages: [{ role: 'user', content: 'hi' }] }));
      assert.strictEqual(calls, 1);
    } finally {
      global.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedDelay === undefined) delete process.env.NETWORK_RETRY_BASE_DELAY_MS;
      else process.env.NETWORK_RETRY_BASE_DELAY_MS = savedDelay;
    }
  });

  // ---- 2. Every attempt counts, fallbacks included ------------------------------------------------
  await testAsync('COUNTED: the first provider and its fallback each count toward the run (externalApiCalls) and the business day', async () => {
    await scenario({ search: tavilyQuota, send: groundedAnswer }, async () => {
      const tracker = createUsageTracker();
      const outcome = await researchUsageGuard.runWithResearchUsageContext({ usageTracker: tracker }, call);
      assert.strictEqual(outcome.ok, true);
      assert.deepStrictEqual(outcome.attempts.map((a) => [a.provider, a.status]), [['tavily', 'SEARCH_QUOTA_EXCEEDED'], ['gemini_grounding', 'SEARCH_OK']]);
      assert.strictEqual(tracker.researchProviderAttempts, 2);
      assert.strictEqual(tracker.externalApiCalls, 2);
      const today = researchUsageGuard.describeResearchUsage({});
      assert.strictEqual(today.provider_attempts, 2);
      assert.strictEqual(today.live_research_runs, 1, 'one run, however many providers it tried');
    });
  });

  await testAsync('PER-RUN LIMIT: provider attempts stop at MAX_RESEARCH_PROVIDER_ATTEMPTS_PER_RUN, nothing more is sent', async () => {
    let searches = 0;
    await scenario({ env: { MAX_RESEARCH_PROVIDER_ATTEMPTS_PER_RUN: '1' }, search: async (args) => { searches += 1; return tavilyQuota(args); }, send: async () => { throw new Error('must not be called'); } }, async () => {
      const tracker = createUsageTracker();
      const outcome = await researchUsageGuard.runWithResearchUsageContext({ usageTracker: tracker }, call);
      assert.strictEqual(searches, 1);
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.searchStatus, 'SEARCH_USAGE_LIMIT_REACHED');
      assert.deepStrictEqual(outcome.attempts.map((a) => [a.provider, a.status, Boolean(a.skipped)]), [['tavily', 'SEARCH_QUOTA_EXCEEDED', false], ['gemini_grounding', 'SEARCH_USAGE_LIMIT_REACHED', true]]);
      assert.strictEqual(tracker.researchProviderAttempts, 1);
    });
  });

  // ---- 3. Daily per-business limits ---------------------------------------------------------------
  await testAsync('DAILY LIMITS: provider attempts and live research runs per business per UTC day are hard limits', async () => {
    await scenario({ env: { DAILY_RESEARCH_PROVIDER_ATTEMPTS_PER_BUSINESS: '3', SEARCH_FALLBACK_PROVIDERS: undefined }, search: tavilyOk, send: groundedAnswer }, async () => {
      for (let i = 0; i < 3; i += 1) {
        const outcome = await researchUsageGuard.runWithResearchUsageContext({}, call);
        assert.strictEqual(outcome.ok, true, `run ${i + 1}`);
      }
      const refused = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(refused.searchStatus, 'SEARCH_USAGE_LIMIT_REACHED');
      assert.ok(/daily limit of 3/.test(refused.reason), refused.reason);
      const other = await researchUsageGuard.runWithResearchUsageContext({ businessId: 'other-business' }, call);
      assert.strictEqual(other.ok, true, "one business's limit never stops another");
    });
    await scenario({ env: { DAILY_LIVE_RESEARCH_RUNS_PER_BUSINESS: '1', SEARCH_FALLBACK_PROVIDERS: undefined }, search: tavilyOk, send: groundedAnswer }, async () => {
      await researchUsageGuard.runWithResearchUsageContext({}, async () => {
        assert.strictEqual((await call()).ok, true);
        assert.strictEqual((await call()).ok, true, 'a run that already counted may finish its own calls');
      });
      const refused = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.ok(/live research request\(s\) today/.test(refused.reason), refused.reason);
    });
  });

  await testAsync('DAILY LIMITS FAIL CLOSED: an unreadable day record means no provider call', async () => {
    let searches = 0;
    await scenario({ search: async (args) => { searches += 1; return tavilyOk(args); }, send: groundedAnswer }, async () => {
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(process.env.RESEARCH_USAGE_STORE_DIR, 'daily', '_default', `${day}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'not json');
      const outcome = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(outcome.searchStatus, 'SEARCH_USAGE_LIMIT_REACHED');
      assert.strictEqual(searches, 0);
    });
  });

  // ---- 5. Provider quota cooldown ------------------------------------------------------------------
  await testAsync('QUOTA COOLDOWN: after Tavily reports its quota exhausted, later requests skip it and go straight to the fallback', async () => {
    let tavilyCalls = 0;
    await scenario({ search: async (args) => { tavilyCalls += 1; return tavilyQuota(args); }, send: groundedAnswer }, async () => {
      await researchUsageGuard.runWithResearchUsageContext({}, call);
      const second = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(tavilyCalls, 1, 'the exhausted provider was not called again');
      assert.strictEqual(second.ok, true);
      assert.deepStrictEqual(second.attempts.map((a) => [a.provider, a.status, Boolean(a.skipped)]), [['tavily', 'SEARCH_PROVIDER_COOLDOWN', true], ['gemini_grounding', 'SEARCH_OK', false]]);
      assert.strictEqual(researchUsageGuard.describeResearchUsage({}).provider_attempts, 3, 'a skipped provider is not counted');
    });
  });

  await testAsync('QUOTA COOLDOWN: both providers exhausted -> the next request sends nothing at all', async () => {
    let sent = 0;
    await scenario({ search: async (args) => { sent += 1; return tavilyQuota(args); }, send: async () => { sent += 1; return geminiQuota(); } }, async () => {
      const first = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(first.searchStatus, 'SEARCH_QUOTA_EXCEEDED');
      assert.strictEqual(sent, 2);
      const second = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(sent, 2, 'no provider was called');
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.searchStatus, 'SEARCH_PROVIDER_COOLDOWN');
      assert.ok(webSearchProvider.isOperationalFailure(second.searchStatus), 'reported as an outage, never as success or empty');
    });
  });

  await testAsync('QUOTA COOLDOWN: after the cooldown exactly one trial is allowed; success closes it, other failures do not open it', async () => {
    await scenario({ search: tavilyQuota, send: groundedAnswer }, async () => {
      await researchUsageGuard.runWithResearchUsageContext({}, call);
      const later = new Date(Date.now() + 61 * 60 * 1000);
      await researchUsageGuard.runWithResearchUsageContext({}, async () => {
        assert.strictEqual(researchUsageGuard.checkProviderAttempt('tavily', { now: later }).allowed, true, 'the trial');
        researchUsageGuard.recordProviderAttempt('tavily', 'SEARCH_OK', { now: later });
      });
      await researchUsageGuard.runWithResearchUsageContext({}, async () => {
        assert.strictEqual(researchUsageGuard.checkProviderAttempt('tavily', { now: later }).allowed, true, 'closed again');
        researchUsageGuard.recordProviderAttempt('tavily', 'SEARCH_RATE_LIMITED', { now: later });
        assert.strictEqual(researchUsageGuard.checkProviderAttempt('tavily', { now: later }).allowed, true, 'a rate limit is not a quota');
      });
    });
    await scenario({ env: { RESEARCH_PROVIDER_QUOTA_COOLDOWN_MINUTES: '0' }, search: tavilyQuota, send: groundedAnswer }, async () => {
      await researchUsageGuard.runWithResearchUsageContext({}, call);
      const again = await researchUsageGuard.runWithResearchUsageContext({}, call);
      assert.strictEqual(again.attempts[0].status, 'SEARCH_QUOTA_EXCEEDED', '0 disables the cooldown');
    });
  });

  // ---- 7. Budget re-checked before every fallback ----------------------------------------------------
  await testAsync('BUDGET: a fallback is not attempted once the first attempt used up the run token budget', async () => {
    let fallbackCalls = 0;
    await scenario({
      env: { MAX_TOKENS_PER_CALL: '1000', MAX_TOKENS_PER_RUN: '1500', SEARCH_PROVIDER: 'gemini_grounding', SEARCH_FALLBACK_PROVIDERS: 'tavily' },
      search: async (args) => { fallbackCalls += 1; return tavilyOk(args); },
      send: async () => ({ text: 'not json', model: 'gemini-test', stopReason: 'STOP', usage: { promptTokenCount: 900, candidatesTokenCount: 200 }, raw: { candidates: [] } }),
    }, async () => {
      const outcome = await researchUsageGuard.runWithResearchUsageContext({}, () => liveResearchCall.runSearchCall({ system: 's', prompt: 'p', query: 'q', tokensUsedThisRun: 0, maxTokens: 1000 }));
      assert.strictEqual(outcome.budgetExhausted, undefined, 'an empty grounding result is not fallback-worthy here');
      assert.strictEqual(fallbackCalls, 0);
    });
    // The budget allows the first attempt; by the time the fallback would run, the run's budget no longer covers
    // another call (here the ceiling is lowered during the first attempt, standing in for tokens spent elsewhere
    // in the run). The fallback must be refused by the re-check, not by the check made before the first attempt.
    await scenario({
      env: { MAX_TOKENS_PER_CALL: '1000', MAX_TOKENS_PER_RUN: '5000' },
      search: async ({ query }) => {
        process.env.MAX_TOKENS_PER_RUN = '1000';
        return { ok: false, status: 'SEARCH_RATE_LIMITED', provider: 'tavily', query, results: [], detail: '429' };
      },
      send: async () => { fallbackCalls += 1; return groundedAnswer(); },
    }, async () => {
      const outcome = await researchUsageGuard.runWithResearchUsageContext({}, () => liveResearchCall.runSearchCall({ system: 's', prompt: 'p', query: 'q', tokensUsedThisRun: 1000, maxTokens: 1000 }));
      assert.strictEqual(fallbackCalls, 0, 'the fallback was not called');
      assert.strictEqual(outcome.budgetExhausted, true);
      assert.strictEqual(outcome.ok, false);
      assert.deepStrictEqual(outcome.attempts.map((a) => a.provider), ['tavily'], 'only the first provider was attempted');
    });
  });

  // ---- 6. Failed identical research cooldown ---------------------------------------------------------
  test('FAILED RESEARCH COOLDOWN: a just-failed identical question with the same providers is not re-run; a new provider or an old failure is', () => {
    const now = Date.parse('2026-09-17T10:00:00.000Z');
    const failure = (minutesAgo, status = 'SEARCH_QUOTA_EXCEEDED', providers = ['tavily', 'gemini_grounding']) => ({
      considered: {
        newest_failure: {
          run_id: 'cc-run-failed',
          result: {
            status: 'partial',
            search_status: status,
            research_memory: { produced_at: new Date(now - minutesAgo * 60000).toISOString() },
            research_summary: { search: { attempts: providers.map((provider) => ({ provider, status })) } },
          },
        },
      },
    });
    const check = (found, chain = ['tavily', 'gemini_grounding'], minutes = 15) =>
      externalResearchMemory.findFailedResearchCooldown({ found, now, providerChain: chain, isOperationalFailure: webSearchProvider.isOperationalFailure, cooldownMinutes: minutes });
    const hit = check(failure(5));
    assert.ok(hit);
    assert.strictEqual(hit.run_id, 'cc-run-failed');
    assert.strictEqual(hit.retry_after, '2026-09-17T10:10:00.000Z');
    assert.strictEqual(check(failure(20)), null, 'older than the cooldown');
    assert.strictEqual(check(failure(5, 'SEARCH_EMPTY_RESULTS')), null, 'an empty answer is not an outage');
    assert.strictEqual(check(failure(5, 'SEARCH_QUOTA_EXCEEDED', ['tavily']), ['tavily', 'gemini_grounding']), null, 'a newly configured fallback runs at once');
    assert.strictEqual(check(failure(5), undefined, 0), null, '0 disables it');
    assert.strictEqual(check({ considered: { newest_failure: null } }), null);
  });

  await testAsync('FAILED RESEARCH COOLDOWN (workflow): the stored failure is reported again and no provider is called', async () => {
    const workflow = require('../../workflows/customerMarketOpportunityWorkflow');
    const runHistoryStore = require('../../agent/core/runHistoryStore');
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-runs-'));
    let providerCalls = 0;
    const count = (fn) => async (...args) => { providerCalls += 1; return fn(...args); };
    await scenario({ search: count(tavilyQuota), send: count(geminiQuota), env: { RESEARCH_PROVIDER_QUOTA_COOLDOWN_MINUTES: '0' } }, async () => {
      const businessConfig = { business_name: 'Fixture Studio', business_model: 'B2C digital products business.', product_categories: ['SVG design files'], target_markets: ['Global market for digital design assets'] };
      const catalogue = [
        { channel: 'shopify', title: 'Halloween Ghost SVG Bundle', category: 'SVG design files', tags: ['halloween', 'svg'] },
        { channel: 'shopify', title: 'Christmas Tree SVG Bundle', category: 'SVG design files', tags: ['christmas', 'svg'] },
      ];
      const params = { businessConfig, catalogue, reuseResearch: true, researchStoreDir: storeDir, storeReference: 'shopify:fixture' };
      const first = await workflow.runCustomerMarketOpportunityResearch(params);
      assert.strictEqual(first.search_status, 'SEARCH_QUOTA_EXCEEDED');
      const firstCalls = providerCalls;
      assert.ok(firstCalls > 0);
      runHistoryStore.saveRunRecord(
        { run_id: 'cc-run-cooldown-1', kind: 'orchestrate', objective: 'fixture', status: 'partial', result: { routing: { plan: [{ inputs: { tool_id: 'catalogue_expansion_opportunities' }, outputs: { result: first } }] } } },
        { storeDir }
      );
      const second = await workflow.runCustomerMarketOpportunityResearch(params);
      assert.strictEqual(providerCalls, firstCalls, 'no provider was called for the repeat');
      assert.strictEqual(second.research_memory.mode, 'failure_cooldown');
      assert.strictEqual(second.search_status, 'SEARCH_QUOTA_EXCEEDED');
      assert.ok(/The same research failed .* so it was not retried before/.test(second.limitations[0]), second.limitations[0]);
    });
  });

  // ---- 8. No model call for unrecognisable text ------------------------------------------------------
  await testAsync('NO AI FOR GIBBERISH: unrecognisable text asks for clarification without a model call; a real system word still may use it', async () => {
    const originals = { claude: claudeClient.sendMessage, selector: aiProviderSelector.sendMessage };
    let calls = 0;
    const fail = async () => { calls += 1; throw new Error('no model in this test'); };
    claudeClient.sendMessage = fail;
    aiProviderSelector.sendMessage = fail;
    try {
      for (const objective of ['zzqxvth wobble unicorn', 'research my market and do the flibbertigibbet dance']) {
        const response = await orchestrator.runOrchestratorContract(objective);
        assert.strictEqual(response.routing.clarification_type, 'unmatched', objective);
      }
      assert.strictEqual(calls, 0, 'no model call was made');
      await orchestrator.runOrchestratorContract('Suggest one SEO fix for our Halloween bundle and update its title.');
      assert.strictEqual(calls, 1, 'text naming a known capability still gets one re-segmentation attempt');
    } finally {
      claudeClient.sendMessage = originals.claude;
      aiProviderSelector.sendMessage = originals.selector;
    }
  });

  test('LIMITS: the defaults are the documented hard limits', () => {
    const saved = {};
    for (const name of ['MAX_RESEARCH_PROVIDER_ATTEMPTS_PER_RUN', 'DAILY_RESEARCH_PROVIDER_ATTEMPTS_PER_BUSINESS', 'DAILY_LIVE_RESEARCH_RUNS_PER_BUSINESS', 'RESEARCH_PROVIDER_QUOTA_COOLDOWN_MINUTES', 'RESEARCH_FAILURE_COOLDOWN_MINUTES']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      assert.deepStrictEqual(researchUsageGuard.getLimits(), { attempts_per_run: 12, daily_attempts: 60, daily_runs: 20, quota_cooldown_minutes: 60 });
      assert.strictEqual(externalResearchMemory.getFailureCooldownMinutes(), 15);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
