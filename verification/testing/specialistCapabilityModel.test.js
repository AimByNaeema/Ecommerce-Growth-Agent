'use strict';

const assert = require('node:assert');
const {
  CAPABILITY_TASK_FIELDS,
  SPECIALIST_CAPABILITY_ENTRY_FIELDS,
  createEmptyCapabilityTask,
  createEmptySpecialistCapabilityEntry,
  validateCapabilityTaskShape,
  validateSpecialistCapabilityEntryShape,
} = require('../../agent/core/specialistCapabilityModel');

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

test('the capability task record has exactly the 6 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    CAPABILITY_TASK_FIELDS.map((f) => f.id),
    ['id', 'title', 'description', 'tool_ids', 'input_contract', 'output_contract']
  );
});

test('the specialist capability entry has exactly the 8 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    SPECIALIST_CAPABILITY_ENTRY_FIELDS.map((f) => f.id),
    ['id', 'title', 'description', 'status', 'supported_tasks', 'required_tools', 'permissions', 'approval_requirements']
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of [...CAPABILITY_TASK_FIELDS, ...SPECIALIST_CAPABILITY_ENTRY_FIELDS]) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyCapabilityTask() produces a record that passes validation', () => {
  const task = createEmptyCapabilityTask('example_task');
  const result = validateCapabilityTaskShape(task);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.valid, true);
});

test('createEmptyCapabilityTask() defaults tool_ids to empty - a task with no wired tool is honestly representable, not an error', () => {
  const task = createEmptyCapabilityTask('example_task');
  assert.deepStrictEqual(task.tool_ids, []);
  assert.strictEqual(validateCapabilityTaskShape(task).valid, true);
});

test('validateCapabilityTaskShape() detects a missing field', () => {
  const task = createEmptyCapabilityTask('example_task');
  delete task.title;
  const result = validateCapabilityTaskShape(task);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: title'));
});

test('validateCapabilityTaskShape() detects an unexpected field', () => {
  const task = createEmptyCapabilityTask('example_task');
  task.unexpected = true;
  const result = validateCapabilityTaskShape(task);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: unexpected'));
});

test('validateCapabilityTaskShape() rejects a non-array tool_ids', () => {
  const task = createEmptyCapabilityTask('example_task');
  task.tool_ids = 'not-an-array';
  const result = validateCapabilityTaskShape(task);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('tool_ids must be an array'));
});

test('validateCapabilityTaskShape() rejects a malformed input_contract', () => {
  const task = createEmptyCapabilityTask('example_task');
  task.input_contract = { required: 'not-an-array', optional: [], extra: true };
  const result = validateCapabilityTaskShape(task);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('input_contract.required must be an array'));
  assert.ok(result.errors.includes('input_contract has unexpected sub-field: extra'));
});

test('validateCapabilityTaskShape() rejects a malformed output_contract', () => {
  const task = createEmptyCapabilityTask('example_task');
  task.output_contract = { model: 123, fields: 'not-an-array' };
  const result = validateCapabilityTaskShape(task);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('output_contract.model must be a string or null'));
  assert.ok(result.errors.includes('output_contract.fields must be an array'));
});

test('createEmptySpecialistCapabilityEntry() produces a record that passes validation, defaulting to status not_implemented', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  assert.strictEqual(entry.status, 'not_implemented');
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.valid, true);
});

test('validateSpecialistCapabilityEntryShape() detects a missing field', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  delete entry.permissions;
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: permissions'));
});

test('validateSpecialistCapabilityEntryShape() detects an unexpected field', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  entry.unexpected = true;
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: unexpected'));
});

test('validateSpecialistCapabilityEntryShape() rejects an invalid status', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  entry.status = 'sort_of_implemented';
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('status must be one of:')));
});

test('validateSpecialistCapabilityEntryShape() rejects a malformed permissions object', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  entry.permissions = { categories: 'not-an-array', tool_access: [], extra: true };
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('permissions.categories must be an array'));
  assert.ok(result.errors.includes('permissions has unexpected sub-field: extra'));
});

test('validateSpecialistCapabilityEntryShape() rejects an approval_requirements entry with a non-boolean requires_human_approval', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  entry.approval_requirements = [
    { tool_id: 'x', classification: null, title: null, description: null, requires_human_approval: 'yes' },
  ];
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('approval_requirements[0].requires_human_approval must be a boolean'));
});

test('validateSpecialistCapabilityEntryShape() validates every supported_tasks entry and prefixes its errors', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  const badTask = createEmptyCapabilityTask('bad_task');
  delete badTask.description;
  entry.supported_tasks = [badTask];
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('bad_task') && e.includes('missing field: description')));
});

test('validateSpecialistCapabilityEntryShape() rejects a task tool_id not present in the entry\'s own required_tools', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  const task = createEmptyCapabilityTask('task_with_gap');
  task.title = 'Task with gap';
  task.description = 'A task referencing a tool the entry never declared.';
  task.tool_ids = ['some_tool'];
  entry.supported_tasks = [task];
  entry.required_tools = [];
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("references tool_id 'some_tool' not present in required_tools")));
});

test('a task with tool_ids: [] still validates at the entry level - an honestly-unwired capability is not an error', () => {
  const entry = createEmptySpecialistCapabilityEntry('example');
  const task = createEmptyCapabilityTask('unwired_task');
  task.title = 'Unwired task';
  task.description = 'A real capability with no tool wrapping it yet.';
  entry.supported_tasks = [task];
  const result = validateSpecialistCapabilityEntryShape(entry);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.valid, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
