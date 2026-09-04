'use strict';

// The SEO Agent (CLAUDE.md section 2, specialist #3: "Search visibility analysis and
// keyword research"). Supports 8 capabilities: keyword research, search intent
// analysis, product SEO, collection SEO, content SEO, on-page SEO, SEO opportunity
// analysis, and information gap analysis (real-question gap detection).
//
// Deterministic only - no AI API call, no external fetch, no live keyword-research API
// (none is configured or called anywhere in this project). Callers supply
// already-structured evidence; this module's job is to validate it, compose it into
// the existing SEO schemas (agent/core/seoResearchModel.js,
// agent/core/listingOptimizationModel.js, agent/core/onPageOptimizationModel.js -
// reused as-is, never duplicated), and grade it honestly - never to synthesize or
// guess a keyword, a finding, or an assessment. Same philosophy and structure as
// agent/core/researchAgent.js and agent/core/productAgent.js: retrieval (build +
// validate records), analysis (flatten findings/evidence/source, derive honest
// limitations), and recommendation (relay only what the caller supplied) stay
// distinct, composed by one thin composeResult().
//
// Capability -> schema mapping (see agent/core/onPageOptimizationModel.js's own header
// for why collection/content needed a new schema while product SEO did not):
//   - keyword research, search intent analysis, SEO opportunity analysis all compose
//     agent/core/seoResearchModel.js records (one per keyword) - search intent analysis
//     groups them by their existing search_intent field rather than inventing a new
//     shape; SEO opportunity analysis summarizes their existing opportunity/competition
//     fields as a structural evidence-coverage count, never a score or verdict (that
//     8-dimension scoring pattern is deliberately Product's territory - see
//     agent/core/opportunityAnalysisModel.js and agent/core/productAgent.js).
//   - product SEO composes agent/core/listingOptimizationModel.js records (already
//     product-shaped): structured recommendations for title, meta description,
//     headings, description, keyword usage, internal links, and supporting content.
//     Every field is a suggestion built only from caller-supplied input - no factual
//     product claim (price, material, dimensions, etc.) is ever generated or altered,
//     and nothing here applies a change to a real listing (see approvals/).
//   - collection SEO and content SEO compose agent/core/onPageOptimizationModel.js
//     records (subject_type: 'collection' | 'content'). Deliberately a narrower field
//     set than product SEO's listingOptimizationModel.js today (no headings/
//     internal_links/keyword_usage/supporting_content there yet) - "ecommerce product
//     SEO optimization" was product-scoped, so collection/content SEO were left as
//     they were rather than widened beyond what was asked.
//   - on-page SEO is not a fourth record type - it dispatches to product/collection/
//     content SEO by subjectType and returns that same result, tagged capability:
//     'on_page_seo'. Composition, not duplication.
//
// Confidence: caller-asserted only, defaulting to 'unassessed' - same convention as
// every other module in this project. A 'verified' claim asserted without evidence is
// downgraded back to 'unverified' (same honesty guard as researchAgent.js's).
//
// Reuses agent/core/researchAgent.js directly rather than reimplementing: retrieveSeoData
// delegates generic-kind entries to its retrieveResearchData, product/collection/content
// SEO's optional evidence composes via the same, and recommendations pass through its
// deriveRecommendations - the same cross-agent reuse pattern agent/core/productAgent.js
// already established.

const { createEmptySeoResearchRecord, validateSeoResearchShape } = require('./seoResearchModel');
const {
  createEmptyListingOptimizationRecord,
  validateListingOptimizationShape,
} = require('./listingOptimizationModel');
const {
  createEmptyOnPageOptimizationRecord,
  validateOnPageOptimizationShape,
} = require('./onPageOptimizationModel');
const {
  SEO_CAPABILITIES,
  createEmptySeoAgentResult,
  validateSeoAgentResultShape,
} = require('./seoAgentResultModel');
const { retrieveResearchData, deriveRecommendations } = require('./researchAgent');
// Real-question gap detection (see analyzeInformationGaps below). All of its
// normalization/clustering/coverage/gap/scoring logic lives in that engine; this file
// only composes its records into the shared seoAgentResultModel.js envelope, exactly as
// every other capability here composes its own schema's records.
const { findInformationGaps } = require('./informationGapEngine');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireNonEmptyArray(value, fieldName, fnName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` array.`);
  }
}

