'use strict';

const assert = require('node:assert');
const {
  getMaxToolCallsPerRun,
  getMaxModelCallsPerRun,
  getMaxResearchCallsPerRun,
  getMaxExternalApiCallsPerRun,
  createUsageTracker,
  checkUsageLimits,
  recordUsage,
} = require('../../agent/core/usageLimits');

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

function withEnv(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test('getMaxToolCallsPerRun, getMaxModelCallsPerRun, getMaxResearchCallsPerRun, getMaxExternalApiCallsPerRun return positive numbers by default', () => {
  assert.ok(getMaxToolCallsPerRun() > 0);
  assert.ok(getMaxModelCallsPerRun() > 0);
  assert.ok(getMaxResearchCallsPerRun() > 0);
  assert.ok(getMaxExternalApiCallsPerRun() > 0);
});

test('getMaxToolCallsPerRun respects a MAX_TOOL_CALLS_PER_RUN env override', () => {
  withEnv('MAX_TOOL_CALLS_PER_RUN', '3', () => {
    assert.strictEqual(getMaxToolCallsPerRun(), 3);
  });
});

test('getMaxModelCallsPerRun respects a MAX_MODEL_CALLS_PER_RUN env override', () => {
  withEnv('MAX_MODEL_CALLS_PER_RUN', '2', () => {
    assert.strictEqual(getMaxModelCallsPerRun(), 2);
  });
});

test('getMaxResearchCallsPerRun respects a MAX_RESEARCH_CALLS_PER_RUN env override', () => {
  withEnv('MAX_RESEARCH_CALLS_PER_RUN', '4', () => {
    assert.strictEqual(getMaxResearchCallsPerRun(), 4);
  });
});

test('getMaxExternalApiCallsPerRun respects a MAX_EXTERNAL_API_CALLS_PER_RUN env override', () => {
  withEnv('MAX_EXTERNAL_API_CALLS_PER_RUN', '5', () => {
    assert.strictEqual(getMaxExternalApiCallsPerRun(), 5);
  });
});

test('createUsageTracker returns a zeroed tracker shape', () => {
  assert.deepStrictEqual(createUsageTracker(), {
    toolCalls: 0,
    modelCalls: 0,
    researchCalls: 0,
    externalApiCalls: 0,
  });
});

test('checkUsageLimits allows any call when every applicable counter is under its limit', () => {
  const tracker = createUsageTracker();
  const result = checkUsageLimits('seo_analysis', tracker);
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.limitType, null);
});

test('checkUsageLimits rejects any toolId once the generic tool-call ceiling is reached', () => {
  withEnv('MAX_TOOL_CALLS_PER_RUN', '2', () => {
    const tracker = createUsageTracker();
    tracker.toolCalls = 2;
    const result = checkUsageLimits('seo_analysis', tracker);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.limitType, 'tool_calls');
    assert.ok(/tool calls/.test(result.reason));
  });
});

test('checkUsageLimits rejects ai_reasoning_completion once the model-call ceiling is reached, even though tool-call budget remains', () => {
  withEnv('MAX_MODEL_CALLS_PER_RUN', '1', () => {
    const tracker = createUsageTracker();
    tracker.modelCalls = 1;
    const result = checkUsageLimits('ai_reasoning_completion', tracker);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.limitType, 'model_calls');
    assert.ok(/model calls/.test(result.reason));
  });
});

test('checkUsageLimits rejects business_configuration_retrieval once the external-API ceiling is reached', () => {
  withEnv('MAX_EXTERNAL_API_CALLS_PER_RUN', '1', () => {
    const tracker = createUsageTracker();
    tracker.externalApiCalls = 1;
    const result = checkUsageLimits('business_configuration_retrieval', tracker);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.limitType, 'external_api_calls');
  });
});

test('checkUsageLimits rejects market_research and keyword_research once the research ceiling is reached', () => {
  withEnv('MAX_RESEARCH_CALLS_PER_RUN', '1', () => {
    const tracker = createUsageTracker();
    tracker.researchCalls = 1;
    assert.strictEqual(checkUsageLimits('market_research', tracker).allowed, false);
    assert.strictEqual(checkUsageLimits('keyword_research', tracker).allowed, false);
    assert.strictEqual(checkUsageLimits('market_research', tracker).limitType, 'research_calls');
  });
});

test('checkUsageLimits allows a non-model/non-external/non-research tool even when those three counters are maxed, as long as the generic tool-call ceiling is not', () => {
  withEnv('MAX_MODEL_CALLS_PER_RUN', '1', () => {
    withEnv('MAX_RESEARCH_CALLS_PER_RUN', '1', () => {
      withEnv('MAX_EXTERNAL_API_CALLS_PER_RUN', '1', () => {
        const tracker = createUsageTracker();
        tracker.modelCalls = 1;
        tracker.researchCalls = 1;
        tracker.externalApiCalls = 1;
        const result = checkUsageLimits('listing_content_generation', tracker);
        assert.strictEqual(result.allowed, true);
      });
    });
  });
});

test('checkUsageLimits never mutates the tracker it is passed', () => {
  const tracker = createUsageTracker();
  checkUsageLimits('market_research', tracker);
  assert.deepStrictEqual(tracker, createUsageTracker());
});

test('recordUsage on ai_reasoning_completion increments toolCalls, modelCalls, and externalApiCalls but not researchCalls', () => {
  const tracker = createUsageTracker();
  recordUsage('ai_reasoning_completion', tracker);
  assert.deepStrictEqual(tracker, { toolCalls: 1, modelCalls: 1, researchCalls: 0, externalApiCalls: 1 });
});

test('recordUsage on market_research increments toolCalls and researchCalls only', () => {
  const tracker = createUsageTracker();
  recordUsage('market_research', tracker);
  assert.deepStrictEqual(tracker, { toolCalls: 1, modelCalls: 0, researchCalls: 1, externalApiCalls: 0 });
});

test('recordUsage on business_configuration_retrieval increments toolCalls and externalApiCalls only', () => {
  const tracker = createUsageTracker();
  recordUsage('business_configuration_retrieval', tracker);
  assert.deepStrictEqual(tracker, { toolCalls: 1, modelCalls: 0, researchCalls: 0, externalApiCalls: 1 });
});

test('recordUsage on listing_content_generation increments toolCalls only', () => {
  const tracker = createUsageTracker();
  recordUsage('listing_content_generation', tracker);
  assert.deepStrictEqual(tracker, { toolCalls: 1, modelCalls: 0, researchCalls: 0, externalApiCalls: 0 });
});

test('recordUsage accumulates across repeated calls on the same shared tracker', () => {
  const tracker = createUsageTracker();
  recordUsage('market_research', tracker);
  recordUsage('market_research', tracker);
  recordUsage('keyword_research', tracker);
  assert.deepStrictEqual(tracker, { toolCalls: 3, modelCalls: 0, researchCalls: 3, externalApiCalls: 0 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
