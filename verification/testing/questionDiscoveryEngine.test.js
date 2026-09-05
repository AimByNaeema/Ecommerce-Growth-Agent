'use strict';

// Behavioral tests for agent/core/questionDiscoveryEngine.js - provenance verification,
// normalization, provenance-preserving deduplication, bounded limits, and the adapter
// into the existing Information Gap Finder.
//
// The engine is pure by construction (no network, model, or filesystem call), so nothing
// here needs mocking and nothing here can reach any external API. The one external call
// in this capability lives in tools/marketQuestionDiscoveryTool.js and is mocked in
// verification/testing/marketQuestionDiscoveryTool.test.js.
//
// Every question, URL, and source below is an invented placeholder for testing.

const assert = require('node:assert');
const {
  MAX_RESULT_LIMIT,
  DEFAULT_RESULT_LIMIT,
  resolveLimit,
  buildQuestionEvidence,
  toGapFinderQuestions,
} = require('../../agent/core/questionDiscoveryEngine');
const { UNSUPPORTED_EVIDENCE_KINDS } = require('../../agent/core/questionEvidenceModel');
const { findInformationGaps } = require('../../agent/core/informationGapEngine');

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

const FAQ_URL = 'https://example.com/faq';
const FORUM_URL = 'https://forum.example.com/thread/1';
const QA_URL = 'https://example.com/help/questions';

function only(records) {
  assert.strictEqual(records.length, 1, `expected exactly 1 record, got ${records.length}`);
  return records[0];
}

// --- 1 & 2. Observed questions and preserved provenance --------------------------

test('a question whose source URL the search actually returned becomes observed evidence', () => {
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      collectedAt: '2026-09-05T00:00:00.000Z',
      claims: [
        {
          question: 'How long does an insulated jacket last?',
          evidenceKind: 'competitor_question',
          sourceUrl: FAQ_URL,
          originalObservation: 'listed in the FAQ section',
        },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'observed');
  assert.strictEqual(record.observation_count, 1);

  // Full provenance retained on the observation.
  const observation = record.observations[0];
  assert.strictEqual(observation.evidence_kind, 'competitor_question');
  assert.strictEqual(observation.source_type, 'web_search_result');
  assert.strictEqual(observation.source_url, FAQ_URL);
  assert.strictEqual(observation.collected_at, '2026-09-05T00:00:00.000Z');
  assert.strictEqual(observation.original_observation, 'listed in the FAQ section');
});

// --- 3. The original question is never lost --------------------------------------

test('normalization never overwrites the original observed wording', () => {
  const original = '  How LONG does an insulated jacket last?!  ';
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      claims: [{ question: original, evidenceKind: 'public_qa', sourceUrl: FAQ_URL }],
    }).records
  );
  assert.strictEqual(record.question, original.trim(), 'the original wording must survive');
  assert.notStrictEqual(record.question, record.normalized_question);
  // Reused verbatim from informationGapEngine.normalizeQuestion: case, punctuation and
  // whitespace only. Stop-word removal happens later, inside that module's own
  // clustering - discovery does not second-guess it.
  assert.strictEqual(record.normalized_question, 'how long does an insulated jacket last');
});

// --- 4. Duplicates merge while preserving every meaningful source ----------------

test('the same question from four sources becomes ONE record carrying all four', () => {
  // The explicit requirement: multi-source evidence must be retained, not collapsed to
  // one source and not split into unrelated questions.
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL, FORUM_URL, QA_URL],
    claims: [
      { question: 'How long does X last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL },
      { question: 'how long does X last', evidenceKind: 'public_forum_question', sourceUrl: FORUM_URL },
      { question: 'How long does X last?!', evidenceKind: 'public_qa', sourceUrl: QA_URL },
      // A fourth observation of the same question at an already-seen source - deduped.
      { question: 'How long does X last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL },
    ],
  });
  const record = only(records);
  assert.strictEqual(record.observation_count, 3, 'all three distinct sources must be preserved');
  assert.deepStrictEqual(
    record.observations.map((observation) => observation.source_url).sort(),
    [FAQ_URL, QA_URL, FORUM_URL].sort()
  );
  assert.deepStrictEqual(
    record.observations.map((observation) => observation.evidence_kind).sort(),
    ['competitor_question', 'public_forum_question', 'public_qa']
  );
});

