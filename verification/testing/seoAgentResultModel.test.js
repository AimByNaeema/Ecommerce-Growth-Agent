'use strict';

const assert = require('node:assert');
const {
  SEO_CAPABILITIES,
  SEO_AGENT_RESULT_FIELDS,
  createEmptySeoAgentResult,
  validateSeoAgentResultShape,
} = require('../../agent/core/seoAgentResultModel');

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

test('SEO_CAPABILITIES lists exactly the 9 supported capabilities', () => {
  assert.deepStrictEqual(SEO_CAPABILITIES, [
    'keyword_research',
    'search_intent_analysis',
    'product_seo',
    'collection_seo',
    'content_seo',
    'on_page_seo',
    'seo_opportunity_analysis',
    'information_gap_analysis',
    'market_question_discovery',
  ]);
});

test('createEmptySeoAgentResult has exactly the fields in SEO_AGENT_RESULT_FIELDS', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  const expectedIds = SEO_AGENT_RESULT_FIELDS.map((field) => field.id);
  assert.deepStrictEqual(Object.keys(result), expectedIds);
});

test('createEmptySeoAgentResult starts unassessed/unverified with empty arrays', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  assert.strictEqual(result.confidence, 'unassessed');
  assert.strictEqual(result.verification_status, 'unverified');
  assert.deepStrictEqual(result.findings, []);
  assert.deepStrictEqual(result.specialized_records, []);
});

test('createEmptySeoAgentResult is valid by construction for every capability', () => {
  for (const capability of SEO_CAPABILITIES) {
    const result = createEmptySeoAgentResult(capability, 'topic');
    assert.strictEqual(validateSeoAgentResultShape(result).valid, true, `capability ${capability} should be valid`);
  }
});

test('validateSeoAgentResultShape rejects a missing field', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  delete result.limitations;
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('missing field: limitations')));
});

test('validateSeoAgentResultShape rejects an unexpected field', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  result.unexpected = 'oops';
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('unexpected field: unexpected')));
});

test('validateSeoAgentResultShape rejects a non-array value for an array field', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  result.findings = 'not an array';
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('findings must be an array')));
});

test('validateSeoAgentResultShape rejects an invalid capability', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  result.capability = 'not_a_real_capability';
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('capability must be one of')));
});

test('validateSeoAgentResultShape rejects an invalid confidence/verification_status', () => {
  const result = createEmptySeoAgentResult('keyword_research', 'topic');
  result.confidence = 'not_a_real_level';
  result.verification_status = 'not_a_real_status';
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('confidence must be one of')));
  assert.ok(validation.errors.some((e) => e.includes('verification_status must be one of')));
});

test('validateSeoAgentResultShape rejects a non-object record', () => {
  assert.strictEqual(validateSeoAgentResultShape(null).valid, false);
  assert.strictEqual(validateSeoAgentResultShape([]).valid, false);
  assert.strictEqual(validateSeoAgentResultShape('x').valid, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
