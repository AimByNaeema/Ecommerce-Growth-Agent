'use strict';

// The Listing Quality Checker. Evaluates 8 dimensions of an already-composed listing
// content record (agent/core/listingContentModel.js - e.g. the output of
// agent/core/listingAgent.js's generateListingContent()) - completeness, clarity,
// accuracy, conversion quality, SEO compatibility, customer objections, missing
// information, unsupported claims - and reports honestly how well each one checks out.
// Never invents a judgment: every finding is a concrete, mechanical fact about the
// actual supplied text (a character count, a substring match, a field being empty) -
// never a subjective opinion about writing quality, tone, persuasiveness, or an actual
// conversion/ranking/sales prediction. Where a dimension has nothing to check (e.g. no
// target keywords were supplied), that is reported honestly as 'empty', with a finding
// explaining why, not silently skipped or guessed.
//
// Standalone deliverable, not yet wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/seoQualityChecker.js and agent/core/productOpportunityScoringEngine.js
// already made (a scoring engine that evaluates existing structured output, directly
// callable, not part of the 7-capability dispatcher). A future, explicitly-scoped
// prompt can wire it in if wanted.
//
// Reuses, never duplicates: takes an already-built, already-validated
// agent/core/listingContentModel.js record as input, plus 3 optional auxiliary inputs
// (keywordRecords, factualAttributes, customerObjections - all caller-supplied, never
// re-derived), rather than re-deriving any of them from raw params - this checker's
// job is to audit existing Listing Agent output, not to build it again.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 8
// dimensions' structural checks passed) - never a claim about actual conversion,
// ranking, or sales performance. See agent/core/listingQualityCheckModel.js's own
// header for how this deliberately differs from
// agent/core/productOpportunityScoreModel.js's coverage_score (evidence
// *availability* vs check *pass/fail*).

