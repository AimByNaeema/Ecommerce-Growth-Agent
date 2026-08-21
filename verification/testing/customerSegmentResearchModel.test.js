'use strict';

const assert = require('node:assert');
const {
  CUSTOMER_SEGMENT_RESEARCH_FIELDS,
  createEmptyCustomerSegmentResearchRecord,
  validateCustomerSegmentResearchShape,
} = require('../../agent/core/customerSegmentResearchModel');

const EXPECTED_ORDER = [
  'segment_definition',
  'needs',
  'problems',
  'buying_motivations',
  'objections',
  'preferences',
  'market',
  'evidence',
  'confidence',
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

test('the record has exactly the 9 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    CUSTOMER_SEGMENT_RESEARCH_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of CUSTOMER_SEGMENT_RESEARCH_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyCustomerSegmentResearchRecord() produces a record that passes validation', () => {
  const record = createEmptyCustomerSegmentResearchRecord('budget-conscious first-time buyers');
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('a default-empty record has confidence "unassessed" - never assumed', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  assert.strictEqual(record.confidence, 'unassessed');
});

test('validator detects a missing field', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  delete record.needs;
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: needs'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  record.persona_name = 'Alex';
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: persona_name'));
});

test('validator detects a wrong array type (objections)', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  record.objections = 'not an array';
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('objections must be an array'));
});

test('validator detects a wrong array type (evidence)', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  record.evidence = 'not an array';
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyCustomerSegmentResearchRecord();
  record.confidence = 'certain';
  const result = validateCustomerSegmentResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of:')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
