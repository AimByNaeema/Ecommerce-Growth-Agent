'use strict';

const assert = require('node:assert');
const { createExperiment, recordExperimentResult, decideExperiment } = require('../../agent/core/experimentEngine');
const {
  recordExperimentLesson,
  getValidatedLearnings,
  getCautionaryLessons,
  lessonsAsRecommendationEvidence,
} = require('../../agent/core/experimentLearningStore');
const { validateLessonShape } = require('../../agent/core/experimentLessonModel');

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

function assertValidLesson(record) {
  const validation = validateLessonShape(record);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// Builds a real, completed, decided experiment end-to-end through
// agent/core/experimentEngine.js, so these tests exercise the full pipeline rather
// than hand-constructing a fake experiment shape.
function decidedExperiment({ domain = 'pricing', outcome = 'ship_variant', evidence = ['(placeholder report)'] } = {}) {
  let experiment = createExperiment({
    experimentId: `exp-${domain}-test`,
    domain,
    subjectReference: '(Example store)',
    hypothesis: 'Placeholder hypothesis.',
    variable: 'placeholder_variable',
    control: { description: 'Control description.', evidence: [] },
    variant: { description: 'Variant description.', evidence: [] },
    targetMetric: 'conversion_rate',
    duration: { startDate: '2026-01-01', plannedDurationDays: 14 },
    successCriteria: 'Placeholder success criteria.',
  });
  experiment = recordExperimentResult(experiment, {
    controlValue: 'control value',
    variantValue: 'variant value',
    observedEffect: 'observed effect',
    evidence,
  });
  experiment = decideExperiment(experiment, {
    outcome,
    rationale: 'Placeholder rationale.',
    actionClassification: 'approval_required',
  });
  return experiment;
}

// --- recordExperimentLesson: honesty guards ---

test('recordExperimentLesson throws if experiment.status is not completed', () => {
  const draft = createExperiment({
    experimentId: 'exp-draft',
    domain: 'seo',
    hypothesis: 'h',
    variable: 'v',
    control: { description: 'c' },
    variant: { description: 'v' },
    targetMetric: 'm',
    duration: {},
    successCriteria: 's',
  });
  assert.throws(() => recordExperimentLesson(draft, { lesson: 'x', confidence: 'medium' }), /status is 'completed'/);
});

test('recordExperimentLesson throws for a not-yet-decided experiment result', () => {
  let experiment = createExperiment({
    experimentId: 'exp-running',
    domain: 'seo',
    hypothesis: 'h',
    variable: 'v',
    control: { description: 'c' },
    variant: { description: 'v' },
    targetMetric: 'm',
    duration: { startDate: '2026-01-01' },
    successCriteria: 's',
  });
  experiment = recordExperimentResult(experiment, { controlValue: 'a', variantValue: 'b', observedEffect: 'c' });
  assert.throws(() => recordExperimentLesson(experiment, { lesson: 'x', confidence: 'medium' }), /decided experiment/);
});

test('recordExperimentLesson throws for an iterate decision (not a clean success/failure)', () => {
  const experiment = decidedExperiment({ domain: 'seo', outcome: 'iterate' });
  assert.throws(() => recordExperimentLesson(experiment, { lesson: 'x', confidence: 'medium' }), /decided experiment/);
});

test('recordExperimentLesson throws for an inconclusive decision', () => {
  const experiment = decidedExperiment({ domain: 'seo', outcome: 'inconclusive' });
  assert.throws(() => recordExperimentLesson(experiment, { lesson: 'x', confidence: 'medium' }), /decided experiment/);
});

test('recordExperimentLesson throws for a missing lesson string', () => {
  const experiment = decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' });
  assert.throws(() => recordExperimentLesson(experiment, { lesson: '', confidence: 'medium' }), /lesson/);
});

// --- recordExperimentLesson: honest outcome derivation ---

test('a ship_variant decision produces outcome success', () => {
  const experiment = decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' });
  const lesson = recordExperimentLesson(experiment, { lesson: 'Price cut worked.', confidence: 'high' });
  assertValidLesson(lesson);
  assert.strictEqual(lesson.outcome, 'success');
});

test('a keep_control decision produces outcome failure, never success', () => {
  const experiment = decidedExperiment({ domain: 'listing', outcome: 'keep_control' });
  const lesson = recordExperimentLesson(experiment, { lesson: 'Shorter title hurt add-to-cart rate.', confidence: 'medium' });
  assertValidLesson(lesson);
  assert.strictEqual(lesson.outcome, 'failure');
});

test('lesson.result and lesson.evidence are relayed exactly from the source experiment', () => {
  const experiment = decidedExperiment({ domain: 'pricing', outcome: 'ship_variant', evidence: ['report A', 'report B'] });
  const lesson = recordExperimentLesson(experiment, { lesson: 'x', confidence: 'medium' });
  assert.deepStrictEqual(lesson.result, experiment.result);
  assert.deepStrictEqual(lesson.evidence, ['report A', 'report B']);
});

// --- recordExperimentLesson: confidence honesty guard ---

test('confidence asserted with no result evidence is forced down to unassessed', () => {
  const experiment = decidedExperiment({ domain: 'marketing', outcome: 'ship_variant', evidence: [] });
  const lesson = recordExperimentLesson(experiment, { lesson: 'x', confidence: 'high' });
  assert.strictEqual(lesson.confidence, 'unassessed');
  assert.ok(lesson.limitations.some((l) => l.includes("downgraded to 'unassessed'")));
});

test('confidence is kept as asserted when result evidence is present', () => {
  const experiment = decidedExperiment({ domain: 'marketing', outcome: 'ship_variant', evidence: ['report'] });
  const lesson = recordExperimentLesson(experiment, { lesson: 'x', confidence: 'high' });
  assert.strictEqual(lesson.confidence, 'high');
  assert.strictEqual(lesson.limitations.length, 0);
});

// --- getValidatedLearnings / getCautionaryLessons: the core "no failure as success" rule ---

test('getValidatedLearnings returns only success lessons, never a failure', () => {
  const won = recordExperimentLesson(decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' }), {
    lesson: 'Won.',
    confidence: 'high',
  });
  const lost = recordExperimentLesson(decidedExperiment({ domain: 'listing', outcome: 'keep_control' }), {
    lesson: 'Lost.',
    confidence: 'medium',
  });
  const validated = getValidatedLearnings([won, lost]);
  assert.strictEqual(validated.length, 1);
  assert.strictEqual(validated[0].outcome, 'success');
  assert.ok(!validated.some((l) => l.outcome === 'failure'));
});

