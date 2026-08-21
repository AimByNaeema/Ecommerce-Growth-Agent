'use strict';

const assert = require('node:assert');
const {
  SEO_RESEARCH_FIELDS,
  createEmptySeoResearchRecord,
  validateSeoResearchShape,
} = require('../../agent/core/seoResearchModel');

const EXPECTED_ORDER = [
  'keyword',
  'search_intent',
  'market',
  'language',
  'relevance',
  'competition',
  'opportunity',
  'source',
  'research_date',
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

test('the record has exactly the 10 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    SEO_RESEARCH_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of SEO_RESEARCH_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySeoResearchRecord() produces a record that passes validation', () => {
  const record = createEmptySeoResearchRecord('(no keyword set)');
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('validator detects a missing field', () => {
  const record = createEmptySeoResearchRecord();
  delete record.opportunity;
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: opportunity'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptySeoResearchRecord();
  record.search_volume = 1000;
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: search_volume'));
});

test('validator detects a wrong array type (source)', () => {
  const record = createEmptySeoResearchRecord();
  record.source = 'not an array';
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('source must be an array'));
});

test('validator detects an invalid relevance value', () => {
  const record = createEmptySeoResearchRecord();
  record.relevance = 'extremely relevant';
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('relevance must be one of')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptySeoResearchRecord();
  record.confidence = 'certain';
  const result = validateSeoResearchShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('a default-empty record has confidence "unassessed" and relevance "unassessed" - never assumed', () => {
  const record = createEmptySeoResearchRecord('some keyword');
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.relevance, 'unassessed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
