'use strict';

const assert = require('node:assert');
const {
  MARKETING_CAPABILITIES,
  MARKETING_AGENT_RESULT_FIELDS,
  createEmptyMarketingAgentResult,
  validateMarketingAgentResultShape,
} = require('../../agent/core/marketingAgentResultModel');

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

test('MARKETING_CAPABILITIES lists exactly the 8 requested capabilities, in the requested order', () => {
  assert.deepStrictEqual(MARKETING_CAPABILITIES, [
    'marketing_strategy',
    'audience_segmentation',
    'offers',
    'promotions',
    'retention',
    'campaign_planning',
    'email_strategy',
    'conversion_opportunities',
  ]);
});

test('every field has a non-empty title and description', () => {
  for (const field of MARKETING_AGENT_RESULT_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyMarketingAgentResult() produces a record that passes validation', () => {
  const record = createEmptyMarketingAgentResult('marketing_strategy', '(no topic set)');
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptyMarketingAgentResult() defaults confidence to unassessed and verification_status to unverified', () => {
  const record = createEmptyMarketingAgentResult();
  assert.strictEqual(record.confidence, 'unassessed');
  assert.strictEqual(record.verification_status, 'unverified');
});

test('validator detects a missing top-level field', () => {
  const record = createEmptyMarketingAgentResult();
  delete record.specialized_records;
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: specialized_records'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptyMarketingAgentResult();
  record.conversion_rate = '5%';
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: conversion_rate'));
});

test('validator detects an invalid capability value', () => {
  const record = createEmptyMarketingAgentResult();
  record.capability = 'not_a_real_capability';
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('capability must be one of')));
});

test('validator detects an invalid confidence value', () => {
  const record = createEmptyMarketingAgentResult();
  record.confidence = 'extremely high';
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('confidence must be one of')));
});

test('validator detects an invalid verification_status value', () => {
  const record = createEmptyMarketingAgentResult();
  record.verification_status = 'confirmed';
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('verification_status must be one of')));
});

test('validator detects a wrong array type (findings)', () => {
  const record = createEmptyMarketingAgentResult();
  record.findings = 'not an array';
  const result = validateMarketingAgentResultShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('findings must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
