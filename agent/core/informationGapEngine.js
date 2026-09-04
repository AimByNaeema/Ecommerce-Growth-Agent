'use strict';

// The Information Gap Finder engine: real question signals -> normalization ->
// duplicate/semantic clustering -> competitor coverage analysis -> information-gap
// detection -> deterministic opportunity scoring -> prioritized, content-ready question
// opportunities.
//
// DETERMINISTIC AND EVIDENCE-COMPOSING ONLY - no AI call, no external fetch, no
// scraping, no SERP/autocomplete/PAA client, no keyword-volume source. This is the same
// discipline agent/core/seoAgent.js and agent/core/researchAgent.js already state in
// their own headers: the caller supplies already-collected, structured signals and this
// module's job is to classify, cluster, compare and score them honestly - never to
// discover, synthesize, or estimate one. Acquiring those signals live (autocomplete,
// People Also Ask, forums) would be a new external integration and is deliberately not
// part of this capability.
//
// THE CENTRAL RULE: a question's provenance is never laundered. Every signal is
// classified as exactly one of:
//   'observed'        - directly seen in a real source, WITH a reference (a competitor
//                       FAQ/heading, a captured People-Also-Ask/related-search entry, a
//                       product review question, a public forum thread, first-party
//                       store/site-search data, or an existing research/keyword output).
//   'inferred'        - not observed as a question, but derived from a real, referenced
//                       related signal (e.g. an existing keyword record).
//   'model_generated' - no supporting observation at all.
// A 'model_generated' question can never reach status 'opportunity'; it is always
// 'review'. That is enforced structurally in deriveStatus() below, not by convention.
//
// NO FABRICATED DEMAND. There is no search-volume input, output, or estimate anywhere in
// this file. The demand scoring component can only rise above zero when the caller
// supplies a real demand signal, and it scores highest only when that signal carries its
// own source reference.
//
// COMPETITOR WORDING IS NEVER REPRODUCED. Competitor observations feed gap
// CLASSIFICATION only (counts and an answer-quality enum). Their free-text `notes` are
// read to classify and are never copied into identified_gap, suggested_title,
// suggested_outline, or any other output field - see buildContentSuggestions(), which is
// built solely from the question, the gap type, and caller-supplied product context.
//
// NO CONTENT IS GENERATED OR PUBLISHED HERE. This engine identifies and prioritizes the
// opportunity and names a recommended content type; writing it is the existing
// listing/content-generation capability's job, and the intended downstream flow stays
// Gap Finder -> SEO/content opportunity -> existing content generation -> Compliance ->
// human approval -> existing integrations. Nothing here bypasses that.
//
// COMPLIANCE: this project has no shared Compliance capability implemented yet (there is
// no compliance/ module). Rather than assert anything about ownership, copyright,
// trademark or platform policy, a caller-flagged ambiguity resolves to status 'review'
// and a standing limitation says plainly that no Compliance check was available. No
// absolute legal or IP claim is made anywhere in this file.
//
// Its own small normalization/clustering helpers are deliberately local rather than
// shared - matching this codebase's documented convention that each capability module
// owns its own small derivation helpers (see agent/core/productOpportunityScoringEngine.js's
// header; there is no shared-utils module anywhere in this project).

const {
  EVIDENCE_STRENGTHS,
  QUESTION_TYPES,
  GAP_TYPES,
  createEmptyInformationGapRecord,
  validateInformationGapShape,
} = require('./informationGapModel');

// Signal kinds that count as DIRECTLY OBSERVING someone ask this question. Anything not
// on this list is at best 'inferred' - a keyword is not a question, and treating one as
// though it were is exactly the overclaim this capability exists to prevent.
const OBSERVED_SIGNAL_KINDS = [
  'competitor_faq',
  'competitor_heading',
  'competitor_qa',
  'people_also_ask',
  'related_search',
  'search_suggestion',
  'product_review_question',
  'community_forum',
  'first_party_site_search',
  'first_party_customer_question',
];

// Signal kinds that support a question INDIRECTLY - real, referenced evidence that this
// topic matters, but not an observation of the question itself.
const INFERRED_SIGNAL_KINDS = ['keyword_research', 'research_output', 'related_topic'];

