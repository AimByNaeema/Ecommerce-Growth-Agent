'use strict';

// The shape of one Experiment Lesson - a validated, structured piece of knowledge
// distilled from one decided experiment (agent/core/experimentModel.js /
// agent/core/experimentEngine.js). Schema and a couple of pure helpers only, following
// the exact convention of every existing *Model.js file (field list + createEmpty* +
// validate*Shape + CLI printer) - the distillation logic itself lives in
// agent/core/experimentLearningStore.js.
//
// LESSON_OUTCOMES is a strict binary: 'success' or 'failure'. This is deliberately
// narrower than agent/core/experimentModel.js's 5-value DECISION_OUTCOMES - a lesson
// can only be recorded from a *decided* experiment (decision.outcome is
// 'ship_variant' or 'keep_control'; see agent/core/experimentLearningStore.js's
// recordExperimentLesson(), which throws for 'iterate'/'inconclusive'/
// 'not_yet_decided' rather than forcing an undecided or ambiguous result into a false
// binary). `outcome` here is always mechanically derived from that decision - never
// caller-set - specifically so a failed experiment can never be mislabeled a success.
//
// `confidence` reuses agent/core/researchRecordModel.js's exact CONFIDENCE_LEVELS enum
// (the same reuse agent/core/growthOpportunityEngineModel.js's confidence field
// already establishes) and the same "confidence asserted with zero evidence is forced
// down to 'unassessed'" honesty guard agent/core/growthOpportunityEngine.js's
// normalizeCandidate() already applies - never a partial downgrade, a full one, since
// an unevidenced confidence claim carries no real information.
//
// `result` and `evidence` are direct relays of the source experiment's own
// result/result.evidence (agent/core/experimentModel.js's RESULT_SUB_KEYS reused, not
// duplicated) - this module never recomputes, reinterprets, or invents a result.
// `hypothesis` and `lesson` are always caller-supplied text - this module never
// invents what was learned.
//
// This is the knowledge layer on top of the Experiment Framework: agent/core/
// experimentLearningStore.js's getValidatedLearnings() is the only supported way to
// surface this knowledge to future recommendations, and it filters to outcome ===
// 'success' only - a 'failure' lesson is real, storable knowledge (worth remembering
// so the same losing test isn't repeated) but is never returned by that function,
// so a failed experiment can never be treated as successful knowledge downstream.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');
const { RESULT_SUB_KEYS } = require('./experimentModel');

const LESSON_OUTCOMES = ['success', 'failure'];
const EXPERIMENT_REFERENCE_SUB_KEYS = ['experiment_id', 'domain', 'subject_reference'];

const LESSON_FIELDS = [
  {
    id: 'experiment',
    title: 'Experiment',
    type: 'object',
    description: '{ experiment_id, domain, subject_reference } - which experiment this lesson was distilled from, a reference only (not a full copy of the experiment record).',
  },
  {
    id: 'hypothesis',
    title: 'Hypothesis',
    type: 'string',
    description: "The source experiment's hypothesis, relayed exactly - never re-worded or reinterpreted.",
  },
  {
    id: 'result',
    title: 'Result',
    type: 'object',
    description: "{ control_value, variant_value, observed_effect, statistical_significance, evidence } - the source experiment's own result, relayed exactly (agent/core/experimentModel.js's RESULT_SUB_KEYS reused).",
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: "The source experiment's result.evidence, relayed at the top level for convenient access - never re-gathered or invented.",
  },
  {
    id: 'outcome',
    title: 'Outcome',
    type: `enum: ${LESSON_OUTCOMES.join(' | ')}`,
    description: "'success' if the source decision was 'ship_variant', 'failure' if 'keep_control' - mechanically derived, never caller-set, so a failure can never be mislabeled a success.",
  },
  {
    id: 'lesson',
    title: 'Lesson',
    type: 'string',
    description: 'What was learned, in plain English - caller-supplied, never invented.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: "How much this lesson is trusted - caller-asserted, then forced to 'unassessed' if evidence is empty.",
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Caveats and honesty-guard downgrades applied while recording this lesson.',
  },
  {
    id: 'recorded_date',
    title: 'Recorded date',
    type: 'string',
    description: 'When this lesson was recorded (ISO date).',
  },
];

const ARRAY_FIELD_IDS = LESSON_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = LESSON_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

function emptyExperimentReference(experiment_id, domain, subject_reference) {
  return { experiment_id, domain, subject_reference };
}

function emptyResult() {
  return { control_value: '', variant_value: '', observed_effect: '', statistical_significance: '', evidence: [] };
}

// Returns a blank Experiment Lesson record conforming to LESSON_FIELDS. No real lesson
// - callers (agent/core/experimentLearningStore.js) fill it in from a decided
// experiment.
function createEmptyLesson(experiment_id = '', domain = '', subject_reference = '') {
  return {
    experiment: emptyExperimentReference(experiment_id, domain, subject_reference),
    hypothesis: '',
    result: emptyResult(),
    evidence: [],
    outcome: 'success',
    lesson: '',
    confidence: 'unassessed',
    limitations: [],
    recorded_date: '',
  };
}

function validateSubKeyedObject(value, pathLabel, expectedSubKeys, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  const subIds = Object.keys(value);
  for (const key of expectedSubKeys) {
    if (!subIds.includes(key)) errors.push(`${pathLabel} is missing sub-field: ${key}`);
  }
  for (const key of subIds) {
    if (!expectedSubKeys.includes(key)) errors.push(`${pathLabel} has unexpected sub-field: ${key}`);
  }
}

// Checks that an Experiment Lesson record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateLessonShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = LESSON_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  for (const id of OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if (record.experiment && typeof record.experiment === 'object' && !Array.isArray(record.experiment)) {
    validateSubKeyedObject(record.experiment, 'experiment', EXPERIMENT_REFERENCE_SUB_KEYS, errors);
  }
  if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
    validateSubKeyedObject(record.result, 'result', RESULT_SUB_KEYS, errors);
    if ('evidence' in record.result && !Array.isArray(record.result.evidence)) {
      errors.push('result.evidence must be an array');
    }
  }

  if ('outcome' in record && !LESSON_OUTCOMES.includes(record.outcome)) {
    errors.push(`outcome must be one of: ${LESSON_OUTCOMES.join(', ')}`);
  }
  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  LESSON_OUTCOMES,
  EXPERIMENT_REFERENCE_SUB_KEYS,
  LESSON_FIELDS,
  createEmptyLesson,
  validateLessonShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Experiment Lesson model (schema only):\n');
  LESSON_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyLesson('(no experiment set)', 'pricing', '(no subject set)'), null, 2));
  console.log("\noutcome is always mechanically derived from the source experiment's decision - never caller-set, so a failure can never be mislabeled a success.");
}
