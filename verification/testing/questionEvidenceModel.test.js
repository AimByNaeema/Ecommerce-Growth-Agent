'use strict';

// Schema tests for agent/core/questionEvidenceModel.js - one discovered market question
// and the evidence that it is really asked. Same conventions as
// verification/testing/informationGapModel.test.js: plain node:assert, no framework, no
// external call of any kind.

const assert = require('node:assert');
const {
  EVIDENCE_KINDS,
  SUPPORTED_EVIDENCE_KINDS,
  UNSUPPORTED_EVIDENCE_KINDS,
  SOURCE_TYPES,
  QUESTION_EVIDENCE_FIELDS,
  createObservation,
  createEmptyQuestionEvidenceRecord,
  validateQuestionEvidenceShape,
} = require('../../agent/core/questionEvidenceModel');
const { EVIDENCE_STRENGTHS } = require('../../agent/core/informationGapModel');

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

function populatedRecord() {
  const record = createEmptyQuestionEvidenceRecord('How long does an insulated jacket last?');
  record.normalized_question = 'how long does insulated jacket last';
  record.evidence_strength = 'observed';
  record.observations = [
    createObservation({
      evidenceKind: 'competitor_question',
      sourceType: 'web_search_result',
      sourceReference: 'https://example.com/faq',
      sourceUrl: 'https://example.com/faq',
      collectedAt: '2026-09-05T00:00:00.000Z',
      originalObservation: 'listed in the FAQ section',
    }),
  ];
  record.observation_count = 1;
  record.source_types = ['web_search_result'];
  record.limitations = ['Demand was not measured.'];
  return record;
}

test('EVIDENCE_KINDS covers the full requested vocabulary', () => {
  assert.deepStrictEqual(EVIDENCE_KINDS, [
    'search_suggestion',
    'people_also_ask',
    'related_search',
    'public_qa',
    'public_forum_question',
    'competitor_question',
    'existing_research',
    'other_observed',
  ]);
});

test('supported and unsupported kinds partition the vocabulary, with nothing left implicit', () => {
  const combined = [...SUPPORTED_EVIDENCE_KINDS, ...UNSUPPORTED_EVIDENCE_KINDS].sort();
  assert.deepStrictEqual(combined, [...EVIDENCE_KINDS].sort());
  // No kind may be claimed as both.
  for (const kind of SUPPORTED_EVIDENCE_KINDS) {
    assert.ok(!UNSUPPORTED_EVIDENCE_KINDS.includes(kind));
  }
});

test('the SERP-feature kinds are explicitly declared unsupported', () => {
  // These are the ones this project genuinely cannot attest to - they must be visibly
  // unsupported rather than quietly absent or, worse, faked.
  for (const kind of ['search_suggestion', 'people_also_ask', 'related_search']) {
    assert.ok(UNSUPPORTED_EVIDENCE_KINDS.includes(kind), `${kind} must be declared unsupported`);
  }
});

test('evidence_strength reuses the Information Gap Finder\'s own scale, not a parallel one', () => {
  const field = QUESTION_EVIDENCE_FIELDS.find((entry) => entry.id === 'evidence_strength');
  for (const strength of EVIDENCE_STRENGTHS) {
    assert.ok(field.type.includes(strength), `${strength} must be part of the declared enum`);
  }
});

test('the schema carries no search-volume or demand-metric field at all', () => {
  const ids = QUESTION_EVIDENCE_FIELDS.map((field) => field.id);
  for (const forbidden of ['search_volume', 'monthly_searches', 'traffic', 'ctr', 'ranking', 'demand_score']) {
    assert.ok(!ids.includes(forbidden), `the schema must not define ${forbidden}`);
  }
  // demand_measured exists precisely so absence is stated, not inferred.
  assert.ok(ids.includes('demand_measured'));
});

test('createEmptyQuestionEvidenceRecord has exactly the declared fields', () => {
  const record = createEmptyQuestionEvidenceRecord('a question');
  assert.deepStrictEqual(Object.keys(record), QUESTION_EVIDENCE_FIELDS.map((field) => field.id));
});

test('an empty record starts model_generated with demand explicitly not measured', () => {
  const record = createEmptyQuestionEvidenceRecord('a question');
  assert.strictEqual(record.evidence_strength, 'model_generated');
  assert.strictEqual(record.demand_measured, false);
  assert.deepStrictEqual(record.observations, []);
  assert.strictEqual(record.observation_count, 0);
  assert.strictEqual(validateQuestionEvidenceShape(record).valid, true);
});

test('createObservation carries the full provenance set', () => {
  const observation = createObservation({
    evidenceKind: 'public_qa',
    sourceType: 'web_search_result',
    sourceReference: 'ref',
    sourceUrl: 'https://example.com/q',
    collectedAt: '2026-09-05T00:00:00.000Z',
    originalObservation: 'seen in the Q&A block',
  });
  assert.deepStrictEqual(Object.keys(observation).sort(), [
    'collected_at',
    'evidence_kind',
    'original_observation',
    'source_reference',
    'source_type',
    'source_url',
  ]);
});

test('a fully populated record validates', () => {
  const validation = validateQuestionEvidenceShape(populatedRecord());
  assert.strictEqual(validation.valid, true, validation.errors.join('; '));
});

test('validateQuestionEvidenceShape rejects a non-object, a missing field and an extra field', () => {
  assert.strictEqual(validateQuestionEvidenceShape(null).valid, false);

  const missing = populatedRecord();
  delete missing.demand_measured;
  assert.ok(validateQuestionEvidenceShape(missing).errors.some((e) => e.includes('missing field: demand_measured')));

  const extra = populatedRecord();
  extra.estimated_monthly_searches = 4000;
  assert.ok(validateQuestionEvidenceShape(extra).errors.some((e) => e.includes('unexpected field: estimated_monthly_searches')));
});

test('validateQuestionEvidenceShape rejects an out-of-enum evidence strength', () => {
  const record = populatedRecord();
  record.evidence_strength = 'verified';
  assert.strictEqual(validateQuestionEvidenceShape(record).valid, false);
});

test('observation_count must match the observations actually held', () => {
  const record = populatedRecord();
  record.observation_count = 7;
  const validation = validateQuestionEvidenceShape(record);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('observation_count must equal')));
});

test('each observation is validated for shape and enum membership', () => {
  const badKind = populatedRecord();
  badKind.observations[0].evidence_kind = 'psychic_intuition';
  assert.ok(validateQuestionEvidenceShape(badKind).errors.some((e) => e.includes('evidence_kind must be one of')));

  const badSourceType = populatedRecord();
  badSourceType.observations[0].source_type = 'scraped_page';
  assert.ok(validateQuestionEvidenceShape(badSourceType).errors.some((e) => e.includes('source_type must be one of')));

  const missingField = populatedRecord();
  delete missingField.observations[0].source_url;
  assert.ok(validateQuestionEvidenceShape(missingField).errors.some((e) => e.includes('observations[0] missing field: source_url')));
});

test('SOURCE_TYPES names only acquisition paths this project actually has', () => {
  assert.deepStrictEqual(SOURCE_TYPES, ['web_search_result', 'existing_research_output']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
