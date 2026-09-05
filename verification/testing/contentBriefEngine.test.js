'use strict';

// Tests for agent/core/contentBriefEngine.js and the schema it composes into
// (agent/core/contentBriefModel.js) - the deterministic half of "validated
// information-gap opportunity -> SEO content brief". Gating, brief composition, prompt
// assembly, and the post-generation honesty checks.
//
// Both modules are pure by construction - no network, model, or filesystem call - so
// nothing here needs mocking and nothing here can reach an external API. The single
// model call in this capability lives in tools/seoContentGenerationTool.js and is mocked
// in verification/testing/seoContentGenerationTool.test.js.
//
// Opportunities are built by calling the REAL findInformationGaps() rather than
// hand-writing gap records, so these tests break if the two contracts ever drift apart.
//
// Every question, competitor, and fact below is an invented placeholder for testing.

const assert = require('node:assert');
const {
  gateOpportunity,
  buildBrief,
  buildGenerationInstruction,
  findCopiedCompetitorPhrase,
  findVerificationMarkers,
  findUnsupportedFactualClaims,
  checkGeneratedContent,
} = require('../../agent/core/contentBriefEngine');
const {
  CONTENT_BRIEF_STATUSES,
  CONTENT_BRIEF_FIELDS,
  createEmptyContentGenerationResult,
  validateContentBriefShape,
  validateContentGenerationResultShape,
} = require('../../agent/core/contentBriefModel');
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

// Builds a real gap opportunity through the actual Gap Finder.
function buildOpportunity(overrides = {}) {
  const { records } = findInformationGaps({
    questions: [
      {
        question: 'How long does an insulated jacket last?',
        questionType: 'buying',
        evidenceSources: [{ signalKind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
        competitorObservations: [
          { competitor: '(Example Co. A)', covered: false },
          { competitor: '(Example Co. B)', covered: false },
        ],
        productContext: '(Example insulated jacket)',
        recommendedInternalLinks: ['(Example) /collections/outerwear'],
        recommendedTargetPage: '(Example) /pages/jacket-care',
        ...overrides,
      },
    ],
  });
  return records[0];
}

// --- The gate --------------------------------------------------------------------

test('a validated, evidenced opportunity is ready', () => {
  const gate = gateOpportunity(buildOpportunity());
  assert.strictEqual(gate.status, 'ready');
  assert.deepStrictEqual(gate.reasons, []);
});

test('a model-generated question is BLOCKED, however attractive its other signals', () => {
  // The central rule: no combination of relevance, usefulness or score can promote a
  // question nobody was observed asking into content.
  const opportunity = buildOpportunity({
    evidenceSources: [],
    businessRelevance: 'high',
    customerUsefulness: 'high',
    differentiationPotential: 'high',
  });
  assert.strictEqual(opportunity.evidence_strength, 'model_generated');
  const gate = gateOpportunity(opportunity);
  assert.strictEqual(gate.status, 'blocked');
  assert.ok(gate.reasons[0].includes('no verified provenance'));
});

test('an opportunity our own site already answers completely is BLOCKED', () => {
  const opportunity = buildOpportunity({
    currentSiteCoverage: { covered: true, coverageQuality: 'complete', pages: ['(Example) /pages/jacket-care'] },
  });
  const gate = gateOpportunity(opportunity);
  assert.strictEqual(gate.status, 'blocked');
  assert.ok(gate.reasons[0].includes('already answers this question'));
  assert.ok(gate.reasons[0].includes('/pages/jacket-care'));
});

test("the Gap Finder's own 'review' verdict is carried forward, never overridden", () => {
  // Only one competitor checked - the Gap Finder holds this at review, and so must this.
  const opportunity = buildOpportunity({ competitorObservations: [{ competitor: '(Example Co. A)', covered: false }] });
  assert.strictEqual(opportunity.status, 'review');
  const gate = gateOpportunity(opportunity);
  assert.strictEqual(gate.status, 'review');
  assert.ok(gate.reasons.some((reason) => reason.includes("left this opportunity at status 'review'")));
});

test('a missing or malformed opportunity is blocked, never assumed', () => {
  for (const bad of [undefined, null, [], 'an opportunity', {}]) {
    assert.strictEqual(gateOpportunity(bad).status, 'blocked');
  }
});

test('every gate outcome names at least one reason unless it is ready', () => {
  for (const opportunity of [buildOpportunity({ evidenceSources: [] }), buildOpportunity({ competitorObservations: [] })]) {
    const gate = gateOpportunity(opportunity);
    assert.notStrictEqual(gate.status, 'ready');
    assert.ok(gate.reasons.length > 0, 'a non-ready gate must say why');
  }
});

// --- The brief -------------------------------------------------------------------

test('a valid opportunity produces a complete, schema-valid brief', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.strictEqual(validateContentBriefShape(brief).valid, true);
  assert.deepStrictEqual(Object.keys(brief), CONTENT_BRIEF_FIELDS.map((field) => field.id));
});

test('the real evidenced question remains the target question, verbatim', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.strictEqual(brief.target_question, 'How long does an insulated jacket last?');
  assert.strictEqual(brief.evidence.length, 1, 'provenance must carry forward');
  assert.strictEqual(brief.evidence[0].signal_kind, 'competitor_faq');
});

