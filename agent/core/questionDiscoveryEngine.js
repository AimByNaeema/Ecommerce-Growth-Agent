'use strict';

// The deterministic half of Real Question Discovery: takes raw question claims plus the
// set of URLs a search actually returned, and turns them into evidence-backed
// agent/core/questionEvidenceModel.js records that the existing Information Gap Finder
// can consume unchanged.
//
// PURE AND OFFLINE. Nothing here makes a network, model, or filesystem call - the
// external call lives in tools/marketQuestionDiscoveryTool.js, which hands its results
// to this module. That split is why every rule below is testable without mocking
// anything, and why normalization/dedup/provenance/validation cost no tokens at all.
//
// THE CENTRAL RULE: PROVENANCE IS VERIFIED, NEVER ACCEPTED. A model asked to find real
// questions can still report a question it invented and attach a plausible-looking URL.
// So a claimed source is only believed when that exact URL is present in the set of URLs
// the search tool ITSELF returned (agent/core/claudeClient.js's
// extractWebSearchResultUrls - a real fact about what was searched, not the model's
// self-report). This is the same verification discipline
// tools/webCompetitorResearchTool.js already applies to competitors, reused here for
// questions. A claim whose URL cannot be verified is NOT dropped silently and NOT
// upgraded - it is kept, marked 'model_generated', stripped of its unverifiable URL, and
// carries a limitation saying exactly that.
//
// A model may normalize, classify, deduplicate, or summarize an observed question. It
// may never manufacture provenance, and nothing it asserts about provenance is taken at
// face value here.
//
// NORMALIZATION IS REUSED, NOT REIMPLEMENTED: normalizeQuestion comes from
// agent/core/informationGapEngine.js, the module that already owns this project's
// question-normalization rules. A second implementation would drift, and two different
// normalizations of the same question is precisely how duplicate evidence would stop
// merging.
//
// DEDUPLICATION PRESERVES PROVENANCE. Merging is by exact normalized-question match
// only - deliberately conservative. The Information Gap Finder already does fuzzy,
// token-overlap semantic clustering downstream; doing it a second time here, on the raw
// discovery output, would risk collapsing genuinely different customer intents before a
// human or the Gap Finder ever sees them. Merging unions the observations rather than
// keeping one and discarding the rest, so a question found in a competitor FAQ, a public
// Q&A page and a forum thread ends up as ONE question carrying ALL THREE sources.
//
// NO FABRICATED DEMAND. There is no search-volume, traffic, CTR, or ranking value read,
// produced, or estimated anywhere in this file. Every record states demand_measured:
// false explicitly and says so in its limitations.

const { normalizeQuestion } = require('./informationGapEngine');
const {
  EVIDENCE_KINDS,
  SUPPORTED_EVIDENCE_KINDS,
  UNSUPPORTED_EVIDENCE_KINDS,
  createObservation,
  createEmptyQuestionEvidenceRecord,
  validateQuestionEvidenceShape,
} = require('./questionEvidenceModel');

// Kinds that count as directly observing somebody ask the question, when and only when
// their source URL verifies. 'existing_research' is deliberately absent: research this
// project already collected supports a question indirectly, so it yields 'inferred'.
const OBSERVED_DISCOVERY_KINDS = [
  'public_qa',
  'public_forum_question',
  'competitor_question',
  'other_observed',
];

// How a discovery evidence_kind maps onto the vocabulary
// agent/core/informationGapEngine.js already accepts, so discovery output flows into the
// Gap Finder with no translation guesswork and no change to its classification logic.
const GAP_FINDER_SIGNAL_KIND = {
  public_qa: 'public_qa',
  public_forum_question: 'public_forum_question',
  competitor_question: 'competitor_question',
  other_observed: 'other_observed',
  existing_research: 'research_output',
};

