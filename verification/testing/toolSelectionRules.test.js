'use strict';

const assert = require('node:assert');
const {
  TOOL_SELECTION_RULES,
} = require('../../agent/core/toolSelectionRules');

const EXPECTED_ORDER = [
  'use_only_relevant_tools',
  'avoid_unnecessary_tool_calls',
  'reuse_valid_existing_information',
  'avoid_duplicate_research',
  'verify_tool_results',
  'handle_tool_failures',
  'never_invent_tool_results',
  'stop_when_enough_evidence_exists',
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

test('the 8 required rules exist, in the requested order', () => {
  assert.deepStrictEqual(
    TOOL_SELECTION_RULES.map((rule) => rule.id),
    EXPECTED_ORDER
  );
});

test('every rule has a non-empty description', () => {
  for (const rule of TOOL_SELECTION_RULES) {
    assert.ok(rule.description && rule.description.trim() !== '', `${rule.id} is missing a description`);
  }
});

test('rule ids are unique', () => {
  const ids = TOOL_SELECTION_RULES.map((rule) => rule.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
