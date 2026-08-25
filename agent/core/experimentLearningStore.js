'use strict';

// The Experiment Learning Store. Distills one decided experiment
// (agent/core/experimentModel.js / agent/core/experimentEngine.js) into a structured
// Experiment Lesson (agent/core/experimentLessonModel.js), and makes validated lessons
// available to future recommendations.
//
// Standalone deliverable, not wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice every
// other engine in agent/core/ already made. There is no database or file-persistence
// layer here (agent/core/memory/ has no persistence engine implemented yet, and adding
// one is an unscoped technical decision per CLAUDE.md rule 15) - like every other
// engine in this project, this module is a set of pure functions over a caller-held
// array of lesson records. Whoever calls it (a workflow, the orchestrator, or a human)
// is responsible for keeping that array across calls; this module never holds hidden
// state.
//
// WHAT THIS MODULE INVENTS VS. RELAYS: `hypothesis`, `result`, and `evidence` are
// direct relays of the source experiment's own fields. `lesson` and `confidence` are
// always caller-supplied. `outcome` is the one thing this module derives itself, and
// only mechanically, from the source experiment's own decision - never invented,
// never caller-overridable:
//   - decision.outcome === 'ship_variant'  -> lesson outcome 'success'
//   - decision.outcome === 'keep_control'  -> lesson outcome 'failure'
//   - decision.outcome === 'iterate' | 'inconclusive' | 'not_yet_decided' -> not
//     learnable yet; recordExperimentLesson() throws rather than forcing an
//     undecided or ambiguous call into a false success/failure binary.
//
// recordExperimentLesson() also requires experiment.status === 'completed' (a real
// result must actually have been recorded - see agent/core/experimentEngine.js's
// recordExperimentResult()) before any lesson can be recorded at all.
//
// HONESTY GUARD (confidence): a confidence asserted with zero result evidence is
// forced down to 'unassessed' - the exact same full-downgrade rule
// agent/core/growthOpportunityEngine.js's normalizeCandidate() already applies to its
// own confidence field (reusing agent/core/researchRecordModel.js's CONFIDENCE_LEVELS).
// The downgrade is recorded in the lesson's own `limitations`, never applied silently.
//
// MAKING VALIDATED KNOWLEDGE AVAILABLE TO FUTURE RECOMMENDATIONS: getValidatedLearnings()
// is the only supported way to surface this knowledge downstream, and it filters
// strictly to outcome === 'success'. getCautionaryLessons() surfaces 'failure' lessons
// separately - real, storable knowledge (so a losing test is not repeated), but never
// mixed into the validated pool. lessonsAsRecommendationEvidence() converts only
// validated (success) lessons into plain evidence strings shaped for direct use as
// `evidence` array entries in agent/core/growthOpportunityEngine.js candidates or
// agent/core/salesGrowthPlanner.js's bottleneck/recommended_action/experiment_idea
// evidence arrays - a failed experiment's lesson can never reach that function, so it
// can never be treated as successful knowledge by anything built on top of it.

const { LESSON_OUTCOMES, createEmptyLesson, validateLessonShape } = require('./experimentLessonModel');
const { CONFIDENCE_LEVELS } = require('./researchRecordModel');

