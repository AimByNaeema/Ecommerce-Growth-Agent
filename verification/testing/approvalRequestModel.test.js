'use strict';

const assert = require('node:assert');
const {
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_FIELDS,
  createEmptyApprovalRequest,
  validateApprovalRequestShape,
} = require('../../approvals/approvalRequestModel');

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

const EXPECTED_FIELD_IDS = [
  'id',
  'classification',
  'specialist_id',
  'tool_id',
  'execution_request',
  'reason',
  'status',
  'requested_at',
  'decided_at',
  'decided_by',
  'decision_notes',
];

test('the schema has exactly the 11 required fields, in the requested order', () => {
  assert.deepStrictEqual(APPROVAL_REQUEST_FIELDS.map((field) => field.id), EXPECTED_FIELD_IDS);
});

test('every field has a non-empty title and description', () => {
  for (const field of APPROVAL_REQUEST_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('APPROVAL_REQUEST_STATUSES is exactly the pending/approved/rejected lifecycle', () => {
  assert.deepStrictEqual(APPROVAL_REQUEST_STATUSES, ['pending', 'approved', 'rejected']);
});

test('createEmptyApprovalRequest returns minimal, honest defaults - nothing invented', () => {
  const record = createEmptyApprovalRequest('apr-1');
  assert.strictEqual(record.id, 'apr-1');
  assert.strictEqual(record.classification, '');
  assert.strictEqual(record.specialist_id, null);
  assert.strictEqual(record.tool_id, '');
  assert.deepStrictEqual(record.execution_request, {});
  assert.strictEqual(record.reason, '');
  assert.strictEqual(record.status, 'pending');
  assert.strictEqual(record.requested_at, '');
  assert.strictEqual(record.decided_at, null);
  assert.strictEqual(record.decided_by, null);
  assert.strictEqual(record.decision_notes, null);
});

function validRecord() {
  return {
    id: 'apr-1',
    classification: 'approval_required',
    specialist_id: 'seo',
    tool_id: 'hypothetical_publish_listing',
    execution_request: { objective: 'publish' },
    reason: 'Explicit approval required.',
    status: 'pending',
    requested_at: '2026-08-25T00:00:00.000Z',
    decided_at: null,
    decided_by: null,
    decision_notes: null,
  };
}

test('validateApprovalRequestShape accepts a well-formed record', () => {
  const result = validateApprovalRequestShape(validRecord());
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateApprovalRequestShape rejects a non-object record', () => {
  const result = validateApprovalRequestShape(null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors[0].includes('must be a plain object'));
});

test('validateApprovalRequestShape reports a missing field', () => {
  const record = validRecord();
  delete record.reason;
  const result = validateApprovalRequestShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: reason'));
});

test('validateApprovalRequestShape reports an unexpected extra field', () => {
  const record = validRecord();
  record.unnecessary_extra_data = 'should not exist';
  const result = validateApprovalRequestShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: unnecessary_extra_data'));
});

test('validateApprovalRequestShape rejects an invalid status value', () => {
  const record = validRecord();
  record.status = 'archived';
  const result = validateApprovalRequestShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((err) => err.startsWith('status must be one of')));
});

test('validateApprovalRequestShape rejects an unknown classification id', () => {
  const record = validRecord();
  record.classification = 'not_a_real_classification';
  const result = validateApprovalRequestShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((err) => err.includes('real classification ids')));
});

test('validateApprovalRequestShape rejects a non-object execution_request', () => {
  const record = validRecord();
  record.execution_request = 'not an object';
  const result = validateApprovalRequestShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('execution_request must be an object'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