const { validateListingContentShape } = require('./listingContentModel');
const { validateSeoResearchShape } = require('./seoResearchModel');
const {
  LISTING_QUALITY_DIMENSIONS,
  createEmptyListingQualityCheck,
  validateListingQualityCheckShape,
} = require('./listingQualityCheckModel');

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Case-insensitive substring check - the only text operation this checker performs
// beyond length/count. No NLP, no semantic matching, no invented interpretation of
// the text.
function containsText(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// Shared status rule for every dimension below that first guards on "is there
// anything here to check at all" (an early return to 'empty' before this is ever
// called): once real content exists, the dimension is never degraded back to 'empty'
// just because every check against it failed - that would conflate "nothing to check"
// with "checked and needs work", which are different, both-honest-but-distinct
// findings. 'empty' is reserved strictly for the former. Matches
// agent/core/seoQualityChecker.js's identical rule exactly.
function deriveNonEmptyCheckStatus(passedCount, applicableCount) {
  return passedCount === applicableCount ? 'success' : 'partial';
}

// Conventional, widely-documented content-length guidelines, applied as explicit,
// labeled thresholds - never presented as a guarantee of readability or performance
// for any specific business.
const TITLE_MIN_LENGTH = 10;
const TITLE_MAX_LENGTH = 80;
const DESCRIPTION_MIN_LENGTH = 40;
const LISTING_ITEM_MAX_LENGTH = 160;

// Not exhaustive - a small, explicit set of absolute/superlative claim phrases that
// commonly appear in unsubstantiated marketing copy. Presence alone is not treated as
// false; it is only ever flagged as "unbacked" when the caller did not also supply a
// matching factual attribute (see checkUnsupportedClaims below).
const CLAIM_TRIGGER_PHRASES = [
  'best', 'guaranteed', 'perfect', '100%', 'always', 'never', '#1', 'number one',
  'top rated', 'award-winning', 'ultimate', 'flawless',
];

function marketingText(listingRecord) {
  return [
    listingRecord.description,
    ...listingRecord.benefits,
    ...listingRecord.features,
    ...listingRecord.selling_points,
  ].join(' ');
}

// ---------------------------------------------------------------------------------
// One check function per dimension. Each returns { status, findings, recommendations }
// - status is always 'empty' (nothing to check, or every applicable check failed),
// 'partial' (some passed), or 'success' (every applicable check passed).
// ---------------------------------------------------------------------------------

// Essential go-live fields only - "can this listing function at all". Distinct from
// missing_information below, which audits every field (including optional ones) for a
// full, itemized gap list.
const COMPLETENESS_FIELD_CHECKS = [
  { label: 'product_title', present: (record) => Boolean(record.product_title) },
  { label: 'description', present: (record) => Boolean(record.description) },
  { label: 'benefits', present: (record) => record.benefits.length > 0 },
  { label: 'features', present: (record) => record.features.length > 0 },
  { label: 'cta', present: (record) => Boolean(record.cta) },
];

function checkCompleteness(listingRecord) {
  const missing = COMPLETENESS_FIELD_CHECKS.filter((check) => !check.present(listingRecord));
  const present = COMPLETENESS_FIELD_CHECKS.length - missing.length;

  const findings = [`${present}/${COMPLETENESS_FIELD_CHECKS.length} essential listing field(s) are populated.`];
  const recommendations = missing.map((check) => `${check.label} is missing - a complete listing needs it.`);

  let status = 'empty';
  if (present === COMPLETENESS_FIELD_CHECKS.length) status = 'success';
  else if (present > 0) status = 'partial';
  return { status, findings, recommendations };
}

// Structural proxies only - title/description length, and per-item conciseness of
// benefits/features. Never evaluates grammar, tone, or actual readability, which would
// require human or AI review this deterministic module does not perform.
function checkClarity(listingRecord) {
  const title = listingRecord.product_title || '';
  const description = listingRecord.description || '';
  const items = [...listingRecord.benefits, ...listingRecord.features];

  if (!title && !description && items.length === 0) {
    return {
      status: 'empty',
      findings: ['No title, description, benefits, or features were supplied to check for clarity.'],
      recommendations: [],
    };
  }

  const findings = [];
  const recommendations = [];
  let passed = 0;
  let applicable = 0;

  if (title) {
    applicable += 1;
    if (title.length < TITLE_MIN_LENGTH || title.length > TITLE_MAX_LENGTH) {
      findings.push(`Title is ${title.length} character(s) (conventional guideline: ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH}).`);
      recommendations.push(`Consider adjusting the title length to roughly ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH} characters for readability.`);
    } else {
      findings.push(`Title length (${title.length} characters) is within the conventional ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH}-character guideline.`);
      passed += 1;
    }
  }

  if (description) {
    applicable += 1;
    if (description.length < DESCRIPTION_MIN_LENGTH) {
      findings.push(`Description is ${description.length} character(s), below the ${DESCRIPTION_MIN_LENGTH}-character thin-content guideline.`);
      recommendations.push(`Consider expanding the description to at least ${DESCRIPTION_MIN_LENGTH} characters.`);
    } else {
      findings.push(`Description is present and at least ${DESCRIPTION_MIN_LENGTH} characters.`);
      passed += 1;
    }
  }

  if (items.length > 0) {
    applicable += 1;
    const overlong = items.filter((item) => item.length > LISTING_ITEM_MAX_LENGTH);
    if (overlong.length === 0) {
      findings.push(`All ${items.length} benefit/feature item(s) stay at or below ${LISTING_ITEM_MAX_LENGTH} characters.`);
      passed += 1;
    } else {
      findings.push(`${overlong.length}/${items.length} benefit/feature item(s) exceed ${LISTING_ITEM_MAX_LENGTH} characters.`);
      recommendations.push(`Consider splitting or shortening benefit/feature items over ${LISTING_ITEM_MAX_LENGTH} characters so each stays a single, clear point.`);
    }
  }

  const status = deriveNonEmptyCheckStatus(passed, applicable);
  return { status, findings, recommendations };
}

// Only assessable when the caller supplies factualAttributes (real facts about the
// product that must be reflected). Checks presence only (a literal substring match) -
// never judges truthfulness, since this module has no independent source of truth.
// Honestly 'empty' (not a failure) when nothing was supplied to check.
function checkAccuracy(listingRecord, factualAttributes) {
  if (factualAttributes.length === 0) {
    return {
      status: 'empty',
      findings: ['No factual attributes were supplied to check listing text coverage against.'],
      recommendations: [],
    };
  }

  const text = marketingText(listingRecord);
  const present = factualAttributes.filter((attribute) => containsText(text, attribute));
  const missing = factualAttributes.filter((attribute) => !containsText(text, attribute));

  const findings = [
    `${present.length}/${factualAttributes.length} factual attribute(s) are mentioned in the description/benefits/features/selling points.`,
  ];
  const recommendations = missing.map(
    (attribute) => `Factual attribute "${attribute}" is not mentioned anywhere in the listing text - verify it should be included.`
  );

  const status = deriveNonEmptyCheckStatus(present.length, factualAttributes.length);
  return { status, findings, recommendations };
}

// Mechanical proxies for elements that typically drive conversion - a CTA, at least
// one benefit, and at least one selling point or feature. Never a claim about actual
// conversion rate or sales impact.
function checkConversionQuality(listingRecord) {
  const findings = [];
  const recommendations = [];
  let passed = 0;
  const applicable = 3;

  if (!listingRecord.cta) {
    findings.push('No CTA (call-to-action) is set.');
    recommendations.push('Add a CTA so the listing has a clear next step for the customer.');
  } else {
    findings.push('A CTA is present.');
    passed += 1;
  }

  if (listingRecord.benefits.length === 0) {
    findings.push('No benefits are listed.');
    recommendations.push('Add at least one customer-facing benefit.');
  } else {
    findings.push(`${listingRecord.benefits.length} benefit(s) are listed.`);
    passed += 1;
  }

  if (listingRecord.selling_points.length === 0 && listingRecord.features.length === 0) {
    findings.push('No selling points or features are listed.');
    recommendations.push('Add at least one selling point or feature to help differentiate the product.');
  } else {
    findings.push(`${listingRecord.selling_points.length} selling point(s) and ${listingRecord.features.length} feature(s) are listed.`);
    passed += 1;
  }

  const status = listingRecord.cta || listingRecord.benefits.length > 0 || listingRecord.selling_points.length > 0 || listingRecord.features.length > 0
    ? deriveNonEmptyCheckStatus(passed, applicable)
    : 'empty';
  return { status, findings, recommendations };
}

// Only assessable when the caller supplies keywordRecords (agent/core/
// seoResearchModel.js records, e.g. from SEO's keyword research). Checks presence only
// (a literal substring match against title/description/FAQs) - never an actual ranking
// or search-visibility prediction.
function checkSeoCompatibility(listingRecord, keywordRecords) {
  if (keywordRecords.length === 0) {
    return {
      status: 'empty',
      findings: ['No target keywords were supplied to check SEO compatibility against.'],
      recommendations: [],
    };
  }

  const text = [
    listingRecord.product_title,
    listingRecord.description,
    ...listingRecord.faqs.map((faq) => `${faq.question || ''} ${faq.answer || ''}`),
  ].join(' ');
  const targeted = keywordRecords.filter((record) => containsText(text, record.keyword));
  const untargeted = keywordRecords.filter((record) => !containsText(text, record.keyword));

  const findings = [
    `${targeted.length}/${keywordRecords.length} target keyword(s) appear in the title, description, or FAQs.`,
  ];
  const recommendations = untargeted.map(
    (record) => `Keyword "${record.keyword}" does not appear in the title, description, or FAQs - consider adding it where relevant.`
  );

  const status = deriveNonEmptyCheckStatus(targeted.length, keywordRecords.length);
  return { status, findings, recommendations };
}

// Only assessable when the caller supplies customerObjections (e.g. from
// agent/core/customerSegmentResearchModel.js's objections field). Checks whether each
// objection is addressed anywhere in the FAQs or description (a literal substring
// match) - never judges whether the response is actually persuasive or sufficient.
function checkCustomerObjections(listingRecord, customerObjections) {
  if (customerObjections.length === 0) {
    return {
      status: 'empty',
      findings: ['No customer objections were supplied to check coverage against.'],
      recommendations: [],
    };
  }

  const text = [
    listingRecord.description,
    ...listingRecord.faqs.map((faq) => `${faq.question || ''} ${faq.answer || ''}`),
  ].join(' ');
  const addressed = customerObjections.filter((objection) => containsText(text, objection));
  const unaddressed = customerObjections.filter((objection) => !containsText(text, objection));

  const findings = [
    `${addressed.length}/${customerObjections.length} known customer objection(s) are addressed in the description or FAQs.`,
  ];
  const recommendations = unaddressed.map(
    (objection) => `Objection "${objection}" is not addressed anywhere in the description or FAQs - consider adding an FAQ for it.`
  );

  const status = deriveNonEmptyCheckStatus(addressed.length, customerObjections.length);
  return { status, findings, recommendations };
}

// Comprehensive, itemized field audit across the full listingContentModel.js record -
// distinct from checkCompleteness above, which only checks the essential go-live
// fields. This dimension names every gap, including optional-but-valuable fields.
const MISSING_INFORMATION_FIELD_CHECKS = [
  { label: 'product_title', present: (record) => Boolean(record.product_title) },
  { label: 'description', present: (record) => Boolean(record.description) },
  { label: 'benefits', present: (record) => record.benefits.length > 0 },
  { label: 'features', present: (record) => record.features.length > 0 },
  { label: 'selling_points', present: (record) => record.selling_points.length > 0 },
  { label: 'faqs', present: (record) => record.faqs.length > 0 },
  { label: 'attributes', present: (record) => record.attributes.length > 0 },
  { label: 'variants', present: (record) => record.variants.length > 0 },
  { label: 'cta', present: (record) => Boolean(record.cta) },
];

function checkMissingInformation(listingRecord) {
  const missing = MISSING_INFORMATION_FIELD_CHECKS.filter((check) => !check.present(listingRecord));
  const present = MISSING_INFORMATION_FIELD_CHECKS.length - missing.length;

  const findings = [`${present}/${MISSING_INFORMATION_FIELD_CHECKS.length} listing field(s) are populated.`];
  const recommendations = missing.map((check) => `${check.label} is missing.`);

  let status = 'empty';
  if (present === MISSING_INFORMATION_FIELD_CHECKS.length) status = 'success';
  else if (present > 0) status = 'partial';
  return { status, findings, recommendations };
}

// Absolute/superlative claim-phrase heuristic across description/benefits/features/
// selling points. A claim phrase is only flagged as "unbacked" when no supplied
// factual attribute corresponds to it - presence alone is never treated as false,
// since this module has no independent source of truth (same honesty rule as
// checkAccuracy above).
function checkUnsupportedClaims(listingRecord, factualAttributes) {
  const text = marketingText(listingRecord);
  if (!text.trim()) {
    return {
      status: 'empty',
      findings: ['No description, benefits, features, or selling points were supplied to check for unsupported claims.'],
      recommendations: [],
    };
  }

  const found = CLAIM_TRIGGER_PHRASES.filter((phrase) => containsText(text, phrase));
  if (found.length === 0) {
    return {
      status: 'success',
      findings: ['No absolute/superlative claim language (e.g. "best", "guaranteed", "#1") was found.'],
      recommendations: [],
    };
  }

  const backed = found.filter((phrase) => factualAttributes.some((attribute) => containsText(attribute, phrase)));
  const unbacked = found.filter((phrase) => !backed.includes(phrase));

  const findings = [
    `${backed.length}/${found.length} claim phrase(s) found are backed by a supplied factual attribute.`,
  ];
  const recommendations = unbacked.map(
    (phrase) => `The phrase "${phrase}" appears in the listing text but is not backed by any supplied factual attribute - verify it can be substantiated or remove it.`
  );

  const status = deriveNonEmptyCheckStatus(backed.length, found.length);
  return { status, findings, recommendations };
}

const DIMENSION_CHECKS = {
  completeness: (listingRecord) => checkCompleteness(listingRecord),
  clarity: (listingRecord) => checkClarity(listingRecord),
  accuracy: (listingRecord, keywordRecords, factualAttributes) => checkAccuracy(listingRecord, factualAttributes),
  conversion_quality: (listingRecord) => checkConversionQuality(listingRecord),
  seo_compatibility: (listingRecord, keywordRecords) => checkSeoCompatibility(listingRecord, keywordRecords),
  customer_objections: (listingRecord, keywordRecords, factualAttributes, customerObjections) =>
    checkCustomerObjections(listingRecord, customerObjections),
  missing_information: (listingRecord) => checkMissingInformation(listingRecord),
  unsupported_claims: (listingRecord, keywordRecords, factualAttributes) => checkUnsupportedClaims(listingRecord, factualAttributes),
};

const DIMENSION_LABELS = {
  completeness: 'Completeness',
  clarity: 'Clarity',
  accuracy: 'Accuracy',
  conversion_quality: 'Conversion quality',
  seo_compatibility: 'SEO compatibility',
  customer_objections: 'Customer objections',
  missing_information: 'Missing information',
  unsupported_claims: 'Unsupported claims',
};

function buildDimensionGapReason(dimensionId, status) {
  const label = DIMENSION_LABELS[dimensionId];
  if (status === 'empty') {
    return `${label} has nothing to check, or every applicable check failed.`;
  }
  return `${label} has at least one unresolved check.`;
}

// ---------------------------------------------------------------------------------
// Combined entry point. Takes already-built, already-validated records - this checker
// audits existing Listing Agent output, it does not build it.
// ---------------------------------------------------------------------------------

function checkListingQuality({
  listingRecord,
  keywordRecords = [],
  factualAttributes = [],
  customerObjections = [],
  researchDate,
} = {}) {
  const fnName = 'checkListingQuality';

  const listingValidation = validateListingContentShape(listingRecord);
  if (!listingValidation.valid) {
    throw new Error(`${fnName} requires a valid listingContentModel.js record: ${listingValidation.errors.join('; ')}`);
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

  for (const dimensionId of LISTING_QUALITY_DIMENSIONS) {
    const check = DIMENSION_CHECKS[dimensionId](listingRecord, keywordRecords, factualAttributes, customerObjections);
    dimensionStatus[dimensionId] = check.status;
    const label = DIMENSION_LABELS[dimensionId];
    findings.push(...check.findings.map((finding) => `[${label}] ${finding}`));
    recommendations.push(...check.recommendations.map((recommendation) => `[${label}] ${recommendation}`));
    if (check.status !== 'success') {
      dimensionGaps.push({ dimension: dimensionId, reason: buildDimensionGapReason(dimensionId, check.status) });
    }
  }

  const statuses = Object.values(dimensionStatus);
  const dimensionsTotal = LISTING_QUALITY_DIMENSIONS.length;
  const dimensionsSuccess = statuses.filter((status) => status === 'success').length;
  const dimensionsPartial = statuses.filter((status) => status === 'partial').length;
  const dimensionsEmpty = statuses.filter((status) => status === 'empty').length;
  let scoreStatus = 'empty';
  if (dimensionsSuccess === dimensionsTotal) scoreStatus = 'success';
  else if (dimensionsSuccess > 0) scoreStatus = 'partial';

  const result = createEmptyListingQualityCheck(listingRecord.product_reference);
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

  const resultValidation = validateListingQualityCheckShape(result);
  if (!resultValidation.valid) {
    throw new Error(`Composed Listing quality check failed validation: ${resultValidation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  checkListingQuality,
  CLAIM_TRIGGER_PHRASES,
  containsText,
};

if (require.main === module) {
  const { createEmptyListingContentRecord } = require('./listingContentModel');
  const { createEmptySeoResearchRecord } = require('./seoResearchModel');

  console.log('Smart E-Commerce Growth AI Agent - Listing Quality Checker (deterministic, mechanical checks only):\n');

  const listingRecord = createEmptyListingContentRecord('(Example insulated jacket)');
  listingRecord.product_title = 'Insulated Hiking Jacket - placeholder';
  listingRecord.description = 'Caller-supplied placeholder description text, long enough to clear the thin-content guideline.';
  listingRecord.benefits = ['Keeps you warm on cold hikes (caller-supplied placeholder).'];
  listingRecord.features = ['Waterproof shell (caller-supplied placeholder).'];
  listingRecord.faqs = [{ question: 'Is it machine washable?', answer: 'Yes, cold wash only (caller-supplied placeholder).' }];
  // cta and selling_points/attributes/variants deliberately left empty, to show an
  // honest gap.

  const keywordRecord = createEmptySeoResearchRecord('insulated hiking jacket');
  keywordRecord.source = ['(placeholder keyword source)'];

  const result = checkListingQuality({
    listingRecord,
    keywordRecords: [keywordRecord],
    factualAttributes: ['waterproof'],
    customerObjections: ['too expensive'],
  });
  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('quality_score is a mechanical checklist-coverage measurement only, never a conversion/ranking/performance prediction.');
}
