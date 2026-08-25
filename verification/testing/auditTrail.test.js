'use strict';

const assert = require('node:assert');
const { AUDIT_EVENT_TYPES } = require('../../audit/auditRecordModel');
const {
  redactSensitiveData,
  createAuditRecord,
  createAuditTracker,
  appendAuditEvent,
  getEventsByType,
  getEventsBySpecialist,
  getErrorEvents,
} = require('../../audit/auditTrail');

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
    type: 'request',
    summary: 'Objective received: research the market.',
    ...overrides,
  };
}

const CANARY = 'sk-ant-CANARY-DO-NOT-LEAK-3f9a7c2e';

// --- redactSensitiveData ---------------------------------------------------------------

test('redactSensitiveData replaces values of credential-shaped keys', () => {
  const redacted = redactSensitiveData({ apiKey: CANARY, password: CANARY, access_token: CANARY });
  assert.strictEqual(redacted.apiKey, '[REDACTED]');
  assert.strictEqual(redacted.password, '[REDACTED]');
  assert.strictEqual(redacted.access_token, '[REDACTED]');
});

test('redactSensitiveData redacts nested and array-nested credential-shaped keys', () => {
  const redacted = redactSensitiveData({
    config: { nested: { clientSecret: CANARY } },
    list: [{ token: CANARY }, { safe: 'keep me' }],
  });
  assert.strictEqual(redacted.config.nested.clientSecret, '[REDACTED]');
  assert.strictEqual(redacted.list[0].token, '[REDACTED]');
  assert.strictEqual(redacted.list[1].safe, 'keep me');
});

test('redactSensitiveData leaves non-sensitive keys and values untouched', () => {
  const redacted = redactSensitiveData({ market: 'US', demandSignals: ['strong'] });
  assert.deepStrictEqual(redacted, { market: 'US', demandSignals: ['strong'] });
});

test('redactSensitiveData does not mutate its input', () => {
  const input = { apiKey: CANARY };
  const snapshot = JSON.parse(JSON.stringify(input));
  redactSensitiveData(input);
  assert.deepStrictEqual(input, snapshot);
});

test('redactSensitiveData truncates a string value longer than 500 characters', () => {
  const longValue = 'x'.repeat(600);
  const redacted = redactSensitiveData({ description: longValue });
  assert.ok(redacted.description.length < longValue.length);
  assert.ok(redacted.description.endsWith('…[TRUNCATED]'));
});

// --- createAuditRecord ------------------------------------------------------------------

test('createAuditRecord produces a valid, frozen record', () => {
  const record = createAuditRecord(baseArgs());
  assert.strictEqual(record.id, 'run-1-0');
  assert.strictEqual(record.run_id, 'run-1');
  assert.strictEqual(record.type, 'request');
  assert.ok(record.timestamp.length > 0);
  assert.strictEqual(record.summary, 'Objective received: research the market.');
  assert.strictEqual(record.detail, null);
  assert.ok(Object.isFrozen(record));
});

test('createAuditRecord throws for an invalid type', () => {
  assert.throws(() => createAuditRecord(baseArgs({ type: 'not_a_real_type' })), /type.*to be one of/);
});

test('createAuditRecord throws for a missing summary', () => {
  assert.throws(() => createAuditRecord(baseArgs({ summary: '' })), /non-empty `summary`/);
});

test('createAuditRecord throws for a missing runId', () => {
  assert.throws(() => createAuditRecord(baseArgs({ runId: '' })), /non-empty `runId`/);
});

test('createAuditRecord throws for a non-integer seq', () => {
  assert.throws(() => createAuditRecord(baseArgs({ seq: -1 })), /seq.*non-negative integer/);
});

test('createAuditRecord redacts a canary secret placed in detail and never stores the raw value', () => {
  const record = createAuditRecord(
    baseArgs({ type: 'data_access', detail: { apiKey: CANARY, fields: ['market'] } })
  );
  assert.strictEqual(record.detail.apiKey, '[REDACTED]');
  assert.deepStrictEqual(record.detail.fields, ['market']);
  assert.ok(!JSON.stringify(record).includes(CANARY), 'the raw canary secret must never appear anywhere in the record');
});

test('createAuditRecord truncates a summary longer than 300 characters', () => {
  const record = createAuditRecord(baseArgs({ summary: 'y'.repeat(400) }));
  assert.ok(record.summary.length <= 300);
});

test('AUDIT_EVENT_TYPES covers every category createAuditRecord accepts', () => {
  for (const type of AUDIT_EVENT_TYPES) {
    const record = createAuditRecord(baseArgs({ type, seq: 0 }));
    assert.strictEqual(record.type, type);
  }
});

// --- createAuditTracker / appendAuditEvent ------------------------------------------------

test('createAuditTracker returns an empty, run-scoped tracker', () => {
  const tracker = createAuditTracker('run-2');
  assert.strictEqual(tracker.run_id, 'run-2');
  assert.deepStrictEqual(tracker.events, []);
});

test('createAuditTracker throws for a missing runId', () => {
  assert.throws(() => createAuditTracker(''), /non-empty `runId`/);
});

test('appendAuditEvent mutates the tracker in place, appending one record per call', () => {
  const tracker = createAuditTracker('run-3');
  const first = appendAuditEvent(tracker, { type: 'request', summary: 'first event' });
  const second = appendAuditEvent(tracker, { type: 'agent', summary: 'second event' });

  assert.strictEqual(tracker.events.length, 2);
  assert.strictEqual(tracker.events[0], first);
  assert.strictEqual(tracker.events[1], second);
  assert.strictEqual(first.id, 'run-3-0');
  assert.strictEqual(second.id, 'run-3-1');
});

test('appendAuditEvent silently no-ops and returns null when tracker is falsy', () => {
  assert.strictEqual(appendAuditEvent(null, { type: 'request', summary: 'ignored' }), null);
  assert.strictEqual(appendAuditEvent(undefined, { type: 'request', summary: 'ignored' }), null);
});

// --- read helpers ------------------------------------------------------------------------

test('getEventsByType / getEventsBySpecialist / getErrorEvents filter correctly', () => {
  const tracker = createAuditTracker('run-4');
  appendAuditEvent(tracker, { type: 'request', summary: 'req' });
  appendAuditEvent(tracker, { type: 'tools', specialistId: 'research', toolId: 'market_research', summary: 'tool call' });
  appendAuditEvent(tracker, { type: 'error', specialistId: 'research', summary: 'boom' });
  appendAuditEvent(tracker, { type: 'error', specialistId: 'seo', summary: 'boom2' });

  assert.strictEqual(getEventsByType(tracker, 'tools').length, 1);
  assert.strictEqual(getEventsBySpecialist(tracker, 'research').length, 2);
  assert.strictEqual(getErrorEvents(tracker).length, 2);
  assert.strictEqual(getErrorEvents(tracker)[0].specialist_id, 'research');
});

test('getEventsByType throws for something that is not a real tracker', () => {
  assert.throws(() => getEventsByType({ not: 'a tracker' }, 'request'), /createAuditTracker/);
  assert.throws(() => getEventsByType(null, 'request'), /createAuditTracker/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
