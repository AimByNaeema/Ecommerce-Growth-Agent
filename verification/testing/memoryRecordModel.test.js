'use strict';

const assert = require('node:assert');
const {
  MEMORY_PRIORITY_IDS,
  MAX_SUMMARY_LENGTH,
  stateFieldForPriority,
  createMemoryRecord,
  validateMemoryRecord,
} = require('../../agent/core/memoryRecordModel');
const { MEMORY_PRIORITIES } = require('../../agent/core/memoryRules');
const { STATE_FIELDS } = require('../../agent/core/stateModel');

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

function baseRecord(overrides = {}) {
  return createMemoryRecord({
    id: 'mem-1',
    businessId: 'demo-business',
    priorityId: 'reusable_findings',
    summary: 'A short, real, already-verified finding.',
    verificationStatus: 'passed',
    ...overrides,
  });
}

test('MEMORY_PRIORITY_IDS is exactly agent/core/memoryRules.js\'s own MEMORY_PRIORITIES ids - never a second, competing list', () => {
  assert.deepStrictEqual(MEMORY_PRIORITY_IDS, MEMORY_PRIORITIES.map((p) => p.id));
});

test('stateFieldForPriority reuses MEMORY_PRIORITIES\' own stateField mapping unchanged', () => {
  assert.strictEqual(stateFieldForPriority('reusable_findings'), 'findings');
  assert.strictEqual(stateFieldForPriority('important_decisions'), 'decisions');
  assert.strictEqual(stateFieldForPriority('business_configuration'), 'relevant_configuration');
  assert.strictEqual(stateFieldForPriority('research_summaries'), 'selected_research');
  assert.strictEqual(stateFieldForPriority('completed_tasks'), 'completed_work');
  assert.strictEqual(stateFieldForPriority('useful_historical_context'), null);
  assert.strictEqual(stateFieldForPriority('not_a_real_priority'), undefined);
});

test('every non-null stateField MEMORY_PRIORITIES points to is a real agent/core/stateModel.js field', () => {
  const stateFieldIds = STATE_FIELDS.map((f) => f.id);
  for (const priority of MEMORY_PRIORITIES) {
    if (priority.stateField) {
      assert.ok(stateFieldIds.includes(priority.stateField), `${priority.id} -> unknown state field ${priority.stateField}`);
    }
  }
});

test('a verified record (verification_status: passed) validates successfully', () => {
  const record = baseRecord();
  assert.deepStrictEqual(validateMemoryRecord(record), { valid: true, errors: [] });
});

test('an approved record (approval.status: approved) validates successfully even without verification_status passed', () => {
  const record = baseRecord({
    verificationStatus: 'unverified',
    approval: { approval_request_id: 'apr-1', status: 'approved', decided_by: 'naeema' },
  });
  assert.deepStrictEqual(validateMemoryRecord(record), { valid: true, errors: [] });
});

test('THE GATE: an unverified, unapproved record is rejected - never saved on a guess', () => {
  const record = baseRecord({ verificationStatus: 'unverified' });
  const result = validateMemoryRecord(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /verified.*approved/i.test(e)));
});

test('THE GATE: a failed verification_status with no approval is still rejected', () => {
  const record = baseRecord({ verificationStatus: 'failed' });
  assert.strictEqual(validateMemoryRecord(record).valid, false);
});

test('THE GATE: a pending (not yet decided) approval is not enough - only status "approved" counts', () => {
  const record = baseRecord({
    verificationStatus: 'unverified',
    approval: { approval_request_id: 'apr-1', status: 'pending' },
  });
  assert.strictEqual(validateMemoryRecord(record).valid, false);
});

test('THE GATE: a rejected approval is not enough', () => {
  const record = baseRecord({
    verificationStatus: 'unverified',
    approval: { approval_request_id: 'apr-1', status: 'rejected' },
  });
  assert.strictEqual(validateMemoryRecord(record).valid, false);
});

test('rejects a missing/empty id', () => {
  const record = baseRecord({ id: '' });
  const result = validateMemoryRecord(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /id/.test(e)));
});

test('rejects a missing/invalid business_id (business isolation starts at the schema)', () => {
  assert.strictEqual(validateMemoryRecord(baseRecord({ businessId: '' })).valid, false);
  assert.strictEqual(validateMemoryRecord(baseRecord({ businessId: '../escape' })).valid, false);
  assert.strictEqual(validateMemoryRecord(baseRecord({ businessId: 'valid-business-1' })).valid, true);
});

test('rejects a priority_id that is not one of MEMORY_PRIORITIES\' own ids', () => {
  const record = baseRecord({ priorityId: 'made_up_category' });
  const result = validateMemoryRecord(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /priority_id/.test(e)));
});

test('accepts every real MEMORY_PRIORITIES id', () => {
  for (const priorityId of MEMORY_PRIORITY_IDS) {
    const record = baseRecord({ priorityId });
    assert.strictEqual(validateMemoryRecord(record).valid, true, `${priorityId} should be accepted`);
  }
});

test('rejects a missing/empty summary - a memory record must say what it actually found', () => {
  assert.strictEqual(validateMemoryRecord(baseRecord({ summary: '' })).valid, false);
  assert.strictEqual(validateMemoryRecord(baseRecord({ summary: undefined })).valid, false);
});

test('rejects a summary over MAX_SUMMARY_LENGTH - "compact", never a raw dump', () => {
  const tooLong = 'x'.repeat(MAX_SUMMARY_LENGTH + 1);
  assert.strictEqual(validateMemoryRecord(baseRecord({ summary: tooLong })).valid, false);
  const justRight = 'x'.repeat(MAX_SUMMARY_LENGTH);
  assert.strictEqual(validateMemoryRecord(baseRecord({ summary: justRight })).valid, true);
});

test('rejects a non-object/array source - a reference only, never a raw data dump', () => {
  assert.strictEqual(validateMemoryRecord(baseRecord({ source: 'a raw string dump' })).valid, false);
  assert.strictEqual(validateMemoryRecord(baseRecord({ source: ['array', 'not', 'allowed'] })).valid, false);
  assert.strictEqual(validateMemoryRecord(baseRecord({ source: { run_id: 'run-1', tool_id: 'x' } })).valid, true);
  assert.strictEqual(validateMemoryRecord(baseRecord({ source: null })).valid, true);
});

test('rejects an invalid verification_status value outright (not just falling through to the gate check)', () => {
  const record = baseRecord({ verificationStatus: 'made_up_status' });
  const result = validateMemoryRecord(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /verification_status must be one of/.test(e)));
});

test('rejects a missing/invalid created_at', () => {
  const record = baseRecord({ createdAt: 'not a date' });
  assert.strictEqual(validateMemoryRecord(record).valid, false);
});

test('rejects a non-object record outright, and never throws', () => {
  assert.strictEqual(validateMemoryRecord(null).valid, false);
  assert.strictEqual(validateMemoryRecord('a string').valid, false);
  assert.strictEqual(validateMemoryRecord([1, 2, 3]).valid, false);
  assert.strictEqual(validateMemoryRecord(undefined).valid, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