function requireObjectEntry(entry, fieldName, fnName) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${fnName} requires each \`${fieldName}\` entry to be an object.`);
  }
}

// Never guesses content - only normalizes a missing/singular value into the array
// shape every model already expects.
function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Retrieval - builds and validates specialized records from raw caller-supplied
// entries. This IS "data retrieval" in this deterministic-only architecture (see
// module header) - no live keyword-research API is configured. Never invents an entry
// that wasn't supplied.
// ---------------------------------------------------------------------------------

function buildKeywordRecord(entry, fnName) {
  requireNonEmptyString(entry.keyword, 'keyword', fnName);
  const record = createEmptySeoResearchRecord(entry.keyword);
  record.search_intent = entry.searchIntent || '';
  record.market = entry.market || '';
  record.language = entry.language || '';
  record.relevance = entry.relevance || 'unassessed';
  record.competition = entry.competition || '';
  record.opportunity = entry.opportunity || '';
  record.source = normalizeArray(entry.source);
  record.research_date = entry.researchDate || todayIsoDate();
  record.confidence = entry.confidence || 'unassessed';

  const validation = validateSeoResearchShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid SEO research record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildMetadata(entryMetadata) {
  if (!entryMetadata) return undefined;
  return {
    meta_title: entryMetadata.metaTitle || '',
    meta_description: entryMetadata.metaDescription || '',
    url_slug: entryMetadata.urlSlug || '',
    alt_text: entryMetadata.altText || '',
  };
}

function buildProductSeoRecord(entry, fnName) {
  requireNonEmptyString(entry.productReference, 'productReference', fnName);
  const record = createEmptyListingOptimizationRecord(entry.productReference);
  record.product_title = entry.productTitle || '';
  record.description = entry.description || '';
  record.keywords = normalizeArray(entry.keywords);
  record.keyword_usage = normalizeArray(entry.keywordUsage);
  record.search_intent = entry.searchIntent || '';
  record.structure = entry.structure || '';
  record.headings = normalizeArray(entry.headings);
  const metadata = buildMetadata(entry.metadata);
  if (metadata) record.metadata = metadata;
  record.internal_links = normalizeArray(entry.internalLinks);
  record.internal_optimization_opportunities = normalizeArray(entry.internalOptimizationOpportunities);
  record.conversion_considerations = normalizeArray(entry.conversionConsiderations);
  record.supporting_content = normalizeArray(entry.supportingContent);

  const validation = validateListingOptimizationShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid listing optimization record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildOnPageRecord(entry, subjectType, fnName) {
  requireNonEmptyString(entry.subjectReference, 'subjectReference', fnName);
  const record = createEmptyOnPageOptimizationRecord(subjectType, entry.subjectReference);
  record.subject_title = entry.subjectTitle || '';
  record.description = entry.description || '';
  record.keywords = normalizeArray(entry.keywords);
  record.search_intent = entry.searchIntent || '';
  record.structure = entry.structure || '';
  const metadata = buildMetadata(entry.metadata);
  if (metadata) record.metadata = metadata;
  record.internal_optimization_opportunities = normalizeArray(entry.internalOptimizationOpportunities);
  record.conversion_considerations = normalizeArray(entry.conversionConsiderations);

  const validation = validateOnPageOptimizationShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid on-page optimization record: ${validation.errors.join('; ')}`);
  }
  return record;
}

const RECORD_BUILDERS = { keyword: buildKeywordRecord };

// Exported for reuse (e.g. by a future Listing specialist), mirroring
// researchAgent.js's retrieveResearchData. 'generic' delegates straight to that
// function rather than reimplementing it - the only "external source" in this
// architecture is the caller's own structured input either way.
function retrieveSeoData(kind, entries, fnName) {
  if (kind === 'generic') {
    return retrieveResearchData('generic', entries, fnName);
  }
  const builder = RECORD_BUILDERS[kind];
  if (!builder) {
    throw new Error(`retrieveSeoData received an unknown record kind: ${kind}`);
  }
  return entries.map((entry) => builder(entry, fnName));
}

// ---------------------------------------------------------------------------------
// Analysis - pure analysis of already-retrieved keyword records: flattens findings/
// evidence/source and builds the honest limitations list. Used by keyword research,
// search intent analysis, and SEO opportunity analysis - the 3 capabilities that
// operate over a set of keyword records.
// ---------------------------------------------------------------------------------

function extractKeywordRecord(record) {
  return {
    findings: [record.opportunity, record.competition].filter(Boolean),
    evidence: [],
    source: [...record.source],
    label: record.keyword || '(unspecified keyword)',
  };
}

function analyzeKeywordRecords(records) {
  const findings = [];
  const evidence = [];
  const source = [];
  const limitations = [
    'No live keyword research API is configured; this result reflects only caller-supplied evidence.',
  ];
  let anyEvidenceSupplied = false;

  for (const record of records) {
    const extracted = extractKeywordRecord(record);
    findings.push(...extracted.findings);
    evidence.push(...extracted.evidence);
    source.push(...extracted.source);
    if (extracted.evidence.length === 0 && extracted.source.length === 0) {
      limitations.push(`No evidence was supplied for ${extracted.label}.`);
    } else {
      anyEvidenceSupplied = true;
    }
  }

  return { findings, evidence, source, limitations, anyEvidenceSupplied };
}

// Product/collection/content SEO's optional supporting evidence, reusing
// researchAgent.js's generic record builder directly (same pattern
// agent/core/productAgent.js's buildDimension already established) rather than
// reimplementing generic evidence handling here.
function buildOnPageEvidence(evidenceEntries, fnName) {
  const records = retrieveResearchData('generic', normalizeArray(evidenceEntries), fnName);
  const evidence = records.filter((record) => record.finding).map((record) => record.finding);
  const source = records.flatMap((record) => record.source);
  return { evidence, source };
}

// ---------------------------------------------------------------------------------
// Composition - a thin assembler: applies the verified-without-evidence honesty guard,
// builds the common agent/core/seoAgentResultModel.js envelope, and validates it. The
// only place every capability's result gets combined into one common shape.
// ---------------------------------------------------------------------------------

function composeResult({
  capability,
  topic,
  market,
  findings,
  evidence,
  source,
  confidence,
  limitations,
  recommendations,
  verificationStatus,
  researchDate,
  specializedRecords,
}) {
  const finalLimitations = [...limitations];
  const anyEvidenceSupplied = evidence.length > 0 || source.length > 0;

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && !anyEvidenceSupplied) {
    finalVerificationStatus = 'unverified';
    finalLimitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptySeoAgentResult(capability, topic);
  result.market = market || '';
  result.findings = findings;
  result.evidence = evidence;
  result.source = source;
  result.confidence = confidence || 'unassessed';
  result.limitations = finalLimitations;
  result.recommendations = deriveRecommendations(recommendations);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = specializedRecords;

  const validation = validateSeoAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed SEO agent result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

// Shared by product/collection/content SEO - all 3 build one suggestion record, an
// optional evidence list, and honest limitations the same way, differing only in
// which schema/builder produced the record and what label their topic/limitation text
// uses.
function composeSuggestionResult(record, referenceValue, params, capability, labelPrefix, fnName) {
  const { evidence, source } = buildOnPageEvidence(params.evidence, fnName);
  const limitations = [
    'No live SEO analysis tool is configured; this result reflects only caller-supplied evidence.',
    'Every recommendation above is a suggestion only - applying it to the real listing/page requires a separate, human-approved action (see approvals/); nothing here is automatically published, and no factual product information is altered or invented.',
  ];
  if (evidence.length === 0 && source.length === 0) {
    limitations.push(`No evidence was supplied for ${referenceValue}.`);
  }
  const findings = [
    ...record.internal_optimization_opportunities,
    ...record.conversion_considerations,
    ...(record.supporting_content || []),
  ];

  return composeResult({
    capability,
    topic: params.topic || `${labelPrefix}: ${referenceValue}`,
    market: params.market || '',
    findings,
    evidence,
    source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

// ---------------------------------------------------------------------------------
// One function per supported capability.
// ---------------------------------------------------------------------------------

function runKeywordResearch(params = {}) {
  const { keywords, topic, market = '', researchDate } = params;
  requireNonEmptyArray(keywords, 'keywords', 'runKeywordResearch');

  const records = keywords.map((entry) => {
    requireObjectEntry(entry, 'keywords', 'runKeywordResearch');
    return buildKeywordRecord({ ...entry, market: entry.market || market }, 'runKeywordResearch');
  });

  const analysis = analyzeKeywordRecords(records);
  const keywordList = records.map((record) => record.keyword).join(', ');
  return composeResult({
    capability: 'keyword_research',
    topic: topic || `Keyword research: ${keywordList}`,
    market,
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: researchDate || todayIsoDate(),
    specializedRecords: records,
  });
}

// Groups already-built keyword records by their existing search_intent field - mirrors
// workflows/keywordResearchWorkflow.js's group_keywords_by_intent stage. Not a new
// schema; the grouping itself is surfaced as findings text ("intent: keyword, keyword"),
// never a separate invented structure.
function analyzeSearchIntent(params = {}) {
  const { keywords, topic, market = '' } = params;
  requireNonEmptyArray(keywords, 'keywords', 'analyzeSearchIntent');

  const records = keywords.map((entry) => {
    requireObjectEntry(entry, 'keywords', 'analyzeSearchIntent');
    return buildKeywordRecord({ ...entry, market: entry.market || market }, 'analyzeSearchIntent');
  });

  const analysis = analyzeKeywordRecords(records);
  const groups = {};
  for (const record of records) {
    const intent = record.search_intent || '(unassigned)';
    if (!groups[intent]) groups[intent] = [];
    groups[intent].push(record.keyword);
  }
  const groupFindings = Object.entries(groups).map(
    ([intent, keywordsInGroup]) => `${intent}: ${keywordsInGroup.join(', ')}`
  );

  const keywordList = records.map((record) => record.keyword).join(', ');
  return composeResult({
    capability: 'search_intent_analysis',
    topic: topic || `Search intent analysis: ${keywordList}`,
    market,
    findings: [...groupFindings, ...analysis.findings],
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
    specializedRecords: records,
  });
}

function analyzeProductSeo(params = {}) {
  const fnName = 'analyzeProductSeo';
  const record = buildProductSeoRecord(params, fnName);
  return composeSuggestionResult(record, record.product_reference, params, 'product_seo', 'Product SEO', fnName);
}

function analyzeCollectionSeo(params = {}) {
  const fnName = 'analyzeCollectionSeo';
  const record = buildOnPageRecord(
    { ...params, subjectReference: params.collectionReference, subjectTitle: params.collectionTitle },
    'collection',
    fnName
  );
  return composeSuggestionResult(record, record.subject_reference, params, 'collection_seo', 'Collection SEO', fnName);
}

function analyzeContentSeo(params = {}) {
  const fnName = 'analyzeContentSeo';
  const record = buildOnPageRecord(
    { ...params, subjectReference: params.contentReference, subjectTitle: params.contentTitle },
    'content',
    fnName
  );
  return composeSuggestionResult(record, record.subject_reference, params, 'content_seo', 'Content SEO', fnName);
}

const ON_PAGE_SUBJECT_HANDLERS = {
  product: analyzeProductSeo,
  collection: analyzeCollectionSeo,
  content: analyzeContentSeo,
};

// Not a fourth record type - dispatches to product/collection/content SEO by
// subjectType and returns that same result, tagged capability: 'on_page_seo'.
// Composition, not duplication (see module header).
function analyzeOnPageSeo(params = {}) {
  const { subjectType, ...rest } = params;
  const handler = ON_PAGE_SUBJECT_HANDLERS[subjectType];
  if (!handler) {
    throw new Error(
      `analyzeOnPageSeo requires a valid \`subjectType\` (one of: ${Object.keys(ON_PAGE_SUBJECT_HANDLERS).join(', ')}).`
    );
  }
  const result = { ...handler(rest), capability: 'on_page_seo' };
  const validation = validateSeoAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`analyzeOnPageSeo produced an invalid result: ${validation.errors.join('; ')}`);
  }
  return result;
}

