'use strict';

// The SEO Quality Checker. Evaluates 9 dimensions of an already-composed product SEO
// suggestion - keyword targeting, search intent, title, metadata, content quality,
// product accuracy, missing information, over-optimization, internal linking
// opportunities - and reports honestly how well each one checks out. Never invents a
// judgment: every finding is a concrete, mechanical fact about the actual supplied
// text (a character count, a substring match, an occurrence count, a field being
// empty) - never a subjective opinion about writing quality, tone, persuasiveness, or
// an actual ranking/performance prediction. Where a dimension has nothing to check
// (e.g. no target keywords were supplied), that is reported honestly as 'empty', with
// a finding explaining why, not silently skipped or guessed.
//
// Wired into Chief dispatch as the seo_quality_check tool (tools/toolRegistry.js,
// tools/seoQualityCheckTool.js) - the same treatment SEO's own
// market_question_discovery/seo_content_generation and Marketing's
// offer_recommendation already got. This module still owns all the check logic; the
// tool only relays this function's own honest result.
//
// Reuses, never duplicates: takes an already-built, already-validated
// agent/core/listingOptimizationModel.js record (e.g. the output of
// agent/core/seoAgent.js's analyzeProductSeo().specialized_records[0]) and an array of
// agent/core/seoResearchModel.js keyword records as input, rather than re-deriving
// them from raw params - this checker's job is to audit existing SEO Agent output, not
// to build it again.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 9
// dimensions' structural checks passed) - never a claim about SEO performance or
// ranking. See agent/core/seoQualityCheckModel.js's own header for how this
// deliberately differs from agent/core/productOpportunityScoreModel.js's
// coverage_score (evidence *availability* vs check *pass/fail*).
//
// AUDITING A REAL STORE LISTING (checkSeoQualityOnAvailableData). The 9 dimensions were
// designed for a composed SEO suggestion, which carries keywords, search intent,
// headings, internal links and supporting content. A live store product has none of those
// fields - they are SEO research and suggestion data, not stored product data. Scored as
// if they had been supplied, every real product "failed" keyword targeting, search intent,
// over-optimization and internal linking, and could never reach 'success', so the Chief's
// store audit was always reported as missing data. The caller now DECLARES which inputs
// have no source (agent/core/crossAgentContext.js's Product -> SEO relay does), each with a
// reason. A check whose input is both declared unavailable AND genuinely absent from what
// was supplied is reported as NOT ASSESSED, with that reason, instead of as a failed check;
// anything actually supplied is always checked. Without a declaration, checkSeoQuality's
// behaviour is exactly what it always was.

