'use strict';

// The deterministic half of "validated information-gap opportunity -> SEO content".
// Three jobs, all offline and all free of model calls:
//
//   1. GATE      - decide whether an opportunity has earned content at all
//                  (ready / review / blocked), from the gap record's own evidence.
//   2. BRIEF     - compose the structured content brief from that opportunity.
//   3. POST-CHECK- inspect generated text and downgrade it when it made a claim the
//                  supplied evidence does not support, or reproduced competitor wording.
//
// The single model call lives in tools/seoContentGenerationTool.js, which reuses the
// existing tools/aiReasoningCompletion.js path (and therefore the existing AI_PROVIDER
// selection, token controls, and usage accounting). Nothing here calls a model, so every
// rule below is testable offline and costs nothing to enforce.
//
// WHY GATING COMES FIRST, AND COSTS NOTHING. A blocked or review opportunity never
// reaches generation at all, so an unevidenced question spends no tokens. That is both
// the honest behavior and the cheap one - the two align here.
//
// THE CENTRAL RULE: EVIDENCE DECIDES, NOT ENTHUSIASM. An opportunity whose question was
// never really observed (agent/core/informationGapModel.js's evidence_strength
// 'model_generated') can never become content, regardless of how high its opportunity
// score is - a high score on an invented question is exactly the failure mode this gate
// exists for. Likewise an opportunity the Gap Finder itself left at 'review' cannot be
// silently promoted here; it stays 'review' and carries that engine's own reasons
// forward.
//
// CONSUMES THE EXISTING GAP CONTRACT UNCHANGED. Input is an
// agent/core/informationGapModel.js record exactly as findInformationGaps() produces
// one. No second gap schema, and nothing in the Gap Finder is modified or re-derived.
//
// COMPETITOR CONTENT IS EVIDENCE, NEVER SOURCE TEXT. The brief's competitor summary is
// built from coverage COUNTS only. If a caller supplies the competitor observations they
// collected, their text is used for exactly one purpose - checking that the generated
// draft did NOT reproduce it (see checkGeneratedContent) - and never as input to the
// prompt.
//
// NOTHING HERE PUBLISHES. This module has no integration, no HTTP call, and no
// destination field. Compliance, human approval and publishing are later stages.

const { GAP_TYPES } = require('./informationGapModel');
const {
  createEmptyContentBrief,
  validateContentBriefShape,
} = require('./contentBriefModel');

// What the identified gap implies about how to approach the answer. Deterministic - the
// missing thing dictates the angle, so this is a lookup, not a judgment.
const GAP_TYPE_TO_ANGLE = {
  missing_question: 'Nobody answers this question yet - answer it plainly and completely, from first principles.',
  weak_answer: 'Existing answers are thin - go deeper than a one-line reply and cover what they leave out.',
  incomplete_answer: 'Existing answers stop short - cover the parts that are consistently left unfinished.',
  unclear_answer: 'Existing answers are confusing - answer in plain language, without jargon or hedging.',
  outdated_answer: 'Existing answers are out of date - state what is current, and say plainly when something changed.',
  poor_product_context: 'Existing answers are generic - tie the answer to concrete, verified product specifics.',
  missing_comparison: 'No usable comparison exists - set out the criteria that actually matter to the buyer.',
  missing_use_case: 'The relevant use cases are not covered - describe who this applies to and when.',
  missing_troubleshooting: 'No practical troubleshooting exists - give clear, ordered steps to resolve the problem.',
  missing_buying_information: 'Buying information is missing - cover what a customer needs in order to decide.',
};

// The searcher's goal, derived from the question type the Gap Finder already recorded.
// SEO's own concern (search intent), not a marketing or audience-segmentation claim.
const QUESTION_TYPE_TO_SEARCH_INTENT = {
  informational: 'informational - the searcher wants to understand something',
  comparison: 'commercial investigation - the searcher is comparing options',
  buying: 'commercial investigation - the searcher is deciding whether to buy',
  use_case: 'informational - the searcher wants to know if it fits their situation',
  troubleshooting: 'informational - the searcher has a problem to solve now',
  product_specific: 'commercial investigation - the searcher wants specifics about this product',
  unclassified: 'unclassified - the search intent was not asserted by the caller',
};

// Any run of this many identical consecutive words between the generated draft and
// supplied competitor text counts as reproduced wording. Long enough that ordinary
// shared phrasing about the same subject ("how long does it last") does not trip it,
// short enough to catch a lifted sentence.
const COPIED_PHRASE_WORD_RUN = 8;

