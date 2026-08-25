'use strict';

const assert = require('node:assert');
const { LESSON_OUTCOMES, createEmptyLesson, validateLessonShape } = require('../../agent/core/experimentLessonModel');

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

// --- createEmptyLesson ---

test('createEmptyLesson() conforms to its own validator', () => {
  const validation = validateLessonShape(createEmptyLesson('exp-001', 'pricing', '(no subject set)'));
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
});

test('createEmptyLesson() defaults to outcome success and confidence unassessed', () => {
  const record = createEmptyLesson('exp-001', 'seo', '');
  assert.strictEqual(record.outcome, 'success');
  assert.strictEqual(record.confidence, 'unassessed');
});

test('LESSON_OUTCOMES is exactly the strict success/failure binary', () => {
  assert.deepStrictEqual(LESSON_OUTCOMES, ['success', 'failure']);
});

// --- validateLessonShape: top-level field checks ---

test('a record missing a required top-level field is invalid', () => {
  const record = createEmptyLesson('exp-001', 'marketing', '');
  delete record.lesson;
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('missing field: lesson'));
});

test('a record with an unexpected top-level field is invalid', () => {
  const record = createEmptyLesson('exp-001', 'social', '');
  record.unexpected_field = 'nope';
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('unexpected field: unexpected_field'));
});

test('outcome must be one of success/failure', () => {
  const record = createEmptyLesson('exp-001', 'offers', '');
  record.outcome = 'partial-success';
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('outcome must be one of:')));
});

test('confidence must be a real CONFIDENCE_LEVELS member', () => {
  const record = createEmptyLesson('exp-001', 'advertising', '');
  record.confidence = 'certain';
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('confidence must be one of:')));
});

// --- validateLessonShape: nested sub-key checks ---

test('experiment reference missing a required sub-field is invalid', () => {
  const record = createEmptyLesson('exp-001', 'listing', '');
  delete record.experiment.domain;
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('experiment is missing sub-field: domain'));
});

test('result missing a required sub-field is invalid', () => {
  const record = createEmptyLesson('exp-001', 'products', '');
  delete record.result.observed_effect;
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('result is missing sub-field: observed_effect'));
});

test('result with an unexpected sub-field is invalid', () => {
  const record = createEmptyLesson('exp-001', 'pricing', '');
  record.result.extra = true;
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('result has unexpected sub-field: extra'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