test('merging keeps the strongest evidence strength across the merged observations', () => {
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      claims: [
        // Unverifiable first, so a naive "first wins" would keep model_generated.
        { question: 'How long does X last?', evidenceKind: 'public_qa', sourceUrl: 'https://not-returned.example.com/x' },
        { question: 'how long does X last', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'observed');
  assert.strictEqual(record.observation_count, 1, 'only the verified observation may be retained');
});

// --- 5. Different intents are NOT merged -----------------------------------------

test('genuinely different questions stay separate', () => {
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [
      { question: 'How long does an insulated jacket last?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
      { question: 'How do I wash an insulated jacket?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
      { question: 'Is this jacket waterproof?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
    ],
  });
  assert.strictEqual(records.length, 3);
});

test('merging is exact-normalized-match only - no aggressive semantic collapsing here', () => {
  // These two share most tokens and WOULD cluster under the Gap Finder's downstream
  // fuzzy clustering, but discovery must not pre-merge distinct customer intents before
  // a human or the Gap Finder can see them.
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [
      { question: 'How do I wash a jacket?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
      { question: 'How do I dry a jacket?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
    ],
  });
  assert.strictEqual(records.length, 2, 'different intents must not be merged at discovery time');
});

// --- 6 & 7. Missing/unverifiable provenance can never become verified ------------

test('a URL the search never returned cannot become evidence', () => {
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      claims: [
        {
          question: 'Is this jacket machine washable?',
          evidenceKind: 'public_qa',
          sourceUrl: 'https://not-returned.example.com/invented',
        },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'model_generated');
  assert.strictEqual(record.observation_count, 0);
  // The false citation is discarded, so it can never later be mistaken for a real one.
  assert.ok(!JSON.stringify(record).includes('not-returned.example.com'));
  assert.ok(record.limitations.some((limitation) => limitation.includes('not among the results')));
});

test('a question with no source URL at all is model_generated and says why', () => {
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      claims: [{ question: 'What is the best jacket for Mars?', evidenceKind: 'public_qa' }],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'model_generated');
  assert.ok(record.limitations.some((limitation) => limitation.includes('No source URL was supplied')));
});

test('a claimed but unsupported source kind is downgraded, never taken at its word', () => {
  // A model claiming "this came from People Also Ask" cannot be true here - no SERP
  // client exists - so the claim is recorded as other_observed and flagged.
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL],
      claims: [{ question: 'How warm is it?', evidenceKind: 'people_also_ask', sourceUrl: FAQ_URL }],
    }).records
  );
  assert.strictEqual(record.observations[0].evidence_kind, 'other_observed');
  assert.ok(record.limitations.some((limitation) => limitation.includes('not a source this project can access')));
});

