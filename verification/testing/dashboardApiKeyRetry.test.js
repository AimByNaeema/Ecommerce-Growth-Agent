'use strict';

// The dashboard's API-key handling after AGENT_API_KEY is rotated.
//
// THE DEFECT. public/dashboard.js's apiFetch cleared a rejected key on a 401 but did not retry
// the request that was rejected. A tab still holding the old key therefore showed "Could not
// load store overview" and "Not available" metrics even though the server was healthy and
// returning real Shopify data to the current key - observed in production after the key
// rotation went live.
//
// WHAT IS TESTED. The REAL apiFetch code, read from public/dashboard.js and run in an isolated
// vm context. Only the browser boundary is substituted (fetch, sessionStorage, window.prompt),
// so this proves the shipped function's behaviour, not a copy of it.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;

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

const DASHBOARD_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
const START_MARKER = 'const API_KEY_STORAGE_KEY';
const END_MARKER = '/* ---------- Shared helpers';

function extractApiKeyBlock() {
  const start = DASHBOARD_SOURCE.indexOf(START_MARKER);
  const end = DASHBOARD_SOURCE.indexOf(END_MARKER, start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'the API key block is present in public/dashboard.js');
  return DASHBOARD_SOURCE.slice(start, end);
}

// A browser boundary with a server that accepts exactly one key.
function makeBrowser({ storedKey = null, promptAnswers = [], acceptedKey = 'current-key' } = {}) {
  const storage = new Map();
  if (storedKey !== null) storage.set('agentApiKey', storedKey);
  const calls = [];
  const prompts = [];
  const answers = promptAnswers.slice();
  const context = {
    sessionStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      prompt: (message) => {
        prompts.push(message);
        return answers.length > 0 ? answers.shift() : null;
      },
    },
    fetch: async (url, options) => {
      const headers = (options && options.headers) || {};
      calls.push({ url, method: options && options.method, body: options && options.body, authorization: headers.Authorization || null, contentType: headers['Content-Type'] || null });
      return { status: headers.Authorization === `Bearer ${acceptedKey}` ? 200 : 401 };
    },
  };
  vm.createContext(context);
  vm.runInContext(extractApiKeyBlock(), context);
  return { context, storage, calls, prompts };
}

(async () => {
  await testAsync('ROTATED KEY: a stale stored key is asked for once and the SAME request is retried with the current key', async () => {
    const browser = makeBrowser({ storedKey: 'old-key', promptAnswers: ['current-key'] });
    const res = await browser.context.apiFetch('/overview');
    assert.strictEqual(res.status, 200, 'the Overview request succeeds after the retry');
    assert.strictEqual(browser.calls.length, 2);
    assert.strictEqual(browser.calls[0].authorization, 'Bearer old-key');
    assert.strictEqual(browser.calls[1].authorization, 'Bearer current-key');
    assert.strictEqual(browser.calls[1].url, '/overview', 'the retry is the same request');
    assert.strictEqual(browser.prompts.length, 1);
    assert.strictEqual(browser.storage.get('agentApiKey'), 'current-key', 'the current key is remembered for the rest of the tab');
  });

  await testAsync('ROTATED KEY: the next request uses the remembered current key with no further prompt', async () => {
    const browser = makeBrowser({ storedKey: 'old-key', promptAnswers: ['current-key'] });
    await browser.context.apiFetch('/overview');
    const res = await browser.context.apiFetch('/store/metrics');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(browser.prompts.length, 1, 'asked only once across both Overview requests');
    assert.strictEqual(browser.calls[2].authorization, 'Bearer current-key');
  });

  await testAsync('A VALID KEY is never prompted for and the request is sent exactly once', async () => {
    const browser = makeBrowser({ storedKey: 'current-key' });
    const res = await browser.context.apiFetch('/overview');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(browser.calls.length, 1);
    assert.strictEqual(browser.prompts.length, 0);
  });

  await testAsync('A WRONG KEY is retried once only - never a loop - and is not remembered', async () => {
    const browser = makeBrowser({ storedKey: 'old-key', promptAnswers: ['also-wrong', 'never-asked'] });
    const res = await browser.context.apiFetch('/overview');
    assert.strictEqual(res.status, 401, 'the rejection is returned honestly');
    assert.strictEqual(browser.calls.length, 2);
    assert.strictEqual(browser.prompts.length, 1);
    assert.strictEqual(browser.storage.has('agentApiKey'), false, 'a rejected key is cleared');
  });

  await testAsync('A CANCELLED PROMPT sends nothing further and returns the 401', async () => {
    const browser = makeBrowser({ storedKey: 'old-key', promptAnswers: [null] });
    const res = await browser.context.apiFetch('/overview');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(browser.calls.length, 1, 'no request is sent without a key');
    assert.strictEqual(browser.storage.has('agentApiKey'), false);
  });

  await testAsync('A RETRIED POST keeps its method, body and headers', async () => {
    const browser = makeBrowser({ storedKey: 'old-key', promptAnswers: ['current-key'] });
    const body = JSON.stringify({ goal: 'Analyse my Shopify store.' });
    const res = await browser.context.apiFetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(browser.calls[1].method, 'POST');
    assert.strictEqual(browser.calls[1].body, body);
    assert.strictEqual(browser.calls[1].contentType, 'application/json');
  });

  await testAsync('NO STORED KEY: the existing first-use prompt still applies', async () => {
    const browser = makeBrowser({ storedKey: null, promptAnswers: ['current-key'] });
    const res = await browser.context.apiFetch('/overview');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(browser.prompts.length, 1);
    assert.strictEqual(browser.calls.length, 1);
  });

  await testAsync('The Overview still loads its store overview and metrics through apiFetch', async () => {
    assert.ok(/apiFetch\('\/overview'\)/.test(DASHBOARD_SOURCE));
    assert.ok(/apiFetch\('\/store\/metrics'\)/.test(DASHBOARD_SOURCE));
    assert.ok(!/AGENT_API_KEY\s*=\s*['"]/.test(DASHBOARD_SOURCE), 'no key is embedded in the page');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
