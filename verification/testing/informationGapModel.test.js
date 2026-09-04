'use strict';

// Schema tests for agent/core/informationGapModel.js - the shape of one information-gap
// opportunity. Same conventions as verification/testing/seoAgentResultModel.test.js:
// plain node:assert, no framework, no external call of any kind.

const assert = require('node:assert');
const {
  EVIDENCE_STRENGTHS,
  QUESTION_TYPES,
  GAP_TYPES,
  GAP_STATUSES,
  INFORMATION_GAP_FIELDS,
  createEmptyInformationGapRecord,
  validateInformationGapShape,
} = require('../../agent/core/informationGapModel');

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

test('EVIDENCE_STRENGTHS keeps the three provenance levels, ordered strongest first', () => {
  // The order is load-bearing: agent/core/informationGapEngine.js compares by index to
  // pick a question cluster's canonical member.
  assert.deepStrictEqual(EVIDENCE_STRENGTHS, ['observed', 'inferred', 'model_generated']);
});

test('GAP_TYPES lists exactly the classified gap kinds', () => {
  assert.deepStrictEqual(GAP_TYPES, [
    'missing_question',
    'weak_answer',
    'incomplete_answer',
    'unclear_answer',
    'outdated_answer',
    'poor_product_context',
    'missing_comparison',
    'missing_use_case',
    'missing_troubleshooting',
    'missing_buying_information',
  ]);
});

test('GAP_STATUSES includes the required review/uncertainty status', () => {
  assert.deepStrictEqual(GAP_STATUSES, ['opportunity', 'review', 'no_gap']);
  assert.ok(GAP_STATUSES.includes('review'));
});

test('QUESTION_TYPES defaults to an explicit unclassified rather than guessing', () => {
  assert.ok(QUESTION_TYPES.includes('unclassified'));
});

test('createEmptyInformationGapRecord has exactly the fields in INFORMATION_GAP_FIELDS', () => {
  const record = createEmptyInformationGapRecord('why does this happen?');
  assert.deepStrictEqual(Object.keys(record), INFORMATION_GAP_FIELDS.map((field) => field.id));
});

test('an empty record starts at the most cautious possible position', () => {
  // A record that is never populated must not be able to read as a verified
  // opportunity - this is the schema-level half of the provenance guarantee.
  const record = createEmptyInformationGapRecord('why does this happen?');
  assert.strictEqual(record.evidence_strength, 'model_generated');
  assert.strictEqual(record.status, 'review');
  assert.strictEqual(record.gap_type, null);
  assert.strictEqual(record.opportunity_score, 0);
  assert.deepStrictEqual(record.evidence_sources, []);
  assert.deepStrictEqual(record.score_reasons, []);
});

test('an empty record is valid by construction', () => {
  const validation = validateInformationGapShape(createEmptyInformationGapRecord('a question'));
  assert.strictEqual(validation.valid, true, validation.errors.join('; '));
});

test('validateInformationGapShape rejects a non-object', () => {
  assert.strictEqual(validateInformationGapShape(null).valid, false);
  assert.strictEqual(validateInformationGapShape([]).valid, false);
  assert.strictEqual(validateInformationGapShape('nope').valid, false);
});

test('validateInformationGapShape reports a missing field', () => {
  const record = createEmptyInformationGapRecord('a question');
  delete record.gap_type;
  const validation = validateInformationGapShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('missing field: gap_type')));
});

test('validateInformationGapShape reports an unexpected field', () => {
  const record = createEmptyInformationGapRecord('a question');
  record.estimated_search_volume = 1000;
  const validation = validateInformationGapShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('unexpected field: estimated_search_volume')));
});

test('validateInformationGapShape rejects an empty question', () => {
  const record = createEmptyInformationGapRecord('a question');
  record.question = '   ';
  assert.strictEqual(validateInformationGapShape(record).valid, false);
});

test('validateInformationGapShape rejects an out-of-enum evidence_strength, status or gap_type', () => {
  for (const [field, badValue] of [
    ['evidence_strength', 'verified'],
    ['status', 'APPROVED'],
    ['gap_type', 'made_up_gap'],
    ['question_type', 'speculative'],
  ]) {
    const record = createEmptyInformationGapRecord('a question');
    record[field] = badValue;
    const validation = validateInformationGapShape(record);
    assert.strictEqual(validation.valid, false, `${field}=${badValue} should be rejected`);
    assert.ok(validation.errors.some((error) => error.includes(field)));
  }
});

test('gap_type null is explicitly valid - "no gap" is a real outcome, not a missing value', () => {
  const record = createEmptyInformationGapRecord('a question');
  record.gap_type = null;
  record.status = 'no_gap';
  assert.strictEqual(validateInformationGapShape(record).valid, true);
});

test('validateInformationGapShape rejects an out-of-range or non-numeric score', () => {
  for (const badScore of [-1, 101, '80', Number.NaN]) {
    const record = createEmptyInformationGapRecord('a question');
    record.opportunity_score = badScore;
    assert.strictEqual(validateInformationGapShape(record).valid, false, `score ${badScore} should be rejected`);
  }
});

test('validateInformationGapShape rejects a non-array array field and a non-object coverage field', () => {
  const arrayCase = createEmptyInformationGapRecord('a question');
  arrayCase.score_reasons = 'because';
  assert.strictEqual(validateInformationGapShape(arrayCase).valid, false);

  const objectCase = createEmptyInformationGapRecord('a question');
  objectCase.competitor_coverage = [];
  assert.strictEqual(validateInformationGapShape(objectCase).valid, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
