'use strict';

const assert = require('node:assert');
const {
  ACTION_CLASSIFICATIONS,
  APPROVAL_POLICY_RULES,
  getClassificationById,
} = require('../../approvals/approvalArchitecture');

const EXPECTED_CLASSIFICATIONS = [
  'analysis_only',
  'recommendation',
  'approval_required',
  'externally_executable',
];

const EXPECTED_POLICY_RULES = ['approval_required_by_default', 'never_silent_consequential_action'];

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

test('the 4 required classifications exist, in the requested order', () => {
  assert.deepStrictEqual(
    ACTION_CLASSIFICATIONS.map((entry) => entry.id),
    EXPECTED_CLASSIFICATIONS
  );
});

test('the 2 required policy rules exist, in the requested order', () => {
  assert.deepStrictEqual(
    APPROVAL_POLICY_RULES.map((rule) => rule.id),
    EXPECTED_POLICY_RULES
  );
});

test('every classification has a non-empty title and description', () => {
  for (const entry of ACTION_CLASSIFICATIONS) {
    assert.ok(entry.title && entry.title.trim() !== '', `${entry.id} is missing a title`);
    assert.ok(entry.description && entry.description.trim() !== '', `${entry.id} is missing a description`);
  }
});

test('every policy rule has a non-empty description', () => {
  for (const rule of APPROVAL_POLICY_RULES) {
    assert.ok(rule.description && rule.description.trim() !== '', `${rule.id} is missing a description`);
  }
});

test('ids are unique across classifications and policy rules combined', () => {
  const ids = [...ACTION_CLASSIFICATIONS, ...APPROVAL_POLICY_RULES].map((entry) => entry.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('getClassificationById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getClassificationById('externally_executable').title, 'Externally executable');
  assert.strictEqual(getClassificationById('does_not_exist'), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