// Wording that, combined with a number, would be a demand/performance claim this
// project never has data for. Matched deterministically against the draft.
const FABRICATED_METRIC_PATTERNS = [
  /\b\d[\d,.]*\s*(?:\+\s*)?(?:monthly\s+)?searches?\b/i,
  /\bsearch\s+volume\b/i,
  /\b\d[\d,.]*\s*(?:monthly\s+)?visitors?\b/i,
  /\b\d[\d,.]*%\s*(?:of\s+)?(?:customers|shoppers|users|people|buyers)\b/i,
  /\brank(?:s|ed|ing)?\s+(?:#\s*)?\d+\b/i,
  /\bclick[-\s]?through\s+rate\b/i,
  /\b\d[\d,.]*\s*(?:page\s*)?views\b/i,
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------------
// 1. The gate.
// ---------------------------------------------------------------------------------

// Returns { status, reasons }. Never throws for a merely weak opportunity - a weak
// opportunity is a real, reportable outcome, not an error.
function gateOpportunity(opportunity) {
  const reasons = [];

  if (!opportunity || typeof opportunity !== 'object' || Array.isArray(opportunity)) {
    return { status: 'blocked', reasons: ['No information-gap opportunity was supplied.'] };
  }
  if (!isNonEmptyString(opportunity.question)) {
    return { status: 'blocked', reasons: ['The opportunity carries no question, so there is nothing to answer.'] };
  }

  // The hard stop. A question nobody was ever observed asking must not become content,
  // however attractive its other signals look.
  if (opportunity.evidence_strength === 'model_generated') {
    return {
      status: 'blocked',
      reasons: [
        `"${opportunity.question}" has no verified provenance (evidence_strength 'model_generated'), so it is not an established market question and must not be turned into content. Discover real evidence for it first.`,
      ],
    };
  }

  // Our own site already answering it completely is the other hard stop: writing it
  // again is duplicate content, not an opportunity.
  const siteCoverage = opportunity.current_site_coverage || {};
  if (siteCoverage.covered === true && (siteCoverage.coverage_quality === 'complete' || siteCoverage.coverage_quality === null)) {
    return {
      status: 'blocked',
      reasons: [
        `Our own site already answers this question${Array.isArray(siteCoverage.pages) && siteCoverage.pages.length > 0 ? ` (see: ${siteCoverage.pages.join(', ')})` : ''}, so new content is not warranted.`,
      ],
    };
  }

  if (opportunity.status === 'no_gap') {
    return { status: 'blocked', reasons: ['The Gap Finder identified no information gap for this question, so there is nothing to close.'] };
  }

  // The Gap Finder's own unresolved verdict is carried forward, never overridden.
  if (opportunity.status === 'review') {
    reasons.push(
      'The Gap Finder left this opportunity at status \'review\', so it is not a validated opportunity yet and content was not generated for it.'
    );
  }
  if (opportunity.gap_type === null || !GAP_TYPES.includes(opportunity.gap_type)) {
    reasons.push('No specific information gap was classified, so there is nothing definite for the content to close.');
  }
  if (!Array.isArray(opportunity.evidence_sources) || opportunity.evidence_sources.length === 0) {
    reasons.push('The opportunity carries no evidence sources, so the question is not demonstrably one real customers ask.');
  }

  return { status: reasons.length > 0 ? 'review' : 'ready', reasons };
}

// ---------------------------------------------------------------------------------
// 2. The brief.
// ---------------------------------------------------------------------------------

// Counts only. Deliberately never reads a competitor's name, title, notes or answer
// text - competitor research tells us WHERE the gap is, not what words to use.
function summarizeCompetitorGap(coverage) {
  if (!coverage || typeof coverage !== 'object') return 'No competitor coverage was assessed for this question.';
  const checked = Number(coverage.competitors_checked) || 0;
  const answering = Number(coverage.competitors_answering) || 0;
  if (checked === 0) return 'No competitors were checked for this question.';
  if (answering === 0) return `None of the ${checked} competitor(s) checked answer this question at all.`;
  return `${answering} of ${checked} competitor(s) checked answer this question, and the best available answer was assessed as '${coverage.best_answer_quality || 'unassessed'}'.`;
}

// What the content must cover, built from the gap type and the opportunity's own
// outline. Never from competitor text.
function buildKeyInformation(opportunity) {
  const points = [`Answer directly: ${opportunity.question}`];
  const angle = GAP_TYPE_TO_ANGLE[opportunity.gap_type];
  if (angle) points.push(angle);
  if (isNonEmptyString(opportunity.identified_gap)) points.push(`Close the identified gap: ${opportunity.identified_gap}`);
  return points;
}

function buildBrief(opportunity, gateResult, params = {}) {
  const brief = createEmptyContentBrief(opportunity.question);
  brief.content_type = opportunity.recommended_content_type || '';
  brief.search_intent = isNonEmptyString(params.searchIntent)
    ? params.searchIntent.trim()
    : QUESTION_TYPE_TO_SEARCH_INTENT[opportunity.question_type] || QUESTION_TYPE_TO_SEARCH_INTENT.unclassified;
  brief.target_page = opportunity.recommended_target_page || '';
  brief.suggested_title = opportunity.suggested_title || '';
  brief.content_angle = GAP_TYPE_TO_ANGLE[opportunity.gap_type] || 'No specific gap was classified, so no content angle could be derived.';
  brief.audience_problem = `A customer researching "${opportunity.question}" cannot currently find a complete answer.`;
  brief.key_information_to_cover = buildKeyInformation(opportunity);
  brief.recommended_outline = normalizeArray(opportunity.suggested_outline);
  brief.evidence = normalizeArray(opportunity.evidence_sources);
  brief.competitor_gap_summary = summarizeCompetitorGap(opportunity.competitor_coverage);
  brief.internal_link_opportunities = normalizeArray(opportunity.recommended_internal_links);
  // Caller-supplied only. What makes our answer better is a business fact this engine
  // has no way to know, so an absent value stays absent rather than being invented.
  brief.differentiation_points = normalizeArray(params.differentiationPoints).filter(isNonEmptyString);
  brief.status = gateResult.status;

  const validation = validateContentBriefShape(brief);
  if (!validation.valid) {
    throw new Error(`buildBrief produced an invalid content brief: ${validation.errors.join('; ')}`);
  }
  return brief;
}

// ---------------------------------------------------------------------------------
// 3. The generation instruction - deterministic prompt assembly, no model call.
// ---------------------------------------------------------------------------------

// Built ONLY from the brief. Competitor text is deliberately never included: the model
// cannot reproduce wording it was never shown, which is a stronger guarantee than asking
// it not to.
function buildGenerationInstruction(brief, params = {}) {
  const businessContext = isNonEmptyString(params.businessContext) ? params.businessContext.trim() : '';
  const supportedFacts = normalizeArray(params.supportedFacts).filter(isNonEmptyString);

  const lines = [
    `Write a ${brief.content_type || 'short answer'} for our own website that answers this exact customer question:`,
    `"${brief.target_question}"`,
    '',
    `Search intent: ${brief.search_intent}`,
    `Angle: ${brief.content_angle}`,
    `Audience problem: ${brief.audience_problem}`,
    '',
    'Cover these points:',
    ...brief.key_information_to_cover.map((point) => `- ${point}`),
  ];

  if (brief.recommended_outline.length > 0) {
    lines.push('', 'Follow this outline:', ...brief.recommended_outline.map((section) => `- ${section}`));
  }
  if (brief.differentiation_points.length > 0) {
    lines.push('', 'What we can say that others do not:', ...brief.differentiation_points.map((point) => `- ${point}`));
  }
  if (supportedFacts.length > 0) {
    lines.push('', 'These are the ONLY specific facts you may state as established:', ...supportedFacts.map((fact) => `- ${fact}`));
  }
  if (businessContext) {
    lines.push('', `Business context: ${businessContext}`);
  }

  lines.push(
    '',
    'Rules you must follow:',
    '- Answer the question directly in the first paragraph. Do not open with filler.',
    supportedFacts.length > 0
      ? '- Do NOT state any specific fact, figure, duration, measurement, material, or price beyond the established facts listed above. If answering well needs a fact you were not given, write [VERIFY: what is needed] instead of guessing it.'
      : '- Do NOT state any specific fact, figure, duration, measurement, material, or price - you were given none, and inventing one is worse than omitting it. Where a specific fact is needed, write [VERIFY: what is needed] instead.',
    '- Never invent statistics, search volumes, traffic figures, rankings, or percentages of customers. You have no such data.',
    '- Where the honest answer is "it depends", say so and explain what it depends on.',
    '- Do not name, quote, paraphrase, or compare against any specific competitor.',
    '- Write original prose in our own voice. Use the question\'s natural wording where it fits, but never repeat a keyword unnaturally.',
    '- Write the content only. No preamble, no explanation of what you wrote, no markdown code fences.'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------------
// 4. Post-checks - deterministic scrutiny of what the model actually returned.
// ---------------------------------------------------------------------------------

function wordRuns(text, runLength) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const runs = new Set();
  for (let i = 0; i + runLength <= words.length; i += 1) {
    runs.add(words.slice(i, i + runLength).join(' '));
  }
  return runs;
}

// Returns the first reproduced phrase found, or null. A model is instructed not to copy
// competitor wording, and is never shown any - but an instruction is not a guarantee,
// so when the caller has the competitor text this checks mechanically.
function findCopiedCompetitorPhrase(generatedContent, competitorTexts) {
  const texts = normalizeArray(competitorTexts).filter(isNonEmptyString);
  if (texts.length === 0) return null;
  const generatedRuns = wordRuns(generatedContent, COPIED_PHRASE_WORD_RUN);
  if (generatedRuns.size === 0) return null;
  for (const text of texts) {
    for (const run of wordRuns(text, COPIED_PHRASE_WORD_RUN)) {
      if (generatedRuns.has(run)) return run;
    }
  }
  return null;
}

// Every explicit verification marker the model left behind. Each one is a place it
// wanted a fact it did not have - exactly the honesty we asked for, and exactly why the
// draft is not ready to publish.
function findVerificationMarkers(generatedContent) {
  const matches = String(generatedContent).match(/\[VERIFY:[^\]]*\]/gi);
  return matches ? [...new Set(matches)] : [];
}

// Numeric or statistical claims that appear in the draft but in none of the facts the
// caller established. This is the "X lasts 5 years" guard: a number the evidence never
// supplied is not something to publish on our own site.
function findUnsupportedFactualClaims(generatedContent, supportedFacts) {
  const supported = normalizeArray(supportedFacts).filter(isNonEmptyString).join(' ').toLowerCase();
  const claims = [];

  for (const pattern of FABRICATED_METRIC_PATTERNS) {
    const match = String(generatedContent).match(pattern);
    if (match) claims.push(`Fabricated performance/demand claim: "${match[0].trim()}" - this project has no such data.`);
  }

  // Sentences carrying a quantity. A number is only acceptable if the caller actually
  // supplied it as an established fact.
  const sentences = String(generatedContent).split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const numbers = sentence.match(/\b\d[\d,.]*\b/g);
    if (!numbers) continue;
    for (const number of numbers) {
      // Ignore numbers inside a verification marker - those are already flagged
      // separately and are honest by construction.
      if (/\[VERIFY:[^\]]*\]/i.test(sentence)) continue;
      if (!supported.includes(number.toLowerCase())) {
        claims.push(`Unsupported specific claim: "${sentence.trim()}" - the figure ${number} is not in the supplied evidence.`);
        break;
      }
    }
  }

  return [...new Set(claims)];
}