// How well a competitor answers a question, weakest first. The engine maps the BEST
// available answer to a gap type: the opportunity is only real where the best answer a
// customer can already find is still inadequate. Taking the worst instead would report a
// gap whenever ANY competitor answers poorly, even when another already answers it
// completely - a false positive that would send content teams to write what already
// exists.
const ANSWER_QUALITIES = ['missing', 'weak', 'incomplete', 'unclear', 'outdated', 'complete'];

const ANSWER_QUALITY_TO_GAP_TYPE = {
  missing: 'missing_question',
  weak: 'weak_answer',
  incomplete: 'incomplete_answer',
  unclear: 'unclear_answer',
  outdated: 'outdated_answer',
};

// A question type can imply a more specific gap than the answer quality alone when
// nobody covers it at all - "nobody answers our comparison question" is more useful to
// a content team than a bare 'missing_question'.
const QUESTION_TYPE_TO_MISSING_GAP_TYPE = {
  comparison: 'missing_comparison',
  use_case: 'missing_use_case',
  troubleshooting: 'missing_troubleshooting',
  buying: 'missing_buying_information',
  product_specific: 'poor_product_context',
};

const QUESTION_TYPE_TO_CONTENT_TYPE = {
  informational: 'informational article',
  comparison: 'comparison page',
  buying: 'buying guide',
  use_case: 'use-case guide',
  troubleshooting: 'troubleshooting guide',
  product_specific: 'product page section',
  unclassified: 'FAQ entry',
};

// The minimum number of competitors that must actually have been checked before this
// engine will claim a competitor-coverage gap. The task requirement is explicit: a
// question is NOT a gap merely because one competitor does not mention it. Below this,
// the record is 'review' with a reason naming the shortfall - never a silent assertion.
const MIN_COMPETITORS_FOR_GAP_CLAIM = 2;

// Two normalized questions cluster together when their meaningful-token sets overlap at
// or above this Jaccard threshold. A fixed constant, so clustering is reproducible.
const CLUSTER_SIMILARITY_THRESHOLD = 0.6;

// Filler words removed before comparison so "how do I clean this jacket" and "how to
// clean the jacket" cluster. Deliberately small and fixed - an aggressive stop-word list
// would collapse genuinely different questions together.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'i', 'you', 'my',
  'your', 'to', 'of', 'for', 'in', 'on', 'at', 'it', 'this', 'that', 'these', 'those',
  'and', 'or', 'be', 'can', 'should', 'would', 'will', 'with', 'about',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Step 1 - normalization. Pure, deterministic string work.
// ---------------------------------------------------------------------------------

function normalizeQuestion(question) {
  return String(question)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(normalized) {
  return new Set(normalized.split(' ').filter((token) => token && !STOP_WORDS.has(token)));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------------
// Step 2 - evidence classification. Runs BEFORE clustering, because a cluster's
// canonical question is chosen by evidence strength.
// ---------------------------------------------------------------------------------

// One evidence source entry, kept structurally so a human can see where each claim came
// from. `reference` is the caller's own citation; without one, a signal cannot be
// 'observed' no matter what kind it claims to be.
function buildEvidenceSource(signal) {
  return {
    signal_kind: isNonEmptyString(signal.signalKind) ? signal.signalKind.trim() : 'unspecified',
    reference: isNonEmptyString(signal.reference) ? signal.reference.trim() : '',
    observed_at: isNonEmptyString(signal.observedAt) ? signal.observedAt.trim() : '',
  };
}

// The provenance decision, made from the evidence alone. An 'observed' claim REQUIRES
// both an observed-kind signal and a real reference - an unreferenced assertion that
// something was observed is not evidence, so it degrades rather than being taken at
// face value.
function classifyEvidenceStrength(evidenceSources) {
  const hasObserved = evidenceSources.some(
    (entry) => OBSERVED_SIGNAL_KINDS.includes(entry.signal_kind) && entry.reference !== ''
  );
  if (hasObserved) return 'observed';

  const hasInferred = evidenceSources.some(
    (entry) =>
      (INFERRED_SIGNAL_KINDS.includes(entry.signal_kind) ||
        OBSERVED_SIGNAL_KINDS.includes(entry.signal_kind)) &&
      entry.reference !== ''
  );
  if (hasInferred) return 'inferred';

  return 'model_generated';
}

function buildQuestionEntry(signal, index) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new Error('findInformationGaps requires each `questions` entry to be an object.');
  }
  if (!isNonEmptyString(signal.question)) {
    throw new Error('findInformationGaps requires each `questions` entry to have a non-empty `question` string.');
  }

  const evidenceSources = normalizeArray(signal.evidenceSources).map(buildEvidenceSource);
  const normalized = normalizeQuestion(signal.question);
  const questionType = QUESTION_TYPES.includes(signal.questionType) ? signal.questionType : 'unclassified';

  return {
    index,
    question: signal.question.trim(),
    normalized,
    tokens: meaningfulTokens(normalized),
    questionType,
    evidenceSources,
    evidenceStrength: classifyEvidenceStrength(evidenceSources),
    competitors: normalizeArray(signal.competitorObservations),
    siteCoverage: signal.currentSiteCoverage || null,
    businessRelevance: signal.businessRelevance,
    customerUsefulness: signal.customerUsefulness,
    differentiationPotential: signal.differentiationPotential,
    demandSignal: signal.demandSignal || null,
    targetPage: isNonEmptyString(signal.recommendedTargetPage) ? signal.recommendedTargetPage.trim() : '',
    internalLinks: normalizeArray(signal.recommendedInternalLinks),
    productContext: isNonEmptyString(signal.productContext) ? signal.productContext.trim() : '',
    complianceAmbiguity: signal.complianceAmbiguity === true,
  };
}

