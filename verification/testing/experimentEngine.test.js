'use strict';

const assert = require('node:assert');
const { createExperiment, recordExperimentResult, decideExperiment } = require('../../agent/core/experimentEngine');
const { validateExperimentShape } = require('../../agent/core/experimentModel');

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

function assertValid(record) {
  const validation = validateExperimentShape(record);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

function baseExperimentInput(overrides = {}) {
  return {
    experimentId: 'exp-001',
    domain: 'pricing',
    subjectReference: '(Example store) - Product X',
    hypothesis: 'Placeholder hypothesis.',
    variable: 'list_price',
    control: { description: 'Control description.', evidence: [] },
    variant: { description: 'Variant description.', evidence: [] },
    targetMetric: 'conversion_rate',
    duration: { plannedDurationDays: 14 },
    successCriteria: 'Placeholder success criteria.',
    ...overrides,
  };
}

// --- createExperiment ---

test('createExperiment with no start_date produces a valid draft experiment', () => {
  const experiment = createExperiment(baseExperimentInput());
  assertValid(experiment);
  assert.strictEqual(experiment.status, 'draft');
});

test('createExperiment with a start_date produces a valid running experiment', () => {
  const experiment = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  assertValid(experiment);
  assert.strictEqual(experiment.status, 'running');
});

test('createExperiment works across multiple domains (social, seo)', () => {
  const social = createExperiment(baseExperimentInput({ experimentId: 'exp-social-001', domain: 'social', variable: 'post_creative' }));
  const seo = createExperiment(baseExperimentInput({ experimentId: 'exp-seo-001', domain: 'seo', variable: 'meta_title' }));
  assertValid(social);
  assertValid(seo);
  assert.strictEqual(social.domain, 'social');
  assert.strictEqual(seo.domain, 'seo');
});

test('createExperiment throws for an invalid domain', () => {
  assert.throws(() => createExperiment(baseExperimentInput({ domain: 'not-a-real-domain' })), /domain/);
});

test('createExperiment throws for a missing hypothesis', () => {
  assert.throws(() => createExperiment(baseExperimentInput({ hypothesis: '' })), /hypothesis/);
});

// --- recordExperimentResult ---

test('recordExperimentResult throws if the experiment has not started (no start_date)', () => {
  const experiment = createExperiment(baseExperimentInput());
  assert.throws(
    () => recordExperimentResult(experiment, { controlValue: 'a', variantValue: 'b', observedEffect: 'c' }),
    /start_date/
  );
});

test('recordExperimentResult moves status to completed once the experiment has started', () => {
  const experiment = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  const withResult = recordExperimentResult(experiment, {
    controlValue: '1.9% conversion rate.',
    variantValue: '2.3% conversion rate.',
    observedEffect: 'Conversion rate improved by 0.4 percentage points.',
    statisticalSignificance: '95% confidence.',
    evidence: ['(placeholder report)'],
  });
  assertValid(withResult);
  assert.strictEqual(withResult.status, 'completed');
  assert.strictEqual(withResult.result.control_value, '1.9% conversion rate.');
});

test('recordExperimentResult does not mutate the input experiment', () => {
  const experiment = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  recordExperimentResult(experiment, { controlValue: 'a', variantValue: 'b', observedEffect: 'c' });
  assert.strictEqual(experiment.status, 'running');
  assert.strictEqual(experiment.result.control_value, '');
});

// --- decideExperiment ---

function completedExperiment() {
  const experiment = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  return recordExperimentResult(experiment, {
    controlValue: '1.9% conversion rate.',
    variantValue: '2.3% conversion rate.',
    observedEffect: 'Conversion rate improved by 0.4 percentage points.',
  });
}

test('decideExperiment builds a correct approval_requirement for a valid actionClassification', () => {
  const decided = decideExperiment(completedExperiment(), {
    outcome: 'ship_variant',
    rationale: 'Clears success criteria.',
    actionClassification: 'approval_required',
  });
  assertValid(decided);
  assert.strictEqual(decided.decision.outcome, 'ship_variant');
  assert.strictEqual(decided.decision.approval_requirement.classification, 'approval_required');
  assert.strictEqual(decided.decision.approval_requirement.requires_human_approval, true);
});

test('decideExperiment throws for an invalid actionClassification', () => {
  assert.throws(
    () => decideExperiment(completedExperiment(), { outcome: 'ship_variant', rationale: 'x', actionClassification: 'not-real' }),
    /actionClassification/
  );
});

test('decideExperiment throws for an invalid outcome', () => {
  assert.throws(
    () => decideExperiment(completedExperiment(), { outcome: 'maybe', rationale: 'x', actionClassification: 'recommendation' }),
    /outcome/
  );
});

test('decideExperiment downgrades ship_variant to inconclusive when status is not completed, and records why', () => {
  const running = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  const decided = decideExperiment(running, {
    outcome: 'ship_variant',
    rationale: 'Premature call.',
    actionClassification: 'approval_required',
  });
  assertValid(decided);
  assert.strictEqual(decided.decision.outcome, 'inconclusive');
  assert.ok(decided.limitations.some((l) => l.includes("downgraded to 'inconclusive'")));
});

test('decideExperiment downgrades keep_control to inconclusive when status is draft', () => {
  const draft = createExperiment(baseExperimentInput());
  const decided = decideExperiment(draft, {
    outcome: 'keep_control',
    rationale: 'Premature call.',
    actionClassification: 'recommendation',
  });
  assert.strictEqual(decided.decision.outcome, 'inconclusive');
});

test('decideExperiment does not downgrade iterate on a non-completed experiment', () => {
  const running = createExperiment(baseExperimentInput({ duration: { startDate: '2026-01-01', plannedDurationDays: 14 } }));
  const decided = decideExperiment(running, {
    outcome: 'iterate',
    rationale: 'Early signal suggests a follow-up test with a bigger price gap.',
    actionClassification: 'recommendation',
  });
  assertValid(decided);
  assert.strictEqual(decided.decision.outcome, 'iterate');
  assert.strictEqual(decided.limitations.length, 0);
});

test('decideExperiment does not downgrade ship_variant when status is already completed', () => {
  const decided = decideExperiment(completedExperiment(), {
    outcome: 'ship_variant',
    rationale: 'Clears success criteria.',
    actionClassification: 'approval_required',
  });
  assert.strictEqual(decided.decision.outcome, 'ship_variant');
  assert.strictEqual(decided.limitations.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