const { validateListingOptimizationShape } = require('./listingOptimizationModel');
const { validateSeoResearchShape } = require('./seoResearchModel');
const {
  SEO_QUALITY_DIMENSIONS,
  createEmptySeoQualityCheck,
  validateSeoQualityCheckShape,
} = require('./seoQualityCheckModel');

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Case-insensitive substring check/count - the only two text operations this checker
// performs. No NLP, no semantic matching, no invented interpretation of the text.
function containsText(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// Shared status rule for every dimension below that first guards on "is there
// anything here to check at all" (an early return to 'empty' before this is ever
// called): once real content exists, the dimension is never degraded back to 'empty'
// just because every check against it failed - that would conflate "nothing to check"
// with "checked and needs work", which are different, both-honest-but-distinct
// findings. 'empty' is reserved strictly for the former.
function deriveNonEmptyCheckStatus(passedCount, applicableCount) {
  return passedCount === applicableCount ? 'success' : 'partial';
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let count = 0;
  let index = 0;
  while ((index = lowerHaystack.indexOf(lowerNeedle, index)) !== -1) {
    count += 1;
    index += lowerNeedle.length;
  }
  return count;
}

// Conventional, widely-documented technical SEO length guidelines (title/meta
// description display-truncation limits) - applied as explicit, labeled thresholds,
// never presented as a guarantee of ranking or display behavior for any specific
// business.
const TITLE_MIN_LENGTH = 15;
const TITLE_MAX_LENGTH = 60;
const META_TITLE_MAX_LENGTH = 60;
const META_DESCRIPTION_MIN_LENGTH = 50;
const META_DESCRIPTION_MAX_LENGTH = 160;
const DESCRIPTION_MIN_LENGTH = 40;
const OVER_OPTIMIZATION_OCCURRENCE_THRESHOLD = 3;

function onPageText(listingRecord) {
  return [
    listingRecord.product_title,
    listingRecord.description,
    listingRecord.metadata.meta_title,
    ...listingRecord.headings.map((heading) => heading.text || ''),
  ].join(' ');
}

// No input is declared unavailable: every check runs exactly as it always has.
const NOTHING_UNAVAILABLE = () => null;

// The honest result of a dimension none of whose checks had a source.
function notAssessed(reason) {
  return { status: 'empty', findings: [`Not assessed: ${reason}`], recommendations: [], notAssessedReason: reason };
}

// ---------------------------------------------------------------------------------
// One check function per dimension. Each returns { status, findings, recommendations }
// - status is always 'empty' (nothing to check, or every applicable check failed),
// 'partial' (some passed), or 'success' (every applicable check passed). `unavailable`
// (field -> reason | null) names inputs the caller declared as having no source; it only
// ever excludes a check whose input is ALSO absent from what was supplied.
// ---------------------------------------------------------------------------------

function checkKeywordTargeting(listingRecord, keywordRecords, unavailable = NOTHING_UNAVAILABLE) {
  if (keywordRecords.length === 0) {
    const reason = unavailable('keywordRecords');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['No target keywords were supplied to check targeting against.'],
      recommendations: [],
    };
  }
  const text = onPageText(listingRecord);
  const targeted = keywordRecords.filter((record) => containsText(text, record.keyword));
  const untargeted = keywordRecords.filter((record) => !containsText(text, record.keyword));

  const findings = [
    `${targeted.length}/${keywordRecords.length} target keyword(s) appear in the title, description, meta title, or headings.`,
  ];
  const recommendations = untargeted.map(
    (record) =>
      `Keyword "${record.keyword}" does not appear in the title, description, meta title, or headings - consider adding it where relevant.`
  );

  const status = deriveNonEmptyCheckStatus(targeted.length, keywordRecords.length);
  return { status, findings, recommendations };
}

function checkSearchIntent(listingRecord, keywordRecords, unavailable = NOTHING_UNAVAILABLE) {
  if (!listingRecord.search_intent) {
    const reason = unavailable('search_intent');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['No search intent is set on the listing.'],
      recommendations: ['Set a search intent for this listing so its content/structure can be checked against it.'],
    };
  }
  if (keywordRecords.length === 0) {
    return {
      status: 'partial',
      findings: [`Search intent is set ("${listingRecord.search_intent}") but no target keywords were supplied to check alignment against.`],
      recommendations: [],
    };
  }

  const aligned = keywordRecords.filter(
    (record) => record.search_intent && record.search_intent.toLowerCase() === listingRecord.search_intent.toLowerCase()
  );

  if (aligned.length === keywordRecords.length) {
    return {
      status: 'success',
      findings: [`Listing search intent matches all ${keywordRecords.length} target keyword(s)' asserted intent.`],
      recommendations: [],
    };
  }
  if (aligned.length > 0) {
    return {
      status: 'partial',
      findings: [`Listing search intent matches ${aligned.length}/${keywordRecords.length} target keyword(s)' asserted intent.`],
      recommendations: ['Review whether the listing search intent matches the intent of every target keyword.'],
    };
  }
  return {
    status: 'partial',
    findings: [`Listing search intent ("${listingRecord.search_intent}") does not match any target keyword's asserted intent.`],
    recommendations: ['Review whether the listing search intent matches the intent of its target keywords.'],
  };
}

