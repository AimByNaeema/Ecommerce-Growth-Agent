'use strict';

const assert = require('node:assert');
const { AGENT_CONTRACT } = require('../../agent/core/agentContract');

// The exact order requested for the ONE agent's conceptual lifecycle.
const EXPECTED_ORDER = [
  'understand_objective',
  'inspect_configuration',
  'retrieve_context',
  'inspect_memory_state',
  'identify_required_work',
  'select_tools',
  'execute_work',
  'verify_results',
  'handle_errors',
  'save_state',
  'respond',
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

test('contract has exactly the 11 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    AGENT_CONTRACT.map((stage) => stage.id),
    EXPECTED_ORDER
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of AGENT_CONTRACT) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(
      stage.description && stage.description.trim() !== '',
      `${stage.id} is missing a description`
    );
  }
});

test('stage ids are unique', () => {
  const ids = AGENT_CONTRACT.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
