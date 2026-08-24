'use strict';

const assert = require('node:assert');
const {
  COMPETITOR_INTELLIGENCE_AREAS,
  COMPETITOR_INTELLIGENCE_FIELDS,
  createEmptyCompetitorIntelligence,
  validateCompetitorIntelligenceShape,
} = require('../../agent/core/competitorIntelligenceModel');

const EXPECTED_ORDER = [
  'competitor',
  'market',
  'research_date',
  'data_availability',
  'observed_facts',
  'analysis',
  'recommendations',
  'limitations',
  'source',
  'specialized_records',
];

const EXPECTED_AREAS = [
  'products',
  'positioning',
  'pricing',
  'offers',
  'listings',
  'seo_signals',
  'social_presence',
  'advertising_signals',
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

test('all 8 areas are defined, in the requested order', () => {
  assert.deepStrictEqual(COMPETITOR_INTELLIGENCE_AREAS, EXPECTED_AREAS);
});

test('the record has exactly the 10 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    COMPETITOR_INTELLIGENCE_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of COMPETITOR_INTELLIGENCE_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyCompetitorIntelligence() produces a record that passes validation', () => {
  const record = createEmptyCompetitorIntelligence('(no competitor set)');
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyCompetitorIntelligence() defaults data_availability to empty for every area - nothing assumed', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  for (const area of EXPECTED_AREAS) {
    assert.strictEqual(record.data_availability[area], 'empty');
  }
  assert.deepStrictEqual(record.observed_facts, []);
  assert.deepStrictEqual(record.analysis, []);
  assert.deepStrictEqual(record.recommendations, []);
});

test('validator detects a missing field', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  delete record.limitations;
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: limitations'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  record.score = 10;
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (observed_facts)', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  record.observed_facts = 'not an array';
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('observed_facts must be an array'));
});

test('validator detects a missing area in data_availability', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  delete record.data_availability.pricing;
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('data_availability is missing area: pricing'));
});

test('validator detects an unexpected area in data_availability', () => {
  const record = createEmptyCompetitorIntelligence('competitor');
  record.data_availability.not_a_real_area = 'empty';
  const result = validateCompetitorIntelligenceShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('data_availability has unexpected area: not_a_real_area'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
