'use strict';

const assert = require('node:assert');
const {
  DIMENSION_RESULT_IDS,
  OPPORTUNITY_SCORING_STATUSES,
  PRODUCT_AGENT_RESULT_FIELDS,
  createEmptyProductAgentResult,
  validateProductAgentResultShape,
} = require('../../agent/core/productAgentResultModel');

const EXPECTED_ORDER = [
  'product_identity',
  'market',
  'research_date',
  'validation',
  'demand',
  'competition',
  'market_fit',
  'product_risk',
  'profitability_inputs',
  'opportunity_scoring',
  'limitations',
  'source',
  'specialized_records',
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

test('the record has exactly the 13 required fields, in the requested order', () => {
  assert.deepStrictEqual(PRODUCT_AGENT_RESULT_FIELDS.map((field) => field.id), EXPECTED_ORDER);
});

test('the 4 dimension result ids are demand/competition/market_fit/product_risk, in order', () => {
  assert.deepStrictEqual(DIMENSION_RESULT_IDS, ['demand', 'competition', 'market_fit', 'product_risk']);
});

test('opportunity scoring statuses are empty/partial/success', () => {
  assert.deepStrictEqual(OPPORTUNITY_SCORING_STATUSES, ['empty', 'partial', 'success']);
});

test('every field has a non-empty title and description', () => {
  for (const field of PRODUCT_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyProductAgentResult() produces a record that passes validation', () => {
  const record = createEmptyProductAgentResult('(no product identity set)');
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyProductAgentResult() defaults every dimension to unassessed/empty - nothing assumed', () => {
  const record = createEmptyProductAgentResult('product');
  for (const id of DIMENSION_RESULT_IDS) {
    assert.strictEqual(record[id].confidence, 'unassessed');
    assert.deepStrictEqual(record[id].evidence, []);
  }
  assert.strictEqual(record.opportunity_scoring.status, 'empty');
  assert.strictEqual(record.opportunity_scoring.dimensions_evidence_backed, 0);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyProductAgentResult('product');
  delete record.limitations;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: limitations'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyProductAgentResult('product');
  record.score = 10;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (limitations)', () => {
  const record = createEmptyProductAgentResult('product');
  record.limitations = 'not an array';
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('limitations must be an array'));
});

test('validator detects a missing sub-field in a dimension (demand)', () => {
  const record = createEmptyProductAgentResult('product');
  delete record.demand.confidence;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('demand is missing sub-field: confidence'));
});

test('validator detects an unexpected sub-field in a dimension (product_risk)', () => {
  const record = createEmptyProductAgentResult('product');
  record.product_risk.score = 5;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('product_risk has unexpected sub-field: score'));
});

test('validator detects a missing sub-field in validation', () => {
  const record = createEmptyProductAgentResult('product');
  delete record.validation.is_research_ready;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('validation is missing sub-field: is_research_ready'));
});

test('validator detects a missing sub-field in profitability_inputs', () => {
  const record = createEmptyProductAgentResult('product');
  delete record.profitability_inputs.cost_components;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('profitability_inputs is missing sub-field: cost_components'));
});

test('validator detects a missing sub-field in opportunity_scoring', () => {
  const record = createEmptyProductAgentResult('product');
  delete record.opportunity_scoring.status;
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('opportunity_scoring is missing sub-field: status'));
});

test('validator detects an invalid opportunity_scoring.status value', () => {
  const record = createEmptyProductAgentResult('product');
  record.opportunity_scoring.status = 'great';
  const result = validateProductAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('opportunity_scoring.status must be one of')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