function checkTitle(listingRecord, keywordRecords, unavailable = NOTHING_UNAVAILABLE) {
  const title = listingRecord.product_title || '';
  if (!title) {
    const reason = unavailable('product_title');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['Product title is missing.'],
      recommendations: ['Add a product title.'],
    };
  }

  const findings = [];
  const recommendations = [];
  let applicable = 1;
  let passed = 0;

  if (title.length < TITLE_MIN_LENGTH || title.length > TITLE_MAX_LENGTH) {
    findings.push(`Title is ${title.length} character(s) (conventional guideline: ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH}).`);
    recommendations.push(`Consider adjusting the title length to roughly ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH} characters so it isn't truncated in search results.`);
  } else {
    findings.push(`Title length (${title.length} characters) is within the conventional ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH}-character guideline.`);
    passed += 1;
  }

  if (keywordRecords.length > 0) {
    applicable += 1;
    const hasKeyword = keywordRecords.some((record) => containsText(title, record.keyword));
    if (hasKeyword) {
      findings.push('Title contains at least one target keyword.');
      passed += 1;
    } else {
      findings.push('Title does not contain any target keyword.');
      recommendations.push('Consider including a target keyword in the title.');
    }
  }

  const status = deriveNonEmptyCheckStatus(passed, applicable);
  return { status, findings, recommendations };
}

function checkMetadata(listingRecord, unavailable = NOTHING_UNAVAILABLE) {
  const metadata = listingRecord.metadata;
  const findings = [];
  const recommendations = [];
  let passed = 0;
  let applicable = 3;
  const skippedReasons = [];
  const skip = (field) => {
    const reason = unavailable(field);
    if (!reason) return false;
    applicable -= 1;
    skippedReasons.push(reason);
    findings.push(`${field.replace('metadata.', '')} not assessed: ${reason}`);
    return true;
  };

  if (!metadata.meta_title) {
    if (!skip('metadata.meta_title')) {
      findings.push('meta_title is missing.');
      recommendations.push('Add a meta_title.');
    }
  } else if (metadata.meta_title.length > META_TITLE_MAX_LENGTH) {
    findings.push(`meta_title is ${metadata.meta_title.length} character(s) (conventional guideline: up to ${META_TITLE_MAX_LENGTH}).`);
    recommendations.push(`Consider shortening meta_title to roughly ${META_TITLE_MAX_LENGTH} characters or fewer.`);
  } else {
    findings.push(`meta_title is present and within the conventional ${META_TITLE_MAX_LENGTH}-character guideline.`);
    passed += 1;
  }

  if (!metadata.meta_description) {
    if (!skip('metadata.meta_description')) {
      findings.push('meta_description is missing.');
      recommendations.push('Add a meta_description.');
    }
  } else if (
    metadata.meta_description.length < META_DESCRIPTION_MIN_LENGTH ||
    metadata.meta_description.length > META_DESCRIPTION_MAX_LENGTH
  ) {
    findings.push(`meta_description is ${metadata.meta_description.length} character(s) (conventional guideline: ${META_DESCRIPTION_MIN_LENGTH}-${META_DESCRIPTION_MAX_LENGTH}).`);
    recommendations.push(`Consider adjusting meta_description length to roughly ${META_DESCRIPTION_MIN_LENGTH}-${META_DESCRIPTION_MAX_LENGTH} characters.`);
  } else {
    findings.push(`meta_description is present and within the conventional ${META_DESCRIPTION_MIN_LENGTH}-${META_DESCRIPTION_MAX_LENGTH}-character guideline.`);
    passed += 1;
  }

  if (!metadata.url_slug) {
    if (!skip('metadata.url_slug')) {
      findings.push('url_slug is missing.');
      recommendations.push('Add a url_slug.');
    }
  } else {
    findings.push('url_slug is present.');
    passed += 1;
  }

  if (applicable === 0) return notAssessed(skippedReasons[0]);
  let status = 'empty';
  if (passed === applicable) status = 'success';
  else if (passed > 0) status = 'partial';
  return { status, findings, recommendations };
}

