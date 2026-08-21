'use strict';

const assert = require('node:assert');
const {
  STATEMENT_TYPES,
  ANALYTICS_INSIGHT_STAGES,
  getStatementTypeById,
} = require('../../workflows/analyticsInsightWorkflow');

const EXPECTED_STAGES = [
  'data',
  'finding',
  'interpretation',
  'opportunity',
  'recommendation',
  'expected_impact',
  'verification',
];

const EXPECTED_STATEMENT_TYPES = [
  'observed_fact',
  'calculated_result',
  'interpretation',
  'hypothesis',
  'recommendation',
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

test('the workflow has exactly the 7 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    ANALYTICS_INSIGHT_STAGES.map((stage) => stage.id),
    EXPECTED_STAGES
  );
});

test('the 5 required statement types exist, in the requested order', () => {
  assert.deepStrictEqual(
    STATEMENT_TYPES.map((entry) => entry.id),
    EXPECTED_STATEMENT_TYPES
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of ANALYTICS_INSIGHT_STAGES) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(stage.description && stage.description.trim() !== '', `${stage.id} is missing a description`);
  }
});

test('every statement type has a non-empty title and description', () => {
  for (const entry of STATEMENT_TYPES) {
    assert.ok(entry.title && entry.title.trim() !== '', `${entry.id} is missing a title`);
    assert.ok(entry.description && entry.description.trim() !== '', `${entry.id} is missing a description`);
  }
});

test('stage ids are unique', () => {
  const ids = ANALYTICS_INSIGHT_STAGES.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('statement type ids are unique', () => {
  const ids = STATEMENT_TYPES.map((entry) => entry.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('getStatementTypeById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getStatementTypeById('hypothesis').title, 'Hypothesis');
  assert.strictEqual(getStatementTypeById('does_not_exist'), undefined);
});

test('opportunity and expected_impact stages are explicitly labeled hypothesis, never a fact', () => {
  const opportunity = ANALYTICS_INSIGHT_STAGES.find((stage) => stage.id === 'opportunity');
  const expectedImpact = ANALYTICS_INSIGHT_STAGES.find((stage) => stage.id === 'expected_impact');
  assert.ok(opportunity.description.includes('hypothesis'));
  assert.ok(expectedImpact.description.includes('hypothesis'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
