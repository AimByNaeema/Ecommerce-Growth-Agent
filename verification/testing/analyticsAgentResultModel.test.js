'use strict';

const assert = require('node:assert');
const {
  ANALYTICS_CAPABILITIES,
  ANALYTICS_AGENT_RESULT_FIELDS,
  createEmptyAnalyticsAgentResult,
  validateAnalyticsAgentResultShape,
} = require('../../agent/core/analyticsAgentResultModel');

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

// The original 10 requested capabilities, plus conversion_optimization - added when
// agent/core/conversionOptimizationChecker.js (already built and tested, but reachable
// by nothing) was exposed through the existing analytics tool, exactly as 'insights'
// exposes agent/core/insightEngine.js. The first 10 and their order are unchanged.
test('ANALYTICS_CAPABILITIES lists exactly the 11 capabilities, in the requested order', () => {
  assert.deepStrictEqual(ANALYTICS_CAPABILITIES, [
    'sales',
    'products',
    'customers',
    'conversion',
    'traffic',
    'marketing',
    'advertising',
    'inventory',
    'growth_opportunities',
    'insights',
    'conversion_optimization',
  ]);
});

test('conversion_optimization is distinct from the conversion snapshot capability', () => {
  assert.ok(ANALYTICS_CAPABILITIES.includes('conversion'), 'the metrics snapshot capability must still exist');
  assert.ok(ANALYTICS_CAPABILITIES.includes('conversion_optimization'), 'the CRO audit capability must exist');
  assert.notStrictEqual('conversion', 'conversion_optimization');
});

test('every field has a non-empty title and description', () => {
  for (const field of ANALYTICS_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyAnalyticsAgentResult() produces a record that passes validation', () => {
  const record = createEmptyAnalyticsAgentResult('sales', '(no topic set)');
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyAnalyticsAgentResult() defaults confidence to unassessed and verification_status to unverified', () => {
  const record = createEmptyAnalyticsAgentResult();
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyAnalyticsAgentResult();
  delete record.specialized_records;
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: specialized_records'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyAnalyticsAgentResult();
  record.bounce_rate = '40%';
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: bounce_rate'));
});

test('validator detects an invalid capability value', () => {
  const record = createEmptyAnalyticsAgentResult();
  record.capability = 'not_a_real_capability';
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('capability must be one of')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyAnalyticsAgentResult();
  record.confidence = 'extremely high';
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyAnalyticsAgentResult();
  record.verification_status = 'confirmed';
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptyAnalyticsAgentResult();
  record.findings = 'not an array';
  const result = validateAnalyticsAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