// A structural evidence-coverage count over each keyword's existing opportunity/
// competition fields - never a score or verdict about whether an opportunity is good
// (that pattern is deliberately Product's territory - see module header).
function analyzeSeoOpportunities(params = {}) {
  const { keywords, topic, market = '' } = params;
  requireNonEmptyArray(keywords, 'keywords', 'analyzeSeoOpportunities');

  const records = keywords.map((entry) => {
    requireObjectEntry(entry, 'keywords', 'analyzeSeoOpportunities');
    return buildKeywordRecord({ ...entry, market: entry.market || market }, 'analyzeSeoOpportunities');
  });

  const total = records.length;
  const opportunityBackedCount = records.filter((record) => record.opportunity !== '').length;
  const competitionBackedCount = records.filter((record) => record.competition !== '').length;
  const fullyAssessedCount = records.filter(
    (record) => record.opportunity !== '' && record.competition !== ''
  ).length;

  let status = 'empty';
  if (fullyAssessedCount === total) status = 'success';
  else if (opportunityBackedCount > 0 || competitionBackedCount > 0) status = 'partial';

  const coverageFindings = [
    `${opportunityBackedCount}/${total} keyword(s) have an opportunity assessment.`,
    `${competitionBackedCount}/${total} keyword(s) have a competition assessment.`,
    `Coverage status: ${status}.`,
  ];

  const analysis = analyzeKeywordRecords(records);
  const keywordList = records.map((record) => record.keyword).join(', ');
  return composeResult({
    capability: 'seo_opportunity_analysis',
    topic: topic || `SEO opportunity analysis: ${keywordList}`,
    market,
    findings: [...coverageFindings, ...analysis.findings],
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
    specializedRecords: records,
  });
}