test('getCautionaryLessons returns only failure lessons, kept separate from validated', () => {
  const won = recordExperimentLesson(decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' }), {
    lesson: 'Won.',
    confidence: 'high',
  });
  const lost = recordExperimentLesson(decidedExperiment({ domain: 'listing', outcome: 'keep_control' }), {
    lesson: 'Lost.',
    confidence: 'medium',
  });
  const cautions = getCautionaryLessons([won, lost]);
  assert.strictEqual(cautions.length, 1);
  assert.strictEqual(cautions[0].outcome, 'failure');
});

test('getValidatedLearnings and getCautionaryLessons can filter by domain', () => {
  const pricingWin = recordExperimentLesson(decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' }), {
    lesson: 'Pricing win.',
    confidence: 'high',
  });
  const seoWin = recordExperimentLesson(decidedExperiment({ domain: 'seo', outcome: 'ship_variant' }), {
    lesson: 'SEO win.',
    confidence: 'high',
  });
  const pricingOnly = getValidatedLearnings([pricingWin, seoWin], { domain: 'pricing' });
  assert.strictEqual(pricingOnly.length, 1);
  assert.strictEqual(pricingOnly[0].experiment.domain, 'pricing');
});

test('getValidatedLearnings throws for a non-array input', () => {
  assert.throws(() => getValidatedLearnings('not-an-array'), /to be an array/);
});

// --- lessonsAsRecommendationEvidence: the "available to future recommendations" surface ---

test('lessonsAsRecommendationEvidence never includes a failed experiment lesson', () => {
  const won = recordExperimentLesson(decidedExperiment({ domain: 'pricing', outcome: 'ship_variant' }), {
    lesson: 'This worked.',
    confidence: 'high',
  });
  const lost = recordExperimentLesson(decidedExperiment({ domain: 'listing', outcome: 'keep_control' }), {
    lesson: 'This failed and should never look like a recommendation.',
    confidence: 'medium',
  });
  const evidenceStrings = lessonsAsRecommendationEvidence([won, lost]);
  assert.strictEqual(evidenceStrings.length, 1);
  assert.ok(evidenceStrings[0].includes('This worked.'));
  assert.ok(!evidenceStrings.some((s) => s.includes('This failed')));
});

test('lessonsAsRecommendationEvidence formats confidence and experiment reference into the string', () => {
  const won = recordExperimentLesson(decidedExperiment({ domain: 'social', outcome: 'ship_variant' }), {
    lesson: 'Video posts outperform static images.',
    confidence: 'high',
  });
  const evidenceStrings = lessonsAsRecommendationEvidence([won]);
  assert.strictEqual(evidenceStrings.length, 1);
  assert.ok(evidenceStrings[0].startsWith('[Validated learning, high confidence]'));
  assert.ok(evidenceStrings[0].includes('exp-social-test'));
  assert.ok(evidenceStrings[0].includes('social'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
