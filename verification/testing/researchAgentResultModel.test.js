'use strict';

const assert = require('node:assert');
const {
  RESEARCH_TYPES,
  RESEARCH_AGENT_RESULT_FIELDS,
  createEmptyResearchAgentResult,
  validateResearchAgentResultShape,
} = require('../../agent/core/researchAgentResultModel');

const EXPECTED_ORDER = [
  'research_type',
  'topic',
  'market',
  'findings',
  'evidence',
  'source',
  'confidence',
  'limitations',
  'recommendations',
  'verification_status',
  'research_date',
  'specialized_records',
];

const EXPECTED_RESEARCH_TYPES = [
  'market_research',
  'global_market_research',
  'competitor_research',
  'trend_research',
  'customer_market_intelligence',
  'opportunity_discovery',
  'customer_segmentation',
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

test('all 7 research types are defined, in the requested order', () => {
  assert.deepStrictEqual(RESEARCH_TYPES, EXPECTED_RESEARCH_TYPES);
});

test('the record has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(
    RESEARCH_AGENT_RESULT_FIELDS.map((field) => field.id),
    EXPECTED_ORDER
  );
});

test('every field has a non-empty title and description', () => {
  for (const field of RESEARCH_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyResearchAgentResult() produces a record that passes validation', () => {
  const record = createEmptyResearchAgentResult('market_research', '(no topic set)');
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('createEmptyResearchAgentResult() defaults confidence/verification_status honestly', () => {
  const record = createEmptyResearchAgentResult('trend_research', 'topic');
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
  assert.deepStrictEqual(record.recommendations, []);
  assert.deepStrictEqual(record.limitations, []);
});

test('validator detects a missing field', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  delete record.limitations;
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: limitations'));
});

test('validator detects an unexpected extra field', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  record.score = 10;
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: score'));
});

test('validator detects a wrong array type (recommendations)', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  record.recommendations = 'not an array';
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('recommendations must be an array'));
});

test('validator detects an invalid research_type', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  record.research_type = 'not_a_real_type';
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('research_type must be one of:')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  record.confidence = 'certain';
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of:')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyResearchAgentResult('market_research', 'topic');
  record.verification_status = 'confirmed';
  const result = validateResearchAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of:')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