test('existing research yields inferred - a keyword or prior report is not somebody asking', () => {
  const record = only(
    buildQuestionEvidence({
      claims: [
        {
          question: 'Which insulation is warmest?',
          evidenceKind: 'existing_research',
          sourceReference: '(placeholder prior research record)',
        },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'inferred');
  assert.strictEqual(record.observations[0].source_type, 'existing_research_output');
});

test('existing research with no reference cannot be inferred either', () => {
  const record = only(
    buildQuestionEvidence({ claims: [{ question: 'Which insulation is warmest?', evidenceKind: 'existing_research' }] }).records
  );
  assert.strictEqual(record.evidence_strength, 'model_generated');
});

test('unsupported sources are reported explicitly rather than silently omitted', () => {
  const { unsupported_sources: unsupported } = buildQuestionEvidence({ claims: [] });
  assert.deepStrictEqual(
    unsupported.map((entry) => entry.evidence_kind).sort(),
    [...UNSUPPORTED_EVIDENCE_KINDS].sort()
  );
  assert.ok(unsupported.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
});

// --- 8. No fabricated demand -----------------------------------------------------

test('no record carries any demand, volume, or ranking figure', () => {
  const { records, limitations } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [{ question: 'How long does X last?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL }],
  });
  const record = only(records);
  assert.strictEqual(record.demand_measured, false);
  // Checked against FIELD NAMES, not the serialized record: the limitations text
  // legitimately mentions volume and traffic in order to disclaim them, and matching
  // that prose would assert the opposite of what this test is for.
  const fieldNames = [...Object.keys(record), ...record.observations.flatMap((o) => Object.keys(o))];
  for (const forbidden of ['search_volume', 'monthly_searches', 'traffic', 'ctr', 'ranking_position', 'demand_score']) {
    assert.ok(!fieldNames.includes(forbidden), `a record must never carry a ${forbidden} field`);
  }
  // And no numeric demand value is smuggled in under any name: the only numbers on a
  // record are the observation count and nothing else.
  const numericFields = Object.entries(record).filter(([, value]) => typeof value === 'number');
  assert.deepStrictEqual(numericFields.map(([key]) => key), ['observation_count']);
  assert.ok(record.limitations.some((limitation) => limitation.includes('Demand was not measured')));
  assert.ok(limitations.some((limitation) => limitation.includes('No search volume')));
});

test('observation_count is corroboration, never presented as popularity', () => {
  const record = only(
    buildQuestionEvidence({
      verifiedUrls: [FAQ_URL, FORUM_URL],
      claims: [
        { question: 'How long does X last?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
        { question: 'how long does X last', evidenceKind: 'public_forum_question', sourceUrl: FORUM_URL },
      ],
    }).records
  );
  assert.strictEqual(record.observation_count, 2);
  assert.strictEqual(record.demand_measured, false);
});

// --- 9 & 10. Safe failure and enforced limits ------------------------------------

test('no verified URLs at all means nothing can be evidenced - and it does not throw', () => {
  const { records } = buildQuestionEvidence({
    verifiedUrls: [],
    claims: [{ question: 'How long does X last?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL }],
  });
  assert.strictEqual(only(records).evidence_strength, 'model_generated');
});

test('malformed claims are skipped rather than crashing or being invented into records', () => {
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [null, 'a string', {}, { question: '   ' }, { question: 'Real one?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL }],
  });
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].question, 'Real one?');
});

test('a non-array claims input is refused with a clear error', () => {
  assert.throws(() => buildQuestionEvidence({}), /`claims` array/);
  assert.throws(() => buildQuestionEvidence({ claims: 'nope' }), /`claims` array/);
});

test('resolveLimit clamps to a hard ceiling and defaults sensibly', () => {
  assert.strictEqual(resolveLimit(undefined), DEFAULT_RESULT_LIMIT);
  assert.strictEqual(resolveLimit(0), DEFAULT_RESULT_LIMIT);
  assert.strictEqual(resolveLimit(-5), DEFAULT_RESULT_LIMIT);
  assert.strictEqual(resolveLimit('nonsense'), DEFAULT_RESULT_LIMIT);
  assert.strictEqual(resolveLimit(5), 5);
  // A caller cannot ask for an unbounded crawl.
  assert.strictEqual(resolveLimit(10000), MAX_RESULT_LIMIT);
});

test('the result limit is actually enforced, and the omission is disclosed', () => {
  const claims = [];
  for (let i = 0; i < 12; i += 1) {
    claims.push({ question: `Distinct question number ${i}?`, evidenceKind: 'public_qa', sourceUrl: FAQ_URL });
  }
  const { records, limitations } = buildQuestionEvidence({ verifiedUrls: [FAQ_URL], claims, limit: 4 });
  assert.strictEqual(records.length, 4);
  assert.ok(limitations.some((limitation) => limitation.includes('omitted by the requested result limit')));
});

test('observed questions are ordered ahead of unverified ones, deterministically', () => {
  const input = {
    verifiedUrls: [FAQ_URL],
    claims: [
      { question: 'An unverified question?', evidenceKind: 'public_qa' },
      { question: 'A verified question?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
    ],
  };
  const first = buildQuestionEvidence(input).records.map((record) => record.question);
  const second = buildQuestionEvidence(input).records.map((record) => record.question);
  assert.deepStrictEqual(first, ['A verified question?', 'An unverified question?']);
  assert.deepStrictEqual(first, second, 'ordering must be deterministic');
});

// --- 13. The existing Gap Finder accepts the output -------------------------------

test('toGapFinderQuestions emits the Gap Finder\'s own input contract, with every source', () => {
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL, FORUM_URL],
    collectedAt: '2026-09-05T00:00:00.000Z',
    claims: [
      { question: 'How long does X last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL },
      { question: 'how long does X last', evidenceKind: 'public_forum_question', sourceUrl: FORUM_URL },
    ],
  });
  const questions = toGapFinderQuestions(records);
  assert.strictEqual(questions.length, 1);
  assert.strictEqual(questions[0].question, 'How long does X last?');
  assert.strictEqual(questions[0].evidenceSources.length, 2, 'both sources must reach the Gap Finder');
  assert.deepStrictEqual(questions[0].evidenceSources[0], {
    signalKind: 'competitor_question',
    reference: FAQ_URL,
    observedAt: '2026-09-05T00:00:00.000Z',
  });
});

test('the existing Gap Finder consumes discovery output and classifies it as observed', () => {
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [{ question: 'How long does an insulated jacket last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL }],
  });
  const gapResult = findInformationGaps({
    questions: toGapFinderQuestions(records).map((question) => ({
      ...question,
      competitorObservations: [
        { competitor: '(Example Co. A)', covered: false },
        { competitor: '(Example Co. B)', covered: false },
      ],
    })),
  });
  const gapRecord = gapResult.records[0];
  assert.strictEqual(gapRecord.evidence_strength, 'observed');
  assert.strictEqual(gapRecord.status, 'opportunity');
  assert.strictEqual(gapRecord.gap_type, 'missing_question');
});

test('a model-generated question reaches the Gap Finder with NO evidence, and stays review', () => {
  // The end-to-end guarantee: discovery never hands the Gap Finder a question labelled
  // as evidenced that it could not itself verify.
  const { records } = buildQuestionEvidence({
    verifiedUrls: [FAQ_URL],
    claims: [{ question: 'An invented question?', evidenceKind: 'public_qa', sourceUrl: 'https://not-returned.example.com/x' }],
  });
  const questions = toGapFinderQuestions(records);
  assert.deepStrictEqual(questions[0].evidenceSources, []);

  const gapRecord = findInformationGaps({
    questions: questions.map((question) => ({
      ...question,
      competitorObservations: [
        { competitor: '(Example Co. A)', covered: false },
        { competitor: '(Example Co. B)', covered: false },
      ],
    })),
  }).records[0];
  assert.strictEqual(gapRecord.evidence_strength, 'model_generated');
  assert.strictEqual(gapRecord.status, 'review');
});

test('toGapFinderQuestions refuses a non-array rather than guessing', () => {
  assert.throws(() => toGapFinderQuestions(undefined), /`records` array/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
