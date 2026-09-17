'use strict';

// TEST NETWORK GUARD - preloaded into every test process by runAllTests.js (node --require).
//
// WHY THIS EXISTS (API cost audit): the suite loaded the project's root .env, whose Tavily and Anthropic keys are
// the production keys, and several tests reached the real providers - about 18 Tavily and 3 Anthropic calls, plus
// Shopify and Etsy reads, on every `npm test`. A test must never spend a real allowance or touch a real store.
//
// WHAT IT DOES, before any test code runs:
//   1. The project's root .env is never loaded: process.loadEnvFile() of that one file does nothing. A test that
//      loads its own temporary env file still can.
//   2. Every provider and store credential inherited from the shell is removed, so no client starts configured
//      with a real key. A test that needs "configured" sets its own fake value.
//   3. Every non-local network request is refused: fetch() rejects, and http/https requests throw. Local servers a
//      test starts on localhost keep working. A test that mocks global.fetch replaces this guard with its mock.
//   4. State that research usage accounting writes goes to a fresh temporary directory per test process, never to
//      the real memory/state.
// Refused requests are counted per process; with TEST_NETWORK_GUARD_LOG set, each is appended to that file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ROOT_ENV_FILE = path.join(PROJECT_ROOT, '.env');

const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'TAVILY_API_KEY',
  'SEARCH_FALLBACK_PROVIDERS',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_ADMIN_API_ACCESS_TOKEN',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'ETSY_API_KEYSTRING',
  'ETSY_SHARED_SECRET',
  'ETSY_OAUTH_ACCESS_TOKEN',
  'ETSY_OAUTH_REFRESH_TOKEN',
  'AGENT_API_KEY',
];

const blocked = [];

function isLocalHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '';
}

function refuse(kind, host) {
  blocked.push({ kind, host });
  if (process.env.TEST_NETWORK_GUARD_LOG) {
    try {
      fs.appendFileSync(process.env.TEST_NETWORK_GUARD_LOG, `${path.basename(process.argv[1] || '')}\t${kind}\t${host}\n`);
    } catch (err) {
      // The refusal itself is what matters; a log that cannot be written changes nothing.
    }
  }
  return new Error(`TEST NETWORK GUARD: external network access to '${host}' is blocked during tests.`);
}

// 1. Never load the real root .env.
const originalLoadEnvFile = process.loadEnvFile;
process.loadEnvFile = function guardedLoadEnvFile(file) {
  const target = path.resolve(file === undefined ? '.env' : String(file));
  if (target.toLowerCase() === ROOT_ENV_FILE.toLowerCase()) return undefined;
  return originalLoadEnvFile.call(process, file);
};

// 2. No inherited credentials.
for (const name of CREDENTIAL_VARIABLES) delete process.env[name];

// 3. No external network.
const originalFetch = global.fetch;
global.fetch = async function guardedFetch(input, init) {
  const target = String(input && input.url ? input.url : input);
  let host = '';
  try {
    host = new URL(target).host;
  } catch (err) {
    host = target;
  }
  if (!isLocalHost(host)) throw refuse('fetch', host);
  return originalFetch(input, init);
};

for (const moduleName of ['http', 'https']) {
  const mod = require(moduleName);
  for (const method of ['request', 'get']) {
    const original = mod[method];
    mod[method] = function guardedRequest(options, ...rest) {
      let host = '';
      if (typeof options === 'string' || options instanceof URL) host = new URL(String(options)).host;
      else if (options && typeof options === 'object') host = options.hostname || options.host || '';
      if (!isLocalHost(host)) throw refuse(`${moduleName}.${method}`, host);
      return original.call(this, options, ...rest);
    };
  }
}

// 4. Research usage state stays out of the real memory/state.
if (!process.env.RESEARCH_USAGE_STORE_DIR) {
  process.env.RESEARCH_USAGE_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-research-usage-'));
}

process.env.TEST_NETWORK_GUARD_ACTIVE = '1';

module.exports = { blockedRequests: () => blocked.slice(), CREDENTIAL_VARIABLES, ROOT_ENV_FILE };