// ---------------------------------------------------------------------------------
// Step 3 - duplicate / semantic clustering.
// ---------------------------------------------------------------------------------

// Greedy single-pass clustering in input order, so the same input always produces the
// same clusters. Exact normalized matches always cluster; near-matches cluster on
// meaningful-token Jaccard overlap.
function clusterQuestions(entries) {
  const clusters = [];

  for (const entry of entries) {
    const match = clusters.find((cluster) => {
      const head = cluster.members[0];
      if (head.normalized === entry.normalized) return true;
      return jaccardSimilarity(head.tokens, entry.tokens) >= CLUSTER_SIMILARITY_THRESHOLD;
    });
    if (match) match.members.push(entry);
    else clusters.push({ members: [entry] });
  }

  return clusters;
}

// The cluster's representative: strongest evidence wins, ties broken by earliest input
// index. Deterministic, and it means a cluster is never represented by its weakest
// member - if any phrasing of a question was genuinely observed, the cluster is
// observed.
function selectCanonical(members) {
  return members.reduce((best, candidate) => {
    const bestRank = EVIDENCE_STRENGTHS.indexOf(best.evidenceStrength);
    const candidateRank = EVIDENCE_STRENGTHS.indexOf(candidate.evidenceStrength);
    if (candidateRank < bestRank) return candidate;
    if (candidateRank > bestRank) return best;
    return candidate.index < best.index ? candidate : best;
  }, members[0]);
}