// The final honesty pass over a generated draft. Returns { reasons } - each one a
// concrete, human-readable statement of why this draft is not ready. An empty list means
// the draft survived every check.
function checkGeneratedContent(generatedContent, { supportedFacts, competitorTexts, targetQuestion } = {}) {
  const reasons = [];

  if (!isNonEmptyString(generatedContent)) {
    return { reasons: ['The generator returned no content.'] };
  }

  const copied = findCopiedCompetitorPhrase(generatedContent, competitorTexts);
  if (copied) {
    reasons.push(`The draft reproduces competitor wording ("${copied}..."). Competitor research is evidence for finding gaps, never source text.`);
  }

  const markers = findVerificationMarkers(generatedContent);
  for (const marker of markers) {
    reasons.push(`The draft needs a fact it was not given: ${marker}`);
  }

  for (const claim of findUnsupportedFactualClaims(generatedContent, supportedFacts)) {
    reasons.push(claim);
  }

  // A draft that never addresses the question is not an answer, however well written.
  if (isNonEmptyString(targetQuestion)) {
    const questionWords = [...wordRuns(targetQuestion, 1)];
    const contentWords = wordRuns(generatedContent, 1);
    const overlap = questionWords.filter((word) => word.length > 3 && contentWords.has(word));
    const meaningful = questionWords.filter((word) => word.length > 3);
    if (meaningful.length > 0 && overlap.length / meaningful.length < 0.5) {
      reasons.push('The draft does not appear to address the target question - fewer than half of the question\'s meaningful terms appear in it.');
    }
  }

  return { reasons };
}

