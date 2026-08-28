'use strict';

const assert = require('node:assert');
const { USAGE_EVENT_CATEGORIES, validateUsageRecordShape } = require('../../usage/usageRecordModel');
const {
  createUsageRecord,
  createUsageLedger,
  appendUsageEvent,
  getEventsByCategory,
  getEventsByBusiness,
  summarizeUsage,
} = require('../../usage/usageTracker');

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

function baseArgs(overrides = {}) {
  return {
    runId: 'run-1',
    seq: 0,
    category: 'agent_task',
    quantity: 1,
    summary: 'Routed clause to specialist.',
    ...overrides,
  };
}

const CANARY = 'sk-ant-CANARY-DO-NOT-LEAK-3f9a7c2e';

// --- createUsageRecord ------------------------------------------------------------------

test('createUsageRecord produces a valid, frozen record', () => {
  const record = createUsageRecord(baseArgs());
  assert.strictEqual(record.id, 'run-1-0');
  assert.strictEqual(record.run_id, 'run-1');
  assert.strictEqual(record.business_id, null);
  assert.strictEqual(record.category, 'agent_task');
  assert.ok(record.timestamp.length > 0);
  assert.strictEqual(record.quantity, 1);
  assert.strictEqual(record.tokens, null);
  assert.strictEqual(record.model, null);
  assert.strictEqual(record.is_external_api, false);
  assert.strictEqual(record.is_research, false);
  assert.ok(Object.isFrozen(record));
});

test('createUsageRecord throws for an invalid category', () => {
  assert.throws(() => createUsageRecord(baseArgs({ category: 'not_a_real_category' })), /category.*to be one of/);
});

test('createUsageRecord throws for a missing summary', () => {
  assert.throws(() => createUsageRecord(baseArgs({ summary: '' })), /non-empty `summary`/);
});

test('createUsageRecord throws for a missing runId', () => {
  assert.throws(() => createUsageRecord(baseArgs({ runId: '' })), /non-empty `runId`/);
});

test('createUsageRecord throws for a non-integer seq', () => {
  assert.throws(() => createUsageRecord(baseArgs({ seq: -1 })), /seq.*non-negative integer/);
});

test('createUsageRecord throws for a negative quantity', () => {
  assert.throws(() => createUsageRecord(baseArgs({ quantity: -1 })), /quantity.*non-negative number/);
});

test('createUsageRecord throws when tokens is supplied with a missing sub-field', () => {
  assert.throws(
    () => createUsageRecord(baseArgs({ category: 'model_call', tokens: { input: 1, output: 2 }, quantity: 3 })),
    /tokens\.total.*to be a number/
  );
});

test('createUsageRecord redacts a canary secret placed in detail and never stores the raw value', () => {
  const record = createUsageRecord(baseArgs({ detail: { apiKey: CANARY, fields: ['market'] } }));
  assert.strictEqual(record.detail.apiKey, '[REDACTED]');
  assert.deepStrictEqual(record.detail.fields, ['market']);
  assert.ok(!JSON.stringify(record).includes(CANARY), 'the raw canary secret must never appear anywhere in the record');
});

test('createUsageRecord truncates a summary longer than 300 characters', () => {
  const record = createUsageRecord(baseArgs({ summary: 'y'.repeat(400) }));
  assert.ok(record.summary.length <= 300);
});

test('a model_call record carries tokens/model; quantity equals tokens.total', () => {
  const record = createUsageRecord(
    baseArgs({
      category: 'model_call',
      toolId: 'ai_reasoning_completion',
      isExternalApi: true,
      tokens: { input: 20, output: 10, total: 30 },
      model: 'claude-sonnet-5',
      quantity: 30,
      summary: 'Tool completed successfully.',
    })
  );
  assert.deepStrictEqual(record.tokens, { input: 20, output: 10, total: 30 });
  assert.strictEqual(record.model, 'claude-sonnet-5');
  assert.strictEqual(record.quantity, record.tokens.total);
  assert.strictEqual(record.is_external_api, true);
});

test('USAGE_EVENT_CATEGORIES covers every category createUsageRecord accepts', () => {
  for (const category of USAGE_EVENT_CATEGORIES) {
    const record = createUsageRecord(baseArgs({ category, seq: 0 }));
    assert.strictEqual(record.category, category);
  }
});

// --- createUsageLedger / appendUsageEvent ------------------------------------------------

test('createUsageLedger returns an empty, run-scoped, business-tagged ledger', () => {
  const ledger = createUsageLedger('run-2', 'acme-store');
  assert.strictEqual(ledger.run_id, 'run-2');
  assert.strictEqual(ledger.business_id, 'acme-store');
  assert.deepStrictEqual(ledger.events, []);
});

test('createUsageLedger defaults business_id to null', () => {
  const ledger = createUsageLedger('run-2b');
  assert.strictEqual(ledger.business_id, null);
});

test('createUsageLedger throws for a missing runId', () => {
  assert.throws(() => createUsageLedger(''), /non-empty `runId`/);
});

test('appendUsageEvent mutates the ledger in place, appending one record per call, tagging each record with the ledger business_id', () => {
  const ledger = createUsageLedger('run-3', 'acme-store');
  const first = appendUsageEvent(ledger, { category: 'agent_task', quantity: 1, summary: 'first event' });
  const second = appendUsageEvent(ledger, { category: 'tool_call', toolId: 'market_research', quantity: 1, summary: 'second event' });

  assert.strictEqual(ledger.events.length, 2);
  assert.strictEqual(ledger.events[0], first);
  assert.strictEqual(ledger.events[1], second);
  assert.strictEqual(first.id, 'run-3-0');
  assert.strictEqual(second.id, 'run-3-1');
  assert.strictEqual(first.business_id, 'acme-store');
  assert.strictEqual(second.business_id, 'acme-store');
});

