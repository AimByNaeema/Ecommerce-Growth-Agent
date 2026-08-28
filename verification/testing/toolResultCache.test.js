'use strict';

const assert = require('node:assert');
const {
  createToolResultCache,
  buildCacheKey,
  getCachedResult,
  setCachedResult,
} = require('../../agent/core/toolResultCache');

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

test('createToolResultCache returns independent instances - mutating one never affects another', () => {
  const cacheA = createToolResultCache();
  const cacheB = createToolResultCache();
  assert.notStrictEqual(cacheA, cacheB);
  assert.notStrictEqual(cacheA.entries, cacheB.entries);

  setCachedResult(cacheA, 'market_research', { market: 'EU' }, { status: 'success', data: 'a' });
  assert.strictEqual(getCachedResult(cacheA, 'market_research', { market: 'EU' }).data, 'a');
  assert.strictEqual(getCachedResult(cacheB, 'market_research', { market: 'EU' }), undefined);
});

test('buildCacheKey is key-order-independent for logically identical params', () => {
  assert.strictEqual(
    buildCacheKey('market_research', { a: 1, b: 2 }),
    buildCacheKey('market_research', { b: 2, a: 1 })
  );
});

test('buildCacheKey differs by toolId for identical params', () => {
  assert.notStrictEqual(
    buildCacheKey('market_research', { market: 'EU' }),
    buildCacheKey('competitor_research', { market: 'EU' })
  );
});

test('buildCacheKey differs for genuinely different params, including nested objects and arrays', () => {
  assert.notStrictEqual(
    buildCacheKey('keyword_research', { keywords: [{ keyword: 'a' }] }),
    buildCacheKey('keyword_research', { keywords: [{ keyword: 'b' }] })
  );
  assert.notStrictEqual(
    buildCacheKey('market_research', { pricing: { currency: 'EUR', price: 10 } }),
    buildCacheKey('market_research', { pricing: { currency: 'USD', price: 10 } })
  );
});

test('buildCacheKey preserves array order (never sorts array entries)', () => {
  assert.notStrictEqual(
    buildCacheKey('keyword_research', { keywords: ['a', 'b'] }),
    buildCacheKey('keyword_research', { keywords: ['b', 'a'] })
  );
});

test('buildCacheKey collapses null/undefined/{} researchParams to one consistent "no params" key', () => {
  const keyNull = buildCacheKey('business_configuration_retrieval', null);
  const keyUndefined = buildCacheKey('business_configuration_retrieval', undefined);
  const keyEmpty = buildCacheKey('business_configuration_retrieval', {});
  assert.strictEqual(keyNull, keyUndefined);
  assert.strictEqual(keyNull, keyEmpty);
});

test('buildCacheKey never throws on null/undefined/{} params', () => {
  assert.doesNotThrow(() => buildCacheKey('any_tool', null));
  assert.doesNotThrow(() => buildCacheKey('any_tool', undefined));
  assert.doesNotThrow(() => buildCacheKey('any_tool', {}));
});

test('getCachedResult returns undefined on a miss', () => {
  const cache = createToolResultCache();
  assert.strictEqual(getCachedResult(cache, 'market_research', { market: 'EU' }), undefined);
});

test('getCachedResult returns the exact stored value (reference identity) on a hit', () => {
  const cache = createToolResultCache();
  const storedResult = { status: 'success', data: { findings: ['placeholder'] } };
  setCachedResult(cache, 'market_research', { market: 'EU' }, storedResult);
  assert.strictEqual(getCachedResult(cache, 'market_research', { market: 'EU' }), storedResult);
});

test('getCachedResult/setCachedResult no-op safely on a falsy cache', () => {
  assert.doesNotThrow(() => setCachedResult(null, 'market_research', { market: 'EU' }, { status: 'success' }));
  assert.strictEqual(getCachedResult(null, 'market_research', { market: 'EU' }), undefined);
  assert.strictEqual(getCachedResult(undefined, 'market_research', { market: 'EU' }), undefined);
});

test('call-count spy proves an identical second call is served from cache, never re-executed', () => {
  const cache = createToolResultCache();
  let calls = 0;
  const fakeExecutor = () => {
    calls += 1;
    return { status: 'success', data: { call: calls } };
  };

  function simulatedRunExecutor(toolId, researchParams) {
    const cached = getCachedResult(cache, toolId, researchParams);
    if (cached !== undefined) return cached;
    const result = fakeExecutor();
    setCachedResult(cache, toolId, researchParams, result);
    return result;
  }

  const first = simulatedRunExecutor('market_research', { market: 'EU' });
  const second = simulatedRunExecutor('market_research', { market: 'EU' });

  assert.strictEqual(calls, 1, 'the fake executor should only run once across two identical calls');
  assert.strictEqual(second, first, 'the second call should return the exact cached reference');
});

test('call-count spy proves different params correctly bypass the cache (no false-positive matching)', () => {
  const cache = createToolResultCache();
  let calls = 0;
  const fakeExecutor = () => {
    calls += 1;
    return { status: 'success', data: { call: calls } };
  };

  function simulatedRunExecutor(toolId, researchParams) {
    const cached = getCachedResult(cache, toolId, researchParams);
    if (cached !== undefined) return cached;
    const result = fakeExecutor();
    setCachedResult(cache, toolId, researchParams, result);
    return result;
  }

  simulatedRunExecutor('keyword_research', { keywords: [{ keyword: 'a' }] });
  simulatedRunExecutor('keyword_research', { keywords: [{ keyword: 'b' }] });

  assert.strictEqual(calls, 2, 'different params must not share a cache entry');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