// Real-question gap detection: which questions people actually ask, how well competitors
// and our own site answer them, what specifically is missing, and a deterministic,
// explainable priority score - agent/core/informationGapEngine.js's own pipeline,
// composed here into the shared result envelope. This function adds NO gap logic of its
// own; it validates that questions were supplied, delegates, and relays.
//
// findings deliberately carry each record's status, score and gap type rather than a
// verdict of this file's making, so the honest provenance the engine computed (observed
// vs inferred vs model_generated) survives into the envelope a human or another
// capability reads. Nothing here upgrades a 'review' record into an assertion.
function analyzeInformationGaps(params = {}) {
  const { questions, topic, market = '' } = params;
  requireNonEmptyArray(questions, 'questions', 'analyzeInformationGaps');

  const { records, limitations } = findInformationGaps(params);

  const findings = records.map(
    (record) =>
      `[${record.status}] ${record.opportunity_score}/100 - "${record.question}" (evidence: ${record.evidence_strength}; gap: ${record.gap_type || 'none identified'})`
  );
  // Only real, caller-supplied references count as evidence/source here - the engine
  // never manufactures one, so an unevidenced question contributes nothing and the
  // composeResult() honesty guard below can still downgrade an unsupported 'verified'
  // claim exactly as it does for every other capability.
  const evidence = records.flatMap((record) =>
    record.evidence_sources.map((entry) => `${entry.signal_kind}: ${entry.reference}`)
  );
  const source = records.flatMap((record) =>
    record.evidence_sources.map((entry) => entry.reference).filter(Boolean)
  );

  return composeResult({
    capability: 'information_gap_analysis',
    topic: topic || `Information gap analysis: ${records.length} question opportunity(ies)`,
    market,
    findings,
    evidence,
    source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: records,
  });
}