// Structural completeness proxies only - description length, presence of a heading/
// structure, presence of supporting content. Never evaluates grammar, tone, or
// persuasiveness, which would require human or AI review this deterministic module
// does not perform.
function checkContentQuality(listingRecord, unavailable = NOTHING_UNAVAILABLE) {
  const findings = [];
  const recommendations = [];
  let passed = 0;
  let applicable = 3;
  const skippedReasons = [];

  const description = listingRecord.description || '';
  if (!description) {
    const reason = unavailable('description');
    if (reason) {
      applicable -= 1;
      skippedReasons.push(reason);
      findings.push(`Description not assessed: ${reason}`);
    } else {
      findings.push('Description is missing.');
      recommendations.push('Add a description.');
    }
  } else if (description.length < DESCRIPTION_MIN_LENGTH) {
    findings.push(`Description is ${description.length} character(s), below the ${DESCRIPTION_MIN_LENGTH}-character thin-content guideline.`);
    recommendations.push(`Consider expanding the description to at least ${DESCRIPTION_MIN_LENGTH} characters.`);
  } else {
    findings.push(`Description is present and at least ${DESCRIPTION_MIN_LENGTH} characters.`);
    passed += 1;
  }

  const hasStructure = Boolean(listingRecord.structure) || listingRecord.headings.length > 0;
  const structureReason = !hasStructure && unavailable('structure') && unavailable('headings') ? unavailable('structure') : null;
  if (structureReason) {
    applicable -= 1;
    skippedReasons.push(structureReason);
    findings.push(`Structure and headings not assessed: ${structureReason}`);
  } else if (!hasStructure) {
    findings.push('No structure or headings are suggested for this listing.');
    recommendations.push('Suggest a content structure or at least one heading.');
  } else {
    findings.push('A structure or heading suggestion is present.');
    passed += 1;
  }

  const supportingReason = listingRecord.supporting_content.length === 0 ? unavailable('supporting_content') : null;
  if (supportingReason) {
    applicable -= 1;
    skippedReasons.push(supportingReason);
    findings.push(`Supporting content not assessed: ${supportingReason}`);
  } else if (listingRecord.supporting_content.length === 0) {
    findings.push('No supporting content ideas are suggested.');
    recommendations.push('Consider suggesting supporting content (e.g. a buying guide or FAQ section).');
  } else {
    findings.push(`${listingRecord.supporting_content.length} supporting content idea(s) suggested.`);
    passed += 1;
  }

  if (applicable === 0) return notAssessed(skippedReasons[0]);
  // 'empty' only when there is truly nothing here (no description, no structure/
  // headings, no supporting content) - once any real content exists, a failed
  // sub-check is a 'partial' finding, never a regression back to 'empty'.
  const status = description || hasStructure || listingRecord.supporting_content.length > 0
    ? deriveNonEmptyCheckStatus(passed, applicable)
    : 'empty';
  return { status, findings, recommendations };
}

// Only assessable when the caller supplies factualAttributes (real facts about the
// product that must be reflected). Checks presence only (a literal substring match) -
// never judges truthfulness, since this module has no independent source of truth.
// Honestly 'empty' (not a failure) when nothing was supplied to check.
function checkProductAccuracy(listingRecord, factualAttributes, unavailable = NOTHING_UNAVAILABLE) {
  if (factualAttributes.length === 0) {
    const reason = unavailable('factualAttributes');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['No factual attributes were supplied to check description/title coverage against.'],
      recommendations: [],
    };
  }

  const text = `${listingRecord.product_title} ${listingRecord.description}`;
  const present = factualAttributes.filter((attribute) => containsText(text, attribute));
  const missing = factualAttributes.filter((attribute) => !containsText(text, attribute));

  const findings = [
    `${present.length}/${factualAttributes.length} factual attribute(s) are mentioned in the title/description.`,
  ];
  const recommendations = missing.map(
    (attribute) => `Factual attribute "${attribute}" is not mentioned in the suggested title/description - verify it should be included.`
  );

  const status = deriveNonEmptyCheckStatus(present.length, factualAttributes.length);
  return { status, findings, recommendations };
}