test("the opportunity's recommended content type is preserved, not re-decided", () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.strictEqual(brief.content_type, opportunity.recommended_content_type);
  assert.strictEqual(brief.content_type, 'buying guide');
});

test('the gap type drives the content angle', () => {
  for (const [questionType, expectedFragment] of [
    ['comparison', 'criteria that actually matter'],
    ['troubleshooting', 'ordered steps'],
    ['buying', 'what a customer needs in order to decide'],
  ]) {
    const opportunity = buildOpportunity({ questionType });
    const brief = buildBrief(opportunity, gateOpportunity(opportunity));
    assert.ok(brief.content_angle.includes(expectedFragment), `${questionType} -> ${brief.content_angle}`);
  }
});

test('a weak existing answer produces a different angle from a missing one', () => {
  const missing = buildBrief(buildOpportunity(), gateOpportunity(buildOpportunity()));
  const weakOpportunity = buildOpportunity({
    competitorObservations: [
      { competitor: '(Example Co. A)', covered: true, answerQuality: 'weak' },
      { competitor: '(Example Co. B)', covered: true, answerQuality: 'weak' },
    ],
  });
  const weak = buildBrief(weakOpportunity, gateOpportunity(weakOpportunity));
  assert.notStrictEqual(weak.content_angle, missing.content_angle);
  assert.ok(weak.content_angle.includes('thin'));
});

test('search intent is derived from the question type - SEO\'s own concern', () => {
  const opportunity = buildOpportunity({ questionType: 'comparison' });
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.ok(brief.search_intent.includes('commercial investigation'));
});

test('the competitor gap summary is counts only - never competitor wording', () => {
  const SECRET = 'ZZQUUX_COMPETITOR_PHRASE';
  const opportunity = buildOpportunity({
    competitorObservations: [
      { competitor: '(Example Co. A)', covered: true, answerQuality: 'weak', notes: SECRET },
      { competitor: '(Example Co. B)', covered: false, notes: SECRET },
    ],
  });
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.ok(brief.competitor_gap_summary.includes('1 of 2'));
  assert.ok(!JSON.stringify(brief).includes(SECRET), 'competitor wording leaked into the brief');
  assert.ok(!JSON.stringify(brief).includes('Example Co.'), 'competitor identity leaked into the brief');
});

test('target page and internal links are relayed, never invented', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.strictEqual(brief.target_page, '(Example) /pages/jacket-care');
  assert.deepStrictEqual(brief.internal_link_opportunities, ['(Example) /collections/outerwear']);

  const bare = buildOpportunity({ recommendedTargetPage: undefined, recommendedInternalLinks: undefined });
  const bareBrief = buildBrief(bare, gateOpportunity(bare));
  assert.strictEqual(bareBrief.target_page, '');
  assert.deepStrictEqual(bareBrief.internal_link_opportunities, []);
});

test('differentiation points are caller-supplied only, never inferred', () => {
  const opportunity = buildOpportunity();
  const withoutPoints = buildBrief(opportunity, gateOpportunity(opportunity));
  assert.deepStrictEqual(withoutPoints.differentiation_points, []);

  const withPoints = buildBrief(opportunity, gateOpportunity(opportunity), {
    differentiationPoints: ['We publish our own durability testing (placeholder).'],
  });
  assert.strictEqual(withPoints.differentiation_points.length, 1);
});

// --- The generation instruction ---------------------------------------------------

test('the prompt carries the question, angle and outline - and no competitor text', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  const instruction = buildGenerationInstruction(brief);
  assert.ok(instruction.includes('How long does an insulated jacket last?'));
  assert.ok(instruction.includes(brief.content_angle));
  assert.ok(!instruction.includes('Example Co.'), 'the model must never be shown competitor identities');
});

test('with no supplied facts, the prompt forbids stating any specific fact at all', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  const instruction = buildGenerationInstruction(brief);
  assert.ok(instruction.includes('you were given none'));
  assert.ok(instruction.includes('[VERIFY:'));
  assert.ok(instruction.includes('Never invent statistics, search volumes'));
});

