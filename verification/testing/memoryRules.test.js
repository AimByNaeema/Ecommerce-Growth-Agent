'use strict';

const assert = require('node:assert');
const { STATE_FIELDS } = require('../../agent/core/stateModel');
const {
  MEMORY_QUALITIES,
  MEMORY_PRIORITIES,
  MEMORY_EXCLUSIONS,
} = require('../../agent/core/memoryRules');

const EXPECTED_QUALITIES = ['relevant', 'compact', 'structured', 'retrievable', 'safe'];
const EXPECTED_PRIORITIES = [
  'reusable_findings',
  'important_decisions',
  'business_configuration',
  'research_summaries',
  'completed_tasks',
  'useful_historical_context',
];
const EXPECTED_EXCLUSIONS = ['temporary_noise', 'full_conversation_by_default'];

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

test('exactly the 5 required memory qualities exist, in the requested order', () => {
  assert.deepStrictEqual(
    MEMORY_QUALITIES.map((q) => q.id),
    EXPECTED_QUALITIES
  );
});

test('exactly the 6 required priority categories exist, in the requested order', () => {
  assert.deepStrictEqual(
    MEMORY_PRIORITIES.map((p) => p.id),
    EXPECTED_PRIORITIES
  );
});

test('exactly the 2 required exclusions exist', () => {
  assert.deepStrictEqual(MEMORY_EXCLUSIONS.map((e) => e.id).sort(), EXPECTED_EXCLUSIONS.sort());
});

test('every quality, priority, and exclusion has a non-empty description', () => {
  for (const entry of [...MEMORY_QUALITIES, ...MEMORY_PRIORITIES, ...MEMORY_EXCLUSIONS]) {
    assert.ok(
      entry.description && entry.description.trim() !== '',
      `${entry.id} is missing a description`
    );
  }
});

test('every non-null priority stateField actually exists in stateModel.js', () => {
  const stateFieldIds = STATE_FIELDS.map((field) => field.id);
  for (const priority of MEMORY_PRIORITIES) {
    if (priority.stateField !== null) {
      assert.ok(
        stateFieldIds.includes(priority.stateField),
        `${priority.id} references unknown state field "${priority.stateField}"`
      );
    }
  }
});

test('useful_historical_context intentionally has no single state field', () => {
  const entry = MEMORY_PRIORITIES.find((p) => p.id === 'useful_historical_context');
  assert.strictEqual(entry.stateField, null);
});

test('no priority id is also listed as an exclusion (no contradictory rules)', () => {
  const priorityIds = new Set(MEMORY_PRIORITIES.map((p) => p.id));
  for (const exclusion of MEMORY_EXCLUSIONS) {
    assert.ok(!priorityIds.has(exclusion.id), `${exclusion.id} is both prioritized and excluded`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