const EXPECTED_FIELD_CHECKS = [
  { label: 'product_title', present: (record) => Boolean(record.product_title) },
  { label: 'description', present: (record) => Boolean(record.description) },
  { label: 'metadata.meta_title', present: (record) => Boolean(record.metadata.meta_title) },
  { label: 'metadata.meta_description', present: (record) => Boolean(record.metadata.meta_description) },
  { label: 'metadata.url_slug', present: (record) => Boolean(record.metadata.url_slug) },
  { label: 'keywords', present: (record) => record.keywords.length > 0 },
  { label: 'headings', present: (record) => record.headings.length > 0 },
];

function checkMissingInformation(listingRecord, unavailable = NOTHING_UNAVAILABLE) {
  // A field with no source is not "missing" from the listing - it is not assessed.
  const excluded = EXPECTED_FIELD_CHECKS.filter((check) => !check.present(listingRecord) && unavailable(check.label));
  const expected = EXPECTED_FIELD_CHECKS.filter((check) => !excluded.includes(check));
  const missing = expected.filter((check) => !check.present(listingRecord));
  const present = expected.length - missing.length;

  if (expected.length === 0) return notAssessed(unavailable(excluded[0].label));

  const findings = [
    `${present}/${expected.length} expected field(s) are populated.`,
  ];
  if (excluded.length > 0) {
    findings.push(`Not assessed (no source): ${excluded.map((check) => check.label).join(', ')}.`);
  }
  const recommendations = missing.map((check) => `${check.label} is missing.`);

  let status = 'empty';
  if (present === expected.length) status = 'success';
  else if (present > 0) status = 'partial';
  return { status, findings, recommendations };
}

// Keyword-stuffing heuristic: counts raw occurrences of each target keyword across
// title/description/meta_title/meta_description. A fixed, documented threshold - never
// a claim about actual ranking impact.
function checkOverOptimization(listingRecord, keywordRecords, unavailable = NOTHING_UNAVAILABLE) {
  if (keywordRecords.length === 0) {
    const reason = unavailable('keywordRecords');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['No target keywords were supplied to check for over-optimization.'],
      recommendations: [],
    };
  }

  const text = [
    listingRecord.product_title,
    listingRecord.description,
    listingRecord.metadata.meta_title,
    listingRecord.metadata.meta_description,
  ].join(' ');

  const flagged = [];
  const clean = [];
  for (const record of keywordRecords) {
    const count = countOccurrences(text, record.keyword);
    if (count > OVER_OPTIMIZATION_OCCURRENCE_THRESHOLD) {
      flagged.push({ keyword: record.keyword, count });
    } else {
      clean.push(record.keyword);
    }
  }

  const findings = [
    `${clean.length}/${keywordRecords.length} target keyword(s) stay at or below ${OVER_OPTIMIZATION_OCCURRENCE_THRESHOLD} occurrences across title/description/metadata.`,
  ];
  const recommendations = flagged.map(
    ({ keyword, count }) =>
      `Keyword "${keyword}" appears ${count} times across title/description/metadata - consider reducing repetition to avoid keyword stuffing.`
  );

  const status = deriveNonEmptyCheckStatus(clean.length, keywordRecords.length);
  return { status, findings, recommendations };
}