const DECISION_TO_LESSON_OUTCOME = {
  ship_variant: 'success',
  keep_control: 'failure',
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireEnumMember(value, allowed, fieldName, fnName) {
  if (!allowed.includes(value)) {
    throw new Error(`${fnName} requires \`${fieldName}\` to be one of: ${allowed.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------
// recordExperimentLesson
// ---------------------------------------------------------------------------------

function recordExperimentLesson(experiment, { lesson, confidence } = {}) {
  const fnName = 'recordExperimentLesson';

  if (!experiment || typeof experiment !== 'object') {
    throw new Error(`${fnName} requires an experiment record.`);
  }
  if (experiment.status !== 'completed') {
    throw new Error(
      `${fnName} requires an experiment whose status is 'completed' (a real result must be recorded first) - got '${experiment.status}'.`
    );
  }
  const decisionOutcome = experiment.decision && experiment.decision.outcome;
  const lessonOutcome = DECISION_TO_LESSON_OUTCOME[decisionOutcome];
  if (!lessonOutcome) {
    throw new Error(
      `${fnName} requires a decided experiment (decision.outcome must be 'ship_variant' or 'keep_control') - got '${decisionOutcome}'. ` +
        "'iterate'/'inconclusive'/'not_yet_decided' are not learnable yet."
    );
  }

  requireNonEmptyString(lesson, 'lesson', fnName);

  const assertedConfidence = confidence || 'unassessed';
  requireEnumMember(assertedConfidence, CONFIDENCE_LEVELS, 'confidence', fnName);

  const evidence = experiment.result.evidence || [];
  const limitations = [];
  let finalConfidence = assertedConfidence;
  if (evidence.length === 0 && assertedConfidence !== 'unassessed') {
    finalConfidence = 'unassessed';
    limitations.push(
      `confidence '${assertedConfidence}' was asserted with no result evidence - downgraded to 'unassessed'.`
    );
  }

  const record = createEmptyLesson(experiment.experiment_id, experiment.domain, experiment.subject_reference);
  record.result = { ...experiment.result };
  record.hypothesis = experiment.hypothesis;
  record.evidence = evidence;
  record.outcome = lessonOutcome;
  record.lesson = lesson;
  record.confidence = finalConfidence;
  record.limitations = limitations;
  record.recorded_date = todayIsoDate();

  const validation = validateLessonShape(record);
  if (!validation.valid) {
    throw new Error(`Composed Experiment Lesson failed validation: ${validation.errors.join('; ')}`);
  }
  return record;
}

// ---------------------------------------------------------------------------------
// Retrieval - making validated knowledge available to future recommendations.
// ---------------------------------------------------------------------------------

function requireLessonArray(lessons, fnName) {
  if (!Array.isArray(lessons)) {
    throw new Error(`${fnName} requires \`lessons\` to be an array.`);
  }
}

function filterByOutcomeAndDomain(lessons, outcome, domain) {
  return lessons.filter((entry) => entry.outcome === outcome && (!domain || entry.experiment.domain === domain));
}

// Validated experiment knowledge, safe to feed into future recommendations. Strictly
// outcome === 'success' - a failed experiment's lesson never appears here, so it can
// never be treated as successful knowledge downstream.
function getValidatedLearnings(lessons, { domain } = {}) {
  requireLessonArray(lessons, 'getValidatedLearnings');
  return filterByOutcomeAndDomain(lessons, 'success', domain);
}

// Cautionary knowledge - real lessons from experiments that failed, kept separate so a
// losing test is not silently repeated, but never mixed into the validated pool above.
function getCautionaryLessons(lessons, { domain } = {}) {
  requireLessonArray(lessons, 'getCautionaryLessons');
  return filterByOutcomeAndDomain(lessons, 'failure', domain);
}

// Converts only validated (success) lessons into plain evidence strings shaped for
// direct use as `evidence` array entries elsewhere in this project (e.g.
// agent/core/growthOpportunityEngine.js candidates, agent/core/salesGrowthPlanner.js's
// bottleneck/recommended_action/experiment_idea evidence). Built strictly on top of
// getValidatedLearnings(), so a failure can never reach a caller through this path.
function lessonsAsRecommendationEvidence(lessons, { domain } = {}) {
  return getValidatedLearnings(lessons, { domain }).map(
    (entry) =>
      `[Validated learning, ${entry.confidence} confidence] ${entry.lesson} (experiment ${entry.experiment.experiment_id}, ${entry.experiment.domain})`
  );
}

module.exports = {
  recordExperimentLesson,
  getValidatedLearnings,
  getCautionaryLessons,
  lessonsAsRecommendationEvidence,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Experiment Learning Store (deterministic distillation only):\n');

  const wonExperiment = {
    experiment_id: 'exp-pricing-001',
    domain: 'pricing',
    subject_reference: '(Example store) - Product X',
    hypothesis: 'Lowering the price by 10% increases conversion rate enough to grow net revenue (caller-supplied placeholder).',
    status: 'completed',
    result: {
      control_value: '1.9% conversion rate (caller-supplied placeholder).',
      variant_value: '2.3% conversion rate (caller-supplied placeholder).',
      observed_effect: 'Net revenue improved by 6% (caller-supplied placeholder).',
      statistical_significance: '95% confidence (caller-supplied placeholder).',
      evidence: ['(placeholder experiment results report)'],
    },
    decision: { outcome: 'ship_variant', rationale: '', evidence: [], approval_requirement: {} },
  };

  const lostExperiment = {
    experiment_id: 'exp-listing-002',
    domain: 'listing',
    subject_reference: '(Example store) - Product Y',
    hypothesis: 'A shorter product title increases add-to-cart rate (caller-supplied placeholder).',
    status: 'completed',
    result: {
      control_value: '3.1% add-to-cart rate (caller-supplied placeholder).',
      variant_value: '2.8% add-to-cart rate (caller-supplied placeholder).',
      observed_effect: 'Add-to-cart rate decreased by 0.3 percentage points (caller-supplied placeholder).',
      statistical_significance: '95% confidence (caller-supplied placeholder).',
      evidence: ['(placeholder experiment results report)'],
    },
    decision: { outcome: 'keep_control', rationale: '', evidence: [], approval_requirement: {} },
  };

  const wonLesson = recordExperimentLesson(wonExperiment, {
    lesson: 'A 10% price reduction on this product increases net revenue - worth testing on similar-margin products (caller-supplied placeholder).',
    confidence: 'high',
  });
  const lostLesson = recordExperimentLesson(lostExperiment, {
    lesson: 'Shortening this product title hurt add-to-cart rate - keep full descriptive titles for this category (caller-supplied placeholder).',
    confidence: 'medium',
  });

  const lessons = [wonLesson, lostLesson];

  console.log('All recorded lessons:');
  console.log(JSON.stringify(lessons, null, 2));

  console.log('\nValidated learnings only (safe to feed future recommendations):');
  console.log(JSON.stringify(getValidatedLearnings(lessons), null, 2));

  console.log('\nCautionary lessons only (kept separate, never treated as successful knowledge):');
  console.log(JSON.stringify(getCautionaryLessons(lessons), null, 2));

  console.log('\nValidated learnings as recommendation evidence strings:');
  console.log(JSON.stringify(lessonsAsRecommendationEvidence(lessons), null, 2));

  console.log('\nNo hypothesis, result, or lesson above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log("A failed experiment's lesson is real, storable knowledge, but getValidatedLearnings()/lessonsAsRecommendationEvidence() never return it.");
}