test('supplied facts are listed as the ONLY established facts', () => {
  const opportunity = buildOpportunity();
  const brief = buildBrief(opportunity, gateOpportunity(opportunity));
  const instruction = buildGenerationInstruction(brief, {
    supportedFacts: ['Our jackets carry a 3-year warranty (placeholder).'],
  });
  assert.ok(instruction.includes('ONLY specific facts you may state'));
  assert.ok(instruction.includes('3-year warranty'));
});

// --- Post-generation checks -------------------------------------------------------

test('copied competitor wording is detected mechanically', () => {
  const competitorText = 'Store your insulated jacket loosely in a breathable garment bag away from direct sunlight always';
  const draft = `To keep it in good shape, store your insulated jacket loosely in a breathable garment bag away from direct sunlight always.`;
  const found = findCopiedCompetitorPhrase(draft, [competitorText]);
  assert.ok(found, 'an eight-word lifted run should be detected');

  // Ordinary shared subject vocabulary must not trip it.
  assert.strictEqual(findCopiedCompetitorPhrase('Insulated jackets last a while.', [competitorText]), null);
  assert.strictEqual(findCopiedCompetitorPhrase(draft, []), null);
});

test('verification markers the model left behind are surfaced', () => {
  const markers = findVerificationMarkers('It lasts [VERIFY: typical lifespan] under normal use. [VERIFY: warranty length]');
  assert.strictEqual(markers.length, 2);
});

test('an invented figure is caught - the "X lasts 5 years" guard', () => {
  const claims = findUnsupportedFactualClaims('A quality insulated jacket lasts 5 years with proper care.', []);
  assert.ok(claims.length > 0);
  assert.ok(claims[0].includes('the figure 5 is not in the supplied evidence'));
});

test('a figure the caller actually established is accepted', () => {
  const claims = findUnsupportedFactualClaims('Our jackets carry a 3 year warranty.', ['Our jackets carry a 3 year warranty (placeholder).']);
  assert.deepStrictEqual(claims, []);
});

test('fabricated demand and ranking claims are caught specifically', () => {
  for (const draft of [
    'This question gets 12,000 monthly searches.',
    'We rank #1 for this term.',
    'Around 60% of customers ask this.',
    'Our search volume for this topic is growing.',
  ]) {
    const claims = findUnsupportedFactualClaims(draft, []);
    assert.ok(claims.length > 0, `should have flagged: ${draft}`);
  }
});

test('checkGeneratedContent passes a clean, fact-free draft', () => {
  const draft =
    'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing, a well-made insulated jacket stays warm and usable for a long time. Signs it needs replacing include flattened insulation that no longer lofts, and outer fabric that no longer sheds water.';
  const { reasons } = checkGeneratedContent(draft, { targetQuestion: 'How long does an insulated jacket last?' });
  assert.deepStrictEqual(reasons, []);
});

test('checkGeneratedContent rejects empty content and off-topic content', () => {
  assert.ok(checkGeneratedContent('', {}).reasons.length > 0);
  const offTopic = checkGeneratedContent('Our company was founded by three friends who enjoy cycling and coffee.', {
    targetQuestion: 'How long does an insulated jacket last?',
  });
  assert.ok(offTopic.reasons.some((reason) => reason.includes('does not appear to address the target question')));
});

// --- The result schema's honesty invariants ---------------------------------------

test('the result schema forbids ready-with-reasons, silent non-ready, and blocked-with-content', () => {
  const readyWithReasons = createEmptyContentGenerationResult('x');
  readyWithReasons.status = 'ready';
  readyWithReasons.review_reasons = ['something is wrong'];
  assert.ok(validateContentGenerationResultShape(readyWithReasons).errors.some((e) => e.includes('cannot be ready')));

  const silentReview = createEmptyContentGenerationResult('x');
  silentReview.status = 'review';
  silentReview.review_reasons = [];
  assert.ok(validateContentGenerationResultShape(silentReview).errors.some((e) => e.includes('requires at least one review reason')));

  const blockedWithContent = createEmptyContentGenerationResult('x');
  blockedWithContent.status = 'blocked';
  blockedWithContent.review_reasons = ['blocked for a reason'];
  blockedWithContent.generated_content = 'some draft';
  assert.ok(validateContentGenerationResultShape(blockedWithContent).errors.some((e) => e.includes('must not carry generated content')));
});

test('the three statuses are exactly ready, review and blocked', () => {
  assert.deepStrictEqual(CONTENT_BRIEF_STATUSES, ['ready', 'review', 'blocked']);
});

test('no schema field invites a publishing destination or schedule', () => {
  const ids = CONTENT_BRIEF_FIELDS.map((field) => field.id);
  for (const forbidden of ['publish_to', 'publish_at', 'schedule', 'destination', 'channel', 'published']) {
    assert.ok(!ids.includes(forbidden), `the brief must not carry ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