function checkInternalLinkingOpportunities(listingRecord, unavailable = NOTHING_UNAVAILABLE) {
  const links = listingRecord.internal_links || [];
  if (links.length === 0) {
    const reason = unavailable('internal_links');
    if (reason) return notAssessed(reason);
    return {
      status: 'empty',
      findings: ['No internal links are suggested for this listing.'],
      recommendations: ['Suggest at least one internal link (e.g. to a related collection or complementary product).'],
    };
  }

  const incomplete = links.filter((link) => !link.anchor_text || !link.target);
  const complete = links.length - incomplete.length;

  const findings = [`${complete}/${links.length} suggested internal link(s) have both anchor text and a target.`];
  if (incomplete.length === 0) {
    return { status: 'success', findings, recommendations: [] };
  }
  return {
    status: 'partial',
    findings,
    recommendations: ['Some suggested internal links are missing anchor text or a target - complete them before use.'],
  };
}

const DIMENSION_CHECKS = {
  keyword_targeting: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkKeywordTargeting(listingRecord, keywordRecords, unavailable),
  search_intent: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkSearchIntent(listingRecord, keywordRecords, unavailable),
  title: (listingRecord, keywordRecords, factualAttributes, unavailable) => checkTitle(listingRecord, keywordRecords, unavailable),
  metadata: (listingRecord, keywordRecords, factualAttributes, unavailable) => checkMetadata(listingRecord, unavailable),
  content_quality: (listingRecord, keywordRecords, factualAttributes, unavailable) => checkContentQuality(listingRecord, unavailable),
  product_accuracy: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkProductAccuracy(listingRecord, factualAttributes, unavailable),
  missing_information: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkMissingInformation(listingRecord, unavailable),
  over_optimization: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkOverOptimization(listingRecord, keywordRecords, unavailable),
  internal_linking_opportunities: (listingRecord, keywordRecords, factualAttributes, unavailable) =>
    checkInternalLinkingOpportunities(listingRecord, unavailable),
};

const DIMENSION_LABELS = {
  keyword_targeting: 'Keyword targeting',
  search_intent: 'Search intent',
  title: 'Title',
  metadata: 'Metadata',
  content_quality: 'Content quality',
  product_accuracy: 'Product accuracy',
  missing_information: 'Missing information',
  over_optimization: 'Over-optimization',
  internal_linking_opportunities: 'Internal linking opportunities',
};

function labelForDimension(dimensionId) {
  return DIMENSION_LABELS[dimensionId] || dimensionId;
}

function buildDimensionGapReason(dimensionId, status) {
  const label = DIMENSION_LABELS[dimensionId];
  if (status === 'empty') {
    return `${label} has nothing to check, or every applicable check failed.`;
  }
  return `${label} has at least one unresolved check.`;
}

// ---------------------------------------------------------------------------------
// Combined entry point. Takes already-built, already-validated records - this checker
// audits existing SEO Agent output, it does not build it.
// ---------------------------------------------------------------------------------

