'use strict';

// Behavioral tests for agent/core/informationGapEngine.js - the Information Gap Finder's
// real logic: evidence classification, normalization/clustering, competitor coverage,
// gap detection, deterministic scoring, and the review/no_gap/opportunity status rules.
//
// The engine makes no network, model, or filesystem call by construction (it is pure
// functions over caller-supplied structured input), so nothing here needs mocking and
// nothing here can reach Gemini, Claude, Shopify, or any advertising API.
//
// Every question, competitor, and reference below is an invented placeholder for
// testing - none of it is real market data.

const assert = require('node:assert');
const {
  MIN_COMPETITORS_FOR_GAP_CLAIM,
  normalizeQuestion,
  classifyEvidenceStrength,
  findInformationGaps,
} = require('../../agent/core/informationGapEngine');
const { validateInformationGapShape } = require('../../agent/core/informationGapModel');

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

// Two competitors, neither answering - the minimum real evidence the engine requires
// before it will claim a coverage gap at all.
function twoCompetitorsNeitherAnswering() {
  return [
    { competitor: '(Example Co. A)', covered: false },
    { competitor: '(Example Co. B)', covered: false },
  ];
}

function observedQuestion(overrides = {}) {
  return {
    question: 'How do I wash an insulated jacket without ruining the loft?',
    questionType: 'troubleshooting',
    evidenceSources: [{ signalKind: 'product_review_question', reference: '(placeholder review reference)' }],
    competitorObservations: twoCompetitorsNeitherAnswering(),
    ...overrides,
  };
}

function only(records) {
  assert.strictEqual(records.length, 1, `expected exactly 1 record, got ${records.length}`);
  return records[0];
}

// --- 1. Real, evidence-supported questions are accepted --------------------------

test('a directly-observed question with a reference is accepted as observed evidence', () => {
  const record = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  assert.strictEqual(record.evidence_strength, 'observed');
  assert.strictEqual(record.status, 'opportunity');
  assert.strictEqual(record.evidence_sources.length, 1);
  assert.strictEqual(record.evidence_sources[0].signal_kind, 'product_review_question');
  assert.strictEqual(validateInformationGapShape(record).valid, true);
});

test('every accepted observed signal kind is a real question observation, not a keyword', () => {
  for (const signalKind of ['competitor_faq', 'people_also_ask', 'community_forum', 'first_party_site_search']) {
    assert.strictEqual(classifyEvidenceStrength([{ signal_kind: signalKind, reference: 'r' }]), 'observed');
  }
  // A keyword is not somebody asking a question - it can support one, never prove one.
  assert.strictEqual(classifyEvidenceStrength([{ signal_kind: 'keyword_research', reference: 'r' }]), 'inferred');
});

test('an observed-kind signal with NO reference degrades to model_generated, not observed', () => {
  // An unreferenced assertion that something was observed is not evidence. Taking it at
  // face value is exactly how an invented question would launder itself into "verified".
  assert.strictEqual(classifyEvidenceStrength([{ signal_kind: 'people_also_ask', reference: '' }]), 'model_generated');
});

// --- 2. Duplicate questions are normalized and clustered -------------------------

test('normalizeQuestion is deterministic, case/punctuation-insensitive', () => {
  assert.strictEqual(normalizeQuestion('How do I WASH a jacket?!'), 'how do i wash a jacket');
  assert.strictEqual(normalizeQuestion("  How's   the fit? "), 'hows the fit');
});

test('duplicate and near-duplicate phrasings collapse into one record, keeping the variants', () => {
  const { records } = findInformationGaps({
    questions: [
      observedQuestion(),
      { question: 'how to wash the insulated jacket without ruining loft' },
      { question: 'How do I wash an insulated jacket without ruining the loft?' },
    ],
  });
  const record = only(records);
  assert.strictEqual(record.clustered_variants.length, 2, 'both duplicate phrasings should have been merged');
  // Merged, not discarded - a human can see exactly what was collapsed.
  assert.ok(record.clustered_variants.every((variant) => typeof variant === 'string' && variant.length > 0));
});

