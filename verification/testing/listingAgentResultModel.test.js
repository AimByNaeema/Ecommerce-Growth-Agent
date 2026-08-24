'use strict';

const assert = require('node:assert');
const {
  LISTING_CAPABILITIES,
  LISTING_AGENT_RESULT_FIELDS,
  createEmptyListingAgentResult,
  validateListingAgentResultShape,
} = require('../../agent/core/listingAgentResultModel');

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

test('LISTING_CAPABILITIES lists exactly the 2 supported capabilities', () => {
  assert.deepStrictEqual(LISTING_CAPABILITIES, ['listing_content', 'marketplace_format']);
});

test('every field has a non-empty title and description', () => {
  for (const field of LISTING_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyListingAgentResult() produces a record that passes validation', () => {
  const record = createEmptyListingAgentResult('listing_content', '(no topic set)');
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyListingAgentResult() defaults confidence to unassessed and verification_status to unverified', () => {
  const record = createEmptyListingAgentResult();
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyListingAgentResult();
  delete record.specialized_records;
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: specialized_records'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyListingAgentResult();
  record.ranking_prediction = '#1';
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: ranking_prediction'));
});

test('validator detects an invalid capability value', () => {
  const record = createEmptyListingAgentResult();
  record.capability = 'not_a_real_capability';
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('capability must be one of')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyListingAgentResult();
  record.confidence = 'extremely high';
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyListingAgentResult();
  record.verification_status = 'confirmed';
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptyListingAgentResult();
  record.findings = 'not an array';
  const result = validateListingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