// A hard ceiling on returned records, independent of whatever a caller asks for. Keeps
// one discovery call bounded no matter what - this is an evidence acquisition
// capability, not a crawler.
const MAX_RESULT_LIMIT = 50;
const DEFAULT_RESULT_LIMIT = 25;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Bounded and clamped, never trusted raw from a caller.
function resolveLimit(requestedLimit) {
  const parsed = Number(requestedLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_RESULT_LIMIT);
}

// The verification step. Returns the claimed URL only when the search tool itself
// actually returned it - otherwise null, which downgrades the claim below.
function verifyUrl(claimedUrl, verifiedUrls) {
  if (!isNonEmptyString(claimedUrl)) return null;
  const trimmed = claimedUrl.trim();
  return verifiedUrls.has(trimmed) ? trimmed : null;
}

// Turns one raw claim into a record. `verifiedUrls` is the Set of URLs the search
// actually returned; for non-web sources (existing research already held by this
// project) pass the claim's own reference through `trustedReference` instead.
function buildRecordFromClaim(claim, verifiedUrls, collectedAt) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
  if (!isNonEmptyString(claim.question)) return null;

  const question = claim.question.trim();
  const record = createEmptyQuestionEvidenceRecord(question);
  record.normalized_question = normalizeQuestion(question);

  const evidenceKind = EVIDENCE_KINDS.includes(claim.evidenceKind) ? claim.evidenceKind : 'other_observed';
  const limitations = [];

  // An unsupported kind can never be produced honestly by this project today, so a claim
  // asserting one is not taken at its word - it degrades to other_observed and says so.
  let effectiveKind = evidenceKind;
  if (UNSUPPORTED_EVIDENCE_KINDS.includes(evidenceKind)) {
    effectiveKind = 'other_observed';
    limitations.push(
      `Claimed evidence kind '${evidenceKind}' is not a source this project can access (no autocomplete/SERP client exists); recorded as 'other_observed' instead.`
    );
  }

  if (effectiveKind === 'existing_research') {
    // Research this project already collected: its reference is its own, not a web URL
    // to verify against a search result.
    if (!isNonEmptyString(claim.sourceReference)) {
      record.evidence_strength = 'model_generated';
      limitations.push('No reference was supplied for this existing-research signal, so its provenance could not be established.');
    } else {
      record.evidence_strength = 'inferred';
      record.observations = [
        createObservation({
          evidenceKind: 'existing_research',
          sourceType: 'existing_research_output',
          sourceReference: claim.sourceReference.trim(),
          collectedAt,
          originalObservation: isNonEmptyString(claim.originalObservation) ? claim.originalObservation.trim() : '',
        }),
      ];
    }
  } else {
    const verifiedUrl = verifyUrl(claim.sourceUrl, verifiedUrls);
    if (verifiedUrl === null) {
      // The decisive case: the model claimed a source that the search never returned, or
      // no source at all. Kept, but never as evidence - and the unverifiable URL is not
      // retained, so a false citation cannot be mistaken for a real one later.
      record.evidence_strength = 'model_generated';
      limitations.push(
        isNonEmptyString(claim.sourceUrl)
          ? 'The claimed source URL was not among the results the search actually returned, so this question is unverified and is recorded as model-generated.'
          : 'No source URL was supplied for this question, so its provenance could not be established and it is recorded as model-generated.'
      );
    } else {
      record.evidence_strength = OBSERVED_DISCOVERY_KINDS.includes(effectiveKind) ? 'observed' : 'inferred';
      record.observations = [
        createObservation({
          evidenceKind: effectiveKind,
          sourceType: 'web_search_result',
          sourceReference: isNonEmptyString(claim.sourceReference) ? claim.sourceReference.trim() : verifiedUrl,
          sourceUrl: verifiedUrl,
          collectedAt,
          // A short attestation of WHERE the question was seen - never page content, and
          // never competitor wording.
          originalObservation: isNonEmptyString(claim.originalObservation)
            ? claim.originalObservation.trim().slice(0, 200)
            : '',
        }),
      ];
    }
  }

  record.observation_count = record.observations.length;
  record.source_types = [...new Set(record.observations.map((observation) => observation.source_type))];
  record.demand_measured = false;
  limitations.push('Demand was not measured - no search volume, traffic, or ranking figure is available from this source and none was estimated.');
  record.limitations = limitations;

  return record;
}

