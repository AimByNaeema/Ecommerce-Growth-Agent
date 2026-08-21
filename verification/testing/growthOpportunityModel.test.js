'use strict';

const assert = require('node:assert');
const {
  GROWTH_OPPORTUNITY_TYPES,
  GROWTH_OPPORTUNITY_FIELDS,
  createEmptyGrowthOpportunityRecord,
  validateGrowthOpportunityShape,
} = require('../../agent/core/growthOpportunityModel');

const EXPECTED_ORDER = [
  'opportunity_type',
  'product_reference',
  'related_products',
  'target_segment',
  'offer',
  'recommendation',
  'evidence',
  'verification_status',
];

const EXPECTED_TYPES = [
  'unclassified',
  'upselling',
  'cross_selling',
  'retention',
  'repeat_purchases',
  'customer_reengagement',
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

test('the record has exactly the 8 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    GROWTH_OPPORTUNITY_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('opportunity_type covers exactly the 5 requested categories plus unclassified', () => {
  assert.deepStrictEqual(GROWTH_OPPORTUNITY_TYPES, EXPECTED_TYPES);
});

test('every field has a non-empty title and description', () => {
  for (const field of GROWTH_OPPORTUNITY_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyGrowthOpportunityRecord() produces a record that passes validation', () => {
  const record = createEmptyGrowthOpportunityRecord('unclassified', '(no product set)');
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('a default-empty record has opportunity_type "unclassified" and verification_status "unverified" - never assumed', () => {
  const record = createEmptyGrowthOpportunityRecord();
  assert.strictEqual(record.opportunity_type, 'unclassified');
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing field', () => {
  const record = createEmptyGrowthOpportunityRecord();
  delete record.recommendation;
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: recommendation'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyGrowthOpportunityRecord();
  record.projected_revenue = '$500';
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: projected_revenue'));
});

test('validator detects a wrong array type (related_products)', () => {
  const record = createEmptyGrowthOpportunityRecord();
  record.related_products = 'not an array';
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('related_products must be an array'));
});

test('validator detects a wrong array type (evidence)', () => {
  const record = createEmptyGrowthOpportunityRecord();
  record.evidence = 'not an array';
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

test('validator detects an invalid opportunity_type value', () => {
  const record = createEmptyGrowthOpportunityRecord();
  record.opportunity_type = 'guaranteed_win';
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('opportunity_type must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyGrowthOpportunityRecord();
  record.verification_status = 'confirmed';
  const result = validateGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
