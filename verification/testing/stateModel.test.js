'use strict';

const assert = require('node:assert');
const {
  STATE_FIELDS,
  createEmptyState,
  validateStateShape,
} = require('../../agent/core/stateModel');

const EXPECTED_ORDER = [
  'current_objective',
  'task_status',
  'relevant_configuration',
  'selected_research',
  'findings',
  'decisions',
  'pending_work',
  'completed_work',
  'failed_work',
  'verification_status',
  'approvals',
];

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

test('exactly the 11 required state fields exist, in the requested order', () => {
  assert.deepStrictEqual(
    STATE_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title, type, and description', () => {
  for (const field of STATE_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.type && field.type.trim() !== '', `${field.id} is missing a type`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('the model never defines a conversation/history/message field', () => {
  for (const field of STATE_FIELDS) {
    assert.ok(
      !/conversation|transcript|message_history/i.test(field.id),
      `${field.id} looks like it stores conversation history, which is explicitly out of scope`
    );
  }
});

test('createEmptyState returns a shape that passes validateStateShape', () => {
  const empty = createEmptyState('Test objective');
  const result = validateStateShape(empty);
  assert.strictEqual(result.valid, true, `unexpected errors: ${result.errors.join(', ')}`);
  assert.strictEqual(empty.current_objective, 'Test objective');
  assert.strictEqual(empty.task_status, 'not_started');
  assert.strictEqual(empty.verification_status, 'unverified');
});

test('validateStateShape reports missing fields', () => {
  const incomplete = createEmptyState('x');
  delete incomplete.findings;
  delete incomplete.approvals;
  const result = validateStateShape(incomplete);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.errors.sort(),
    ['missing field: findings', 'missing field: approvals'].sort()
  );
});

test('validateStateShape reports unexpected extra fields', () => {
  const withExtra = { ...createEmptyState('x'), conversation_log: ['hi'] };
  const result = validateStateShape(withExtra);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: conversation_log'));
});

test('validateStateShape reports wrong types without guessing or coercing', () => {
  const wrongTypes = { ...createEmptyState('x'), findings: 'not an array', task_status: 'bogus' };
  const result = validateStateShape(wrongTypes);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
  assert.ok(result.errors.some((e) => e.startsWith('task_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