function runChecks({ listingRecord, keywordRecords = [], factualAttributes = [], researchDate } = {}, unavailable = NOTHING_UNAVAILABLE) {
  const fnName = 'checkSeoQuality';

  const listingValidation = validateListingOptimizationShape(listingRecord);
  if (!listingValidation.valid) {
    throw new Error(`${fnName} requires a valid listingOptimizationModel.js record: ${listingValidation.errors.join('; ')}`);
  }
  keywordRecords.forEach((record, index) => {
    const validation = validateSeoResearchShape(record);
    if (!validation.valid) {
      throw new Error(`${fnName} received an invalid keyword record at index ${index}: ${validation.errors.join('; ')}`);
    }
  });

  const dimensionStatus = {};
  const findings = [];
  const recommendations = [];
  const dimensionGaps = [];
  const notAssessedDimensions = [];

  for (const dimensionId of SEO_QUALITY_DIMENSIONS) {
    const check = DIMENSION_CHECKS[dimensionId](listingRecord, keywordRecords, factualAttributes, unavailable);
    dimensionStatus[dimensionId] = check.status;
    const label = DIMENSION_LABELS[dimensionId];
    findings.push(...check.findings.map((finding) => `[${label}] ${finding}`));
    recommendations.push(...check.recommendations.map((recommendation) => `[${label}] ${recommendation}`));
    if (check.notAssessedReason) {
      notAssessedDimensions.push({ dimension: dimensionId, reason: check.notAssessedReason });
      dimensionGaps.push({ dimension: dimensionId, reason: `${label} was not assessed: ${check.notAssessedReason}` });
    } else if (check.status !== 'success') {
      dimensionGaps.push({ dimension: dimensionId, reason: buildDimensionGapReason(dimensionId, check.status) });
    }
  }

  const statuses = Object.values(dimensionStatus);
  const dimensionsTotal = SEO_QUALITY_DIMENSIONS.length;
  const dimensionsSuccess = statuses.filter((status) => status === 'success').length;
  const dimensionsPartial = statuses.filter((status) => status === 'partial').length;
  const dimensionsEmpty = statuses.filter((status) => status === 'empty').length;
  let scoreStatus = 'empty';
  if (dimensionsSuccess === dimensionsTotal) scoreStatus = 'success';
  else if (dimensionsSuccess > 0) scoreStatus = 'partial';

  const result = createEmptySeoQualityCheck(listingRecord.product_reference);
  result.research_date = researchDate || todayIsoDate();
  result.dimension_status = dimensionStatus;
  result.findings = findings;
  result.recommendations = recommendations;
  result.dimension_gaps = dimensionGaps;
  result.quality_score = {
    dimensions_total: dimensionsTotal,
    dimensions_success: dimensionsSuccess,
    dimensions_partial: dimensionsPartial,
    dimensions_empty: dimensionsEmpty,
    percentage: Math.round((dimensionsSuccess / dimensionsTotal) * 100),
    status: scoreStatus,
  };
  result.source = keywordRecords.flatMap((record) => record.source);
  result.specialized_records = { listing_record: listingRecord, keyword_records: keywordRecords };

  const resultValidation = validateSeoQualityCheckShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed SEO quality check failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return { result, notAssessedDimensions };
}

function checkSeoQuality(params = {}) {
  return runChecks(params).result;
}

// Validates a caller's declaration of inputs with no source: [{ field, reason }].
function unavailabilityLookup(unavailableInputs) {
  if (!Array.isArray(unavailableInputs)) {
    throw new Error('checkSeoQualityOnAvailableData requires unavailableInputs to be an array of { field, reason } entries.');
  }
  const reasons = new Map();
  unavailableInputs.forEach((entry, index) => {
    if (!entry || typeof entry.field !== 'string' || !entry.field || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`checkSeoQualityOnAvailableData: unavailableInputs[${index}] must be { field, reason } with a non-empty reason.`);
    }
    if (!reasons.has(entry.field)) reasons.set(entry.field, entry.reason.trim());
  });
  return (field) => reasons.get(field) || null;
}

// Audits a REAL listing on the data it actually has. Returns the schema-valid check record
// plus which dimensions were not assessed (and why), and `assessed_status` - the verdict
// over the dimensions that WERE assessed: 'success' (every one passed), 'empty' (none had
// anything present), 'partial' (the listing has at least one finding to act on).
function checkSeoQualityOnAvailableData({ unavailableInputs = [], ...params } = {}) {
  const { result, notAssessedDimensions } = runChecks(params, unavailabilityLookup(unavailableInputs));
  const notAssessedIds = new Set(notAssessedDimensions.map((entry) => entry.dimension));
  const assessedDimensions = SEO_QUALITY_DIMENSIONS.filter((dimension) => !notAssessedIds.has(dimension));
  const assessedStatuses = assessedDimensions.map((dimension) => result.dimension_status[dimension]);
  let assessedStatus = 'partial';
  if (assessedStatuses.length === 0 || assessedStatuses.every((status) => status === 'empty')) assessedStatus = 'empty';
  else if (assessedStatuses.every((status) => status === 'success')) assessedStatus = 'success';
  return {
    check: result,
    not_assessed: notAssessedDimensions,
    assessed_dimensions: assessedDimensions,
    assessed_status: assessedStatus,
  };
}