test('appendUsageEvent lets fields.businessId override the ledger business_id', () => {
  const ledger = createUsageLedger('run-3b', 'acme-store');
  const record = appendUsageEvent(ledger, { category: 'agent_task', quantity: 1, summary: 'override', businessId: 'other-store' });
  assert.strictEqual(record.business_id, 'other-store');
});

test('appendUsageEvent silently no-ops and returns null when ledger is falsy', () => {
  assert.strictEqual(appendUsageEvent(null, { category: 'agent_task', quantity: 1, summary: 'ignored' }), null);
  assert.strictEqual(appendUsageEvent(undefined, { category: 'agent_task', quantity: 1, summary: 'ignored' }), null);
});

// --- read helpers ------------------------------------------------------------------------

test('getEventsByCategory / getEventsByBusiness filter correctly', () => {
  const ledger = createUsageLedger('run-4', 'acme-store');
  appendUsageEvent(ledger, { category: 'agent_task', quantity: 1, summary: 'agent' });
  appendUsageEvent(ledger, { category: 'tool_call', toolId: 'market_research', quantity: 1, summary: 'tool' });
  appendUsageEvent(ledger, { category: 'tool_call', toolId: 'keyword_research', quantity: 1, summary: 'tool2' });
  appendUsageEvent(ledger, { category: 'model_call', toolId: 'ai_reasoning_completion', quantity: 1, summary: 'model', businessId: 'other-store' });

  assert.strictEqual(getEventsByCategory(ledger, 'tool_call').length, 2);
  assert.strictEqual(getEventsByCategory(ledger, 'agent_task').length, 1);
  assert.strictEqual(getEventsByBusiness(ledger, 'acme-store').length, 3);
  assert.strictEqual(getEventsByBusiness(ledger, 'other-store').length, 1);
});

test('getEventsByCategory throws for something that is not a real ledger', () => {
  assert.throws(() => getEventsByCategory({ not: 'a ledger' }, 'tool_call'), /createUsageLedger/);
  assert.throws(() => getEventsByCategory(null, 'tool_call'), /createUsageLedger/);
});

// --- summarizeUsage ------------------------------------------------------------------------

test('summarizeUsage returns all-zero aggregates for an empty ledger, never undefined/NaN', () => {
  const ledger = createUsageLedger('run-5', 'acme-store');
  const summary = summarizeUsage(ledger);
  assert.strictEqual(summary.run_id, 'run-5');
  assert.strictEqual(summary.business_id, 'acme-store');
  assert.strictEqual(summary.total_events, 0);
  for (const category of USAGE_EVENT_CATEGORIES) {
    assert.strictEqual(summary.by_category[category].count, 0);
  }
  assert.strictEqual(summary.by_category.model_call.tokens_input, 0);
  assert.strictEqual(summary.by_category.model_call.tokens_output, 0);
  assert.strictEqual(summary.by_category.model_call.tokens_total, 0);
});

test('summarizeUsage sums counts and tokens correctly across mixed-category events', () => {
  const ledger = createUsageLedger('run-6', 'acme-store');
  appendUsageEvent(ledger, { category: 'agent_task', quantity: 1, summary: 'agent' });
  appendUsageEvent(ledger, {
    category: 'tool_call',
    toolId: 'market_research',
    isResearch: true,
    quantity: 1,
    summary: 'research tool',
  });
  appendUsageEvent(ledger, {
    category: 'tool_call',
    toolId: 'business_configuration_retrieval',
    isExternalApi: true,
    quantity: 1,
    summary: 'api tool',
  });
  appendUsageEvent(ledger, {
    category: 'model_call',
    toolId: 'ai_reasoning_completion',
    isExternalApi: true,
    tokens: { input: 20, output: 10, total: 30 },
    model: 'claude-sonnet-5',
    quantity: 30,
    summary: 'model call',
  });
  appendUsageEvent(ledger, {
    category: 'model_call',
    toolId: 'ai_reasoning_completion',
    isExternalApi: true,
    tokens: { input: 5, output: 15, total: 20 },
    model: 'claude-sonnet-5',
    quantity: 20,
    summary: 'model call 2',
  });

  const summary = summarizeUsage(ledger);
  assert.strictEqual(summary.total_events, 5);
  assert.strictEqual(summary.by_category.agent_task.count, 1);
  assert.strictEqual(summary.by_category.tool_call.count, 2);
  assert.strictEqual(summary.by_category.model_call.count, 2);
  // api_call/research_op are tag counts (is_external_api/is_research), not a
  // category-equality count - see usage/usageRecordModel.js's header. Here that's
  // 1 tool_call tagged research + 2 model_call events tagged external API.
  assert.strictEqual(summary.by_category.research_op.count, 1);
  assert.strictEqual(summary.by_category.api_call.count, 3);
  assert.strictEqual(summary.by_category.model_call.tokens_input, 25);
  assert.strictEqual(summary.by_category.model_call.tokens_output, 25);
  assert.strictEqual(summary.by_category.model_call.tokens_total, 50);
});

// --- validateUsageRecordShape --------------------------------------------------------------

test('validateUsageRecordShape rejects a record missing a required field', () => {
  const record = createUsageRecord(baseArgs());
  const broken = { ...record };
  delete broken.summary;
  const result = validateUsageRecordShape(broken);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('missing field: summary')));
});

test('validateUsageRecordShape rejects a record with an unexpected extra field', () => {
  const record = createUsageRecord(baseArgs());
  const broken = { ...record, extra_field: 'nope' };
  const result = validateUsageRecordShape(broken);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unexpected field: extra_field')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