// Merging a cluster pools every member's real evidence and competitor observations -
// nothing a caller supplied is discarded just because its phrasing lost the canonical
// vote. Deduplicated by reference so pooling never inflates the evidence count.
function mergeCluster(members) {
  const canonical = selectCanonical(members);
  const seenEvidence = new Set();
  const evidenceSources = [];
  for (const member of members) {
    for (const entry of member.evidenceSources) {
      const key = `${entry.signal_kind}|${entry.reference}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidenceSources.push(entry);
    }
  }

  const seenCompetitors = new Set();
  const competitors = [];
  for (const member of members) {
    for (const observation of member.competitors) {
      const name = observation && isNonEmptyString(observation.competitor) ? observation.competitor.trim() : null;
      if (!name || seenCompetitors.has(name)) continue;
      seenCompetitors.add(name);
      competitors.push(observation);
    }
  }

  return {
    ...canonical,
    evidenceSources,
    // Recomputed over the POOLED evidence, so a cluster is classified on everything
    // known about it rather than on one member's slice.
    evidenceStrength: classifyEvidenceStrength(evidenceSources),
    competitors,
    variants: members
      .filter((member) => member.index !== canonical.index)
      .map((member) => member.question),
    // Any member flagging compliance ambiguity flags the whole cluster - ambiguity is
    // never averaged away.
    complianceAmbiguity: members.some((member) => member.complianceAmbiguity),
    siteCoverage: canonical.siteCoverage || members.find((member) => member.siteCoverage)?.siteCoverage || null,
  };
}

// ---------------------------------------------------------------------------------
// Step 4 - competitor coverage analysis. Counts and an enum only; no competitor text.
// ---------------------------------------------------------------------------------

function analyzeCompetitorCoverage(observations) {
  let checked = 0;
  let answering = 0;
  let bestIndex = null;

  for (const observation of observations) {
    if (!observation || typeof observation !== 'object' || !isNonEmptyString(observation.competitor)) continue;
    checked += 1;

    // A competitor who does not cover the question contributes nothing to the best
    // available answer - only those who actually answer can raise the bar a customer
    // can already clear elsewhere.
    if (observation.covered !== true) continue;
    answering += 1;

    // Covered but with no stated quality is treated as 'weak', not 'complete': an
    // unassessed answer is not evidence that a good answer exists.
    const quality = ANSWER_QUALITIES.includes(observation.answerQuality) ? observation.answerQuality : 'weak';
    const rank = ANSWER_QUALITIES.indexOf(quality);
    if (bestIndex === null || rank > bestIndex) bestIndex = rank;
  }

  return {
    competitors_checked: checked,
    competitors_answering: answering,
    best_answer_quality: bestIndex === null ? null : ANSWER_QUALITIES[bestIndex],
  };
}

function analyzeSiteCoverage(siteCoverage) {
  if (!siteCoverage || typeof siteCoverage !== 'object' || Array.isArray(siteCoverage)) {
    return { covered: false, coverage_quality: null, pages: [] };
  }
  const quality = ANSWER_QUALITIES.includes(siteCoverage.coverageQuality) ? siteCoverage.coverageQuality : null;
  return {
    covered: siteCoverage.covered === true,
    coverage_quality: quality,
    pages: normalizeArray(siteCoverage.pages).filter(isNonEmptyString),
  };
}

// ---------------------------------------------------------------------------------
// Step 5 - gap detection.
// ---------------------------------------------------------------------------------

// Returns { gapType, identifiedGap, insufficientEvidenceReason }. Never asserts a gap
// the supplied evidence cannot support: too few competitors checked yields a null gap
// AND a reason, which deriveStatus() turns into 'review'.
function detectGap(cluster, coverage, siteCoverage) {
  // Our own site already answering it well is not a gap, no matter what competitors do.
  // This is what prevents the most damaging false positive: recommending we write
  // content we already have.
  if (siteCoverage.covered && (siteCoverage.coverage_quality === 'complete' || siteCoverage.coverage_quality === null)) {
    return {
      gapType: null,
      identifiedGap: '',
      insufficientEvidenceReason: null,
      alreadyCovered: true,
    };
  }

  if (coverage.competitors_checked < MIN_COMPETITORS_FOR_GAP_CLAIM) {
    return {
      gapType: null,
      identifiedGap: '',
      alreadyCovered: false,
      insufficientEvidenceReason: `Only ${coverage.competitors_checked} competitor(s) were checked; at least ${MIN_COMPETITORS_FOR_GAP_CLAIM} are required before a coverage gap can be claimed.`,
    };
  }

  const best = coverage.best_answer_quality;

  // Someone already answers it completely - a customer can find a good answer today, so
  // there is no information gap to fill, however many other competitors ignore it.
  if (best === 'complete') {
    return { gapType: null, identifiedGap: '', insufficientEvidenceReason: null, alreadyCovered: false };
  }

  // Nobody answers it at all -> prefer the question-type-specific gap, which tells a
  // content team more than a bare 'missing_question'.
  let gapType;
  if (coverage.competitors_answering === 0) {
    gapType = QUESTION_TYPE_TO_MISSING_GAP_TYPE[cluster.questionType] || 'missing_question';
  } else {
    gapType = ANSWER_QUALITY_TO_GAP_TYPE[best] || null;
  }
  if (!GAP_TYPES.includes(gapType)) gapType = null;

  const identifiedGap =
    gapType === null
      ? ''
      : coverage.competitors_answering === 0
        ? `None of the ${coverage.competitors_checked} checked competitor(s) answer this question. Missing: a complete, product-specific answer to "${cluster.question}".`
        : `${coverage.competitors_answering}/${coverage.competitors_checked} checked competitor(s) answer this question, and the best available answer is '${best}'. Missing: a complete, product-specific answer to "${cluster.question}".`;

  return { gapType, identifiedGap, insufficientEvidenceReason: null, alreadyCovered: false };
}

// ---------------------------------------------------------------------------------
// Step 6 - deterministic, explainable scoring.
// ---------------------------------------------------------------------------------

// Seven components, each scored 0/1/2 and weighted EQUALLY (max 14, normalized to
// 0-100). Equal weighting is deliberate and follows
// agent/core/productOpportunityScoringEngine.js's documented stance: no justified
// weighting scheme exists for these dimensions, so none is invented. Every component
// pushes a reason naming the evidence it used - or explicitly naming what was missing -
// so the number is always explainable.
const MAX_COMPONENT_POINTS = 2;
const SCORING_COMPONENT_COUNT = 7;

function levelPoints(value) {
  if (value === 'high') return 2;
  if (value === 'medium') return 1;
  return 0;
}

function scoreOpportunity(cluster, coverage, siteCoverage, gap) {
  const reasons = [];
  let points = 0;

  // 1. Evidence strength - the provenance of the question itself.
  const evidencePoints = cluster.evidenceStrength === 'observed' ? 2 : cluster.evidenceStrength === 'inferred' ? 1 : 0;
  points += evidencePoints;
  reasons.push(
    `Evidence strength '${cluster.evidenceStrength}' from ${cluster.evidenceSources.length} source(s): +${evidencePoints}/2.`
  );

  // 2. Business relevance - caller-asserted only.
  const relevancePoints = levelPoints(cluster.businessRelevance);
  points += relevancePoints;
  reasons.push(
    cluster.businessRelevance
      ? `Business relevance asserted '${cluster.businessRelevance}': +${relevancePoints}/2.`
      : 'No business relevance was asserted by the caller: +0/2.'
  );

  // 3. Competitor coverage weakness - the size of the opening.
  let competitorPoints = 0;
  if (coverage.competitors_checked >= MIN_COMPETITORS_FOR_GAP_CLAIM) {
    if (coverage.competitors_answering === 0) competitorPoints = 2;
    else if (coverage.best_answer_quality !== 'complete') competitorPoints = 1;
  }
  points += competitorPoints;
  reasons.push(
    coverage.competitors_checked >= MIN_COMPETITORS_FOR_GAP_CLAIM
      ? `${coverage.competitors_answering}/${coverage.competitors_checked} competitor(s) answer this; best available answer '${coverage.best_answer_quality === null ? 'none' : coverage.best_answer_quality}': +${competitorPoints}/2.`
      : `Only ${coverage.competitors_checked} competitor(s) checked - too few to credit a coverage weakness: +0/2.`
  );

  // 4. Customer usefulness - caller-asserted only.
  const usefulnessPoints = levelPoints(cluster.customerUsefulness);
  points += usefulnessPoints;
  reasons.push(
    cluster.customerUsefulness
      ? `Customer usefulness asserted '${cluster.customerUsefulness}': +${usefulnessPoints}/2.`
      : 'No customer usefulness was asserted by the caller: +0/2.'
  );

  // 5. Demand signal - the one component that could tempt a fabricated number. It reads
  // ONLY a caller-supplied signal, scores highest only when that signal carries its own
  // source, and never parses, estimates, or emits a search volume.
  let demandPoints = 0;
  let demandReason = 'No market/search demand signal was supplied - demand was NOT estimated or inferred: +0/2.';
  if (cluster.demandSignal && isNonEmptyString(cluster.demandSignal.signal)) {
    const hasSource = isNonEmptyString(cluster.demandSignal.source);
    demandPoints = hasSource ? 2 : 1;
    demandReason = hasSource
      ? `Caller-supplied demand signal with a source reference: +${demandPoints}/2.`
      : `Caller-supplied demand signal without a source reference: +${demandPoints}/2.`;
  }
  points += demandPoints;
  reasons.push(demandReason);

  // 6. Content differentiation potential - caller-asserted only.
  const differentiationPoints = levelPoints(cluster.differentiationPotential);
  points += differentiationPoints;
  reasons.push(
    cluster.differentiationPotential
      ? `Content differentiation potential asserted '${cluster.differentiationPotential}': +${differentiationPoints}/2.`
      : 'No content differentiation potential was asserted by the caller: +0/2.'
  );

  // 7. Current-site coverage gap - how much of this we are missing ourselves.
  let sitePoints = 0;
  if (!siteCoverage.covered) sitePoints = 2;
  else if (siteCoverage.coverage_quality !== null && siteCoverage.coverage_quality !== 'complete') sitePoints = 1;
  points += sitePoints;
  reasons.push(
    siteCoverage.covered
      ? `Our site already covers this ('${siteCoverage.coverage_quality || 'unspecified quality'}'): +${sitePoints}/2.`
      : `Our site does not currently answer this question: +${sitePoints}/2.`
  );

  const score = Math.round((points / (MAX_COMPONENT_POINTS * SCORING_COMPONENT_COUNT)) * 100);
  reasons.push(`Total: ${points}/${MAX_COMPONENT_POINTS * SCORING_COMPONENT_COUNT} across ${SCORING_COMPONENT_COUNT} equally-weighted components = ${score}/100.`);
  if (gap.insufficientEvidenceReason) reasons.push(gap.insufficientEvidenceReason);

  return { score, reasons };
}

// ---------------------------------------------------------------------------------
// Step 7 - status and content-readiness.
// ---------------------------------------------------------------------------------

// The structural guarantee. A model-generated question can NEVER be an 'opportunity',
// regardless of how strong every other signal is - which is what stops an AI-invented
// question from ever being presented as a verified real market question.
function deriveStatus(cluster, gap) {
  if (cluster.evidenceStrength === 'model_generated') return 'review';
  if (cluster.complianceAmbiguity) return 'review';
  if (gap.alreadyCovered) return 'no_gap';
  if (gap.insufficientEvidenceReason) return 'review';
  if (gap.gapType === null) return 'no_gap';
  return 'opportunity';
}

// Built ONLY from the question, the gap type, and caller-supplied product context.
// Competitor observations are deliberately not in scope here - not their notes, not
// their titles, not their phrasing. Competitor research informs WHICH gap to fill, never
// WHAT WORDS to fill it with.
function buildContentSuggestions(cluster, gapType) {
  const contentType = QUESTION_TYPE_TO_CONTENT_TYPE[cluster.questionType] || 'FAQ entry';
  const suggestedTitle = cluster.productContext
    ? `${cluster.question} (${cluster.productContext})`
    : cluster.question;

  const outline = [`Answer the question directly: ${cluster.question}`];
  if (cluster.productContext) outline.push(`Explain how this applies to ${cluster.productContext}.`);
  if (gapType === 'missing_comparison') outline.push('Set out the comparison criteria that matter to the customer.');
  if (gapType === 'missing_use_case') outline.push('Describe the specific use cases this applies to.');
  if (gapType === 'missing_troubleshooting') outline.push('Give step-by-step troubleshooting for the described problem.');
  if (gapType === 'missing_buying_information') outline.push('Cover the buying information a customer needs to decide.');
  if (gapType === 'poor_product_context') outline.push('Tie the answer to concrete, verified product details.');
  if (gapType === 'outdated_answer') outline.push('State what changed and when, so the answer is current.');
  if (gapType === 'incomplete_answer' || gapType === 'weak_answer') outline.push('Cover the parts existing answers leave out.');
  if (gapType === 'unclear_answer') outline.push('Answer plainly and unambiguously, without jargon.');
  outline.push('Link to the related pages listed in recommended_internal_links.');

  return { contentType, suggestedTitle, outline };
}

// ---------------------------------------------------------------------------------
// The single entry point.
// ---------------------------------------------------------------------------------

// `questions` is the caller's already-collected question signals. Returns
// { records, limitations } - records sorted by opportunity_score descending (ties by
// question text, so ordering is fully deterministic), and honest limitations about what
// this engine could not do.
function findInformationGaps(params = {}) {
  const { questions } = params;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('findInformationGaps requires a non-empty `questions` array.');
  }

  const entries = questions.map((signal, index) => buildQuestionEntry(signal, index));
  const clusters = clusterQuestions(entries).map((cluster) => mergeCluster(cluster.members));

  const records = clusters.map((cluster) => {
    const coverage = analyzeCompetitorCoverage(cluster.competitors);
    const siteCoverage = analyzeSiteCoverage(cluster.siteCoverage);
    const gap = detectGap(cluster, coverage, siteCoverage);
    const { score, reasons } = scoreOpportunity(cluster, coverage, siteCoverage, gap);
    const status = deriveStatus(cluster, gap);
    const suggestions = buildContentSuggestions(cluster, gap.gapType);

    const record = createEmptyInformationGapRecord(cluster.question);
    record.normalized_question = cluster.normalized;
    record.question_type = cluster.questionType;
    record.clustered_variants = cluster.variants;
    record.evidence_sources = cluster.evidenceSources;
    record.evidence_strength = cluster.evidenceStrength;
    record.competitor_coverage = coverage;
    record.current_site_coverage = siteCoverage;
    record.identified_gap = gap.identifiedGap;
    record.gap_type = gap.gapType;
    record.opportunity_score = score;
    record.score_reasons = reasons;
    record.recommended_content_type = suggestions.contentType;
    record.recommended_target_page = cluster.targetPage;
    record.suggested_title = suggestions.suggestedTitle;
    record.suggested_outline = suggestions.outline;
    record.recommended_internal_links = cluster.internalLinks;
    record.status = status;
    record.research_date = params.researchDate || todayIsoDate();

    const validation = validateInformationGapShape(record);
    if (!validation.valid) {
      throw new Error(`findInformationGaps produced an invalid information gap record: ${validation.errors.join('; ')}`);
    }
    return record;
  });

  records.sort((a, b) => {
    if (b.opportunity_score !== a.opportunity_score) return b.opportunity_score - a.opportunity_score;
    return a.question.localeCompare(b.question);
  });

  const limitations = [
    'No live question-discovery source (search suggestions, People Also Ask, related searches, forums) is configured; this result reflects only caller-supplied, already-collected signals.',
    'No search volume or demand figure is produced, estimated, or inferred anywhere in this result - only caller-supplied demand signals are used, and only where supplied.',
    'Competitor observations were used to classify coverage gaps only; no competitor wording is reproduced in any suggested title, outline, or gap statement.',
    'Every suggestion here is a content opportunity for a human to consider - nothing is written, applied, or published, and no ownership, copyright, trademark, or platform-policy status is asserted (no shared Compliance capability is available in this project to check it).',
  ];

  for (const record of records) {
    if (record.evidence_sources.length === 0) {
      limitations.push(`No evidence was supplied for ${record.question}`);
    }
    if (record.evidence_strength === 'model_generated') {
      limitations.push(
        `"${record.question}" has no supporting observation and is marked model_generated - it is NOT a verified real market question and is held at status 'review'.`
      );
    }
  }

  return { records, limitations };
}

module.exports = {
  OBSERVED_SIGNAL_KINDS,
  INFERRED_SIGNAL_KINDS,
  ANSWER_QUALITIES,
  MIN_COMPETITORS_FOR_GAP_CLAIM,
  CLUSTER_SIMILARITY_THRESHOLD,
  normalizeQuestion,
  classifyEvidenceStrength,
  findInformationGaps,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Information Gap Finder engine (deterministic, no invented demand):\n');

  const { records, limitations } = findInformationGaps({
    questions: [
      {
        question: 'How do I wash an insulated jacket without ruining it?',
        questionType: 'troubleshooting',
        evidenceSources: [
          { signalKind: 'product_review_question', reference: '(placeholder review thread reference)' },
          { signalKind: 'people_also_ask', reference: '(placeholder captured PAA reference)' },
        ],
        competitorObservations: [
          { competitor: '(Example Co. A)', covered: false },
          { competitor: '(Example Co. B)', covered: true, answerQuality: 'weak', notes: '(placeholder competitor note)' },
        ],
        currentSiteCoverage: { covered: false },
        businessRelevance: 'high',
        customerUsefulness: 'high',
        differentiationPotential: 'medium',
        productContext: '(Example insulated jacket)',
      },
      // A near-duplicate phrasing - clusters into the one above rather than double-counting.
      { question: 'how to wash the insulated jacket without ruining it' },
      // No supporting observation at all - can never be an 'opportunity'.
      {
        question: 'What is the best jacket for hiking in space?',
        questionType: 'buying',
      },
    ],
  });

  for (const record of records) {
    console.log(`--- [${record.status}] ${record.opportunity_score}/100 - ${record.question}`);
    console.log(`    evidence_strength: ${record.evidence_strength} | gap_type: ${record.gap_type}`);
    console.log(`    clustered_variants: ${record.clustered_variants.length}`);
  }
  console.log('\nLimitations:');
  for (const limitation of limitations) console.log(`  - ${limitation}`);
  console.log('\nNo question, competitor, or signal above is real - every value is a caller-supplied placeholder for demonstration.');
}