const SEO_CAPABILITY_HANDLERS = {
  keyword_research: runKeywordResearch,
  search_intent_analysis: analyzeSearchIntent,
  product_seo: analyzeProductSeo,
  collection_seo: analyzeCollectionSeo,
  content_seo: analyzeContentSeo,
  on_page_seo: analyzeOnPageSeo,
  seo_opportunity_analysis: analyzeSeoOpportunities,
  information_gap_analysis: analyzeInformationGaps,
};

// The single entry point: dispatches by capability to the matching function above.
// Never guesses an unrecognized capability - throws a clear error instead.
function runSeoAgent({ capability, ...params } = {}) {
  const handler = SEO_CAPABILITY_HANDLERS[capability];
  if (!handler) {
    throw new Error(`Unknown SEO capability: ${capability}. Must be one of: ${SEO_CAPABILITIES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  runKeywordResearch,
  analyzeSearchIntent,
  analyzeProductSeo,
  analyzeCollectionSeo,
  analyzeContentSeo,
  analyzeOnPageSeo,
  analyzeSeoOpportunities,
  analyzeInformationGaps,
  runSeoAgent,
  retrieveSeoData,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - SEO Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      runKeywordResearch({
        market: 'European Union',
        keywords: [
          {
            keyword: 'insulated hiking jacket',
            searchIntent: 'commercial investigation (caller-supplied placeholder)',
            opportunity: 'Rising search interest (caller-supplied placeholder).',
            competition: 'Moderate, few well-reviewed listings (caller-supplied placeholder).',
            source: ['(placeholder keyword source)'],
          },
          { keyword: 'lightweight rain jacket' },
        ],
      }),
    () =>
      analyzeSearchIntent({
        market: 'European Union',
        keywords: [
          { keyword: 'insulated hiking jacket', searchIntent: 'commercial investigation' },
          { keyword: 'how to layer for cold hikes', searchIntent: 'informational' },
          { keyword: 'buy insulated jacket online', searchIntent: 'transactional' },
        ],
      }),
    () =>
      analyzeProductSeo({
        productReference: '(Example insulated jacket)',
        productTitle: 'Insulated Hiking Jacket - placeholder',
        description: 'Caller-supplied placeholder description text.',
        keywords: ['insulated hiking jacket'],
        keywordUsage: [{ keyword: 'insulated hiking jacket', placement: 'title, h1, first paragraph (caller-supplied placeholder)' }],
        searchIntent: 'commercial investigation',
        headings: [
          { level: 'h1', text: 'Insulated Hiking Jacket - placeholder' },
          { level: 'h2', text: 'Key Features - placeholder' },
        ],
        metadata: { metaTitle: 'Insulated Hiking Jacket | Placeholder Store', metaDescription: 'Placeholder meta description.' },
        internalLinks: [{ anchor_text: 'outdoor apparel collection (caller-supplied placeholder)', target: '(Example outdoor apparel collection)' }],
        internalOptimizationOpportunities: ['Meta description missing target keyword (caller-supplied placeholder).'],
        supportingContent: ['Add a cold-weather layering buying guide (caller-supplied placeholder).'],
        evidence: [{ topic: 'On-page audit', finding: 'Meta description is empty (caller-supplied placeholder).', source: ['(placeholder audit source)'] }],
      }),
    () =>
      analyzeCollectionSeo({
        collectionReference: '(Example outdoor apparel collection)',
        collectionTitle: 'Outdoor Apparel - placeholder',
        internalOptimizationOpportunities: ['No collection description set (caller-supplied placeholder).'],
      }),
    () =>
      analyzeContentSeo({
        contentReference: '(Example blog: cold-weather layering guide)',
        contentTitle: 'How to Layer for Cold Hikes - placeholder',
        searchIntent: 'informational',
      }),
    () =>
      analyzeOnPageSeo({
        subjectType: 'product',
        productReference: '(Example insulated jacket)',
        productTitle: 'Insulated Hiking Jacket - placeholder',
      }),
    () =>
      analyzeSeoOpportunities({
        market: 'European Union',
        keywords: [
          { keyword: 'insulated hiking jacket', opportunity: 'Rising interest (placeholder).', competition: 'Moderate (placeholder).' },
          { keyword: 'lightweight rain jacket', opportunity: 'Steady interest (placeholder).' },
          { keyword: 'waterproof hiking boots' },
        ],
      }),
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.capability} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
