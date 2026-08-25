'use strict';

const assert = require('node:assert');
const {
  SALES_GROWTH_PLAN_DOMAINS,
  DOMAIN_STATUSES,
  SALES_GROWTH_PLAN_FIELDS,
  createEmptySalesGrowthPlan,
  validateSalesGrowthPlanShape,
} = require('../../agent/core/salesGrowthPlanModel');

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

test('SALES_GROWTH_PLAN_DOMAINS lists exactly the 7 requested domains, in the requested order', () => {
  assert.deepStrictEqual(SALES_GROWTH_PLAN_DOMAINS, [
    'product',
    'customer',
    'analytics',
    'seo',
    'marketing',
    'social',
    'advertising',
  ]);
});

test('DOMAIN_STATUSES is exactly empty/partial/success', () => {
  assert.deepStrictEqual(DOMAIN_STATUSES, ['empty', 'partial', 'success']);
});

test('every field has a non-empty title and description', () => {
  for (const field of SALES_GROWTH_PLAN_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptySalesGrowthPlan() produces a record that passes validation', () => {
  const record = createEmptySalesGrowthPlan('(no subject set)');
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`);
});

test('createEmptySalesGrowthPlan() defaults every domain to empty and 0% coverage', () => {
  const record = createEmptySalesGrowthPlan('x');
  for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
    assert.strictEqual(record.domain_status[domain], 'empty');
    assert.strictEqual(record.current_state[domain].summary, '');
  }
  assert.strictEqual(record.domain_coverage.percentage, 0);
  assert.strictEqual(record.domain_coverage.status, 'empty');
  assert.strictEqual(record.domain_coverage.domains_empty, SALES_GROWTH_PLAN_DOMAINS.length);
});

test('validator detects a missing top-level field', () => {
  const record = createEmptySalesGrowthPlan();
  delete record.domain_coverage;
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: domain_coverage'));
});

test('validator detects an unexpected extra top-level field', () => {
  const record = createEmptySalesGrowthPlan();
  record.projected_revenue_increase = '+20%';
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: projected_revenue_increase'));
});

test('validator detects a missing domain in domain_status', () => {
  const record = createEmptySalesGrowthPlan();
  delete record.domain_status.seo;
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('domain_status is missing domain: seo'));
});

test('validator detects an invalid domain_status value', () => {
  const record = createEmptySalesGrowthPlan();
  record.domain_status.seo = 'excellent';
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('domain_status.seo must be one of')));
});

test('validator detects a missing domain in current_state', () => {
  const record = createEmptySalesGrowthPlan();
  delete record.current_state.marketing;
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('current_state is missing domain: marketing'));
});

test('validator detects a malformed current_state sub-shape', () => {
  const record = createEmptySalesGrowthPlan();
  delete record.current_state.seo.summary;
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('current_state.seo is missing sub-field: summary'));
});

test('validator detects an invalid current_state verification_status', () => {
  const record = createEmptySalesGrowthPlan();
  record.current_state.seo.verification_status = 'confirmed';
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('current_state.seo.verification_status must be one of')));
});

test('validator detects a malformed bottlenecks entry (missing sub-field)', () => {
  const record = createEmptySalesGrowthPlan();
  record.bottlenecks = [{ domain: 'seo', description: 'x', evidence: [] }];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('bottlenecks[0] is missing sub-field: severity'));
});

test('validator detects an invalid bottlenecks.severity value', () => {
  const record = createEmptySalesGrowthPlan();
  record.bottlenecks = [{ domain: 'seo', description: 'x', evidence: [], severity: 'urgent' }];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('bottlenecks[0].severity must be one of')));
});

test('validator detects an invalid bottlenecks.domain value', () => {
  const record = createEmptySalesGrowthPlan();
  record.bottlenecks = [{ domain: 'not_real', description: 'x', evidence: [], severity: 'low' }];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('bottlenecks[0].domain must be one of')));
});

test('validator detects a malformed recommended_actions approval_requirement', () => {
  const record = createEmptySalesGrowthPlan();
  record.recommended_actions = [
    { domain: 'seo', action: 'x', rationale: 'x', evidence: [], approval_requirement: { classification: 'recommendation' } },
  ];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.includes('recommended_actions[0].approval_requirement is missing sub-field: title')
  );
});

test('validator detects a malformed kpis entry (missing sub-field)', () => {
  const record = createEmptySalesGrowthPlan();
  record.kpis = [{ domain: 'analytics', metric: 'x' }];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('kpis[0] is missing sub-field: current_value'));
});

test('validator detects a malformed experiment_ideas entry (missing sub-field)', () => {
  const record = createEmptySalesGrowthPlan();
  record.experiment_ideas = [{ domain: 'analytics', hypothesis: 'x' }];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('experiment_ideas[0] is missing sub-field: test_description'));
});

test('validator detects an invalid approval_requirements.source value', () => {
  const record = createEmptySalesGrowthPlan();
  record.approval_requirements = [
    { source: 'not_real', reference: 'x', classification: 'recommendation', title: 'x', description: 'x', requires_human_approval: false },
  ];
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('approval_requirements[0].source must be one of')));
});

test('validator detects a missing sub-field in domain_coverage', () => {
  const record = createEmptySalesGrowthPlan();
  delete record.domain_coverage.percentage;
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('domain_coverage is missing sub-field: percentage'));
});

test('validator detects an invalid domain_coverage.status value', () => {
  const record = createEmptySalesGrowthPlan();
  record.domain_coverage.status = 'excellent';
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('domain_coverage.status must be one of')));
});

test('validator detects a wrong array type (bottlenecks)', () => {
  const record = createEmptySalesGrowthPlan();
  record.bottlenecks = 'not an array';
  const result = validateSalesGrowthPlanShape(record);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('bottlenecks must be an array'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