test('a cluster is represented by its strongest-evidence member, and pools all evidence', () => {
  const { records } = findInformationGaps({
    questions: [
      // Weakest phrasing first, so a naive "first wins" would pick the wrong one.
      { question: 'how to wash an insulated jacket without ruining the loft' },
      observedQuestion(),
    ],
  });
  const record = only(records);
  assert.strictEqual(record.evidence_strength, 'observed');
  assert.strictEqual(record.question, observedQuestion().question);
});

test('genuinely different questions are NOT clustered together', () => {
  const { records } = findInformationGaps({
    questions: [observedQuestion(), { question: 'What is the return policy for damaged orders?' }],
  });
  assert.strictEqual(records.length, 2);
});

// --- 3. AI-invented questions are never presented as verified market questions ----

test('a question with no supporting observation is model_generated and forced to review', () => {
  const record = only(
    findInformationGaps({
      questions: [
        {
          question: 'What is the best jacket for hiking on Mars?',
          // Everything else asserted as favourably as a caller possibly could.
          businessRelevance: 'high',
          customerUsefulness: 'high',
          differentiationPotential: 'high',
          competitorObservations: twoCompetitorsNeitherAnswering(),
          currentSiteCoverage: { covered: false },
        },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'model_generated');
  // The structural guarantee: no combination of other signals can promote it.
  assert.strictEqual(record.status, 'review', 'a model-generated question must never be an opportunity');
  assert.deepStrictEqual(record.evidence_sources, []);
});

test('the result names an unsupported question as not-verified rather than staying silent', () => {
  const { limitations } = findInformationGaps({
    questions: [{ question: 'What is the best jacket for hiking on Mars?' }],
  });
  assert.ok(
    limitations.some((limitation) => limitation.includes('model_generated') && limitation.includes('NOT a verified')),
    'the limitations must state plainly that the question is not a verified market question'
  );
});

test('an inferred question is kept distinct from an observed one', () => {
  const record = only(
    findInformationGaps({
      questions: [
        {
          question: 'Which jacket insulation is warmest?',
          evidenceSources: [{ signalKind: 'keyword_research', reference: '(placeholder keyword record)' }],
          competitorObservations: twoCompetitorsNeitherAnswering(),
        },
      ],
    }).records
  );
  assert.strictEqual(record.evidence_strength, 'inferred');
});

// --- 4 & 5. Competitor coverage and gap classification ---------------------------

test('competitor coverage is counted, and the BEST available answer drives the gap', () => {
  const record = only(
    findInformationGaps({
      questions: [
        observedQuestion({
          competitorObservations: [
            { competitor: '(Example Co. A)', covered: false },
            { competitor: '(Example Co. B)', covered: true, answerQuality: 'weak' },
            { competitor: '(Example Co. C)', covered: true, answerQuality: 'incomplete' },
          ],
        }),
      ],
    }).records
  );
  assert.strictEqual(record.competitor_coverage.competitors_checked, 3);
  assert.strictEqual(record.competitor_coverage.competitors_answering, 2);
  // 'incomplete' outranks 'weak' - the best answer a customer can already find.
  assert.strictEqual(record.competitor_coverage.best_answer_quality, 'incomplete');
  assert.strictEqual(record.gap_type, 'incomplete_answer');
});

test('each answer quality maps to its own gap classification', () => {
  for (const [answerQuality, expectedGapType] of [
    ['weak', 'weak_answer'],
    ['incomplete', 'incomplete_answer'],
    ['unclear', 'unclear_answer'],
    ['outdated', 'outdated_answer'],
  ]) {
    const record = only(
      findInformationGaps({
        questions: [
          observedQuestion({
            competitorObservations: [
              { competitor: '(Example Co. A)', covered: true, answerQuality },
              { competitor: '(Example Co. B)', covered: true, answerQuality },
            ],
          }),
        ],
      }).records
    );
    assert.strictEqual(record.gap_type, expectedGapType, `answerQuality '${answerQuality}'`);
    assert.strictEqual(record.status, 'opportunity');
  }
});

test('when nobody answers, the gap is specialized by question type', () => {
  for (const [questionType, expectedGapType] of [
    ['comparison', 'missing_comparison'],
    ['use_case', 'missing_use_case'],
    ['troubleshooting', 'missing_troubleshooting'],
    ['buying', 'missing_buying_information'],
    ['product_specific', 'poor_product_context'],
    ['informational', 'missing_question'],
  ]) {
    const record = only(findInformationGaps({ questions: [observedQuestion({ questionType })] }).records);
    assert.strictEqual(record.gap_type, expectedGapType, `questionType '${questionType}'`);
  }
});

test('one competitor already answering completely means there is NO gap', () => {
  // Even though a second competitor ignores the question entirely.
  const record = only(
    findInformationGaps({
      questions: [
        observedQuestion({
          competitorObservations: [
            { competitor: '(Example Co. A)', covered: false },
            { competitor: '(Example Co. B)', covered: true, answerQuality: 'complete' },
          ],
        }),
      ],
    }).records
  );
  assert.strictEqual(record.gap_type, null);
  assert.strictEqual(record.status, 'no_gap');
});

test('a single competitor\'s silence is NOT enough to claim a gap', () => {
  // The explicit requirement: do not classify a question as a gap merely because one
  // competitor does not mention it.
  const record = only(
    findInformationGaps({
      questions: [observedQuestion({ competitorObservations: [{ competitor: '(Example Co. A)', covered: false }] })],
    }).records
  );
  assert.strictEqual(record.gap_type, null, 'one competitor must not be enough to assert a gap');
  assert.strictEqual(record.status, 'review');
  assert.ok(
    record.score_reasons.some((reason) => reason.includes(`at least ${MIN_COMPETITORS_FOR_GAP_CLAIM}`)),
    'the shortfall must be stated, not silent'
  );
});

test('a competitor entry without a name is ignored rather than inflating the count', () => {
  const record = only(
    findInformationGaps({
      questions: [
        observedQuestion({
          competitorObservations: [{ competitor: '(Example Co. A)', covered: false }, { covered: false }, null],
        }),
      ],
    }).records
  );
  assert.strictEqual(record.competitor_coverage.competitors_checked, 1);
  assert.strictEqual(record.status, 'review');
});

// --- 6. Existing website coverage prevents false-positive gaps -------------------

test('a question our own site already answers completely is no_gap, not an opportunity', () => {
  const record = only(
    findInformationGaps({
      questions: [
        observedQuestion({
          currentSiteCoverage: {
            covered: true,
            coverageQuality: 'complete',
            pages: ['(Example) /pages/jacket-care'],
          },
        }),
      ],
    }).records
  );
  assert.strictEqual(record.status, 'no_gap');
  assert.strictEqual(record.gap_type, null);
  assert.strictEqual(record.current_site_coverage.covered, true);
  assert.deepStrictEqual(record.current_site_coverage.pages, ['(Example) /pages/jacket-care']);
});

test('our site covering a question only WEAKLY still leaves a real opportunity', () => {
  const record = only(
    findInformationGaps({
      questions: [observedQuestion({ currentSiteCoverage: { covered: true, coverageQuality: 'weak' } })],
    }).records
  );
  assert.strictEqual(record.status, 'opportunity');
  assert.ok(record.gap_type);
});

// --- 7. Scoring is deterministic and explainable ---------------------------------

test('identical input produces an identical score, twice', () => {
  const input = {
    questions: [observedQuestion({ businessRelevance: 'high', customerUsefulness: 'medium' })],
    researchDate: '2026-09-04',
  };
  const first = only(findInformationGaps(input).records);
  const second = only(findInformationGaps(input).records);
  assert.strictEqual(first.opportunity_score, second.opportunity_score);
  assert.deepStrictEqual(first.score_reasons, second.score_reasons);
});

test('every score carries a reason per component plus a stated total', () => {
  const record = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  // 7 components + the total line.
  assert.strictEqual(record.score_reasons.length, 8);
  assert.ok(record.score_reasons.some((reason) => reason.startsWith('Total:')));
  assert.ok(record.score_reasons.every((reason) => typeof reason === 'string' && reason.length > 0));
});

test('missing evidence is named explicitly in the reasons, not silently scored zero', () => {
  const record = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  assert.ok(record.score_reasons.some((reason) => reason.includes('No business relevance was asserted')));
  assert.ok(record.score_reasons.some((reason) => reason.includes('No customer usefulness was asserted')));
});

test('stronger evidence scores strictly higher than weaker, all else equal', () => {
  const base = { competitorObservations: twoCompetitorsNeitherAnswering(), businessRelevance: 'high' };
  const observed = only(
    findInformationGaps({
      questions: [{ question: 'Does this jacket fit true to size?', evidenceSources: [{ signalKind: 'competitor_faq', reference: 'r' }], ...base }],
    }).records
  );
  const inferred = only(
    findInformationGaps({
      questions: [{ question: 'Does this jacket fit true to size?', evidenceSources: [{ signalKind: 'keyword_research', reference: 'r' }], ...base }],
    }).records
  );
  const invented = only(
    findInformationGaps({ questions: [{ question: 'Does this jacket fit true to size?', ...base }] }).records
  );
  assert.ok(observed.opportunity_score > inferred.opportunity_score);
  assert.ok(inferred.opportunity_score > invented.opportunity_score);
});

test('records come back sorted by opportunity score, highest first', () => {
  const { records } = findInformationGaps({
    questions: [
      { question: 'A low-evidence question about sizing charts?' },
      observedQuestion({ businessRelevance: 'high', customerUsefulness: 'high', differentiationPotential: 'high' }),
    ],
  });
  assert.strictEqual(records.length, 2);
  assert.ok(records[0].opportunity_score >= records[1].opportunity_score);
  assert.strictEqual(records[0].status, 'opportunity');
});

// --- Demand: never fabricated ----------------------------------------------------

test('no demand signal scores zero and says so - demand is never estimated', () => {
  const record = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  assert.ok(
    record.score_reasons.some((reason) => reason.includes('demand was NOT estimated or inferred')),
    'the absence of demand data must be stated'
  );
});

test('a caller-supplied demand signal scores higher with a source than without', () => {
  const withSource = only(
    findInformationGaps({
      questions: [observedQuestion({ demandSignal: { signal: 'rising interest (placeholder)', source: '(placeholder source)' } })],
    }).records
  );
  const withoutSource = only(
    findInformationGaps({ questions: [observedQuestion({ demandSignal: { signal: 'rising interest (placeholder)' } })] }).records
  );
  assert.ok(withSource.opportunity_score > withoutSource.opportunity_score);
});

test('no numeric search volume is produced anywhere in a record', () => {
  const record = only(
    findInformationGaps({
      questions: [observedQuestion({ demandSignal: { signal: 'rising interest (placeholder)', source: '(placeholder source)' } })],
    }).records
  );
  const serialized = JSON.stringify(record).toLowerCase();
  for (const forbidden of ['search_volume', 'searchvolume', 'monthly_searches', 'estimated_volume', 'searches per month']) {
    assert.ok(!serialized.includes(forbidden), `a record must never carry ${forbidden}`);
  }
  assert.ok(!('estimated_search_volume' in record));
});

// --- 8. Insufficient evidence produces review ------------------------------------

test('review is produced for thin evidence, and for caller-flagged compliance ambiguity', () => {
  // Too few competitors checked.
  const thin = only(
    findInformationGaps({
      questions: [observedQuestion({ competitorObservations: [] })],
    }).records
  );
  assert.strictEqual(thin.status, 'review');

  // Ownership/policy ambiguity - never resolved into an assertion either way.
  const ambiguous = only(findInformationGaps({ questions: [observedQuestion({ complianceAmbiguity: true })] }).records);
  assert.strictEqual(ambiguous.status, 'review');
});

test('the result states plainly that no Compliance capability was available', () => {
  const { limitations } = findInformationGaps({ questions: [observedQuestion()] });
  assert.ok(limitations.some((limitation) => limitation.includes('Compliance')));
  // And makes no absolute legal/IP claim.
  const joined = limitations.join(' ').toLowerCase();
  for (const forbidden of ['copyright-free', 'legally cleared', 'no copyright', 'trademark-free']) {
    assert.ok(!joined.includes(forbidden), `must not claim "${forbidden}"`);
  }
});

test('an empty or malformed questions list is refused with a clear error, never guessed', () => {
  assert.throws(() => findInformationGaps({}), /non-empty `questions` array/);
  assert.throws(() => findInformationGaps({ questions: [] }), /non-empty `questions` array/);
  assert.throws(() => findInformationGaps({ questions: ['just a string'] }), /entry to be an object/);
  assert.throws(() => findInformationGaps({ questions: [{ question: '  ' }] }), /non-empty `question` string/);
});

// --- 9. Competitor wording is never copied ---------------------------------------

test('competitor notes and wording never reach any output field', () => {
  const SECRET = 'ZZQUUX_COMPETITOR_PROPRIETARY_PHRASE';
  const { records, limitations } = findInformationGaps({
    questions: [
      observedQuestion({
        productContext: '(Example insulated jacket)',
        competitorObservations: [
          { competitor: '(Example Co. A)', covered: true, answerQuality: 'weak', notes: `${SECRET} washing advice` },
          { competitor: '(Example Co. B)', covered: true, answerQuality: 'weak', title: `${SECRET} guide`, answerText: SECRET },
        ],
      }),
    ],
  });
  const record = only(records);

  // The gap was still classified from those observations...
  assert.strictEqual(record.gap_type, 'weak_answer');
  // ...but not one character of their wording is reproduced anywhere.
  assert.ok(!JSON.stringify(record).includes(SECRET), 'competitor wording leaked into the record');
  assert.ok(!JSON.stringify(limitations).includes(SECRET), 'competitor wording leaked into the limitations');
  // The competitor's own name is likewise not reproduced in content suggestions.
  assert.ok(!record.suggested_title.includes('Example Co.'));
  assert.ok(!record.suggested_outline.join(' ').includes('Example Co.'));
});

test('content suggestions are built from the question and caller product context only', () => {
  const record = only(
    findInformationGaps({
      questions: [observedQuestion({ questionType: 'comparison', productContext: '(Example insulated jacket)' })],
    }).records
  );
  assert.ok(record.suggested_title.includes(observedQuestion().question));
  assert.ok(record.suggested_title.includes('(Example insulated jacket)'));
  assert.strictEqual(record.recommended_content_type, 'comparison page');
  assert.ok(record.suggested_outline.length > 0);
});

test('recommended target page and internal links are relayed, never invented', () => {
  const noneSupplied = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  assert.strictEqual(noneSupplied.recommended_target_page, '');
  assert.deepStrictEqual(noneSupplied.recommended_internal_links, []);

  const supplied = only(
    findInformationGaps({
      questions: [
        observedQuestion({
          recommendedTargetPage: '(Example) /pages/jacket-care',
          recommendedInternalLinks: ['(Example) /collections/outerwear'],
        }),
      ],
    }).records
  );
  assert.strictEqual(supplied.recommended_target_page, '(Example) /pages/jacket-care');
  assert.deepStrictEqual(supplied.recommended_internal_links, ['(Example) /collections/outerwear']);
});

test('no content is generated - only a recommended content type and an outline of sections', () => {
  const record = only(findInformationGaps({ questions: [observedQuestion()] }).records);
  // Outline entries are instructions to a writer, not written copy.
  assert.ok(record.suggested_outline.every((entry) => typeof entry === 'string'));
  assert.ok(!('generated_content' in record) && !('body' in record) && !('article' in record));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
