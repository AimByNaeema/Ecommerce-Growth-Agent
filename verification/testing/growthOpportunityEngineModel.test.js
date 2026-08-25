'use strict';

const assert = require('node:assert');
const {
  OPPORTUNITY_CATEGORIES,
  IMPACT_CATEGORIES,
  CONFIDENCE_MULTIPLIERS,
  RANKED_OPPORTUNITY_FIELDS,
  createEmptyRankedGrowthOpportunity,
  validateRankedGrowthOpportunityShape,
} = require('../../agent/core/growthOpportunityEngineModel');

const EXPECTED_CATEGORIES = [
  'products',
  'pricing',
  'listings',
  'seo',
  'marketing',
  'social',
  'advertising',
  'conversion',
  'retention',
];

const EXPECTED_IMPACT_CATEGORIES = [
  'revenue',
  'margin',
  'conversion_rate',
  'customer_retention',
  'customer_acquisition',
  'traffic_visibility',
  'operational_efficiency',
  'brand_trust',
];

const EXPECTED_FIELD_ORDER = [
  'category',
  'opportunity',
  'reason',
  'evidence',
  'expected_impact_category',
  'expected_impact_magnitude',
  'confidence',
  'verification_status',
  'required_action',
  'approval_requirement',
  'rank',
  'rank_score',
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

test('the 9 opportunity categories are in the requested order', () => {
  assert.deepStrictEqual(OPPORTUNITY_CATEGORIES, EXPECTED_CATEGORIES);
});

test('the 8 impact categories are the standard e-commerce set', () => {
  assert.deepStrictEqual(IMPACT_CATEGORIES, EXPECTED_IMPACT_CATEGORIES);
});

test('confidence multipliers cover all 4 confidence levels, unassessed contributes nothing', () => {
  assert.deepStrictEqual(CONFIDENCE_MULTIPLIERS, { unassessed: 0, low: 0.33, medium: 0.66, high: 1 });
});

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(RANKED_OPPORTUNITY_FIELDS.map((field) => field.id), EXPECTED_FIELD_ORDER);
});

test('every field has a non-empty title and description', () => {
  for (const field of RANKED_OPPORTUNITY_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyRankedGrowthOpportunity() produces a record that passes validation', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', '(no opportunity set)');
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyRankedGrowthOpportunity() defaults confidence/verification honestly', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
  assert.deepStrictEqual(record.evidence, []);
  assert.strictEqual(record.rank, 0);
  assert.strictEqual(record.rank_score, 0);
  assert.strictEqual(record.approval_requirement.requires_human_approval, false);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  delete record.reason;
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: reason'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.priority = 'high';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: priority'));
});

test('validator rejects an invalid category', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.category = 'not_a_real_category';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('category must be one of')));
});

test('validator rejects an invalid expected_impact_category', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.expected_impact_category = 'not_a_real_impact';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('expected_impact_category must be one of')));
});

test('validator rejects an invalid confidence value', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.confidence = 'certain';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('confidence must be one of')));
});

test('validator rejects an invalid verification_status value', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.verification_status = 'confirmed';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('verification_status must be one of')));
});

test('validator detects a missing sub-field in approval_requirement', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  delete record.approval_requirement.description;
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('approval_requirement is missing sub-field: description'));
});

test('validator detects an unexpected sub-field in approval_requirement', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.approval_requirement.urgency = 'high';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('approval_requirement has unexpected sub-field: urgency'));
});

test('validator rejects an invalid approval_requirement.classification', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.approval_requirement.classification = 'not_a_real_classification';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('approval_requirement.classification must be one of')));
});

test('validator rejects a non-boolean requires_human_approval', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.approval_requirement.requires_human_approval = 'yes';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('approval_requirement.requires_human_approval must be a boolean'));
});

test('validator rejects a non-array evidence field', () => {
  const record = createEmptyRankedGrowthOpportunity('seo', 'opportunity');
  record.evidence = 'not an array';
  const result = validateRankedGrowthOpportunityShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('evidence must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
