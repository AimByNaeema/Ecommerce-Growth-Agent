'use strict';

const assert = require('node:assert');
const {
  EXPERIMENT_DOMAINS,
  createEmptyExperiment,
  validateExperimentShape,
} = require('../../agent/core/experimentModel');

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

// --- createEmptyExperiment ---

test('createEmptyExperiment() conforms to its own validator for every domain', () => {
  for (const domain of EXPERIMENT_DOMAINS) {
    const validation = validateExperimentShape(createEmptyExperiment('(no subject set)', domain));
    assert.strictEqual(validation.valid, true, `expected valid for domain ${domain}, got errors: ${validation.errors.join(', ')}`);
  }
});

test('createEmptyExperiment() defaults to status draft and decision outcome not_yet_decided', () => {
  const record = createEmptyExperiment('', 'seo');
  assert.strictEqual(record.status, 'draft');
  assert.strictEqual(record.decision.outcome, 'not_yet_decided');
});

// --- validateExperimentShape: top-level field checks ---

test('a record missing a required top-level field is invalid', () => {
  const record = createEmptyExperiment('', 'marketing');
  delete record.hypothesis;
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('missing field: hypothesis'));
});

test('a record with an unexpected top-level field is invalid', () => {
  const record = createEmptyExperiment('', 'social');
  record.unexpected_field = 'nope';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('unexpected field: unexpected_field'));
});

test('a record whose domain is not one of the 8 EXPERIMENT_DOMAINS is invalid', () => {
  const record = createEmptyExperiment('', 'products');
  record.domain = 'not-a-real-domain';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('domain must be one of:')));
});

test('a record whose status is not one of draft/running/completed is invalid', () => {
  const record = createEmptyExperiment('', 'offers');
  record.status = 'archived';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('status must be one of:')));
});

// --- validateExperimentShape: nested sub-key checks ---

test('control missing a required sub-field is invalid', () => {
  const record = createEmptyExperiment('', 'listing');
  delete record.control.description;
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('control is missing sub-field: description'));
});

test('variant with an unexpected sub-field is invalid', () => {
  const record = createEmptyExperiment('', 'advertising');
  record.variant.extra = true;
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('variant has unexpected sub-field: extra'));
});

test('duration missing a required sub-field is invalid', () => {
  const record = createEmptyExperiment('', 'pricing');
  delete record.duration.planned_duration_days;
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('duration is missing sub-field: planned_duration_days'));
});

test('result missing a required sub-field is invalid', () => {
  const record = createEmptyExperiment('', 'seo');
  delete record.result.observed_effect;
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('result is missing sub-field: observed_effect'));
});

test('decision.outcome not in DECISION_OUTCOMES is invalid', () => {
  const record = createEmptyExperiment('', 'marketing');
  record.decision.outcome = 'maybe';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('decision.outcome must be one of:')));
});

test('decision.approval_requirement.classification not a real classification id is invalid', () => {
  const record = createEmptyExperiment('', 'products');
  record.decision.approval_requirement.classification = 'not-a-real-classification';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('decision.approval_requirement.classification must be one of:')));
});

test('decision.approval_requirement.requires_human_approval must be a boolean', () => {
  const record = createEmptyExperiment('', 'social');
  record.decision.approval_requirement.requires_human_approval = 'yes';
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.includes('decision.approval_requirement.requires_human_approval must be a boolean'));
});

test('a fully valid, hand-built record across every domain passes validation', () => {
  for (const domain of EXPERIMENT_DOMAINS) {
    const record = {
      experiment_id: `exp-${domain}-001`,
      domain,
      subject_reference: '(Example store)',
      hypothesis: 'Placeholder hypothesis.',
      variable: 'placeholder_variable',
      control: { description: 'Control description.', evidence: [] },
      variant: { description: 'Variant description.', evidence: [] },
      target_metric: 'conversion_rate',
      duration: { start_date: '', end_date: '', planned_duration_days: 14 },
      success_criteria: 'Placeholder success criteria.',
      status: 'draft',
      result: { control_value: '', variant_value: '', observed_effect: '', statistical_significance: '', evidence: [] },
      decision: { outcome: 'not_yet_decided', rationale: '', evidence: [], approval_requirement: { classification: '', title: '', description: '', requires_human_approval: false } },
      limitations: [],
      created_date: '2026-01-01',
    };
    const validation = validateExperimentShape(record);
    assert.strictEqual(validation.valid, true, `expected valid for domain ${domain}, got errors: ${validation.errors.join(', ')}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