// STORE LISTING FIELDS. The listing-quality fields a store product carries outside the SEO
// suggestion shape - product type, vendor, tags, and whether it is published. Mechanical
// presence facts only. A field the read did not return is not assessed, never guessed.
const STORE_LISTING_FIELD_CHECKS = [
  {
    field: 'product_type',
    check: (value) => (value ? { passed: true, finding: `Product type is set ("${value}").` } : { passed: false, finding: 'Product type is not set.', recommendation: 'Set a product type so the listing is categorised in the store and in search.' }),
  },
  {
    field: 'vendor',
    check: (value) => (value ? { passed: true, finding: 'Vendor is set.' } : { passed: false, finding: 'Vendor is not set.', recommendation: 'Set the vendor on this product.' }),
  },
  {
    field: 'tags',
    check: (value) => (Array.isArray(value) && value.length > 0
      ? { passed: true, finding: `${value.length} tag(s) are set.` }
      : { passed: false, finding: 'The product has no tags.', recommendation: 'Add descriptive tags so the product is easier to find and group.' }),
  },
  {
    field: 'status',
    check: (value) => (value === 'ACTIVE'
      ? { passed: true, finding: 'Product status is ACTIVE (published to the storefront).' }
      : { passed: false, finding: `Product status is ${value || 'not set'} - it is not published to the storefront, so shoppers and search engines cannot see it.`, recommendation: 'Review whether this product should be published.' }),
  },
];

function checkStoreListingFields(storeFields) {
  const fields = storeFields && typeof storeFields === 'object' ? storeFields : {};
  const unread = new Set(Array.isArray(fields.unavailable_fields) ? fields.unavailable_fields : []);
  const findings = [];
  const recommendations = [];
  const notAssessedFields = [];
  let applicable = 0;
  let passed = 0;
  for (const { field, check } of STORE_LISTING_FIELD_CHECKS) {
    if (unread.has(field) || !(field in fields)) {
      notAssessedFields.push({ field, reason: 'The store read did not return this field for this product.' });
      continue;
    }
    applicable += 1;
    const outcome = check(fields[field]);
    findings.push(outcome.finding);
    if (outcome.passed) passed += 1;
    else recommendations.push(outcome.recommendation);
  }
  let status = 'empty';
  if (applicable > 0) status = deriveNonEmptyCheckStatus(passed, applicable);
  return { status, findings, recommendations, not_assessed: notAssessedFields };
}

module.exports = {
  checkSeoQuality,
  checkSeoQualityOnAvailableData,
  checkStoreListingFields,
  labelForDimension,
};

if (require.main === module) {
  const { createEmptyListingOptimizationRecord } = require('./listingOptimizationModel');
  const { createEmptySeoResearchRecord } = require('./seoResearchModel');

  console.log('Smart E-Commerce Growth AI Agent - SEO Quality Checker (deterministic, mechanical checks only):\n');

  const listingRecord = createEmptyListingOptimizationRecord('(Example insulated jacket)');
  listingRecord.product_title = 'Insulated Hiking Jacket - placeholder';
  listingRecord.description = 'Caller-supplied placeholder description text.';
  listingRecord.keywords = ['insulated hiking jacket'];
  listingRecord.search_intent = 'commercial investigation';
  listingRecord.headings = [{ level: 'h1', text: 'Insulated Hiking Jacket - placeholder' }];
  listingRecord.metadata.meta_title = 'Insulated Hiking Jacket | Placeholder Store';
  // meta_description deliberately left empty, to show an honest gap.

  const keywordRecord = createEmptySeoResearchRecord('insulated hiking jacket');
  keywordRecord.search_intent = 'commercial investigation';
  keywordRecord.source = ['(placeholder keyword source)'];

  const result = checkSeoQuality({
    listingRecord,
    keywordRecords: [keywordRecord],
    factualAttributes: ['waterproof'],
  });
  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('quality_score is a mechanical checklist-coverage measurement only, never a ranking or performance prediction.');
}