// Unions two records for the same normalized question. The FIRST record's original
// wording is kept as the canonical `question` (the earliest observation of it), every
// observation from both is preserved, and evidence_strength takes the strongest of the
// two - if any phrasing was genuinely observed at a verified source, the merged question
// is observed.
function mergeRecords(existing, incoming) {
  const seen = new Set(
    existing.observations.map((observation) => `${observation.evidence_kind}|${observation.source_url}|${observation.source_reference}`)
  );
  for (const observation of incoming.observations) {
    const key = `${observation.evidence_kind}|${observation.source_url}|${observation.source_reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.observations.push(observation);
  }

  const strengthRank = { observed: 0, inferred: 1, model_generated: 2 };
  if (strengthRank[incoming.evidence_strength] < strengthRank[existing.evidence_strength]) {
    existing.evidence_strength = incoming.evidence_strength;
  }

  existing.observation_count = existing.observations.length;
  existing.source_types = [...new Set(existing.observations.map((observation) => observation.source_type))];
  for (const limitation of incoming.limitations) {
    if (!existing.limitations.includes(limitation)) existing.limitations.push(limitation);
  }
  return existing;
}

// The entry point. `claims` are raw question claims (from a model, or from research this
// project already holds); `verifiedUrls` is the list of URLs the search tool actually
// returned. Returns { records, limitations, unsupported_sources }.
function buildQuestionEvidence({ claims, verifiedUrls = [], limit, collectedAt } = {}) {
  if (!Array.isArray(claims)) {
    throw new Error('buildQuestionEvidence requires a `claims` array.');
  }

  const verified = new Set(
    (Array.isArray(verifiedUrls) ? verifiedUrls : []).filter(isNonEmptyString).map((url) => url.trim())
  );
  const stamp = isNonEmptyString(collectedAt) ? collectedAt : new Date().toISOString();

  const byNormalized = new Map();
  for (const claim of claims) {
    const record = buildRecordFromClaim(claim, verified, stamp);
    if (record === null) continue;
    const key = record.normalized_question;
    if (byNormalized.has(key)) mergeRecords(byNormalized.get(key), record);
    else byNormalized.set(key, record);
  }

  // Observed first, then inferred, then model-generated; within a strength, more
  // corroborating observations first; ties broken by question text so ordering is fully
  // deterministic. Never by any demand or popularity proxy - there is none.
  const strengthRank = { observed: 0, inferred: 1, model_generated: 2 };
  const ordered = [...byNormalized.values()].sort((a, b) => {
    if (strengthRank[a.evidence_strength] !== strengthRank[b.evidence_strength]) {
      return strengthRank[a.evidence_strength] - strengthRank[b.evidence_strength];
    }
    if (b.observation_count !== a.observation_count) return b.observation_count - a.observation_count;
    return a.question.localeCompare(b.question);
  });

  const resolvedLimit = resolveLimit(limit);
  const records = ordered.slice(0, resolvedLimit);

  for (const record of records) {
    const validation = validateQuestionEvidenceShape(record);
    if (!validation.valid) {
      throw new Error(`buildQuestionEvidence produced an invalid question evidence record: ${validation.errors.join('; ')}`);
    }
  }

  const limitations = [
    'Only publicly accessible page-level question evidence reached through the project\'s existing web_search capability is collected; nothing is scraped, and no authentication, rate limit, robots restriction, or CAPTCHA is bypassed.',
    'No search volume, monthly searches, traffic, click-through rate, or ranking position is collected or estimated anywhere in this result.',
    'Every question\'s provenance was verified against the URLs the search actually returned; any question whose source could not be verified is recorded as model-generated, never as a real market question.',
  ];
  if (ordered.length > records.length) {
    limitations.push(`${ordered.length - records.length} further question(s) were discovered but omitted by the requested result limit of ${resolvedLimit}.`);
  }

  return {
    records,
    limitations,
    // Named explicitly so an unsupported source is visibly unsupported rather than
    // quietly missing from the output.
    unsupported_sources: UNSUPPORTED_EVIDENCE_KINDS.map((kind) => ({
      evidence_kind: kind,
      reason: 'This is a SERP feature rather than a page, and this project has no autocomplete/SERP API client; web_search returns pages, so there is no honest way to attest a question came from it.',
    })),
  };
}

// The adapter into the EXISTING Information Gap Finder. Produces exactly the
// `questions[]` entries agent/core/informationGapEngine.js's findInformationGaps()
// already accepts - its input contract is not changed, and none of its
// clustering/gap/scoring logic is touched or duplicated here.
//
// A model_generated record is passed through WITH NO evidenceSources, so the Gap Finder
// independently classifies it model_generated by its own rules and holds it at 'review'.
// Discovery never hands the Gap Finder a question labelled as evidenced that it could
// not itself verify.
function toGapFinderQuestions(records) {
  if (!Array.isArray(records)) {
    throw new Error('toGapFinderQuestions requires a `records` array.');
  }
  return records.map((record) => ({
    question: record.question,
    evidenceSources:
      record.evidence_strength === 'model_generated'
        ? []
        : record.observations.map((observation) => ({
            signalKind: GAP_FINDER_SIGNAL_KIND[observation.evidence_kind] || 'other_observed',
            reference: observation.source_url || observation.source_reference,
            observedAt: observation.collected_at,
          })),
  }));
}

module.exports = {
  OBSERVED_DISCOVERY_KINDS,
  GAP_FINDER_SIGNAL_KIND,
  SUPPORTED_EVIDENCE_KINDS,
  UNSUPPORTED_EVIDENCE_KINDS,
  MAX_RESULT_LIMIT,
  DEFAULT_RESULT_LIMIT,
  resolveLimit,
  buildQuestionEvidence,
  toGapFinderQuestions,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - question discovery engine (deterministic, provenance-verified):\n');

  const { records, limitations, unsupported_sources: unsupported } = buildQuestionEvidence({
    verifiedUrls: ['https://example.com/faq', 'https://forum.example.com/thread/1'],
    collectedAt: '2026-09-05T00:00:00.000Z',
    claims: [
      { question: 'How long does an insulated jacket last?', evidenceKind: 'competitor_question', sourceUrl: 'https://example.com/faq', originalObservation: 'listed in the FAQ section' },
      // Same question, different source - merges, keeping BOTH observations.
      { question: 'how long does an insulated jacket last', evidenceKind: 'public_forum_question', sourceUrl: 'https://forum.example.com/thread/1' },
      // A URL the search never returned - cannot become evidence.
      { question: 'Is this jacket machine washable?', evidenceKind: 'public_qa', sourceUrl: 'https://not-returned.example.com/made-up' },
    ],
  });

  for (const record of records) {
    console.log(`--- [${record.evidence_strength}] ${record.question}`);
    console.log(`    observations: ${record.observation_count} (${record.source_types.join(', ') || 'none'})`);
    for (const observation of record.observations) {
      console.log(`      - ${observation.evidence_kind} @ ${observation.source_url}`);
    }
  }
  console.log('\nGap Finder input:');
  console.log(JSON.stringify(toGapFinderQuestions(records), null, 1));
  console.log('\nUnsupported sources:');
  for (const entry of unsupported) console.log(`  - ${entry.evidence_kind}`);
  console.log('\nLimitations:');
  for (const limitation of limitations) console.log(`  - ${limitation}`);
  console.log('\nNo question, URL, or source above is real - every value is a placeholder for demonstration.');
}