module.exports = {
  GAP_TYPE_TO_ANGLE,
  QUESTION_TYPE_TO_SEARCH_INTENT,
  COPIED_PHRASE_WORD_RUN,
  gateOpportunity,
  buildBrief,
  buildGenerationInstruction,
  findCopiedCompetitorPhrase,
  findVerificationMarkers,
  findUnsupportedFactualClaims,
  checkGeneratedContent,
};

if (require.main === module) {
  const { findInformationGaps } = require('./informationGapEngine');

  console.log('Smart E-Commerce Growth AI Agent - SEO content brief engine (deterministic, no model call):\n');

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
      },
      { question: 'What is the best jacket for hiking on Mars?' },
    ],
  });

  for (const opportunity of records) {
    const gate = gateOpportunity(opportunity);
    console.log(`--- [${gate.status}] ${opportunity.question}`);
    for (const reason of gate.reasons) console.log(`    reason: ${reason}`);
    if (gate.status === 'blocked') continue;
    const brief = buildBrief(opportunity, gate);
    console.log(`    content type: ${brief.content_type}`);
    console.log(`    angle: ${brief.content_angle}`);
    console.log(`    competitor gap: ${brief.competitor_gap_summary}`);
  }

  console.log('\nNo question, competitor, or fact above is real - every value is a placeholder for demonstration.');
}
